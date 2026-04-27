use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::keepass_manager;
use crate::local_shell_manager::LocalShellManager;
use crate::profiles::{ConnectionProfile, ProfileManager};
use crate::rdp_manager::RdpManager;
use crate::sftp_manager::{FileEntry, SftpManager};
use crate::ssh_manager::SshManager;
use crate::sync::{
    pack_state, unpack_state, OAuthFinishResult, OAuthProvider, OAuthStartResult, SyncBackendKind,
    SyncConfig, SyncManager, SyncState,
};

// ─── Comandos de gestión de perfiles ─────────────────────────────────────────

/// Devuelve todos los perfiles de conexión guardados
#[tauri::command]
pub fn get_profiles(state: State<ProfileManager>) -> Result<Vec<ConnectionProfile>, String> {
    state.load_all().map_err(|e| e.to_string())
}

/// Crea o actualiza un perfil (upsert).
/// El ID debe venir generado desde el frontend con crypto.randomUUID().
#[tauri::command]
pub fn save_profile(
    state: State<ProfileManager>,
    profile: ConnectionProfile,
) -> Result<(), String> {
    state.save(profile).map_err(|e| e.to_string())
}

/// Elimina un perfil por su ID
#[tauri::command]
pub fn delete_profile(state: State<ProfileManager>, id: String) -> Result<(), String> {
    state.delete(&id).map_err(|e| e.to_string())
}

// ─── Comandos SSH ─────────────────────────────────────────────────────────────

/// Inicia una sesión SSH a partir de un perfil guardado.
/// Devuelve el session_id que el frontend usará para identificar la sesión.
///
/// El flujo de eventos emitidos por el backend:
///   - `ssh-connected-{id}` : conexión y auth exitosas
///   - `ssh-data-{id}`      : Vec<u8> con bytes recibidos del servidor
///   - `ssh-error-{id}`     : String con el error
///   - `ssh-closed-{id}`    : sesión finalizada (limpiamente o por error)
#[tauri::command]
pub fn ssh_connect(
    ssh_state: State<'_, SshManager>,
    profile_state: State<'_, ProfileManager>,
    app_handle: AppHandle,
    profile_id: String,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;

    let resolved_password = resolve_password_from_keepass(&profile, password)?;

    let session_id = uuid::Uuid::new_v4().to_string();

    ssh_state
        .connect(
            session_id.clone(),
            profile,
            resolved_password,
            passphrase,
            app_handle,
        )
        .map_err(|e| e.to_string())?;

    Ok(session_id)
}

/// Si el perfil tiene `keepass_entry_uuid` y la DB está desbloqueada, devuelve
/// la contraseña de KeePass. Si el uuid está pero la DB bloqueada, devuelve error.
/// En cualquier otro caso, pasa a través la contraseña recibida del frontend.
fn resolve_password_from_keepass(
    profile: &ConnectionProfile,
    password: Option<String>,
) -> Result<Option<String>, String> {
    let Some(entry_uuid) = profile.keepass_entry_uuid.as_deref() else {
        return Ok(password);
    };
    if entry_uuid.is_empty() {
        return Ok(password);
    }
    if !keepass_manager::status().unlocked {
        return Err("KeePass está bloqueada; desbloquéala en Preferencias".to_string());
    }
    match keepass_manager::get_password(entry_uuid).map_err(|e| e.to_string())? {
        Some(pw) => Ok(Some(pw)),
        None => Err(format!("Entrada KeePass {} no encontrada", entry_uuid)),
    }
}

/// Cierra una sesión SSH activa
#[tauri::command]
pub fn ssh_disconnect(ssh_state: State<SshManager>, session_id: String) -> Result<(), String> {
    ssh_state.disconnect(&session_id).map_err(|e| e.to_string())
}

/// Resuelve la contraseña almacenada del perfil (KeePass o keyring).
/// No interroga al usuario; devuelve `Ok(None)` si no hay ninguna guardada.
/// Usado por el atajo "pegar contraseña" (Ctrl+Alt+P).
#[tauri::command]
pub fn get_profile_password(
    profile_state: State<'_, ProfileManager>,
    profile_id: String,
) -> Result<Option<String>, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;

    // 1) KeePass si el perfil la tiene asociada
    if let Some(uuid) = profile
        .keepass_entry_uuid
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        if !keepass_manager::status().unlocked {
            return Err("KeePass está bloqueada; desbloquéala en Preferencias".into());
        }
        return keepass_manager::get_password(uuid).map_err(|e| e.to_string());
    }

    // 2) keyring (si el usuario guardó la contraseña al crear el perfil)
    let entry = keyring::Entry::new("rustty", &format!("password:{}", profile.id))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Envía bytes de entrada del usuario al servidor SSH.
/// `data` es un array de bytes (Vec<u8>) serializado como array JSON de números.
#[tauri::command]
pub fn ssh_send_input(
    ssh_state: State<SshManager>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    ssh_state
        .send_input(&session_id, data)
        .map_err(|e| e.to_string())
}

/// Notifica al servidor SSH del nuevo tamaño del terminal (columnas × filas)
#[tauri::command]
pub fn ssh_resize(
    ssh_state: State<SshManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    ssh_state
        .resize(&session_id, cols, rows)
        .map_err(|e| e.to_string())
}

// ─── Comandos RDP ────────────────────────────────────────────────────────────

/// Lanza el cliente RDP nativo y devuelve el session_id.
/// El backend emitirá `rdp-closed-{id}` cuando el proceso externo termine.
#[tauri::command]
pub fn rdp_connect(
    rdp_state: State<'_, RdpManager>,
    profile_state: State<'_, ProfileManager>,
    app_handle: AppHandle,
    profile_id: String,
    password: Option<String>,
) -> Result<String, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;

    let password = resolve_password_from_keepass(&profile, password)?;

    let session_id = uuid::Uuid::new_v4().to_string();

    rdp_state
        .launch(
            session_id.clone(),
            profile_id,
            &profile.host,
            profile.port,
            &profile.username,
            profile.domain.as_deref(),
            password.as_deref(),
            app_handle,
        )
        .map_err(|e| e)?;

    Ok(session_id)
}

/// Termina el proceso RDP asociado a la sesión
#[tauri::command]
pub fn rdp_disconnect(rdp_state: State<'_, RdpManager>, session_id: String) -> Result<(), String> {
    rdp_state.disconnect(&session_id)
}

// ─── Comandos de shell local ──────────────────────────────────────────────────

/// Abre una sesión de shell local con PTY.
/// Devuelve el session_id. Emite `shell-data-{id}` y `shell-closed-{id}`.
#[tauri::command]
pub fn local_shell_open(
    shell_state: State<'_, LocalShellManager>,
    app_handle: AppHandle,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    shell_state.open(session_id, app_handle, cols, rows)
}

/// Envía bytes al stdin del shell local
#[tauri::command]
pub fn local_shell_send_input(
    shell_state: State<'_, LocalShellManager>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    shell_state.send_input(&session_id, data)
}

/// Notifica al PTY del nuevo tamaño del terminal
#[tauri::command]
pub fn local_shell_resize(
    shell_state: State<'_, LocalShellManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    shell_state.resize(&session_id, cols, rows)
}

/// Cierra la sesión de shell local y termina el proceso
#[tauri::command]
pub fn local_shell_close(
    shell_state: State<'_, LocalShellManager>,
    session_id: String,
) -> Result<(), String> {
    shell_state.close(&session_id)
}

// ─── Comandos SFTP ────────────────────────────────────────────────────────────

/// Abre una sesión SFTP paralela a la SSH para transferencia de ficheros.
/// Devuelve el session_id (independiente del de la sesión SSH interactiva).
#[tauri::command]
pub fn sftp_connect(
    sftp_state: State<'_, SftpManager>,
    profile_state: State<'_, ProfileManager>,
    app_handle: AppHandle,
    profile_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    elevated: Option<bool>,
) -> Result<String, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;

    let password = resolve_password_from_keepass(&profile, password)?;

    let session_id = uuid::Uuid::new_v4().to_string();

    sftp_state.connect(
        session_id.clone(),
        profile,
        password,
        passphrase,
        elevated.unwrap_or(false),
        app_handle,
    )?;
    Ok(session_id)
}

#[tauri::command]
pub fn sftp_disconnect(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
) -> Result<(), String> {
    sftp_state.disconnect(&session_id)
}

#[tauri::command]
pub fn sftp_list_dir(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    sftp_state.list_dir(&session_id, path)
}

#[tauri::command]
pub fn sftp_home_dir(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
) -> Result<String, String> {
    sftp_state.home_dir(&session_id)
}

#[tauri::command]
pub fn sftp_stat(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<FileEntry, String> {
    sftp_state.stat(&session_id, path)
}

#[tauri::command]
pub fn sftp_mkdir(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    sftp_state.mkdir(&session_id, path)
}

#[tauri::command]
pub fn sftp_remove(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    sftp_state.remove(&session_id, path, is_dir)
}

#[tauri::command]
pub fn sftp_rename(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    sftp_state.rename(&session_id, from, to)
}

/// Descarga un fichero remoto a `local_path`.
/// Emite `sftp-progress-{transfer_id}` con { transferred, total, done }.
#[tauri::command]
pub fn sftp_download(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), String> {
    sftp_state.download(
        &session_id,
        remote_path,
        PathBuf::from(local_path),
        transfer_id,
    )
}

/// Sube un fichero local a `remote_path`.
#[tauri::command]
pub fn sftp_upload(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    sftp_state.upload(
        &session_id,
        PathBuf::from(local_path),
        remote_path,
        transfer_id,
    )
}

// ─── Comandos de keyring ──────────────────────────────────────────────────────

/// Guarda una contraseña/passphrase en el gestor de credenciales del SO.
/// `service` identifica la aplicación, `key` identifica la entrada concreta.
#[tauri::command]
pub fn keyring_set(service: String, key: String, secret: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &key).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

/// Recupera una contraseña del keyring. Devuelve None si no existe entrada.
#[tauri::command]
pub fn keyring_get(service: String, key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(&service, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Elimina una entrada del keyring
#[tauri::command]
pub fn keyring_delete(service: String, key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &key).map_err(|e| e.to_string())?;
    entry.delete_credential().map_err(|e| e.to_string())
}

// ─── Comandos de KeePass ─────────────────────────────────────────────────────

/// Abre una base KeePass (.kdbx). La DB queda cacheada en memoria hasta `keepass_lock`
/// o hasta que se cierre la app. El `password` puede ser vacío si se usa solo keyfile.
#[tauri::command]
pub fn keepass_unlock(
    path: String,
    password: Option<String>,
    keyfile_path: Option<String>,
) -> Result<(), String> {
    keepass_manager::unlock(&path, password.as_deref(), keyfile_path.as_deref())
        .map_err(|e| e.to_string())
}

/// Cierra la base KeePass (borra la copia descifrada en memoria).
#[tauri::command]
pub fn keepass_lock() -> Result<(), String> {
    keepass_manager::lock();
    Ok(())
}

/// Devuelve el estado actual de la base KeePass.
#[tauri::command]
pub fn keepass_status() -> keepass_manager::KeepassStatus {
    keepass_manager::status()
}

/// Lista todas las entradas de la base KeePass desbloqueada (sin contraseñas).
#[tauri::command]
pub fn keepass_list_entries() -> Result<Vec<keepass_manager::EntrySummary>, String> {
    keepass_manager::list_entries().map_err(|e| e.to_string())
}

// ─── Directorio de datos ──────────────────────────────────────────────────────

/// Devuelve la ruta al directorio de datos de la app donde se guardan los perfiles.
/// Devuelve el directorio de datos **efectivo** de la app (el que realmente
/// se usa para `profiles.json` y demás). Coincide con `app_data_dir()` salvo
/// en la build portable de Windows, donde apunta a `.conf/com.rustty.app/`
/// junto al `.exe`.
///
/// Útil para que el usuario sepa dónde hacer backups.
///   Linux:   ~/.local/share/com.rustty.app/
///   macOS:   ~/Library/Application Support/com.rustty.app/
///   Windows: %APPDATA%\com.rustty.app\  (o `<dir-del-exe>\.conf\com.rustty.app\` en portable)
#[tauri::command]
pub fn get_data_dir(state: State<crate::DataDir>) -> Result<String, String> {
    Ok(state.0.to_string_lossy().into_owned())
}

/// Devuelve el directorio de descargas del usuario (p.ej. ~/Downloads).
/// Si no se puede determinar, hace fallback al home.
#[tauri::command]
pub fn get_download_dir() -> Result<String, String> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "No se pudo determinar el directorio de descargas".into())
}

/// Escribe un fichero binario en disco.
/// Se usa para subidas vía input HTML: el frontend pasa los bytes leídos
/// del File API y esta función los materializa en un path temporal que
/// luego `sftp_upload` transfiere al servidor.
#[tauri::command]
pub fn write_temp_file(
    app_handle: AppHandle,
    name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("sftp-uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Elimina un fichero del sistema (se usa tras subidas para limpiar temporales)
#[tauri::command]
pub fn remove_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Escribe texto (ej. JSON de export) a un path absoluto.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Lee un fichero de texto (ej. JSON para import)
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Une dos segmentos de ruta usando el separador nativo del SO.
#[tauri::command]
pub fn join_path(base: String, name: String) -> Result<String, String> {
    Ok(std::path::Path::new(&base)
        .join(&name)
        .to_string_lossy()
        .into_owned())
}

/// Lista las familias de fuentes monoespaciadas instaladas en el sistema.
/// Se usa en Preferencias → Terminal para elegir la familia del xterm.js.
/// Devuelve nombres únicos, ordenados alfabéticamente.
#[tauri::command]
pub fn list_monospace_fonts() -> Result<Vec<String>, String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut families: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for face in db.faces() {
        if !face.monospaced {
            continue;
        }
        if let Some((family, _)) = face.families.first() {
            families.insert(family.clone());
        }
    }
    Ok(families.into_iter().collect())
}

// ═══════════════════════════════════════════════════════════════════
//  Sincronización en la nube
// ═══════════════════════════════════════════════════════════════════

/// Devuelve la configuración de sincronización persistida.
#[tauri::command]
pub fn sync_get_config(state: State<SyncManager>) -> Result<SyncConfig, String> {
    Ok(state.load_config())
}

/// Guarda la configuración de sincronización (sin secretos: la passphrase y
/// la contraseña WebDAV viven en el keyring del SO).
#[tauri::command]
pub fn sync_save_config(state: State<SyncManager>, config: SyncConfig) -> Result<(), String> {
    state.save_config(&config).map_err(|e| e.to_string())
}

/// Devuelve el `device_id` único de este equipo (UUID v4 persistido).
#[tauri::command]
pub fn sync_get_device_id(data_dir: State<crate::DataDir>) -> Result<String, String> {
    Ok(crate::sync::get_or_create_device_id(&data_dir.0))
}

/// Verifica que el backend configurado sea accesible (lee el estado remoto;
/// si no existe aún, devuelve "vacío" pero éxito).
#[tauri::command]
pub async fn sync_test_backend(
    state: State<'_, SyncManager>,
    webdav_password: Option<String>,
) -> Result<String, String> {
    let config = state.load_config();
    if matches!(config.backend, SyncBackendKind::None) {
        return Err("No hay backend seleccionado".into());
    }
    let backend = state
        .backend(&config, webdav_password.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    match backend.read().await.map_err(|e| e.to_string())? {
        Some(_) => Ok("ok-existing".into()),
        None => Ok("ok-empty".into()),
    }
}

#[tauri::command]
pub async fn sync_oauth_begin(
    state: State<'_, SyncManager>,
    provider: String,
) -> Result<OAuthStartResult, String> {
    let provider = OAuthProvider::parse(&provider).map_err(|e| e.to_string())?;
    state.oauth_begin(provider).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_oauth_complete(
    state: State<'_, SyncManager>,
    flow_id: String,
) -> Result<OAuthFinishResult, String> {
    state
        .oauth_complete(&flow_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_oauth_status(state: State<SyncManager>, provider: String) -> Result<bool, String> {
    let provider = OAuthProvider::parse(&provider).map_err(|e| e.to_string())?;
    state.oauth_connected(provider).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_oauth_disconnect(state: State<SyncManager>, provider: String) -> Result<(), String> {
    let provider = OAuthProvider::parse(&provider).map_err(|e| e.to_string())?;
    state.oauth_disconnect(provider).map_err(|e| e.to_string())
}

/// Ejecuta una sincronización: pull → merge → push, devolviendo el estado
/// resultante para que el frontend lo aplique. El frontend pasa su `current`
/// (lo que tiene en memoria) y recibe el merge final.
#[tauri::command]
pub async fn sync_run(
    state: State<'_, SyncManager>,
    current: SyncState,
    passphrase: String,
    webdav_password: Option<String>,
) -> Result<SyncState, String> {
    let config = state.load_config();
    if !config.enabled || matches!(config.backend, SyncBackendKind::None) {
        return Err("Sincronización no habilitada".into());
    }
    let backend = state
        .backend(&config, webdav_password.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;

    // 1. Pull
    let remote = match backend.read().await.map_err(|e| e.to_string())? {
        Some(bytes) => unpack_state(&passphrase, &bytes).map_err(|e| e.to_string())?,
        None => SyncState::default(),
    };

    // 2. Merge: empezamos con el estado del frontend y aplicamos remoto LWW
    let mut merged = current;
    merged.merge(remote);

    // 3. Push
    let bytes = pack_state(&passphrase, &merged).map_err(|e| e.to_string())?;
    backend.write(&bytes).await.map_err(|e| e.to_string())?;

    // 4. Cache local (snapshot del último merge)
    state.save_local_state(&merged).map_err(|e| e.to_string())?;

    Ok(merged)
}

/// Exporta el estado a un fichero cifrado (`.rustty-sync.bin`) con la
/// passphrase indicada. No requiere backend ni configuración previa: sirve
/// de backup portable, transferible por USB/email.
#[tauri::command]
pub fn sync_export_file(path: String, passphrase: String, state: SyncState) -> Result<(), String> {
    let bytes = pack_state(&passphrase, &state).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Importa un fichero cifrado y devuelve el estado descifrado. El frontend
/// luego decide si reemplaza, fusiona o solo previsualiza.
#[tauri::command]
pub fn sync_import_file(path: String, passphrase: String) -> Result<SyncState, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    unpack_state(&passphrase, &bytes).map_err(|e| e.to_string())
}
