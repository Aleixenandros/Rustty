use std::net::UdpSocket;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State};

use crate::credentials::{self, CredentialKind, CredentialMeta, CredentialStore};
use crate::external_client::{TelnetManager, VncManager};
use crate::host_keys::fingerprint_sha256;
use crate::keepass_manager;
use crate::local_shell_manager::LocalShellManager;
use crate::notes::{NoteDoc, NoteSummary, NotesManager};
use crate::profiles::{AuthType, ConnectionProfile, PasswordSource, ProfileManager};
use crate::rdp_manager::RdpManager;
use crate::sftp_manager::{FileEntry, SftpManager, TransferConflictPolicy};
use crate::ssh_manager::{legacy_catalog_info, SshManager, SshTunnelConfig, SshTunnelInfo};
use crate::sync::{
    pack_state, resolve_sync_folder, unpack_state, OAuthFinishResult, OAuthProvider,
    OAuthStartResult, SnapshotEntry, SyncBackendKind, SyncConfig, SyncManager, SyncState,
};
use crate::{DataDir, LaunchMinimized};

// ─── Comandos de aplicación ─────────────────────────────────────────────────

/// Cierra la aplicación de forma explícita desde los controles CSD.
#[tauri::command]
pub fn close_app(
    app: AppHandle,
    ssh_state: State<SshManager>,
    sftp_state: State<SftpManager>,
    shell_state: State<LocalShellManager>,
    rdp_state: State<RdpManager>,
    vnc_state: State<VncManager>,
    telnet_state: State<TelnetManager>,
) {
    ssh_state.disconnect_all();
    sftp_state.disconnect_all();
    shell_state.close_all();
    rdp_state.disconnect_all();
    // VNC/Telnet también, para no dejar visores/clientes externos huérfanos
    // (coherente con el manejador de `CloseRequested` en `lib.rs`).
    vnc_state.disconnect_all();
    telnet_state.disconnect_all();
    app.exit(0);
}

// ─── Comandos de gestión de perfiles ─────────────────────────────────────────

/// Devuelve todos los perfiles de conexión guardados
#[tauri::command]
pub fn get_profiles(state: State<ProfileManager>) -> Result<Vec<ConnectionProfile>, String> {
    state.load_all().map_err(|e| e.to_string())
}

/// Una entrada del catálogo de algoritmos legacy para la UI.
#[derive(serde::Serialize)]
pub struct LegacyAlgoInfo {
    /// Nombre wire del algoritmo (p. ej. `hmac-sha1`, `aes256-cbc`).
    pub id: String,
    /// Categoría estable para agrupar en la interfaz: `cipher`, `kex`, `mac`, `hostkey`.
    pub category: String,
}

/// Devuelve el catálogo de algoritmos legacy seleccionables. La UI lo usa para
/// mostrar exactamente lo que se ofrecerá al activar los algoritmos antiguos.
#[tauri::command]
pub fn legacy_algorithm_catalog() -> Vec<LegacyAlgoInfo> {
    legacy_catalog_info()
        .into_iter()
        .map(|(id, category)| LegacyAlgoInfo { id, category })
        .collect()
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

/// Elimina un perfil por su ID y limpia sus secretos del keyring del SO.
///
/// Único punto de borrado para todos los flujos del frontend (individual y en
/// lote): antes se quedaban entradas `password:<id>` / `passphrase:<id>`
/// huérfanas para siempre (los ids son UUID irrepetibles). Solo se borran las
/// claves derivadas del propio `id` del perfil; las credenciales maestras
/// (`master:*`) y secretos sueltos (`secret:*`), que se comparten entre
/// perfiles, no se tocan.
#[tauri::command]
pub fn delete_profile(state: State<ProfileManager>, id: String) -> Result<(), String> {
    // Recogemos las claves de keyring del perfil antes de borrarlo del disco.
    let mut keyring_keys = vec![format!("password:{id}"), format!("passphrase:{id}")];
    if let Ok(profiles) = state.load_all() {
        if let Some(profile) = profiles.iter().find(|p| p.id == id) {
            for cred in &profile.extra_credentials {
                keyring_keys.push(format!("password:{id}:{}", cred.id));
                keyring_keys.push(format!("passphrase:{id}:{}", cred.id));
            }
        }
    }

    state.delete(&id).map_err(|e| e.to_string())?;

    // Borrado best-effort: una entrada inexistente no es un error real.
    for key in keyring_keys {
        if let Ok(entry) = keyring::Entry::new("rustty", &key) {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => log::warn!("keyring: no se pudo borrar {key}: {e}"),
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn wake_on_lan(
    mac_address: String,
    broadcast: Option<String>,
    port: Option<u16>,
) -> Result<(), String> {
    let mac = parse_mac_address(&mac_address)?;
    let mut packet = [0xffu8; 102];
    for i in 0..16 {
        packet[6 + i * 6..12 + i * 6].copy_from_slice(&mac);
    }

    let addr = format!(
        "{}:{}",
        broadcast.unwrap_or_else(|| "255.255.255.255".to_string()),
        port.unwrap_or(9),
    );
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    socket.send_to(&packet, &addr).map_err(|e| e.to_string())?;
    Ok(())
}

fn parse_mac_address(input: &str) -> Result<[u8; 6], String> {
    let hex: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 {
        return Err("MAC inválida".to_string());
    }
    let mut out = [0u8; 6];
    for i in 0..6 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| "MAC inválida".to_string())?;
    }
    Ok(out)
}

// ─── Comandos SSH ─────────────────────────────────────────────────────────────

/// Overrides puntuales de «Duplicar sesión con cambios»: se aplican sobre la
/// copia del perfil cargada para esta conexión, sin tocar el perfil guardado.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ConnectOverrides {
    pub username: Option<String>,
    pub port: Option<u16>,
    /// `Some("")` quita el bastion del perfil; `Some(s)` lo sustituye;
    /// `None` conserva el del perfil.
    pub proxy_jump: Option<String>,
    /// Cambia el método de autenticación. Si se indica, la contraseña o
    /// passphrase necesarias llegan en los parámetros `password`/`passphrase`
    /// y se ignoran las fuentes del perfil (keyring/KeePass/maestra).
    pub auth_type: Option<AuthType>,
    /// Ruta de la clave privada cuando `auth_type == Some(PublicKey)`.
    pub key_path: Option<String>,
}

/// Aplica los overrides de conexión sobre la copia local del perfil.
fn apply_connect_overrides(profile: &mut ConnectionProfile, ov: &ConnectOverrides) {
    if let Some(u) = ov.username.as_deref() {
        if !u.trim().is_empty() {
            profile.username = u.trim().to_string();
        }
    }
    if let Some(p) = ov.port {
        if p > 0 {
            profile.port = p;
        }
    }
    if let Some(j) = ov.proxy_jump.as_deref() {
        let j = j.trim();
        profile.proxy_jump = if j.is_empty() { None } else { Some(j.to_string()) };
    }
    if let Some(at) = ov.auth_type.clone() {
        profile.auth_type = at;
        profile.key_path = ov.key_path.clone();
        // Con autenticación puntual no aplican las fuentes del perfil: la
        // contraseña (si hace falta) llega en el parámetro `password`.
        profile.keepass_entry_uuid = None;
        profile.master_credential_id = None;
        profile.password_source = PasswordSource::Own;
    }
}

/// Inicia una sesión SSH a partir de un perfil guardado.
/// Devuelve el session_id que el frontend usará para identificar la sesión.
///
/// Los bytes recibidos del servidor se entregan por `on_data`
/// (`tauri::ipc::Channel`, binario). El resto del protocolo va por eventos:
///   - `ssh-connected-{id}` : conexión y auth exitosas
///   - `ssh-log-{id}`       : etapa de diagnóstico de conexión
///   - `ssh-error-{id}`     : String con el error
///   - `ssh-closed-{id}`    : sesión finalizada (limpiamente o por error)
#[tauri::command]
pub fn ssh_connect(
    ssh_state: State<'_, SshManager>,
    profile_state: State<'_, ProfileManager>,
    cred_state: State<'_, CredentialStore>,
    data_dir: State<'_, DataDir>,
    app_handle: AppHandle,
    // Canal binario para el caudal de datos del terminal (`ssh-data` ya no se
    // emite como evento JSON). El frontend crea el `Channel` antes del invoke.
    on_data: Channel<Response>,
    profile_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    session_id: Option<String>,
    ask_answers: Option<std::collections::HashMap<String, String>>,
    // Identidad adicional a usar (`ProfileCredential.id`). `None` = principal.
    credential_id: Option<String>,
    // Cuando es Some(false) desactiva session_log aunque el perfil lo tenga activo.
    // Usado por sesiones privadas/efímeras desde el frontend.
    session_log_override: Option<bool>,
    // Overrides puntuales (usuario/puerto/bastion/auth) de «Duplicar sesión
    // con cambios». No se persisten en el perfil.
    overrides: Option<ConnectOverrides>,
) -> Result<String, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let mut profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;
    if let Some(cid) = credential_id.as_deref() {
        apply_credential(&mut profile, cid)?;
    }
    if let Some(ov) = overrides.as_ref() {
        apply_connect_overrides(&mut profile, ov);
    }
    credentials::substitute_connection_fields(&mut profile, &cred_state);

    // Aplicar override de session_log si se solicita (sesión privada → false).
    if let Some(log_val) = session_log_override {
        profile.session_log = log_val;
    }

    let resolved_password = resolve_profile_password(&profile, &cred_state, password, ask_answers)?;

    let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    ssh_state
        .connect(
            session_id.clone(),
            profile,
            resolved_password,
            passphrase,
            app_handle,
            on_data,
            data_dir.0.clone(),
        )
        .map_err(|e| e.to_string())?;

    Ok(session_id)
}

#[tauri::command]
pub fn ssh_test_connection(
    cred_state: State<'_, CredentialStore>,
    app_handle: AppHandle,
    mut profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    test_id: String,
    ask_answers: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    credentials::substitute_connection_fields(&mut profile, &cred_state);
    let resolved_password = resolve_profile_password(&profile, &cred_state, password, ask_answers)?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt.block_on(crate::ssh_manager::test_connection(
                test_id,
                profile,
                resolved_password,
                passphrase,
                app_handle,
            )),
            Err(e) => Err(format!("No se pudo crear runtime tokio: {e}")),
        };
        let _ = tx.send(result);
    });
    rx.recv()
        .map_err(|e| format!("La prueba de conexión no respondió: {e}"))?
}

/// Resuelve la contraseña efectiva de un perfil según su `password_source`,
/// con precedencia conforme al contrato del motor de credenciales:
///
/// - `Keepass` (o, por compatibilidad, `keepass_entry_uuid` no vacío aunque el
///   `password_source` no se haya migrado todavía): resuelve la propiedad
///   configurada de la entrada KeePass (requiere DB desbloqueada).
/// - `Master`: lee el valor de la credencial maestra (`master:<id>`) del
///   keyring a través del catálogo. Error claro si no existe o no tiene valor.
/// - `Own` (por defecto): pasa la contraseña recibida del frontend por el motor
///   de sustitución, de modo que marcadores como `${var:}`, `${secret:}`,
///   `${master:}` o `${ask:}` (Fase 5) se resuelvan antes de autenticar.
///
/// `ask_answers` contiene las respuestas a los `${ask:}` que el frontend pidió
/// al usuario (clave = etiqueta); es `None`/vacío para perfiles sin `${ask:}`.
fn resolve_profile_password(
    profile: &ConnectionProfile,
    store: &CredentialStore,
    password: Option<String>,
    ask_answers: Option<std::collections::HashMap<String, String>>,
) -> Result<Option<String>, String> {
    use crate::profiles::PasswordSource;

    // Compatibilidad: un perfil con `keepass_entry_uuid` no vacío se trata como
    // KeePass aunque su `password_source` aún no se haya migrado a `Keepass`.
    let has_keepass = profile
        .keepass_entry_uuid
        .as_deref()
        .is_some_and(|s| !s.is_empty());

    match profile.password_source {
        PasswordSource::Keepass => resolve_password_from_keepass(profile),
        PasswordSource::Master => {
            let id = profile
                .master_credential_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "El perfil no referencia ninguna credencial maestra".to_string())?;
            let catalog = store.load_all().map_err(|e| e.to_string())?;
            let Some(cred) = catalog
                .iter()
                .find(|c| c.id == id && c.kind == CredentialKind::Master)
            else {
                return Err("Credencial maestra no encontrada".to_string());
            };
            match credentials::resolve_master(&catalog, &cred.name) {
                Some(value) => Ok(Some(value)),
                None => Err("Credencial maestra no encontrada".to_string()),
            }
        }
        PasswordSource::Own if has_keepass => resolve_password_from_keepass(profile),
        // La contraseña propia pasa por el motor de sustitución: así soporta
        // `${var:}`/`${secret:}`/`${master:}`/`${ask:}`. Si no hay marcadores el
        // texto se devuelve tal cual (el motor es de una sola pasada).
        PasswordSource::Own => match password {
            Some(pw) if pw.contains("${") => {
                let catalog = store.load_all().map_err(|e| e.to_string())?;
                let ctx = crate::subst::SubstContext::from_profile(profile);
                let resolver = credentials::CredentialResolver::with_ask_answers(
                    ctx,
                    catalog,
                    ask_answers.unwrap_or_default(),
                );
                Ok(Some(crate::subst::substitute(&pw, &resolver)))
            }
            other => Ok(other),
        },
    }
}

/// Resuelve la contraseña desde la entrada KeePass referenciada por el perfil.
/// Requiere `keepass_entry_uuid` no vacío y la DB desbloqueada.
fn resolve_password_from_keepass(
    profile: &ConnectionProfile,
) -> Result<Option<String>, String> {
    let entry_uuid = profile
        .keepass_entry_uuid
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "El perfil no referencia ninguna entrada KeePass".to_string())?;
    if !keepass_manager::status().unlocked {
        return Err("KeePass está bloqueada; desbloquéala en Preferencias".to_string());
    }
    let property = profile
        .keepass_property
        .as_deref()
        .and_then(keepass_manager::EntryProperty::from_str)
        .unwrap_or(keepass_manager::EntryProperty::Password);
    match keepass_manager::get_property(entry_uuid, property).map_err(|e| e.to_string())? {
        Some(pw) => Ok(Some(pw)),
        None => Err(format!("Entrada KeePass {} no encontrada", entry_uuid)),
    }
}

/// Aplica una identidad adicional (`ProfileCredential`) sobre una copia del
/// perfil: sobrescribe usuario y parámetros de autenticación para que el resto
/// del flujo (sustitución, resolución de contraseña, conexión) use esa
/// identidad en vez de la principal. Si el id no existe, devuelve error.
fn apply_credential(profile: &mut ConnectionProfile, credential_id: &str) -> Result<(), String> {
    let cred = profile
        .extra_credentials
        .iter()
        .find(|c| c.id == credential_id)
        .cloned()
        .ok_or_else(|| format!("Identidad {credential_id} no encontrada en el perfil"))?;
    profile.username = cred.username;
    profile.auth_type = cred.auth_type;
    profile.key_path = cred.key_path;
    profile.password_source = cred.password_source;
    profile.master_credential_id = cred.master_credential_id;
    // La identidad extra no usa la entrada KeePass de la principal.
    profile.keepass_entry_uuid = None;
    Ok(())
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
    cred_state: State<'_, CredentialStore>,
    profile_id: String,
    // Identidad adicional cuya contraseña se quiere pegar. `None` = principal.
    credential_id: Option<String>,
) -> Result<Option<String>, String> {
    use crate::profiles::PasswordSource;

    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let mut profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;

    // Clave de keyring de la contraseña propia: la principal usa
    // `password:<id>`; cada identidad extra usa `password:<id>:<cred_id>`.
    let keyring_key = match credential_id.as_deref() {
        Some(cid) => {
            apply_credential(&mut profile, cid)?;
            format!("password:{}:{}", profile_id, cid)
        }
        None => format!("password:{}", profile_id),
    };

    let has_keepass = profile
        .keepass_entry_uuid
        .as_deref()
        .is_some_and(|s| !s.is_empty());

    // 1) KeePass o credencial maestra → reutilizamos la resolución unificada.
    if matches!(profile.password_source, PasswordSource::Keepass | PasswordSource::Master)
        || has_keepass
    {
        return resolve_profile_password(&profile, &cred_state, None, None);
    }

    // 2) keyring (si el usuario guardó la contraseña al crear el perfil)
    let entry = keyring::Entry::new("rustty", &keyring_key)
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

#[tauri::command]
pub async fn ssh_start_tunnel(
    ssh_state: State<'_, SshManager>,
    session_id: String,
    config: SshTunnelConfig,
) -> Result<SshTunnelInfo, String> {
    ssh_state.start_tunnel(&session_id, config).await
}

#[tauri::command]
pub async fn ssh_stop_tunnel(
    ssh_state: State<'_, SshManager>,
    session_id: String,
    tunnel_id: String,
) -> Result<(), String> {
    ssh_state.stop_tunnel(&session_id, tunnel_id).await
}

#[tauri::command]
pub async fn ssh_list_tunnels(
    ssh_state: State<'_, SshManager>,
    session_id: String,
) -> Result<Vec<SshTunnelInfo>, String> {
    ssh_state.list_tunnels(&session_id).await
}

// ─── Comandos RDP ────────────────────────────────────────────────────────────

/// Lanza el cliente RDP nativo y devuelve el session_id.
/// El backend emitirá `rdp-closed-{id}` cuando el proceso externo termine.
#[tauri::command]
pub fn rdp_connect(
    rdp_state: State<'_, RdpManager>,
    profile_state: State<'_, ProfileManager>,
    cred_state: State<'_, CredentialStore>,
    app_handle: AppHandle,
    profile_id: String,
    password: Option<String>,
    ask_answers: Option<std::collections::HashMap<String, String>>,
    credential_id: Option<String>,
) -> Result<String, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let mut profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;
    if let Some(cid) = credential_id.as_deref() {
        apply_credential(&mut profile, cid)?;
    }
    credentials::substitute_connection_fields(&mut profile, &cred_state);

    let password = resolve_profile_password(&profile, &cred_state, password, ask_answers)?;

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

// ─── Comandos VNC ────────────────────────────────────────────────────────────

/// Lanza el visor VNC externo del sistema y devuelve el session_id.
/// El backend emitirá `vnc-closed-{id}` cuando el proceso externo termine.
#[tauri::command]
pub fn vnc_connect(
    vnc_state: State<'_, VncManager>,
    profile_state: State<'_, ProfileManager>,
    cred_state: State<'_, CredentialStore>,
    app_handle: AppHandle,
    profile_id: String,
    credential_id: Option<String>,
) -> Result<String, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let mut profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;
    if let Some(cid) = credential_id.as_deref() {
        apply_credential(&mut profile, cid)?;
    }
    credentials::substitute_connection_fields(&mut profile, &cred_state);

    let session_id = uuid::Uuid::new_v4().to_string();
    vnc_state.launch(
        session_id.clone(),
        profile_id,
        &profile.host,
        profile.port,
        app_handle,
    )?;
    Ok(session_id)
}

/// Termina el proceso VNC asociado a la sesión
#[tauri::command]
pub fn vnc_disconnect(vnc_state: State<'_, VncManager>, session_id: String) -> Result<(), String> {
    vnc_state.disconnect(&session_id)
}

// ─── Comandos Telnet ─────────────────────────────────────────────────────────

/// Lanza el cliente Telnet externo (en un emulador de terminal) y devuelve el
/// session_id. El backend emitirá `telnet-closed-{id}` al terminar el proceso.
#[tauri::command]
pub fn telnet_connect(
    telnet_state: State<'_, TelnetManager>,
    profile_state: State<'_, ProfileManager>,
    cred_state: State<'_, CredentialStore>,
    app_handle: AppHandle,
    profile_id: String,
    credential_id: Option<String>,
) -> Result<String, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let mut profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;
    if let Some(cid) = credential_id.as_deref() {
        apply_credential(&mut profile, cid)?;
    }
    credentials::substitute_connection_fields(&mut profile, &cred_state);

    let session_id = uuid::Uuid::new_v4().to_string();
    telnet_state.launch(
        session_id.clone(),
        profile_id,
        &profile.host,
        profile.port,
        app_handle,
    )?;
    Ok(session_id)
}

/// Termina el proceso Telnet asociado a la sesión
#[tauri::command]
pub fn telnet_disconnect(
    telnet_state: State<'_, TelnetManager>,
    session_id: String,
) -> Result<(), String> {
    telnet_state.disconnect(&session_id)
}

// ─── Comandos de shell local ──────────────────────────────────────────────────

/// Abre una sesión de shell local con PTY.
/// Devuelve el session_id. Los bytes del shell llegan por `on_data` (Channel
/// binario) y el fin del proceso por el evento `shell-closed-{id}`.
#[tauri::command]
pub fn local_shell_open(
    shell_state: State<'_, LocalShellManager>,
    app_handle: AppHandle,
    on_data: Channel<Response>,
    session_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    shell_state.open(session_id, app_handle, on_data, cwd, cols, rows)
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

/// Comprueba si el shell local de la sesión tiene procesos hijos activos
/// (p. ej. `vim`, `top`, una compilación en curso).
/// Devuelve `true` si hay al menos un hijo vivo; `false` si la consola está
/// idle o si no se puede determinar (Windows o `pgrep` no disponible).
#[tauri::command]
pub fn local_shell_has_job(
    shell_state: State<'_, LocalShellManager>,
    session_id: String,
) -> bool {
    shell_state.has_running_job(&session_id)
}

// ─── Comandos SFTP ────────────────────────────────────────────────────────────

/// Abre una sesión SFTP paralela a la SSH para transferencia de ficheros.
/// Devuelve el session_id (independiente del de la sesión SSH interactiva).
#[tauri::command]
pub async fn sftp_connect(
    sftp_state: State<'_, SftpManager>,
    profile_state: State<'_, ProfileManager>,
    cred_state: State<'_, CredentialStore>,
    app_handle: AppHandle,
    profile_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    elevated: Option<bool>,
    session_id: Option<String>,
    ask_answers: Option<std::collections::HashMap<String, String>>,
    max_concurrent: Option<usize>,
    credential_id: Option<String>,
) -> Result<String, String> {
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let mut profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;
    if let Some(cid) = credential_id.as_deref() {
        apply_credential(&mut profile, cid)?;
    }
    credentials::substitute_connection_fields(&mut profile, &cred_state);

    let password = resolve_profile_password(&profile, &cred_state, password, ask_answers)?;

    let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // Concurrencia de transferencia por sesión. Default 4 (conservador para
    // servidores con límite de handles como Hetzner Storage Box).
    let max_parallelism = max_concurrent.unwrap_or(4).clamp(1, 64);

    sftp_state
        .connect(
            session_id.clone(),
            profile,
            password,
            passphrase,
            elevated.unwrap_or(false),
            max_parallelism,
            app_handle,
        )
        .await?;
    Ok(session_id)
}

#[tauri::command]
pub async fn sftp_disconnect(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
) -> Result<(), String> {
    sftp_state.disconnect(&session_id)
}

#[tauri::command]
pub async fn sftp_list_dir(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    sftp_state.list_dir(&session_id, path).await
}

#[tauri::command]
pub async fn sftp_home_dir(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
) -> Result<String, String> {
    sftp_state.home_dir(&session_id).await
}

#[tauri::command]
pub async fn sftp_stat(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<FileEntry, String> {
    sftp_state.stat(&session_id, path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    sftp_state.mkdir(&session_id, path).await
}

#[tauri::command]
pub async fn sftp_create_file(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    sftp_state.create_file(&session_id, path).await
}

#[tauri::command]
pub async fn sftp_remove(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    sftp_state.remove(&session_id, path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    sftp_state.rename(&session_id, from, to).await
}

#[tauri::command]
pub async fn sftp_chmod(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    validate_octal_mode(mode)?;
    sftp_state.chmod(&session_id, path, mode).await
}

/// Descarga un fichero remoto a `local_path`.
/// Emite `sftp-progress-{transfer_id}` con { transferred, total, done }.
#[tauri::command]
pub async fn sftp_download(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    verify_size: Option<bool>,
) -> Result<(), String> {
    sftp_state
        .download(
            &session_id,
            remote_path,
            PathBuf::from(local_path),
            transfer_id,
            verify_size.unwrap_or(false),
        )
        .await
}

/// Sube un fichero local a `remote_path`.
#[tauri::command]
pub async fn sftp_upload(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    verify_size: Option<bool>,
) -> Result<(), String> {
    sftp_state
        .upload(
            &session_id,
            PathBuf::from(local_path),
            remote_path,
            transfer_id,
            verify_size.unwrap_or(false),
        )
        .await
}

/// Descarga un directorio remoto recursivamente a `local_path`.
#[tauri::command]
pub async fn sftp_download_dir(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    conflict_policy: Option<String>,
    verify_size: Option<bool>,
) -> Result<(), String> {
    sftp_state
        .download_dir(
            &session_id,
            remote_path,
            PathBuf::from(local_path),
            transfer_id,
            TransferConflictPolicy::from_str(conflict_policy.as_deref().unwrap_or("overwrite")),
            verify_size.unwrap_or(false),
        )
        .await
}

/// Sube un directorio local recursivamente a `remote_path`.
#[tauri::command]
pub async fn sftp_upload_dir(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    conflict_policy: Option<String>,
    verify_size: Option<bool>,
) -> Result<(), String> {
    sftp_state
        .upload_dir(
            &session_id,
            PathBuf::from(local_path),
            remote_path,
            transfer_id,
            TransferConflictPolicy::from_str(conflict_policy.as_deref().unwrap_or("overwrite")),
            verify_size.unwrap_or(false),
        )
        .await
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    sftp_state.cancel_transfer(&session_id, transfer_id)
}

#[tauri::command]
pub async fn sftp_pause_transfer(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    sftp_state.pause_transfer(&session_id, transfer_id)
}

#[tauri::command]
pub async fn sftp_resume_transfer(
    sftp_state: State<'_, SftpManager>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    sftp_state.resume_transfer(&session_id, transfer_id)
}

// ─── Comandos de FS local (panel SFTP partido) ────────────────────────────────

#[derive(serde::Serialize)]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

/// Lista un directorio local con el mismo formato (forma) que `sftp_list_dir`.
///
/// `read_dir` + `stat` por entrada puede tardar cientos de milisegundos en
/// directorios grandes (`node_modules`, `/usr/lib`, …). En Tauri 2 los
/// comandos síncronos corren en el hilo principal, así que delegamos en
/// `spawn_blocking` para no bloquear la UI mientras se hace la I/O.
#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<LocalFileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || local_list_dir_sync(&path))
        .await
        .map_err(|e| format!("local_list_dir: {e}"))?
}

fn local_list_dir_sync(path: &str) -> Result<Vec<LocalFileEntry>, String> {
    let read = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let p = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        out.push(LocalFileEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: if meta.is_file() { meta.len() } else { 0 },
            modified,
            permissions: local_mode(&meta),
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// Devuelve el directorio home del usuario.
#[tauri::command]
pub fn local_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .ok_or_else(|| "No se pudo resolver el home del usuario".to_string())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Mide la latencia (en milisegundos) hasta `host:port` abriendo una
/// conexión TCP nueva. Útil para la barra de estado de la sesión SSH activa.
/// Timeout: 3 segundos.
#[tauri::command]
pub async fn tcp_ping(host: String, port: u16) -> Result<u64, String> {
    let start = std::time::Instant::now();
    let addr = format!("{host}:{port}");
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| e.to_string())?;
    Ok(start.elapsed().as_millis() as u64)
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Crea un archivo vacío. Falla si ya existe para no sobrescribir contenido.
#[tauri::command]
pub fn local_create_file(path: String) -> Result<(), String> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Borra un fichero o directorio local. Si es directorio, borra recursivamente.
#[tauri::command]
pub fn local_remove(path: String) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_chmod(path: String, mode: u32) -> Result<(), String> {
    validate_octal_mode(mode)?;
    set_local_mode(&path, mode)
}

fn validate_octal_mode(mode: u32) -> Result<(), String> {
    if mode <= 0o7777 {
        Ok(())
    } else {
        Err("Permisos octales no válidos".to_string())
    }
}

#[cfg(unix)]
fn local_mode(meta: &std::fs::Metadata) -> Option<u32> {
    Some(meta.permissions().mode())
}

#[cfg(not(unix))]
fn local_mode(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_local_mode(path: &str, mode: u32) -> Result<(), String> {
    let perms = std::fs::Permissions::from_mode(mode);
    std::fs::set_permissions(path, perms).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_local_mode(_path: &str, _mode: u32) -> Result<(), String> {
    Err("Cambiar permisos locales solo está soportado en Unix".to_string())
}

#[tauri::command]
pub fn local_path_join(base: String, name: String) -> Result<String, String> {
    Ok(PathBuf::from(base)
        .join(name)
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub fn local_path_parent(path: String) -> Result<Option<String>, String> {
    Ok(PathBuf::from(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned()))
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
        Ok(p) => {
            #[cfg(target_os = "linux")]
            {
                // The Linux combo backend reads legacy keyutils entries as a cache
                // and writes to Secret Service for persistence across reboots.
                let _ = entry.set_password(&p);
            }
            Ok(Some(p))
        }
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

/// Devuelve el valor de una propiedad de una entrada KeePass.
/// `property` ∈ {"password", "username", "title", "url", "notes"}.
/// El frontend lo usa para previsualizar referencias por propiedad antes de
/// guardarlas en el perfil; siempre requiere la DB desbloqueada.
#[tauri::command]
pub fn keepass_get_property(
    entry_uuid: String,
    property: String,
) -> Result<Option<String>, String> {
    let property = keepass_manager::EntryProperty::from_str(&property)
        .ok_or_else(|| format!("Propiedad KeePass desconocida: {property}"))?;
    keepass_manager::get_property(&entry_uuid, property).map_err(|e| e.to_string())
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

/// Sanea un nombre de fichero a su componente final, rechazando rutas
/// absolutas, separadores y travesías (`..`). Defensa frente a path traversal
/// cuando el frontend propone el nombre de un temporal: solo se acepta un
/// único componente «normal» de ruta.
fn sanitize_file_name(name: &str) -> Result<String, String> {
    use std::path::Component;
    let mut comps = std::path::Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(s)), None) => {
            let s = s.to_string_lossy();
            if s.is_empty() || s == "." || s == ".." {
                Err("nombre de fichero no válido".into())
            } else {
                Ok(s.into_owned())
            }
        }
        _ => Err("nombre de fichero no válido".into()),
    }
}

/// Escritura atómica de exports (JSON de backup, temporales de subida): vuelca a
/// un temporal hermano y renombra sobre el destino, sin restringir permisos.
/// Delega en [`crate::atomic_file::write`]; ver allí el detalle de garantías.
fn write_atomic(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    crate::atomic_file::write(path, data, false)
}

/// Escribe un fichero binario en disco.
/// Se usa para subidas vía input HTML: el frontend pasa los bytes leídos
/// del File API y esta función los materializa en un path temporal que
/// luego `sftp_upload` transfiere al servidor. El nombre se sanea para que
/// no pueda salirse de la carpeta de temporales (path traversal).
#[tauri::command]
pub fn write_temp_file(
    app_handle: AppHandle,
    name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let safe_name = sanitize_file_name(&name)?;
    let dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("sftp-uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&safe_name);
    write_atomic(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Elimina un fichero del sistema (se usa tras subidas para limpiar temporales).
/// `std::fs::remove_file` desenlaza el propio path: sobre un symlink borra el
/// enlace, nunca su destino.
#[tauri::command]
pub fn remove_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Escribe texto (ej. JSON de export) a un path absoluto, de forma atómica
/// (temporal + rename) para no dejar exports a medias ni escribir a través de
/// un symlink preparado en el destino.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    write_atomic(std::path::Path::new(&path), contents.as_bytes()).map_err(|e| e.to_string())
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

/// Salida de un comando local ejecutado por el catálogo de "Comandos locales".
#[derive(serde::Serialize)]
pub struct LocalCommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Ejecuta `command` con el shell del SO (`sh -c` en Unix, `cmd /C` en Windows)
/// capturando su salida. No es interactivo. Lo invoca el catálogo de "Comandos
/// locales" de la UI, que pide confirmación al usuario antes de lanzar acciones
/// potencialmente destructivas; aquí no hay allowlist porque el catálogo lo
/// define el propio usuario en su equipo.
fn run_shell_capture(command: &str) -> std::io::Result<std::process::Output> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", command])
            .output()
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .output()
    }
}

/// Comando IPC que ejecuta un comando local y devuelve código + stdout/stderr.
#[tauri::command]
pub async fn run_local_command(command: String) -> Result<LocalCommandOutput, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("comando vacío".into());
    }
    let output = tauri::async_runtime::spawn_blocking(move || run_shell_capture(&command))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(LocalCommandOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Lista las familias de fuentes instaladas en el sistema.
/// Se usa en Preferencias → Terminal para elegir la familia del xterm.js.
/// Devuelve primero las monoespaciadas y después el resto, ambas en orden
/// alfabético, para mantener visibles las opciones recomendadas para terminal.
#[tauri::command]
pub fn list_monospace_fonts() -> Result<Vec<String>, String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut monospace: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut proportional: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for face in db.faces() {
        if let Some((family, _)) = face.families.first() {
            if face.monospaced {
                monospace.insert(family.clone());
            } else {
                proportional.insert(family.clone());
            }
        }
    }

    let mut families: Vec<String> = monospace.iter().cloned().collect();
    families.extend(
        proportional
            .into_iter()
            .filter(|family| !monospace.contains(family)),
    );
    Ok(families)
}

// ═══════════════════════════════════════════════════════════════════
//  Gestor de known_hosts
// ═══════════════════════════════════════════════════════════════════

/// Una entrada del fichero `~/.ssh/known_hosts` lista para mostrar en la UI.
#[derive(serde::Serialize)]
pub struct KnownHostEntry {
    /// Número de línea (1-indexed) dentro del fichero.
    pub line: usize,
    /// Host (o `(hashed)` si la entrada está ofuscada con `|1|...`).
    pub host: String,
    /// Puerto; 22 si la entrada no lleva el formato `[host]:puerto`.
    pub port: u16,
    /// Algoritmo de la clave (p. ej. `ssh-ed25519`).
    pub algorithm: String,
    /// Huella SHA256 en formato `SHA256:...`.
    pub fingerprint: String,
}

/// Devuelve la ruta de `~/.ssh/known_hosts` (la que usa russh por defecto).
fn known_hosts_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .ok_or_else(|| "No se pudo localizar el directorio home".to_string())
}

/// Separa el campo de hosts de una entrada known_hosts en `(host, puerto)`.
/// Soporta el formato `[host]:puerto` y toma solo el primer host si hay varios
/// separados por comas. Las entradas hashed (`|1|...`) se marcan como `(hashed)`.
fn parse_known_host_field(field: &str) -> (String, u16) {
    if field.starts_with("|1|") || field.starts_with("|") {
        return ("(hashed)".to_string(), 22);
    }
    let first = field.split(',').next().unwrap_or(field);
    if let Some(rest) = first.strip_prefix('[') {
        if let Some((host, port)) = rest.split_once("]:") {
            let port = port.parse::<u16>().unwrap_or(22);
            return (host.to_string(), port);
        }
    }
    (first.to_string(), 22)
}

/// Lista las entradas de `~/.ssh/known_hosts` con host, puerto, algoritmo y
/// huella SHA256. Salta líneas vacías y comentarios. Si el fichero no existe,
/// devuelve una lista vacía (no es un error).
#[tauri::command]
pub fn list_known_hosts() -> Result<Vec<KnownHostEntry>, String> {
    use russh::keys::ssh_key::PublicKey;

    let path = known_hosts_path()?;
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.to_string()),
    };

    let mut entries = Vec::new();
    for (idx, raw) in contents.lines().enumerate() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Formato: hosts algoritmo clave_base64 [comentario]
        let mut parts = trimmed.split_whitespace();
        let Some(hosts_field) = parts.next() else {
            continue;
        };
        // Las marcas `@cert-authority` / `@revoked` van delante del campo host.
        let (hosts_field, algorithm, key_b64) = if hosts_field.starts_with('@') {
            let Some(real_hosts) = parts.next() else {
                continue;
            };
            let (Some(alg), Some(key)) = (parts.next(), parts.next()) else {
                continue;
            };
            (real_hosts, alg, key)
        } else {
            let (Some(alg), Some(key)) = (parts.next(), parts.next()) else {
                continue;
            };
            (hosts_field, alg, key)
        };

        let (host, port) = parse_known_host_field(hosts_field);
        // Reconstruimos la línea openssh (`algoritmo clave`) para parsear la
        // clave pública y calcular la huella con el helper común.
        let openssh = format!("{algorithm} {key_b64}");
        let fingerprint = match PublicKey::from_openssh(&openssh) {
            Ok(key) => fingerprint_sha256(&key),
            Err(_) => "(clave no reconocida)".to_string(),
        };

        entries.push(KnownHostEntry {
            line: idx + 1,
            host,
            port,
            algorithm: algorithm.to_string(),
            fingerprint,
        });
    }

    Ok(entries)
}

/// Elimina una línea concreta (1-indexed, coherente con `list_known_hosts`) de
/// `~/.ssh/known_hosts` y reescribe el fichero de forma atómica con permisos
/// 0600. La escritura atómica es crítica aquí: un corte a mitad de un
/// `fs::write` directo truncaría `known_hosts` y se perderían todos los pins
/// TOFU, reabriendo una ventana de MITM en las siguientes conexiones.
#[tauri::command]
pub fn remove_known_host_line(line: usize) -> Result<(), String> {
    let path = known_hosts_path()?;
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    if line == 0 {
        return Err("Número de línea no válido".to_string());
    }

    // Conservamos el carácter de fin de línea final si existía.
    let had_trailing_newline = contents.ends_with('\n');
    let kept: Vec<&str> = contents
        .lines()
        .enumerate()
        .filter(|(idx, _)| idx + 1 != line)
        .map(|(_, l)| l)
        .collect();

    let mut output = kept.join("\n");
    if !output.is_empty() && had_trailing_newline {
        output.push('\n');
    }

    // `private = true` fija 0600 en Unix desde la creación del temporal, así que
    // ya no hace falta el `set_permissions` posterior.
    crate::atomic_file::write(&path, output.as_bytes(), true).map_err(|e| e.to_string())?;

    Ok(())
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
pub fn sync_get_backend_folder(state: State<SyncManager>) -> Result<Option<String>, String> {
    let config = state.load_config();
    let folder = resolve_sync_folder(&config).map_err(|e| e.to_string())?;
    Ok(folder.map(|path| path.to_string_lossy().into_owned()))
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
    let mut config = state.load_config();
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
    merged.merge(remote.clone());

    // 3. Push solo si el merge aporta un cambio de CONTENIDO al remoto.
    // Comparamos por contenido (ignorando `updated_at`): un mero refresco de
    // timestamps —mismo dato— no debe subir ni archivar una versión, o se
    // acumularían snapshots "restaurables" idénticos en cada arranque. El
    // cifrado age además produce bytes distintos en cada escritura, así que
    // comparar el blob cifrado crearía falsos positivos.
    if !merged.content_eq(&remote) {
        let history_keep = config.history_keep.max(1);
        backend
            .archive_existing(history_keep)
            .await
            .map_err(|e| e.to_string())?;
        let bytes = pack_state(&passphrase, &merged).map_err(|e| e.to_string())?;
        backend.write(&bytes).await.map_err(|e| e.to_string())?;
    }

    // 4. Cache local (snapshot del último merge). No persistimos secretos en
    // sync_state.json: solo deben vivir en keyring local o en el blob E2E.
    let mut local_cache = merged.clone();
    local_cache
        .items
        .retain(|key, _| !key.starts_with("secret:"));
    state
        .save_local_state(&local_cache)
        .map_err(|e| e.to_string())?;
    config.last_sync_at = Some(chrono::Utc::now());
    state.save_config(&config).map_err(|e| e.to_string())?;

    Ok(merged)
}

/// Exporta el estado a un fichero cifrado (`.rustty-sync.bin`) con la
/// passphrase indicada. No requiere backend ni configuración previa: sirve
/// de backup portable, transferible por USB/email.
#[tauri::command]
pub fn sync_export_file(path: String, passphrase: String, state: SyncState) -> Result<(), String> {
    let bytes = pack_state(&passphrase, &state).map_err(|e| e.to_string())?;
    // Escritura atómica: un backup interrumpido a medias quedaría corrupto y no
    // descifraría al importarlo.
    write_atomic(std::path::Path::new(&path), &bytes).map_err(|e| e.to_string())
}

/// Importa un fichero cifrado y devuelve el estado descifrado. El frontend
/// luego decide si reemplaza, fusiona o solo previsualiza.
#[tauri::command]
pub fn sync_import_file(path: String, passphrase: String) -> Result<SyncState, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    unpack_state(&passphrase, &bytes).map_err(|e| e.to_string())
}

/// Lista los snapshots históricos disponibles en el backend remoto.
/// Devuelve `Vec<SnapshotEntry>` (id, label, modified). Si el backend no
/// guarda histórico (None) o aún no hay copias, devuelve la lista vacía.
#[tauri::command]
pub async fn sync_list_snapshots(
    state: State<'_, SyncManager>,
    webdav_password: Option<String>,
) -> Result<Vec<SnapshotEntry>, String> {
    let config = state.load_config();
    if matches!(config.backend, SyncBackendKind::None) {
        return Ok(Vec::new());
    }
    let backend = state
        .backend(&config, webdav_password.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    backend.list_snapshots().await.map_err(|e| e.to_string())
}

/// Descarga un snapshot, lo descifra y devuelve el `SyncState`.
/// El frontend lo aplica con la misma rutina que importFromFile.
#[tauri::command]
pub async fn sync_read_snapshot(
    state: State<'_, SyncManager>,
    snapshot_id: String,
    passphrase: String,
    webdav_password: Option<String>,
) -> Result<SyncState, String> {
    let config = state.load_config();
    if matches!(config.backend, SyncBackendKind::None) {
        return Err("Sincronización no habilitada".into());
    }
    let backend = state
        .backend(&config, webdav_password.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    let bytes = backend
        .read_snapshot(&snapshot_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Snapshot no encontrado".to_string())?;
    unpack_state(&passphrase, &bytes).map_err(|e| e.to_string())
}

// ─── Retención de logs de sesión ──────────────────────────────────────────────

/// Resumen del contenido de la carpeta de logs de sesión.
#[derive(serde::Serialize)]
pub struct SessionLogsInfo {
    pub count: usize,
    pub total_bytes: u64,
}

/// Resultado de una limpieza (poda) de la carpeta de logs de sesión.
#[derive(serde::Serialize)]
pub struct SessionLogsPruneResult {
    pub removed: usize,
    pub freed_bytes: u64,
}

/// Ruta efectiva por defecto de la carpeta de logs de sesión
/// (`<data_dir>/session_logs`). Coincide con el destino que usa
/// `resolve_log_path` cuando el perfil no fija una carpeta propia.
fn session_logs_path(data_dir: &State<crate::DataDir>) -> PathBuf {
    data_dir.0.join("session_logs")
}

/// Devuelve la ruta efectiva por defecto de los logs de sesión.
#[tauri::command]
pub fn session_logs_dir(data_dir: State<crate::DataDir>) -> Result<String, String> {
    Ok(session_logs_path(&data_dir).to_string_lossy().into_owned())
}

/// Recorre la carpeta de logs y devuelve cuántos ficheros hay y su tamaño total.
/// Si la carpeta no existe devuelve ceros. Solo cuenta ficheros regulares.
#[tauri::command]
pub fn session_logs_list(data_dir: State<crate::DataDir>) -> Result<SessionLogsInfo, String> {
    let dir = session_logs_path(&data_dir);
    let mut count = 0usize;
    let mut total_bytes = 0u64;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(ref err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionLogsInfo { count, total_bytes });
        }
        Err(err) => return Err(err.to_string()),
    };
    for entry in entries.flatten() {
        // `metadata()` no sigue symlinks: descarta directorios y enlaces.
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                count += 1;
                total_bytes += meta.len();
            }
        }
    }
    Ok(SessionLogsInfo { count, total_bytes })
}

/// Borra logs de sesión antiguos. Primero elimina los más viejos que
/// `max_age_days` (por fecha de modificación) y, si tras eso el total
/// sigue por encima de `max_total_mb`, sigue borrando del más antiguo al
/// más reciente hasta bajar del límite. Si ambos son `None` no borra nada.
///
/// Conservador: solo toca ficheros regulares dentro de la carpeta (no
/// subdirectorios ni symlinks, que `metadata()` descarta por no ser file).
#[tauri::command]
pub fn session_logs_prune(
    data_dir: State<crate::DataDir>,
    max_age_days: Option<u32>,
    max_total_mb: Option<u64>,
) -> Result<SessionLogsPruneResult, String> {
    let mut removed = 0usize;
    let mut freed_bytes = 0u64;

    if max_age_days.is_none() && max_total_mb.is_none() {
        return Ok(SessionLogsPruneResult { removed, freed_bytes });
    }

    let dir = session_logs_path(&data_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(ref err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionLogsPruneResult { removed, freed_bytes });
        }
        Err(err) => return Err(err.to_string()),
    };

    // Recopila ficheros regulares con tamaño y mtime.
    struct LogFile {
        path: PathBuf,
        size: u64,
        modified: std::time::SystemTime,
    }
    let mut files: Vec<LogFile> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        files.push(LogFile {
            path: entry.path(),
            size: meta.len(),
            modified,
        });
    }

    // Más antiguos primero.
    files.sort_by(|a, b| a.modified.cmp(&b.modified));

    // 1) Poda por edad.
    if let Some(days) = max_age_days {
        let cutoff = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(days as u64 * 86_400));
        if let Some(cutoff) = cutoff {
            files.retain(|f| {
                if f.modified < cutoff {
                    if std::fs::remove_file(&f.path).is_ok() {
                        removed += 1;
                        freed_bytes += f.size;
                    }
                    false
                } else {
                    true
                }
            });
        }
    }

    // 2) Poda por tamaño total (sobre los que quedan, del más antiguo al más nuevo).
    if let Some(max_mb) = max_total_mb {
        let max_bytes = max_mb.saturating_mul(1_048_576);
        let mut total: u64 = files.iter().map(|f| f.size).sum();
        for f in &files {
            if total <= max_bytes {
                break;
            }
            if std::fs::remove_file(&f.path).is_ok() {
                removed += 1;
                freed_bytes += f.size;
                total = total.saturating_sub(f.size);
            }
        }
    }

    Ok(SessionLogsPruneResult { removed, freed_bytes })
}

// ─── Snapshots de pantalla por sesión (restaurar sesión anterior) ────────────
//
// Guardan lo último que se vio en el terminal de una conexión (serializado por
// el frontend con sus secuencias ANSI) para poder repintarlo como scrollback al
// reconectar. Es restauración *visual*, no reanudación del proceso remoto.
// Un fichero por perfil en `<data_dir>/session_snapshots/<profile_id>.snapshot`
// con permisos 0o600. Nunca se sincroniza ni se captura en sesiones privadas.

fn session_snapshots_dir(data_dir: &State<crate::DataDir>) -> PathBuf {
    data_dir.0.join("session_snapshots")
}

/// Solo caracteres seguros para nombre de fichero (evita path traversal).
fn valid_snapshot_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Escribe el snapshot de forma atómica y privada (0600 en Unix): el contenido
/// del terminal es sensible y un corte a mitad no debe dejar el fichero truncado.
fn write_snapshot_file(path: &PathBuf, data: &[u8]) -> std::io::Result<()> {
    crate::atomic_file::write(path, data, true)
}

/// Guarda (o reemplaza) el snapshot de pantalla del perfil.
#[tauri::command]
pub fn session_snapshot_set(
    data_dir: State<crate::DataDir>,
    profile_id: String,
    content: String,
) -> Result<(), String> {
    if !valid_snapshot_id(&profile_id) {
        return Err("Identificador de perfil no válido".to_string());
    }
    let dir = session_snapshots_dir(&data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{profile_id}.snapshot"));
    write_snapshot_file(&path, content.as_bytes()).map_err(|e| e.to_string())
}

/// Devuelve el snapshot guardado del perfil, o `None` si no hay.
#[tauri::command]
pub fn session_snapshot_get(
    data_dir: State<crate::DataDir>,
    profile_id: String,
) -> Result<Option<String>, String> {
    if !valid_snapshot_id(&profile_id) {
        return Err("Identificador de perfil no válido".to_string());
    }
    let path = session_snapshots_dir(&data_dir).join(format!("{profile_id}.snapshot"));
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Borra el snapshot del perfil (idempotente).
#[tauri::command]
pub fn session_snapshot_delete(
    data_dir: State<crate::DataDir>,
    profile_id: String,
) -> Result<(), String> {
    if !valid_snapshot_id(&profile_id) {
        return Err("Identificador de perfil no válido".to_string());
    }
    let path = session_snapshots_dir(&data_dir).join(format!("{profile_id}.snapshot"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Lista los `profile_id` que tienen snapshot guardado (para el menú contextual).
#[tauri::command]
pub fn session_snapshot_list(data_dir: State<crate::DataDir>) -> Result<Vec<String>, String> {
    let dir = session_snapshots_dir(&data_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut ids = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if let Some(id) = name.strip_suffix(".snapshot") {
                ids.push(id.to_string());
            }
        }
    }
    Ok(ids)
}

// ─── Preguntas al ejecutar (`${ask:}`) ───────────────────────────────────────

/// Escanea los campos de texto del perfil que pasan por el motor de sustitución
/// y devuelve los `${ask:Etiqueta|op1|op2}` únicos (en orden de aparición). El
/// frontend usa esto para, antes de conectar, preguntar al usuario cada valor y
/// pasarlo de vuelta como `ask_answers`.
///
/// Campos cubiertos en esta fase: la **contraseña propia** del perfil cuando
/// `password_source == own` (la que el usuario guardó en el keyring como
/// `password:<id>`). Otros orígenes (KeePass/maestra) no llevan `${ask:}`.
#[tauri::command]
pub fn template_asks(
    profile_state: State<'_, ProfileManager>,
    profile_id: String,
) -> Result<Vec<credentials::AskSpec>, String> {
    use crate::profiles::PasswordSource;

    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Perfil {} no encontrado", profile_id))?;

    // Solo la contraseña propia pasa por el motor con posibles `${ask:}`.
    let has_keepass = profile
        .keepass_entry_uuid
        .as_deref()
        .is_some_and(|s| !s.is_empty());
    if profile.password_source != PasswordSource::Own || has_keepass {
        return Ok(vec![]);
    }

    // Leemos la contraseña guardada en el keyring (si la hay) para escanearla.
    let stored = keyring::Entry::new("rustty", &format!("password:{}", profile.id))
        .ok()
        .and_then(|e| e.get_password().ok());
    let Some(pw) = stored else {
        return Ok(vec![]);
    };

    // Deduplicamos por etiqueta conservando el orden de aparición.
    let mut seen = std::collections::HashSet::new();
    let asks = credentials::collect_asks(&pw)
        .into_iter()
        .filter(|a| seen.insert(a.label.clone()))
        .collect();
    Ok(asks)
}

// ─── Catálogo de credenciales (master / var / secret) ────────────────────────

/// Lista los metadatos del catálogo. NUNCA incluye valores secretos: para
/// `Master`/`Secret` el `value` es siempre `None` (vive en el keyring); para
/// `Var` puede traer el valor por no ser secreto.
#[tauri::command]
pub fn master_cred_list(store: State<CredentialStore>) -> Result<Vec<CredentialMeta>, String> {
    store.load_all().map_err(|e| e.to_string())
}

/// Crea (si `id` es `None`, genera UUID) o actualiza una credencial. Valida que
/// el nombre no tenga espacios y sea único (case-sensitive) dentro del mismo
/// `kind`. Para `Master`/`Secret`, escribe `value` al keyring y NO al catálogo;
/// para `Var`, guarda `value` en el catálogo. Devuelve la credencial resultante.
#[tauri::command]
pub fn master_cred_set(
    store: State<CredentialStore>,
    id: Option<String>,
    name: String,
    kind: CredentialKind,
    description: Option<String>,
    value: Option<String>,
) -> Result<CredentialMeta, String> {
    credentials::cred_set(&store, id, name, kind, description, value).map_err(|e| e.to_string())
}

/// Aplica unos metadatos sincronizados (upsert por id) en `credentials.json`
/// SIN tocar el keyring. Lo usa la sincronización para reescribir el catálogo
/// con los metadatos remotos conservando el `id`. Para `Var` conserva el valor;
/// para `Master`/`Secret` el valor queda `None` (viaja aparte como `secret:*`).
#[tauri::command]
pub fn master_cred_import(
    store: State<CredentialStore>,
    meta: CredentialMeta,
) -> Result<(), String> {
    credentials::cred_import(&store, meta).map_err(|e| e.to_string())
}

/// Renombra una credencial (solo cambia `name`; no toca el keyring, indexado por
/// id). Valida unicidad y ausencia de espacios.
#[tauri::command]
pub fn master_cred_rename(
    store: State<CredentialStore>,
    id: String,
    new_name: String,
) -> Result<CredentialMeta, String> {
    credentials::cred_rename(&store, id, new_name).map_err(|e| e.to_string())
}

/// Elimina la credencial del catálogo y su valor del keyring. Si `force` es
/// `false` y algún perfil la referencia, falla indicando cuántos la usan.
#[tauri::command]
pub fn master_cred_delete(
    store: State<CredentialStore>,
    data_dir: State<DataDir>,
    id: String,
    force: bool,
) -> Result<(), String> {
    credentials::cred_delete(&store, &data_dir.0, id, force).map_err(|e| e.to_string())
}

// ─── Autostart ────────────────────────────────────────────────────────────────

/// Activa o desactiva el arranque automático con el sistema.
///
/// Si `enable` es `true` y `minimized` es `true`, la entrada del SO incluye
/// el argumento `--minimized` para que la app arranque en el tray sin mostrar
/// la ventana. Si `enable` es `false`, elimina la entrada del SO.
///
/// Usa `auto_launch::AutoLaunchBuilder` directamente para poder construir la
/// entrada con o sin `--minimized` en tiempo de ejecución. Es el **único**
/// mecanismo de autostart: tanto el alta/baja (`autostart_apply`) como la
/// consulta de estado (`autostart_is_enabled`) comparten este builder, así que
/// el toggle del frontend nunca se desincroniza de la entrada real del SO.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn autostart_handle(minimized: bool) -> Result<auto_launch::AutoLaunch, String> {
    use auto_launch::AutoLaunchBuilder;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    let app_path = {
        // En AppImage preferimos registrar el AppImage en lugar del binario interno.
        std::env::var("APPIMAGE").unwrap_or_else(|_| exe.display().to_string())
    };
    #[cfg(not(target_os = "linux"))]
    let app_path = exe.display().to_string();

    let mut builder = AutoLaunchBuilder::new();
    builder.set_app_name("Rustty");
    builder.set_app_path(&app_path);

    #[cfg(target_os = "macos")]
    {
        // macOS: usar Launch Agent (plist en ~/Library/LaunchAgents/)
        builder.set_use_launch_agent(true);
        // Si el exe está dentro de un .app, registrar el bundle
        let path_str = exe.canonicalize()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| exe.display().to_string());
        let parts: Vec<&str> = path_str.split(".app/").collect();
        if parts.len() == 2 {
            builder.set_app_path(&format!("{}.app", parts[0]));
        }
    }

    if minimized {
        builder.set_args(&["--minimized"]);
    }

    builder.build().map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn autostart_apply(enable: bool, minimized: bool) -> Result<(), String> {
    let al = autostart_handle(enable && minimized)?;
    if enable {
        al.enable().map_err(|e| e.to_string())
    } else {
        al.disable().map_err(|e| e.to_string())
    }
}

/// Devuelve `true` si la entrada de autostart del SO está activa. Los args
/// (`--minimized`) no afectan a la detección, que se hace por `app_name`.
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn autostart_is_enabled() -> Result<bool, String> {
    autostart_handle(false)?.is_enabled().map_err(|e| e.to_string())
}

/// Versión no-op para plataformas móviles (Android/iOS): el autostart no aplica.
#[tauri::command]
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn autostart_apply(_enable: bool, _minimized: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn autostart_is_enabled() -> Result<bool, String> {
    Ok(false)
}

/// Devuelve `true` si la app fue lanzada con el argumento `--minimized`
/// (es decir, por el autostart del SO con la opción "arrancar minimizado").
/// El frontend lo consulta al arrancar para ocultar la ventana al tray.
#[tauri::command]
pub fn is_launched_minimized(state: State<LaunchMinimized>) -> bool {
    state.0
}

/// Indica si la app se está ejecutando como AppImage en Linux (variable de
/// entorno `APPIMAGE` presente y no vacía). El frontend lo usa para habilitar
/// el updater de Tauri en Linux solo cuando es AppImage (el único formato que
/// el updater sabe actualizar in-place); el resto de formatos se actualizan por
/// el gestor de paquetes.
#[tauri::command]
pub fn is_appimage() -> bool {
    std::env::var("APPIMAGE")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

// ─── Notas Markdown por conexión («runbooks») ───────────────────────────────

/// Lee la nota Markdown de un perfil. `None` si no existe.
#[tauri::command]
pub fn note_get(notes: State<NotesManager>, profile_id: String) -> Result<Option<NoteDoc>, String> {
    notes.read(&profile_id).map_err(|e| e.to_string())
}

/// Crea o actualiza la nota de un perfil. Fija `updated_at = now` y conserva
/// `created_at`. Devuelve el documento resultante.
#[tauri::command]
pub fn note_set(
    notes: State<NotesManager>,
    profile_id: String,
    body: String,
    title: String,
    connection: String,
    tags: Vec<String>,
) -> Result<NoteDoc, String> {
    notes
        .set(&profile_id, body, title, connection, tags)
        .map_err(|e| e.to_string())
}

/// Borra la nota de un perfil (idempotente).
#[tauri::command]
pub fn note_delete(notes: State<NotesManager>, profile_id: String) -> Result<(), String> {
    notes.delete(&profile_id).map_err(|e| e.to_string())
}

/// Resúmenes de todas las notas (índice del frontend: badge, búsqueda).
#[tauri::command]
pub fn note_list(notes: State<NotesManager>) -> Result<Vec<NoteSummary>, String> {
    notes.list().map_err(|e| e.to_string())
}

/// Volcado completo de notas (lo usa la sincronización para construir el estado).
#[tauri::command]
pub fn note_export_all(notes: State<NotesManager>) -> Result<Vec<NoteDoc>, String> {
    notes.export_all().map_err(|e| e.to_string())
}

/// Upsert de una nota sincronizada (preserva `updated_at`/`created_at`).
#[tauri::command]
pub fn note_import(notes: State<NotesManager>, doc: NoteDoc) -> Result<(), String> {
    notes.import(doc).map_err(|e| e.to_string())
}

/// Búsqueda full-text simple sobre título, tags y cuerpo de las notas.
#[tauri::command]
pub fn note_search(notes: State<NotesManager>, query: String) -> Result<Vec<NoteSummary>, String> {
    notes.search(&query).map_err(|e| e.to_string())
}

/// Ruta de la carpeta `notes/` (para abrirla en el explorador del SO).
#[tauri::command]
pub fn notes_dir(notes: State<NotesManager>) -> Result<String, String> {
    Ok(notes.dir().to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn run_shell_capture_devuelve_stdout() {
        let out = run_shell_capture("echo hola").expect("ejecuta echo");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hola");
    }

    #[cfg(unix)]
    #[test]
    fn run_shell_capture_propaga_codigo_de_error() {
        let out = run_shell_capture("exit 3").expect("ejecuta exit");
        assert_eq!(out.status.code(), Some(3));
    }

    fn unique_test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rustty-test-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("crea dir temporal de test");
        dir
    }

    #[test]
    fn sanitize_file_name_acepta_nombre_simple() {
        assert_eq!(sanitize_file_name("informe.txt").unwrap(), "informe.txt");
        assert_eq!(sanitize_file_name("a b c.log").unwrap(), "a b c.log");
    }

    #[test]
    fn sanitize_file_name_rechaza_travesias_y_separadores() {
        for malo in ["", ".", "..", "../evil", "a/b", "/etc/passwd", "sub/dir/x"] {
            assert!(
                sanitize_file_name(malo).is_err(),
                "debería rechazar {malo:?}"
            );
        }
    }

    #[test]
    fn write_atomic_escribe_y_reemplaza_contenido() {
        let dir = unique_test_dir("atomic");
        let path = dir.join("datos.txt");
        write_atomic(&path, b"primero").expect("primera escritura");
        assert_eq!(std::fs::read(&path).unwrap(), b"primero");
        write_atomic(&path, b"segundo mas largo").expect("sobrescritura");
        assert_eq!(std::fs::read(&path).unwrap(), b"segundo mas largo");
        // No deja temporales `.tmp` colgando en la carpeta.
        let sobras = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".rustty-"))
            .count();
        assert_eq!(sobras, 0, "no deben quedar temporales");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_reemplaza_symlink_sin_seguirlo() {
        let dir = unique_test_dir("symlink");
        let target = dir.join("target");
        std::fs::write(&target, b"DESTINO-ORIGINAL").expect("crea destino");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&target, &link).expect("crea symlink");
        write_atomic(&link, b"NUEVO").expect("escribe sobre el symlink");
        // El destino real queda intacto (no se escribió a través del enlace).
        assert_eq!(std::fs::read(&target).unwrap(), b"DESTINO-ORIGINAL");
        // El path del enlace ahora es un fichero regular con el contenido nuevo.
        assert_eq!(std::fs::read(&link).unwrap(), b"NUEVO");
        assert!(!std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn remove_file_sobre_symlink_no_borra_el_destino() {
        let dir = unique_test_dir("rm-symlink");
        let target = dir.join("target");
        std::fs::write(&target, b"X").expect("crea destino");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&target, &link).expect("crea symlink");
        std::fs::remove_file(&link).expect("borra el enlace");
        assert!(!link.exists(), "el enlace se borró");
        assert!(target.exists(), "el destino sigue existiendo");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
