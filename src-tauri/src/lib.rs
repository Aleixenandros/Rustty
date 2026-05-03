mod commands;
mod error;
mod host_keys;
mod keepass_manager;
mod local_shell_manager;
mod profiles;
mod rdp_manager;
mod sftp_manager;
mod ssh_manager;
mod sync;

use std::path::PathBuf;

use local_shell_manager::LocalShellManager;
use profiles::ProfileManager;
use rdp_manager::RdpManager;
use sftp_manager::SftpManager;
use ssh_manager::SshManager;
use sync::SyncManager;
use tauri::{Manager, WindowEvent};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            // Si es la build portable de Windows, los datos viajan junto al
            // .exe en `.conf/com.rustty.app/`. Si no, ruta estándar (identifier).
            let data_dir = portable_data_dir().unwrap_or_else(|| {
                app.path()
                    .app_data_dir()
                    .expect("No se pudo obtener el directorio de datos de la app")
            });

            std::fs::create_dir_all(&data_dir).expect("No se pudo crear el directorio de datos");

            // Estado global gestionado por Tauri (inyectado en los comandos vía State<T>)
            app.manage(SshManager::new());
            app.manage(RdpManager::new());
            app.manage(LocalShellManager::new());
            app.manage(SftpManager::new());
            app.manage(ProfileManager::new(data_dir.clone()));
            app.manage(SyncManager::new(data_dir.clone()));
            app.manage(DataDir(data_dir));

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                window.state::<SshManager>().disconnect_all();
                window.state::<SftpManager>().disconnect_all();
                window.state::<LocalShellManager>().close_all();
                window.state::<RdpManager>().disconnect_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // ── Perfiles de conexión
            commands::get_profiles,
            commands::save_profile,
            commands::delete_profile,
            // ── Sesiones SSH
            commands::ssh_connect,
            commands::ssh_disconnect,
            commands::ssh_send_input,
            commands::ssh_resize,
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
            // ── Shell local
            commands::local_shell_open,
            commands::local_shell_send_input,
            commands::local_shell_resize,
            commands::local_shell_close,
            // ── SFTP
            commands::sftp_connect,
            commands::sftp_disconnect,
            commands::sftp_list_dir,
            commands::sftp_home_dir,
            commands::sftp_stat,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_download_dir,
            commands::sftp_upload_dir,
            // ── FS local (panel SFTP partido)
            commands::local_list_dir,
            commands::local_home_dir,
            commands::local_mkdir,
            commands::local_remove,
            commands::local_rename,
            commands::local_path_join,
            commands::local_path_parent,
            // ── Utilidades
            commands::get_data_dir,
            commands::get_download_dir,
            commands::write_temp_file,
            commands::remove_file,
            commands::write_text_file,
            commands::read_text_file,
            commands::join_path,
            commands::list_monospace_fonts,
            commands::tcp_ping,
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
        ])
        .run(tauri::generate_context!())
        .expect("Error al iniciar la aplicación Rustty");
}
