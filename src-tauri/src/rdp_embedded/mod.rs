//! Escritorio remoto RDP **dentro de la pestaña** (cliente integrado IronRDP).
//!
//! Es opcional: por defecto el RDP sigue abriéndose en el cliente externo
//! (`rdp_manager`), y el integrado se elige en Preferencias (`prefs.rdpMode`).
//! Además de la imagen y la entrada, la sesión puede llevar portapapeles
//! compartido ([`clipboard`], texto y, si se activa, ficheros) y una carpeta
//! local como unidad ([`drive`]). Aquí viven el gestor de sesiones y los
//! comandos Tauri, todos acotados a una sesión que el gestor conoce:
//!
//! | Comando                      | Para qué                                                   |
//! |------------------------------|------------------------------------------------------------|
//! | `rdp_embed_connect`          | Abre la sesión de un perfil (el secreto se resuelve aquí)  |
//! | `rdp_embed_input`            | Lote binario de ratón y teclado (cuerpo crudo)             |
//! | `rdp_embed_resize`           | Pide un tamaño nuevo del escritorio                        |
//! | `rdp_embed_ack`              | Confirma el último fotograma pintado (contrapresión)       |
//! | `rdp_embed_disconnect`       | Cierra la sesión                                           |
//! | `rdp_embed_clipboard_sync`   | Anuncia al remoto el portapapeles local si cambió          |
//! | `rdp_embed_clipboard_save`   | Guarda los ficheros copiados en el remoto (diálogo nativo) |
//! | `rdp_embed_clipboard_cancel` | Cancela esa descarga                                       |
//! | `rdp_shared_folder_*`        | Carpeta local compartida como unidad (la elige el backend) |
//! | `rdp_cert_response`          | Respuesta al diálogo de certificado (TOFU)                 |
//! | `rdp_known_certs_list`       | Gestor: huellas guardadas                                  |
//! | `rdp_known_cert_remove`      | Gestor: olvidar una huella                                 |
//!
//! Ninguno añade permisos de plugin ni acepta rutas del renderer: las dos
//! carpetas que tocan el disco (la compartida y el destino de los ficheros del
//! portapapeles) las elige el usuario en un diálogo que abre el backend, y las
//! dos pasan por [`LocalFsGuard`].

pub mod certs;
pub mod clipboard;
pub mod drive;
pub mod frames;
pub mod input;
mod perf;
mod resize;
mod session;
mod tls;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use crate::commands::{
    apply_connect_overrides, apply_credential, external_forward, resolve_connection_secret,
    ConnectOverrides,
};
use crate::credentials::{self, CredentialStore};
use crate::ipc::{event_name, EventKind};
use crate::jump_forward::ForwardRegistry;
use crate::jump_pool::JumpPool;
use crate::jump_route::JumpRequest;
use crate::local_fs_guard::LocalFsGuard;
use crate::locks::MutexExt;
use crate::profiles::ProfileManager;
use crate::DataDir;

use session::{ConnectParams, Ended, SessionCmd, Shared};

/// Órdenes en cola por sesión. La entrada que no quepa se descarta antes que
/// acumular memoria (el estado de teclas se resincroniza al soltar el foco).
const CMD_QUEUE: usize = 256;

struct Handle {
    generation: u64,
    cmds: mpsc::Sender<SessionCmd>,
    shared: Arc<Shared>,
}

/// Sesiones integradas vivas, por `session_id`.
#[derive(Default)]
pub struct EmbeddedRdpManager {
    sessions: Mutex<HashMap<String, Handle>>,
    generation: AtomicU64,
}

impl EmbeddedRdpManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, session_id: &str) -> Option<(mpsc::Sender<SessionCmd>, Arc<Shared>)> {
        self.sessions
            .lock_recover()
            .get(session_id)
            .map(|h| (h.cmds.clone(), h.shared.clone()))
    }

    /// Cierra todas las sesiones (cierre de la ventana).
    pub fn disconnect_all(&self) {
        for (_, h) in self.sessions.lock_recover().drain() {
            let _ = h.cmds.try_send(SessionCmd::Close);
        }
    }
}

/// Estado de la sesión que ve la pestaña (`rdp-embed-status-{id}`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    /// `connecting` | `connected` | `display-control` | `closed` | `error`.
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u16>,
    /// Con `display-control`: el servidor admite cambiar el tamaño del
    /// escritorio sin reconectar (Display Control).
    #[serde(skip_serializing_if = "Option::is_none")]
    display_control: Option<bool>,
}

impl StatusEvent {
    fn bare(state: &'static str) -> Self {
        Self {
            state,
            code: None,
            message: None,
            width: None,
            height: None,
            display_control: None,
        }
    }
}

struct EventReporter {
    app: AppHandle,
    event: String,
}

impl session::Reporter for EventReporter {
    fn connected(&self, width: u16, height: u16) {
        let _ = self.app.emit(
            &self.event,
            StatusEvent {
                width: Some(width),
                height: Some(height),
                ..StatusEvent::bare("connected")
            },
        );
    }

    fn display_control(&self, supported: bool) {
        let _ = self.app.emit(
            &self.event,
            StatusEvent {
                display_control: Some(supported),
                ..StatusEvent::bare("display-control")
            },
        );
    }
}

struct ClipEventNotifier {
    app: AppHandle,
    event: String,
}

impl clipboard::ClipNotifier for ClipEventNotifier {
    fn notice(&self, notice: clipboard::ClipNotice) {
        let _ = self.app.emit(&self.event, notice);
    }
}

/// Primer motivo de cautela entre las rutas copiadas en local, si lo hay
/// (clave privada, `~/.ssh`, carpeta de datos), con el nombre y si es carpeta.
fn upload_concern(
    guard: &LocalFsGuard,
    paths: &[std::path::PathBuf],
) -> Option<(crate::local_fs_guard::UploadConcern, String, bool)> {
    paths.iter().find_map(|path| {
        let is_dir = path.is_dir();
        let concern = if is_dir {
            guard.upload_dir_concern(path)
        } else {
            guard.upload_concern(path)
        };
        // Lo que no se puede resolver (ya no existe) tampoco se anunciará.
        let concern = concern.ok().flatten()?;
        let name = path
            .file_name()
            .map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
        Some((concern, name, is_dir))
    })
}

/// Antes de ofrecer al remoto ficheros locales sensibles, el mismo diálogo
/// nativo que la subida por SFTP: el servidor puede leerlos en cuanto se
/// anuncian, sin esperar a que nadie pegue.
struct DialogUploadGate {
    app: AppHandle,
    guard: LocalFsGuard,
    lang: String,
    host: String,
}

impl clipboard::UploadGate for DialogUploadGate {
    fn allow(&self, paths: &[std::path::PathBuf]) -> bool {
        match upload_concern(&self.guard, paths) {
            None => true,
            Some((concern, name, is_dir)) => crate::commands::ask_sensitive_upload(
                &self.app, &self.lang, &concern, &name, &self.host, is_dir,
            ),
        }
    }
}

/// Canales extra de la sesión, según los ajustes del frontend.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedOptions {
    /// Portapapeles compartido (texto).
    #[serde(default)]
    pub clipboard: bool,
    /// Además, ficheros por el portapapeles.
    #[serde(default)]
    pub clipboard_files: bool,
    /// Compartir la carpeta elegida en Ajustes (la ruta la guarda el backend).
    #[serde(default)]
    pub shared_folder: bool,
    /// Perfil de rendimiento (`speed`, `balanced`, `quality`).
    #[serde(default)]
    pub perf_profile: perf::PerfProfile,
    /// Idioma de los diálogos nativos que abre el backend.
    #[serde(default)]
    pub lang: Option<String>,
    /// «Preguntar si el certificado de un servidor RDP cambia».
    #[serde(default)]
    pub cert_change_prompt: Option<bool>,
}

/// Respuesta de `rdp_embed_connect`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectReply {
    /// No hay contraseña guardada: el frontend la pide y vuelve a llamar con
    /// `password`. No se ha abierto ninguna conexión.
    pub needs_password: bool,
}

fn valid_session_id(id: &str) -> bool {
    id.starts_with("rdp-")
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Abre una sesión RDP integrada para un perfil guardado.
///
/// El frontend pasa **solo** el id del perfil (y la identidad elegida): la
/// contraseña se resuelve aquí (keyring, KeePass, credencial maestra,
/// `${…}`). `password` solo llega cuando no había ninguna guardada y el
/// usuario la acaba de teclear en el diálogo.
///
/// Vuelve en cuanto la sesión está lanzada; el progreso (diálogo del
/// certificado, autenticación, cierre) llega por `rdp-embed-status-{id}` y los
/// fotogramas por `on_frame`.
// Frontera IPC: los argumentos los dicta el `invoke` del frontend y los
// estados que Tauri inyecta; agruparlos sería otro struct de ida y vuelta.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn rdp_embed_connect(
    app: AppHandle,
    manager: State<'_, EmbeddedRdpManager>,
    profile_state: State<'_, ProfileManager>,
    cred_state: State<'_, CredentialStore>,
    jump_pool: State<'_, JumpPool>,
    forwards: State<'_, ForwardRegistry>,
    data_dir: State<'_, DataDir>,
    guard: State<'_, LocalFsGuard>,
    session_id: String,
    profile_id: String,
    credential_id: Option<String>,
    password: Option<String>,
    jumps: Option<Vec<JumpRequest>>,
    overrides: Option<ConnectOverrides>,
    width: u32,
    height: u32,
    scale: Option<u32>,
    options: Option<EmbedOptions>,
    on_frame: Channel<Response>,
) -> Result<ConnectReply, String> {
    if !valid_session_id(&session_id) {
        return Err("Identificador de sesión no válido".into());
    }
    let profiles = profile_state.load_all().map_err(|e| e.to_string())?;
    let mut profile = profiles
        .iter()
        .find(|p| p.id == profile_id && p.connection_type == "rdp")
        .cloned()
        .ok_or_else(|| format!("Perfil RDP {profile_id} no encontrado"))?;
    if let Some(cid) = credential_id.as_deref() {
        apply_credential(&mut profile, cid)?;
    }
    if let Some(ov) = overrides.as_ref() {
        apply_connect_overrides(&mut profile, ov);
    }
    credentials::substitute_connection_fields(&mut profile, &cred_state);

    let Some(secret) = resolve_connection_secret(
        &profile,
        &profile_id,
        credential_id.as_deref(),
        &cred_state,
        password,
    )?
    else {
        return Ok(ConnectReply {
            needs_password: true,
        });
    };

    let event = event_name(EventKind::RdpEmbedStatus, &session_id);
    let _ = app.emit(&event, StatusEvent::bare("connecting"));

    let forward = external_forward(
        "RDP",
        &profiles,
        &profile,
        Some(secret.as_str()),
        jumps.as_deref(),
        &cred_state,
        &jump_pool,
        &forwards,
    )
    .await?;
    let (dial_host, dial_port) = match forward.as_ref() {
        Some(f) => (f.host().to_string(), f.port()),
        None => (profile.host.clone(), profile.port),
    };

    let options = options.unwrap_or_default();
    // La carpeta guardada se revalida al usarla: si ya no se puede compartir
    // (p. ej. se movió la carpeta de datos dentro), la sesión sigue sin ella.
    let shared_folder = options
        .shared_folder
        .then(|| drive::configured(&data_dir.0))
        .flatten()
        .filter(|folder| match guard.check_share(folder) {
            Ok(()) => true,
            Err(e) => {
                log::warn!("RDP integrado: carpeta compartida rechazada ({e})");
                false
            }
        });
    let params = ConnectParams {
        host: profile.host.clone(),
        port: profile.port,
        dial_host,
        dial_port,
        via_jump: forward.is_some(),
        username: profile.username.clone(),
        domain: profile.domain.clone(),
        password: secret,
        width,
        height,
        scale,
        cert_store: certs::store_path(&data_dir.0),
        clipboard: options.clipboard.then_some(clipboard::ClipboardOptions {
            files: options.clipboard_files,
        }),
        clipboard_notifier: Arc::new(ClipEventNotifier {
            app: app.clone(),
            event: event_name(EventKind::RdpEmbedClip, &session_id),
        }),
        upload_gate: Arc::new(DialogUploadGate {
            app: app.clone(),
            guard: guard.inner().clone(),
            lang: options.lang.clone().unwrap_or_else(|| "es".into()),
            host: profile.host.clone(),
        }),
        shared_folder,
        perf: options.perf_profile,
        cert_change_prompt: options.cert_change_prompt,
    };

    let (tx, rx) = mpsc::channel(CMD_QUEUE);
    let shared = Arc::new(Shared::default());
    let generation = manager.generation.fetch_add(1, Ordering::Relaxed);
    // Reconectar reutiliza el id: la sesión anterior, si sigue viva, se cierra.
    if let Some(old) = manager.sessions.lock_recover().insert(
        session_id.clone(),
        Handle {
            generation,
            cmds: tx,
            shared: shared.clone(),
        },
    ) {
        let _ = old.cmds.try_send(SessionCmd::Close);
    }

    let reporter = Arc::new(EventReporter {
        app: app.clone(),
        event: event.clone(),
    });
    let app_task = app.clone();
    tauri::async_runtime::spawn(async move {
        // El reenvío del salto vive lo que la sesión.
        let _forward = forward;
        let outcome = session::run(params, on_frame, rx, shared, reporter).await;
        let status = match outcome {
            Ok(Ended::Local) => StatusEvent::bare("closed"),
            Ok(Ended::Server(reason)) => StatusEvent {
                code: Some("server-closed"),
                message: (!reason.is_empty()).then_some(reason),
                ..StatusEvent::bare("closed")
            },
            Err(err) => {
                log::warn!("RDP integrado {session_id}: {} ({})", err.code, err.message);
                StatusEvent {
                    code: Some(err.code),
                    message: Some(err.message),
                    ..StatusEvent::bare("error")
                }
            }
        };
        let manager = tauri::Manager::state::<EmbeddedRdpManager>(&app_task);
        let mut sessions = manager.sessions.lock_recover();
        let current = sessions
            .get(&session_id)
            .is_some_and(|h| h.generation == generation);
        if current {
            sessions.remove(&session_id);
        }
        drop(sessions);
        // Reconectar en la pestaña (p. ej. a otra resolución) reutiliza el id
        // con la sesión vieja aún viva: su cierre no debe llegar a la nueva,
        // que escucha el mismo evento.
        if current {
            let _ = app_task.emit(&event, status);
        }
    });

    Ok(ConnectReply {
        needs_password: false,
    })
}

/// Lote de entrada del canvas. Cuerpo crudo (ver `input`), con el id de la
/// sesión en la cabecera `x-session`.
#[tauri::command]
pub fn rdp_embed_input(
    manager: State<'_, EmbeddedRdpManager>,
    request: Request<'_>,
) -> Result<(), String> {
    let session_id = request
        .headers()
        .get("x-session")
        .and_then(|v| v.to_str().ok())
        .ok_or("Falta la sesión")?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Se esperaba un cuerpo binario".into());
    };
    let events = input::decode_batch(body).map_err(str::to_string)?;
    if events.is_empty() {
        return Ok(());
    }
    let Some((cmds, _)) = manager.get(session_id) else {
        return Ok(());
    };
    // Cola llena = el servidor no da abasto: se descarta este lote.
    let _ = cmds.try_send(SessionCmd::Input(events));
    Ok(())
}

/// Pide un tamaño nuevo del escritorio (píxeles físicos y escala en %) por
/// Display Control. Si el canal aún no está listo, la sesión guarda la última
/// petición y la manda en cuanto lo esté; si el servidor no lo ofrece, lo avisa
/// con `display-control` (`displayControl: false`) y el frontend reconecta.
#[tauri::command]
pub fn rdp_embed_resize(
    manager: State<'_, EmbeddedRdpManager>,
    session_id: String,
    width: u32,
    height: u32,
    scale: Option<u32>,
) {
    if let Some((cmds, _)) = manager.get(&session_id) {
        let _ = cmds.try_send(SessionCmd::Resize {
            width,
            height,
            scale,
        });
    }
}

/// Confirma que el frontend ya pintó el fotograma `seq`.
#[tauri::command]
pub fn rdp_embed_ack(manager: State<'_, EmbeddedRdpManager>, session_id: String, seq: u32) {
    if let Some((_, shared)) = manager.get(&session_id) {
        shared.acked.store(seq, Ordering::Release);
        shared.ack_notify.notify_one();
    }
}

#[tauri::command]
pub fn rdp_embed_disconnect(manager: State<'_, EmbeddedRdpManager>, session_id: String) {
    if let Some((cmds, _)) = manager.get(&session_id) {
        let _ = cmds.try_send(SessionCmd::Close);
    }
}

/// El escritorio recibió el foco (o va a pegar): si el portapapeles local
/// cambió desde lo último anunciado, se anuncia al remoto.
#[tauri::command]
pub fn rdp_embed_clipboard_sync(manager: State<'_, EmbeddedRdpManager>, session_id: String) {
    if let Some((cmds, _)) = manager.get(&session_id) {
        let _ = cmds.try_send(SessionCmd::ClipboardSync);
    }
}

/// Guarda los ficheros que el remoto copió (oferta `offer` del aviso
/// `files-offered`) en una carpeta que el usuario elige en el diálogo nativo
/// que abre **el backend**: el renderer no nombra ninguna ruta. La carpeta no
/// puede ser la personal entera ni tocar `~/.ssh` o la de datos
/// (`LocalFsGuard::check_share`). `Ok(false)` = canceló el diálogo.
#[tauri::command]
pub async fn rdp_embed_clipboard_save(
    window: tauri::Window,
    manager: State<'_, EmbeddedRdpManager>,
    guard: State<'_, LocalFsGuard>,
    session_id: String,
    offer: u32,
    title: Option<String>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    if manager.get(&session_id).is_none() {
        return Err("La sesión ya no está abierta".into());
    }
    let mut builder = window.dialog().file();
    #[cfg(any(windows, target_os = "macos"))]
    {
        builder = builder.set_parent(&window);
    }
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        builder = builder.set_title(title);
    }
    if let Some(downloads) = dirs::download_dir() {
        builder = builder.set_directory(downloads);
    }
    let Some(dest) = builder
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .filter(|p| p.is_dir())
    else {
        return Ok(false);
    };
    guard.check_share(&dest)?;
    // La sesión pudo cerrarse mientras el diálogo estaba abierto.
    let Some((cmds, _)) = manager.get(&session_id) else {
        return Err("La sesión ya no está abierta".into());
    };
    cmds.try_send(SessionCmd::ClipboardSave { offer, dest })
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Cancela la descarga de ficheros del portapapeles en curso (se borra lo que
/// llevaba creado).
#[tauri::command]
pub fn rdp_embed_clipboard_cancel(manager: State<'_, EmbeddedRdpManager>, session_id: String) {
    if let Some((cmds, _)) = manager.get(&session_id) {
        let _ = cmds.try_send(SessionCmd::ClipboardCancel);
    }
}

/// Respuesta al diálogo del certificado (`rdp-cert-prompt`).
#[tauri::command]
pub fn rdp_cert_response(prompt_id: String, accept: bool) -> bool {
    certs::resolve_prompt(&prompt_id, accept)
}

#[tauri::command]
pub fn rdp_known_certs_list(data_dir: State<'_, DataDir>) -> Vec<certs::KnownCert> {
    certs::list(&certs::store_path(&data_dir.0))
}

#[tauri::command]
pub fn rdp_known_cert_remove(
    data_dir: State<'_, DataDir>,
    host_port: String,
) -> Result<bool, String> {
    certs::forget(&certs::store_path(&data_dir.0), &host_port).map_err(|e| e.to_string())
}

/// `true`: esta build trae el cliente integrado.
#[tauri::command]
pub fn rdp_embed_available() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ficheros_sensibles_piden_confirmacion_antes_de_ofrecerlos() {
        let home = std::env::temp_dir().join(format!("rustty-rdpgate-{}", uuid::Uuid::new_v4()));
        let data = home.join("datos");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let home = std::fs::canonicalize(&home).unwrap();
        let guard = LocalFsGuard::new(&home.join("datos"), Some(&home));
        std::fs::write(home.join("nota.txt"), b"hola").unwrap();
        std::fs::write(home.join(".ssh").join("config"), b"Host x").unwrap();
        std::fs::write(home.join(".ssh").join("clave"), b"secreto").unwrap();

        assert!(upload_concern(&guard, &[home.join("nota.txt")]).is_none());
        assert!(upload_concern(&guard, &[home.join(".ssh").join("config")]).is_none());
        let (concern, name, is_dir) =
            upload_concern(&guard, &[home.join("nota.txt"), home.join(".ssh").join("clave")])
                .unwrap();
        assert_eq!(concern, crate::local_fs_guard::UploadConcern::SshDir);
        assert_eq!(name, "clave");
        assert!(!is_dir);
        // Una carpeta que contiene la de datos, también.
        assert!(upload_concern(&guard, std::slice::from_ref(&home)).is_some());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn ids_de_sesion_validos() {
        assert!(valid_session_id("rdp-0f8e2c1a-1b2c-4d5e-8f90-123456789abc"));
        assert!(!valid_session_id("ssh-1"));
        assert!(!valid_session_id("rdp-../x"));
        assert!(!valid_session_id(&format!("rdp-{}", "a".repeat(80))));
    }
}
