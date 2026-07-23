mod app_tray;
mod asbru;
mod atomic_file;
pub mod cli;
mod commands;
mod credentials;
mod error;
mod external_client;
mod host_keys;
mod ipc;
mod keepass_manager;
mod keyring_scope;
mod local_command;
mod local_shell_manager;
mod locks;
mod notes;
mod profiles;
#[cfg(all(test, target_os = "linux"))]
mod rdp_fixture;
mod rdp_manager;
#[cfg(all(test, target_os = "linux"))]
mod ssh_fixture;
mod scripts;
mod sftp_manager;
mod ssh_manager;
mod store_file;
mod subst;
mod sync;
mod tunnel_throttle;

use std::path::PathBuf;
use std::time::Duration;

use credentials::CredentialStore;
use external_client::{TelnetManager, VncManager};
use local_command::LocalCommandRegistry;
use local_shell_manager::LocalShellManager;
use notes::NotesManager;
use profiles::ProfileManager;
use rdp_manager::RdpManager;
use scripts::ScriptManager;
use sftp_manager::SftpManager;
use ssh_manager::SshManager;
use sync::SyncManager;
use tauri::{Manager, WindowEvent};

/// Señal de arranque minimizado: la app fue lanzada por el autostart del SO
/// con el argumento `--minimized`. El frontend consulta este estado para decidir
/// si ocultar la ventana al tray en lugar de mostrarla al frente.
pub struct LaunchMinimized(pub bool);

/// Directorio de datos efectivo de la aplicación.
///
/// Habitualmente coincide con `app.path().app_data_dir()` (en Linux:
/// `~/.local/share/com.rustty.app/`). Cuando el binario es la build portable
/// de Windows (`Rustty_<ver>_x64-portable.exe`), apunta a `.conf/com.rustty.app/`
/// junto al propio ejecutable, para que la configuración viaje con el USB.
///
/// Se inyecta como `State<DataDir>` en los comandos que necesitan la ruta
/// (p. ej. `get_data_dir`).
pub struct DataDir(pub PathBuf);

/// Devuelve `Some(path)` cuando el ejecutable actual es la versión portable
/// de Windows (filename termina en `-portable.exe`). En ese caso el data dir
/// vive en `<dir del exe>/.conf/com.rustty.app/`.
#[cfg(windows)]
fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = exe.file_name()?.to_str()?.to_ascii_lowercase();
    if !name.ends_with("-portable.exe") {
        return None;
    }
    let parent = exe.parent()?;
    Some(parent.join(".conf").join("com.rustty.app"))
}

#[cfg(not(windows))]
fn portable_data_dir() -> Option<PathBuf> {
    None
}

pub fn resolve_data_dir() -> PathBuf {
    portable_data_dir().unwrap_or_else(|| {
        dirs::data_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .join("com.rustty.app")
    })
}

/// Plugin de logging técnico de diagnóstico. Escribe a stdout y a un fichero con
/// rotación acotada en el directorio de logs de la app (`<log_dir>/rustty.log`),
/// conservando un único fichero rotado para no crecer sin límite. Nivel `Debug`
/// en builds de desarrollo, `Info` en release. **No** registra contenido de
/// terminal ni secretos: solo trazas de la propia aplicación.
fn build_log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    tauri_plugin_log::Builder::new()
        .level(level)
        .max_file_size(5_000_000) // ~5 MB por fichero antes de rotar
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("rustty".into()),
            }),
        ])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Detectar si la app fue lanzada por el autostart del SO con --minimized
    // ANTES de construir el Builder para que el estado esté disponible en setup().
    let launched_minimized = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        // Instancia única. **Debe registrarse el primero** (requisito del plugin).
        //
        // Dos motivos: (1) abrir dos ventanas de Rustty contra el mismo
        // `profiles.json` invita a que una pise los cambios de la otra —los
        // ciclos leer→modificar→escribir de los stores no están serializados entre
        // procesos—; (2) al usuario que relanza la app desde el lanzador del SO le
        // sirve más recuperar su ventana que abrir una nueva vacía.
        //
        // No afecta a la CLI: `main()` la despacha y sale **antes** de construir
        // este Builder, así que `rustty -c perfil` sigue funcionando con la GUI
        // abierta.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Segunda instancia: en vez de arrancar, devolvemos el foco a la que
            // ya está. (El reenvío de `argv` se implementará cuando haya un
            // consumidor real —deep links—; hoy no lo hay y no se crea superficie
            // muerta.)
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(build_log_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            log::info!(
                "Rustty {} iniciando ({} {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            // Updater de Tauri (solo escritorio): permite actualizar la app
            // desde dentro sin re-lanzar el instalador. Las actualizaciones se
            // verifican con la clave pública de `tauri.conf.json`.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            // El handler TOFU necesita poder pedir confirmación de una host key
            // nueva al usuario (evento `ssh-hostkey-prompt`). Sin este registro
            // —caso de la CLI— cae al prompt por stdin.
            host_keys::register_app(app.handle().clone());
            // Si es la build portable de Windows, los datos viajan junto al
            // .exe en `.conf/com.rustty.app/`. Si no, ruta estándar (identifier).
            let data_dir = resolve_data_dir();

            std::fs::create_dir_all(&data_dir).expect("No se pudo crear el directorio de datos");

            // Retira los temporales que dejó un cierre brusco (kill -9, corte de
            // luz) entre el `open` y el `rename` de una escritura atómica. Solo
            // toca los que llevan más de una hora inactivos: un temporal reciente
            // puede ser la escritura **viva** de otra instancia.
            let swept = atomic_file::sweep_orphan_temps(&data_dir, Duration::from_secs(3600));
            if swept > 0 {
                log::info!("Retirados {swept} temporales huérfanos del directorio de datos");
            }

            // Estado global gestionado por Tauri (inyectado en los comandos vía State<T>)
            app.manage(SshManager::new());
            app.manage(RdpManager::new());
            app.manage(VncManager::new());
            app.manage(TelnetManager::new());
            app.manage(LocalShellManager::new());
            app.manage(LocalCommandRegistry::new());
            app.manage(SftpManager::new());
            let profile_manager = ProfileManager::new(data_dir.clone());
            // Migración idempotente: vuelca el campo inline `notes` de los
            // perfiles a ficheros `notes/<id>.md` la primera vez. A partir de
            // aquí el `.md` es la fuente de verdad de las notas.
            let notes_manager = NotesManager::new(data_dir.clone());
            if let Ok(profiles) = profile_manager.load_all() {
                notes_manager.migrate_from_profiles(&profiles);
            }
            app.manage(profile_manager);
            app.manage(notes_manager);
            app.manage(CredentialStore::new(data_dir.clone()));
            app.manage(ScriptManager::new(data_dir.clone()));
            app.manage(SyncManager::new(data_dir.clone()));
            app.manage(DataDir(data_dir));
            // Señal de arranque minimizado: el frontend la consulta al inicio
            // para decidir si ocultar la ventana en lugar de mostrarla.
            app.manage(LaunchMinimized(launched_minimized));
            app_tray::setup(app);

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                window.state::<SshManager>().disconnect_all();
                window.state::<SftpManager>().disconnect_all();
                window.state::<LocalShellManager>().close_all();
                window.state::<RdpManager>().disconnect_all();
                window.state::<VncManager>().disconnect_all();
                window.state::<TelnetManager>().disconnect_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // ── Aplicación
            commands::close_app,
            commands::autostart_apply,
            commands::autostart_is_enabled,
            commands::is_launched_minimized,
            commands::is_appimage,
            app_tray::tray_update_quick_launcher,
            // ── Perfiles de conexión
            commands::get_profiles,
            commands::save_profile,
            commands::save_profiles,
            commands::delete_profile,
            commands::delete_profiles,
            commands::wake_on_lan,
            commands::hosts_health_check,
            commands::legacy_algorithm_catalog,
            // ── Catálogo de credenciales (master / var / secret)
            commands::master_cred_list,
            commands::master_cred_set,
            commands::master_cred_import,
            commands::master_cred_delete,
            commands::template_asks,
            // ── Motor de scripts (recetas interactivas por host)
            commands::scripts_get_all,
            commands::scripts_save,
            commands::scripts_delete,
            commands::scripts_preview,
            commands::scripts_run,
            commands::scripts_abort,
            commands::scripts_history_get,
            commands::scripts_history_save,
            commands::scripts_history_clear,
            // ── Notas Markdown por conexión (runbooks)
            commands::note_get,
            commands::note_set,
            commands::note_delete,
            commands::note_list,
            commands::note_export_all,
            commands::note_import,
            commands::notes_dir,
            // ── Sesiones SSH
            commands::ssh_connect,
            commands::ssh_test_connection,
            commands::ssh_disconnect,
            commands::ssh_send_input,
            commands::ssh_resize,
            commands::ssh_start_tunnel,
            commands::ssh_stop_tunnel,
            commands::ssh_set_keepalive,
            commands::get_profile_password,
            // ── Keyring (credenciales del SO)
            commands::keyring_set,
            commands::keyring_get,
            commands::keyring_delete,
            // ── KeePass
            commands::keepass_unlock,
            commands::keepass_lock,
            commands::keepass_status,
            commands::keepass_list_entries,
            // ── Sesiones RDP
            commands::rdp_connect,
            commands::rdp_disconnect,
            // ── Sesiones VNC / Telnet (lanzador externo)
            commands::vnc_connect,
            commands::vnc_disconnect,
            commands::telnet_connect,
            commands::telnet_disconnect,
            // ── Shell local
            commands::local_shell_open,
            commands::local_shell_send_input,
            commands::local_shell_resize,
            commands::local_shell_close,
            commands::local_shell_has_job,
            // ── SFTP
            commands::sftp_connect,
            commands::sftp_disconnect,
            commands::sftp_list_dir,
            commands::sftp_home_dir,
            commands::sftp_mkdir,
            commands::sftp_create_file,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_chmod,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_download_dir,
            commands::sftp_upload_dir,
            commands::sftp_cancel_transfer,
            commands::sftp_pause_transfer,
            commands::sftp_resume_transfer,
            // ── FS local (panel SFTP partido)
            commands::local_list_dir,
            commands::local_home_dir,
            commands::local_mkdir,
            commands::local_create_file,
            commands::local_remove,
            commands::local_rename,
            commands::local_chmod,
            commands::local_path_join,
            // ── Utilidades
            commands::get_data_dir,
            commands::write_text_file,
            commands::read_text_file,
            asbru::parse_asbru,
            asbru::asbru_decrypt,
            commands::run_local_command,
            commands::local_command_cancel,
            commands::list_monospace_fonts,
            commands::tcp_ping,
            // ── Gestor de known_hosts
            commands::list_known_hosts,
            commands::remove_known_host_line,
            commands::set_host_key_policy,
            commands::ssh_hostkey_response,
            commands::profiles_recovery,
            // ── Sincronización en la nube
            commands::sync_get_config,
            commands::sync_save_config,
            commands::sync_get_device_id,
            commands::sync_run,
            commands::sync_test_backend,
            commands::sync_get_backend_folder,
            commands::sync_oauth_begin,
            commands::sync_oauth_complete,
            commands::sync_oauth_status,
            commands::sync_oauth_disconnect,
            commands::sync_export_file,
            commands::sync_import_file,
            commands::sync_list_snapshots,
            commands::sync_read_snapshot,
            commands::sync_peek_remote,
            commands::sync_cache_exists,
            commands::sync_wipe_remote,
            commands::sync_clear_local_cache,
            commands::sync_rotate_passphrase,
            // ── Retención de logs de sesión
            commands::session_logs_dir,
            commands::session_logs_list,
            commands::session_logs_prune,
            // ── Snapshots de pantalla por sesión (restaurar sesión anterior)
            commands::session_snapshot_set,
            commands::session_snapshot_get,
            commands::session_snapshot_delete,
            commands::session_snapshot_list,
        ])
        .run(tauri::generate_context!())
        .expect("Error al iniciar la aplicación Rustty");
}
