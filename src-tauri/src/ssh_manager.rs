//! Gestor SSH interactivo basado en `russh`.
//!
//! Misma arquitectura que `sftp_manager`: un hilo dedicado por sesión con
//! un runtime tokio single-threaded. El hilo principal de Tauri se comunica
//! con él mediante un `tokio::sync::mpsc::UnboundedSender` (cuyo `send` es
//! síncrono), lo que nos permite exponer la misma API que antes sin obligar
//! al resto del backend a ser asíncrono.
//!
//! Soporta las tres formas de autenticación del perfil: contraseña, clave
//! pública (con passphrase opcional) y agente SSH del sistema.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use std::borrow::Cow;

use russh::client::{self, AuthResult};
use russh::keys::ssh_key::Algorithm;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{cipher, kex, ChannelMsg, Preferred};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::host_keys;
use crate::profiles::{AuthType, ConnectionProfile};

// ─── Mensajes del frontend al hilo SSH ──────────────────────────────────────

pub enum SessionCommand {
    /// Bytes de entrada del usuario (teclas)
    Input(Vec<u8>),
    /// Solicitud de redimensionado del terminal
    Resize { cols: u32, rows: u32 },
    /// Cierre limpio de la sesión
    Disconnect,
}

// ─── Handle de sesión ────────────────────────────────────────────────────────

struct SessionHandle {
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
}

// ─── Estado global gestionado por Tauri ─────────────────────────────────────

pub struct SshManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl SshManager {
    pub fn new() -> Self {
        SshManager {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Inicia una conexión SSH en un hilo dedicado con runtime tokio.
    /// Emite eventos Tauri para notificar al frontend:
    ///   - `ssh-connected-{id}` : conexión establecida
    ///   - `ssh-data-{id}`      : bytes recibidos del servidor (stdout + stderr)
    ///   - `ssh-error-{id}`     : error de conexión/autenticación
    ///   - `ssh-reconnecting-{id}` : intentando reconectar (payload: número de intento)
    ///   - `ssh-closed-{id}`    : sesión terminada
    pub fn connect(
        &self,
        session_id: String,
        profile: ConnectionProfile,
        password: Option<String>,
        passphrase: Option<String>,
        app_handle: AppHandle,
        default_log_dir: PathBuf,
    ) -> Result<(), AppError> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();

        let sid = session_id.clone();
        let ah = app_handle.clone();

        thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ah.emit(
                        &format!("ssh-error-{}", sid),
                        format!("No se pudo crear runtime tokio: {e}"),
                    );
                    let _ = ah.emit(&format!("ssh-closed-{}", sid), "");
                    return;
                }
            };
            rt.block_on(run_session_with_reconnect(
                sid.clone(),
                profile,
                password,
                passphrase,
                cmd_rx,
                ah.clone(),
                default_log_dir,
            ));
            let _ = ah.emit(&format!("ssh-closed-{}", sid), "");
        });

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id, SessionHandle { cmd_tx });

        Ok(())
    }

    /// Envía bytes de entrada (teclas del usuario) a la sesión activa
    pub fn send_input(&self, session_id: &str, data: Vec<u8>) -> Result<(), AppError> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        handle
            .cmd_tx
            .send(SessionCommand::Input(data))
            .map_err(|_| AppError::SessionNotFound(session_id.to_string()))
    }

    /// Solicita al servidor SSH un cambio de tamaño del PTY
    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), AppError> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        handle
            .cmd_tx
            .send(SessionCommand::Resize { cols, rows })
            .map_err(|_| AppError::SessionNotFound(session_id.to_string()))
    }

    /// Cierra y elimina una sesión del mapa de estado
    pub fn disconnect(&self, session_id: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(handle) = sessions.remove(session_id) {
            let _ = handle.cmd_tx.send(SessionCommand::Disconnect);
        }
        Ok(())
    }

    pub fn disconnect_all(&self) {
        let handles: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, h)| h)
            .collect();
        for handle in handles {
            let _ = handle.cmd_tx.send(SessionCommand::Disconnect);
        }
    }
}

// ─── Worker asíncrono ───────────────────────────────────────────────────────

/// Indica cómo terminó una iteración de `run_session`. Se usa para decidir si
/// conviene reintentar (en caso de cierre del servidor) o no (cierre del
/// usuario o error fatal).
enum SessionExit {
    /// El usuario pidió desconectar (Disconnect command o cmd_rx cerrado).
    UserDisconnect,
    /// El servidor cerró el canal o caída de red. Candidato a reconectar.
    ServerClosed,
    /// Error fatal (auth, conexión imposible…). No reintenta automáticamente.
    Fatal(AppError),
}

async fn run_session_with_reconnect(
    session_id: String,
    profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    app_handle: AppHandle,
    default_log_dir: PathBuf,
) {
    let max_attempts = profile.auto_reconnect.unwrap_or(0);
    let mut attempt: u32 = 0;
    let log_path = if profile.session_log {
        Some(resolve_log_path(&profile, &default_log_dir))
    } else {
        None
    };

    loop {
        let exit = run_session(
            session_id.clone(),
            profile.clone(),
            password.clone(),
            passphrase.clone(),
            &mut cmd_rx,
            app_handle.clone(),
            log_path.clone(),
        )
        .await;

        match exit {
            SessionExit::UserDisconnect => return,
            SessionExit::Fatal(err) => {
                let _ = app_handle.emit(&format!("ssh-error-{}", session_id), err.to_string());
                return;
            }
            SessionExit::ServerClosed => {
                if max_attempts == 0 || attempt >= max_attempts {
                    return;
                }
                attempt += 1;
                let delay = backoff_delay(attempt);
                let _ = app_handle.emit(
                    &format!("ssh-reconnecting-{}", session_id),
                    serde_json::json!({
                        "attempt": attempt,
                        "max": max_attempts,
                        "delay_ms": delay.as_millis() as u64,
                    }),
                );
                // Si el usuario pide desconectar durante el backoff, abortamos
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(SessionCommand::Disconnect) | None => return,
                            // Cualquier otro comando durante el sleep se ignora
                            // (no hay sesión activa donde reenviarlo).
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

fn backoff_delay(attempt: u32) -> Duration {
    // 2s, 4s, 8s, 16s, 32s, capado a 60s
    let secs = 2u64.saturating_pow(attempt.min(5)).min(60);
    Duration::from_secs(secs)
}

fn resolve_log_path(profile: &ConnectionProfile, default_dir: &Path) -> PathBuf {
    let base: PathBuf = profile
        .session_log_dir
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_dir.join("session_logs"));
    let safe_name = sanitize_filename(&profile.name);
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    base.join(format!("{}-{}.log", safe_name, stamp))
}

fn sanitize_filename(input: &str) -> String {
    input
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

async fn open_session_log(path: &Path) -> Option<tokio::fs::File> {
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .ok()
}

async fn run_session(
    session_id: String,
    profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    cmd_rx: &mut mpsc::UnboundedReceiver<SessionCommand>,
    app_handle: AppHandle,
    log_path: Option<PathBuf>,
) -> SessionExit {
    // Si está activado el log de sesión, abrimos el fichero en modo append.
    let mut log_file = match &log_path {
        Some(p) => open_session_log(p).await,
        None => None,
    };

    // 1. TCP + handshake SSH
    let keepalive_interval = profile
        .keep_alive_secs
        .filter(|s| *s > 0)
        .map(|s| Duration::from_secs(s as u64));
    let preferred = if profile.allow_legacy_algorithms {
        legacy_preferred()
    } else {
        Preferred::default()
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        keepalive_interval,
        preferred,
        ..Default::default()
    });
    let addr = format!("{}:{}", profile.host, profile.port);
    let (client_handler, host_key_failure) = host_keys::client(
        profile.host.clone(),
        profile.port,
        profile.agent_forwarding,
        profile.x11_forwarding,
    );
    let mut handle = match client::connect(config, addr.clone(), client_handler).await {
        Ok(handle) => handle,
        Err(err) => {
            if let Some(reason) = host_keys::take_failure(&host_key_failure) {
                return SessionExit::Fatal(AppError::Auth(reason));
            }
            // Errores de red/TCP: candidatos a reconectar
            let _ = app_handle.emit(
                &format!("ssh-error-{}", session_id),
                format!("No se puede conectar a {addr}: {err}"),
            );
            return SessionExit::ServerClosed;
        }
    };

    // 2. Autenticación
    let auth = match &profile.auth_type {
        AuthType::Password => {
            let pass = match password.clone() {
                Some(p) => p,
                None => return SessionExit::Fatal(AppError::Auth("Se requiere contraseña".into())),
            };
            match handle
                .authenticate_password(profile.username.clone(), pass)
                .await
            {
                Ok(a) => a,
                Err(e) => {
                    return SessionExit::Fatal(AppError::Auth(format!(
                        "Autenticación por contraseña fallida: {e}"
                    )))
                }
            }
        }
        AuthType::PublicKey => {
            let key_path = match profile.key_path.as_ref() {
                Some(p) => p,
                None => {
                    return SessionExit::Fatal(AppError::Auth(
                        "Se requiere ruta de clave privada".into(),
                    ))
                }
            };
            let key = match load_secret_key(Path::new(key_path), passphrase.as_deref()) {
                Ok(k) => k,
                Err(e) => {
                    return SessionExit::Fatal(AppError::Auth(format!("Clave inválida: {e}")))
                }
            };
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            match handle
                .authenticate_publickey(
                    profile.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
            {
                Ok(a) => a,
                Err(e) => {
                    return SessionExit::Fatal(AppError::Auth(format!(
                        "Autenticación por clave fallida: {e}"
                    )))
                }
            }
        }
        AuthType::Agent => match authenticate_with_agent(&mut handle, &profile.username).await {
            Ok(a) => a,
            Err(e) => return SessionExit::Fatal(e),
        },
    };

    match auth {
        AuthResult::Success => {}
        AuthResult::Failure { remaining_methods } => {
            return SessionExit::Fatal(AppError::Auth(format!(
                "Autenticación fallida. Métodos restantes: {:?}",
                remaining_methods
            )));
        }
    }

    // 3. Canal + PTY + shell
    let mut channel = match handle.channel_open_session().await {
        Ok(c) => c,
        Err(e) => {
            return SessionExit::Fatal(AppError::Ssh(format!("No se pudo abrir canal: {e}")))
        }
    };

    if profile.agent_forwarding {
        // No bloqueamos la conexión si el servidor no acepta agent forwarding.
        let _ = channel.agent_forward(false).await;
    }

    if profile.x11_forwarding {
        // Cookie MIT-MAGIC-COOKIE-1 sintética. Requiere X server local y un
        // `xauth add` previo si el server valida la cookie estrictamente.
        let cookie = generate_x11_cookie();
        let _ = channel
            .request_x11(false, false, "MIT-MAGIC-COOKIE-1", cookie, 0)
            .await;
    }

    if let Err(e) = channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
    {
        return SessionExit::Fatal(AppError::Ssh(format!("No se pudo solicitar PTY: {e}")));
    }

    if let Err(e) = channel.request_shell(true).await {
        return SessionExit::Fatal(AppError::Ssh(format!("No se pudo abrir shell: {e}")));
    }

    let _ = app_handle.emit(&format!("ssh-connected-{}", session_id), &profile.name);

    // 4. Bucle de E/S: multiplexa datos del servidor y comandos del frontend
    let mut exit_kind = SessionExit::ServerClosed;
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if let Some(f) = log_file.as_mut() {
                            let _ = f.write_all(&data).await;
                        }
                        let _ = app_handle
                            .emit(&format!("ssh-data-{}", session_id), data.to_vec());
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        // stderr → lo mezclamos con stdout, como hacía ssh2.
                        if let Some(f) = log_file.as_mut() {
                            let _ = f.write_all(&data).await;
                        }
                        let _ = app_handle
                            .emit(&format!("ssh-data-{}", session_id), data.to_vec());
                    }
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => break,
                    Some(_) => {}
                    None => break,
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCommand::Input(data)) => {
                        let _ = channel.data(&data[..]).await;
                    }
                    Some(SessionCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SessionCommand::Disconnect) | None => {
                        exit_kind = SessionExit::UserDisconnect;
                        break;
                    }
                }
            }
        }
    }

    // 5. Cierre limpio
    if let Some(mut f) = log_file.take() {
        let _ = f.flush().await;
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    exit_kind
}

/// Autenticación vía agente SSH. Probamos cada identidad hasta que una
/// funcione o se acaben.
#[cfg(unix)]
async fn authenticate_with_agent(
    handle: &mut client::Handle<host_keys::KnownHostsClient>,
    username: &str,
) -> Result<AuthResult, AppError> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| AppError::Auth(format!("No se pudo contactar con el agente SSH: {e}")))?
        .dynamic();
    let identities = agent.request_identities().await.map_err(|e| {
        AppError::Auth(format!("No se pudieron listar identidades del agente: {e}"))
    })?;

    if identities.is_empty() {
        return Err(AppError::Auth(
            "El agente SSH no tiene claves cargadas".into(),
        ));
    }

    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let mut last_failure = None;
    for key in identities {
        let res = handle
            .authenticate_publickey_with(username, key, hash_alg, &mut agent)
            .await;
        match res {
            Ok(AuthResult::Success) => return Ok(AuthResult::Success),
            Ok(other) => last_failure = Some(other),
            Err(e) => return Err(AppError::Auth(format!("Error al firmar con agente: {e}"))),
        }
    }
    Ok(last_failure.unwrap_or(AuthResult::Failure {
        remaining_methods: russh::MethodSet::empty(),
    }))
}

#[cfg(not(unix))]
async fn authenticate_with_agent(
    _handle: &mut client::Handle<host_keys::KnownHostsClient>,
    _username: &str,
) -> Result<AuthResult, AppError> {
    Err(AppError::Auth(
        "Autenticación vía agente SSH no soportada en esta plataforma".into(),
    ))
}

/// Construye una lista de algoritmos preferidos que conserva los modernos
/// como prioritarios pero añade variantes legacy (CBC, 3DES, DH-SHA1,
/// HMAC-SHA1, ssh-rsa) al final para poder negociar con servidores antiguos.
fn legacy_preferred() -> Preferred {
    let default = Preferred::default();

    let mut cipher: Vec<cipher::Name> = default.cipher.iter().copied().collect();
    for extra in [
        cipher::AES_256_CBC,
        cipher::AES_192_CBC,
        cipher::AES_128_CBC,
    ] {
        if !cipher.contains(&extra) {
            cipher.push(extra);
        }
    }

    let mut kex_list: Vec<kex::Name> = default.kex.iter().copied().collect();
    for extra in [kex::DH_GEX_SHA1, kex::DH_G14_SHA1, kex::DH_G1_SHA1] {
        if !kex_list.contains(&extra) {
            kex_list.push(extra);
        }
    }

    // mac::HMAC_SHA1 ya está en el orden por defecto, así que no toca añadirlo.

    let mut keys: Vec<Algorithm> = default.key.iter().cloned().collect();
    let rsa_sha1 = Algorithm::Rsa { hash: None };
    if !keys.iter().any(|k| matches!(k, Algorithm::Rsa { hash: None })) {
        keys.push(rsa_sha1);
    }

    Preferred {
        kex: Cow::Owned(kex_list),
        key: Cow::Owned(keys),
        cipher: Cow::Owned(cipher),
        mac: default.mac.clone(),
        compression: default.compression.clone(),
    }
}

/// Genera una cookie hex aleatoria de 16 bytes para MIT-MAGIC-COOKIE-1.
fn generate_x11_cookie() -> String {
    use sha2::Digest;
    let nonce = uuid::Uuid::new_v4();
    let digest = sha2::Sha256::digest(nonce.as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}
