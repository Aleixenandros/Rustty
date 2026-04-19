mod commands;
mod error;
mod keepass_manager;
mod local_shell_manager;
mod profiles;
mod rdp_manager;
mod sftp_manager;
mod ssh_manager;

use local_shell_manager::LocalShellManager;
use profiles::ProfileManager;
use rdp_manager::RdpManager;
use sftp_manager::SftpManager;
use ssh_manager::SshManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            // Directorio de datos de la app (~/.local/share/rustty/ en Linux)
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("No se pudo obtener el directorio de datos de la app");

            std::fs::create_dir_all(&data_dir)
                .expect("No se pudo crear el directorio de datos");

            // Estado global gestionado por Tauri (inyectado en los comandos vía State<T>)
            app.manage(SshManager::new());
            app.manage(RdpManager::new());
            app.manage(LocalShellManager::new());
            app.manage(SftpManager::new());
            app.manage(ProfileManager::new(data_dir));

            Ok(())
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
            // ── Utilidades
            commands::get_data_dir,
            commands::get_download_dir,
            commands::write_temp_file,
            commands::remove_file,
            commands::write_text_file,
            commands::read_text_file,
            commands::join_path,
        ])
        .run(tauri::generate_context!())
        .expect("Error al iniciar la aplicación Rustty");
}
