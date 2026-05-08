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
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::host_keys;
use crate::profiles::{AuthType, ConnectionProfile, SshTunnelType};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub id: Option<String>,
    pub name: Option<String>,
    pub tunnel_type: SshTunnelType,
    pub bind_host: Option<String>,
    pub local_port: u16,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelInfo {
    pub id: String,
    pub name: Option<String>,
    pub tunnel_type: SshTunnelType,
    pub bind_host: String,
    pub local_port: u16,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub status: String,
    pub bytes_up: u64,
    pub bytes_down: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshTunnelTrafficEvent {
    id: String,
    bytes_up: u64,
    bytes_down: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshConnectionLogEvent {
    stage: &'static str,
    status: &'static str,
    message: String,
    timestamp: String,
}

fn emit_connection_log(
    app_handle: &AppHandle,
    session_id: &str,
    stage: &'static str,
    status: &'static str,
    message: impl Into<String>,
) {
    let _ = app_handle.emit(
        &format!("ssh-log-{}", session_id),
        SshConnectionLogEvent {
            stage,
            status,
            message: message.into(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        },
    );
}

// ─── Mensajes del frontend al hilo SSH ──────────────────────────────────────

pub enum SessionCommand {
    /// Bytes de entrada del usuario (teclas)
    Input(Vec<u8>),
    /// Solicitud de redimensionado del terminal
    Resize { cols: u32, rows: u32 },
    /// Cierre limpio de la sesión
    Disconnect,
    /// Arranca un túnel sobre la conexión SSH ya autenticada.
    StartTunnel {
        config: SshTunnelConfig,
        reply: oneshot::Sender<Result<SshTunnelInfo, String>>,
    },
    /// Cierra un túnel activo.
    StopTunnel {
        tunnel_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Devuelve los túneles activos en esta sesión.
    ListTunnels {
        reply: oneshot::Sender<Vec<SshTunnelInfo>>,
    },
    /// Conexión TCP aceptada por un listener local o SOCKS.
    TunnelAccepted {
        tunnel_id: String,
        stream: TcpStream,
        peer_host: String,
        peer_port: u32,
    },
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
    ///   - `ssh-log-{id}`       : etapa de diagnóstico de conexión
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
        let worker_cmd_tx = cmd_tx.clone();

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
                worker_cmd_tx,
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

    pub async fn start_tunnel(
        &self,
        session_id: &str,
        config: SshTunnelConfig,
    ) -> Result<SshTunnelInfo, String> {
        let cmd_tx = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .get(session_id)
                .ok_or_else(|| format!("Sesión SSH {session_id} no encontrada"))?
                .cmd_tx
                .clone()
        };
        let (reply, rx) = oneshot::channel();
        cmd_tx
            .send(SessionCommand::StartTunnel { config, reply })
            .map_err(|_| format!("Sesión SSH {session_id} no disponible"))?;
        rx.await
            .map_err(|_| "La sesión SSH no respondió".to_string())?
    }

    pub async fn stop_tunnel(&self, session_id: &str, tunnel_id: String) -> Result<(), String> {
        let cmd_tx = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .get(session_id)
                .ok_or_else(|| format!("Sesión SSH {session_id} no encontrada"))?
                .cmd_tx
                .clone()
        };
        let (reply, rx) = oneshot::channel();
        cmd_tx
            .send(SessionCommand::StopTunnel { tunnel_id, reply })
            .map_err(|_| format!("Sesión SSH {session_id} no disponible"))?;
        rx.await
            .map_err(|_| "La sesión SSH no respondió".to_string())?
    }

    pub async fn list_tunnels(&self, session_id: &str) -> Result<Vec<SshTunnelInfo>, String> {
        let cmd_tx = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .get(session_id)
                .ok_or_else(|| format!("Sesión SSH {session_id} no encontrada"))?
                .cmd_tx
                .clone()
        };
        let (reply, rx) = oneshot::channel();
        cmd_tx
            .send(SessionCommand::ListTunnels { reply })
            .map_err(|_| format!("Sesión SSH {session_id} no disponible"))?;
        rx.await
            .map_err(|_| "La sesión SSH no respondió".to_string())
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

struct ActiveTunnel {
    info: SshTunnelInfo,
    local_task: Option<JoinHandle<()>>,
}

impl ActiveTunnel {
    fn from_info(info: SshTunnelInfo, local_task: Option<JoinHandle<()>>) -> Self {
        Self { info, local_task }
    }
}

async fn run_session_with_reconnect(
    session_id: String,
    profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
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
            cmd_tx.clone(),
            app_handle.clone(),
            log_path.clone(),
        )
        .await;

        match exit {
            SessionExit::UserDisconnect => return,
            SessionExit::Fatal(err) => {
                emit_connection_log(&app_handle, &session_id, "error", "error", err.to_string());
                let _ = app_handle.emit(&format!("ssh-error-{}", session_id), err.to_string());
                return;
            }
            SessionExit::ServerClosed => {
                if max_attempts == 0 || attempt >= max_attempts {
                    emit_connection_log(
                        &app_handle,
                        &session_id,
                        "closed",
                        "warning",
                        "La sesión SSH se ha cerrado",
                    );
                    return;
                }
                attempt += 1;
                let delay = backoff_delay(attempt);
                emit_connection_log(
                    &app_handle,
                    &session_id,
                    "reconnecting",
                    "warning",
                    format!(
                        "Reconectando en {}s ({}/{})",
                        delay.as_secs(),
                        attempt,
                        max_attempts
                    ),
                );
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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
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
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
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
    let remote_forwards = host_keys::remote_forward_map();
    let addr = format!("{}:{}", profile.host, profile.port);
    let proxy_spec = profile
        .proxy_jump
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    emit_connection_log(
        &app_handle,
        &session_id,
        "resolving",
        "info",
        format!("Resolviendo {}:{}", profile.host, profile.port),
    );

    let mut handle = if let Some(spec) = proxy_spec {
        // ── Modo ProxyJump: conectar al bastion → direct-tcpip → handshake target
        let (b_user, b_host, b_port) = parse_jump_spec(spec, &profile.username);
        let bastion_addr = format!("{}:{}", b_host, b_port);
        let (bastion_handler, bastion_failure) =
            host_keys::client(b_host.clone(), b_port, false, false);
        emit_connection_log(
            &app_handle,
            &session_id,
            "connecting",
            "info",
            format!("Conectando al bastion {bastion_addr}"),
        );
        emit_connection_log(
            &app_handle,
            &session_id,
            "verifying_host_key",
            "info",
            format!("Verificando host key del bastion {b_host}:{b_port}"),
        );
        let mut bastion =
            match client::connect(config.clone(), bastion_addr.clone(), bastion_handler).await {
                Ok(h) => h,
                Err(err) => {
                    if let Some(reason) = host_keys::take_failure(&bastion_failure) {
                        return SessionExit::Fatal(AppError::Auth(format!("Bastion: {reason}")));
                    }
                    emit_connection_log(
                        &app_handle,
                        &session_id,
                        "connecting",
                        "error",
                        format!("No se puede conectar al bastion {bastion_addr}: {err}"),
                    );
                    let _ = app_handle.emit(
                        &format!("ssh-error-{}", session_id),
                        format!("No se puede conectar al bastion {bastion_addr}: {err}"),
                    );
                    return SessionExit::ServerClosed;
                }
            };
        emit_connection_log(
            &app_handle,
            &session_id,
            "connecting",
            "ok",
            format!("Bastion conectado: {bastion_addr}"),
        );

        emit_connection_log(
            &app_handle,
            &session_id,
            "authenticating",
            "info",
            format!("Autenticando en bastion como {b_user}"),
        );
        match authenticate_handle(
            &mut bastion,
            &profile.auth_type,
            &b_user,
            password.as_ref(),
            passphrase.as_ref(),
            profile.key_path.as_deref(),
        )
        .await
        {
            Ok(AuthResult::Success) => {}
            Ok(AuthResult::Failure { remaining_methods }) => {
                return SessionExit::Fatal(AppError::Auth(format!(
                    "Autenticación contra bastion fallida. Métodos restantes: {:?}",
                    remaining_methods
                )));
            }
            Err(e) => return SessionExit::Fatal(AppError::Auth(format!("Bastion: {e}"))),
        }
        emit_connection_log(
            &app_handle,
            &session_id,
            "authenticating",
            "ok",
            "Autenticación contra bastion completada",
        );

        emit_connection_log(
            &app_handle,
            &session_id,
            "connecting",
            "info",
            format!("Abriendo túnel del bastion hacia {addr}"),
        );
        let chan = match bastion
            .channel_open_direct_tcpip(
                profile.host.clone(),
                profile.port as u32,
                "127.0.0.1".to_string(),
                0,
            )
            .await
        {
            Ok(c) => c,
            Err(e) => {
                return SessionExit::Fatal(AppError::Ssh(format!(
                    "No se pudo abrir canal direct-tcpip a través del bastion: {e}"
                )))
            }
        };
        let stream = chan.into_stream();

        let (target_handler, target_failure) = host_keys::client_with_remote_forwards(
            profile.host.clone(),
            profile.port,
            profile.agent_forwarding,
            profile.x11_forwarding,
            remote_forwards.clone(),
        );
        emit_connection_log(
            &app_handle,
            &session_id,
            "verifying_host_key",
            "info",
            format!("Verificando host key de {}", addr),
        );
        match client::connect_stream(config, stream, target_handler).await {
            Ok(h) => {
                emit_connection_log(
                    &app_handle,
                    &session_id,
                    "connecting",
                    "ok",
                    format!("SSH establecido con {addr} a través del bastion"),
                );
                h
            }
            Err(err) => {
                if let Some(reason) = host_keys::take_failure(&target_failure) {
                    return SessionExit::Fatal(AppError::Auth(reason));
                }
                return SessionExit::Fatal(AppError::Io(format!(
                    "No se puede establecer SSH con {addr} a través del bastion: {err}"
                )));
            }
        }
    } else {
        // ── Conexión directa
        let (client_handler, host_key_failure) = host_keys::client_with_remote_forwards(
            profile.host.clone(),
            profile.port,
            profile.agent_forwarding,
            profile.x11_forwarding,
            remote_forwards.clone(),
        );
        emit_connection_log(
            &app_handle,
            &session_id,
            "connecting",
            "info",
            format!("Conectando a {addr}"),
        );
        emit_connection_log(
            &app_handle,
            &session_id,
            "verifying_host_key",
            "info",
            format!("Verificando host key de {addr}"),
        );
        match client::connect(config, addr.clone(), client_handler).await {
            Ok(handle) => {
                emit_connection_log(
                    &app_handle,
                    &session_id,
                    "connecting",
                    "ok",
                    format!("TCP/SSH establecido con {addr}"),
                );
                handle
            }
            Err(err) => {
                if let Some(reason) = host_keys::take_failure(&host_key_failure) {
                    return SessionExit::Fatal(AppError::Auth(reason));
                }
                emit_connection_log(
                    &app_handle,
                    &session_id,
                    "connecting",
                    "error",
                    format!("No se puede conectar a {addr}: {err}"),
                );
                let _ = app_handle.emit(
                    &format!("ssh-error-{}", session_id),
                    format!("No se puede conectar a {addr}: {err}"),
                );
                return SessionExit::ServerClosed;
            }
        }
    };

    // 2. Autenticación contra el destino
    emit_connection_log(
        &app_handle,
        &session_id,
        "authenticating",
        "info",
        format!("Autenticando como {}", profile.username),
    );
    let auth = match authenticate_handle(
        &mut handle,
        &profile.auth_type,
        &profile.username,
        password.as_ref(),
        passphrase.as_ref(),
        profile.key_path.as_deref(),
    )
    .await
    {
        Ok(a) => a,
        Err(e) => return SessionExit::Fatal(e),
    };

    match auth {
        AuthResult::Success => {
            emit_connection_log(
                &app_handle,
                &session_id,
                "authenticating",
                "ok",
                "Autenticación completada",
            );
        }
        AuthResult::Failure { remaining_methods } => {
            return SessionExit::Fatal(AppError::Auth(format!(
                "Autenticación fallida. Métodos restantes: {:?}",
                remaining_methods
            )));
        }
    }

    // 3. Canal + PTY + shell
    emit_connection_log(
        &app_handle,
        &session_id,
        "opening_shell",
        "info",
        "Abriendo canal SSH",
    );
    let mut channel = match handle.channel_open_session().await {
        Ok(c) => c,
        Err(e) => return SessionExit::Fatal(AppError::Ssh(format!("No se pudo abrir canal: {e}"))),
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

    emit_connection_log(
        &app_handle,
        &session_id,
        "opening_shell",
        "ok",
        "Shell remota abierta",
    );
    emit_connection_log(
        &app_handle,
        &session_id,
        "connected",
        "ok",
        format!("Conectado a {}", profile.name),
    );
    let _ = app_handle.emit(&format!("ssh-connected-{}", session_id), &profile.name);

    // 4. Bucle de E/S: multiplexa datos del servidor y comandos del frontend
    let mut exit_kind = SessionExit::ServerClosed;
    let mut tunnels: HashMap<String, ActiveTunnel> = HashMap::new();
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
                    Some(SessionCommand::StartTunnel { config, reply }) => {
                        let result = start_tunnel_runtime(
                            &session_id,
                            config,
                            &mut handle,
                            &mut tunnels,
                            cmd_tx.clone(),
                            app_handle.clone(),
                            remote_forwards.clone(),
                        ).await;
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::StopTunnel { tunnel_id, reply }) => {
                        let result = stop_tunnel_runtime(
                            &mut handle,
                            &mut tunnels,
                            remote_forwards.clone(),
                            &tunnel_id,
                        ).await;
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::ListTunnels { reply }) => {
                        let list = tunnels.values().map(|t| t.info.clone()).collect();
                        let _ = reply.send(list);
                    }
                    Some(SessionCommand::TunnelAccepted { tunnel_id, stream, peer_host, peer_port }) => {
                        if let Some(tunnel) = tunnels.get(&tunnel_id) {
                            let info = tunnel.info.clone();
                            if matches!(info.tunnel_type, SshTunnelType::Local | SshTunnelType::Dynamic) {
                                let target = if info.tunnel_type == SshTunnelType::Dynamic {
                                    match read_socks5_target(stream).await {
                                        Ok((stream, host, port)) => Some((stream, host, port)),
                                        Err(_) => None,
                                    }
                                } else {
                                    info.remote_host
                                        .clone()
                                        .zip(info.remote_port)
                                        .map(|(host, port)| (stream, host, port))
                                };
                                if let Some((stream, host, port)) = target {
                                    match handle
                                        .channel_open_direct_tcpip(host, port as u32, peer_host, peer_port)
                                        .await
                                    {
                                        Ok(channel) => {
                                            tokio::spawn(pump_tunnel(
                                                channel,
                                                stream,
                                                session_id.clone(),
                                                tunnel_id.clone(),
                                                app_handle.clone(),
                                            ));
                                        }
                                        Err(err) => {
                                            let _ = app_handle.emit(
                                                &format!("ssh-error-{}", session_id),
                                                format!("No se pudo abrir canal de túnel: {err}"),
                                            );
                                        }
                                    }
                                }
                            }
                        }
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
    for (_, tunnel) in tunnels.drain() {
        if let Some(task) = tunnel.local_task {
            task.abort();
        }
    }
    if let Ok(mut map) = remote_forwards.lock() {
        map.clear();
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    exit_kind
}

async fn start_tunnel_runtime(
    session_id: &str,
    config: SshTunnelConfig,
    handle: &mut client::Handle<host_keys::KnownHostsClient>,
    tunnels: &mut HashMap<String, ActiveTunnel>,
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    app_handle: AppHandle,
    remote_forwards: host_keys::RemoteForwardMap,
) -> Result<SshTunnelInfo, String> {
    let id = config
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if tunnels.contains_key(&id) {
        return Err(format!("El túnel {id} ya está activo"));
    }

    let bind_host = config
        .bind_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string();

    match config.tunnel_type {
        SshTunnelType::Local | SshTunnelType::Dynamic => {
            if config.local_port == 0 {
                return Err("El puerto local debe ser mayor que 0".into());
            }
            if config.tunnel_type == SshTunnelType::Local
                && (config
                    .remote_host
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                    || config.remote_port.unwrap_or(0) == 0)
            {
                return Err("El túnel local requiere host y puerto remotos".into());
            }

            let listener = TcpListener::bind((bind_host.as_str(), config.local_port))
                .await
                .map_err(|e| {
                    format!(
                        "No se pudo escuchar en {bind_host}:{}: {e}",
                        config.local_port
                    )
                })?;
            let local_addr = listener
                .local_addr()
                .map_err(|e| format!("No se pudo leer el puerto local: {e}"))?;
            let tunnel_id = id.clone();
            let task_tx = cmd_tx.clone();
            let task_session_id = session_id.to_string();
            let local_task = tokio::spawn(async move {
                loop {
                    match listener.accept().await {
                        Ok((stream, peer)) => {
                            let msg = SessionCommand::TunnelAccepted {
                                tunnel_id: tunnel_id.clone(),
                                stream,
                                peer_host: peer.ip().to_string(),
                                peer_port: peer.port() as u32,
                            };
                            if task_tx.send(msg).is_err() {
                                break;
                            }
                        }
                        Err(err) => {
                            let _ = app_handle.emit(
                                &format!("ssh-error-{}", task_session_id),
                                format!("Listener de túnel cerrado: {err}"),
                            );
                            break;
                        }
                    }
                }
            });

            let info = SshTunnelInfo {
                id: id.clone(),
                name: config.name,
                tunnel_type: config.tunnel_type,
                bind_host,
                local_port: local_addr.port(),
                remote_host: config.remote_host,
                remote_port: config.remote_port,
                status: "running".into(),
                bytes_up: 0,
                bytes_down: 0,
            };
            tunnels.insert(id, ActiveTunnel::from_info(info.clone(), Some(local_task)));
            Ok(info)
        }
        SshTunnelType::Remote => {
            let remote_port = config
                .remote_port
                .filter(|p| *p > 0)
                .ok_or_else(|| "El túnel remoto requiere puerto remoto".to_string())?;
            let local_host = config
                .remote_host
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("127.0.0.1")
                .to_string();
            if config.local_port == 0 {
                return Err("El túnel remoto requiere puerto local de destino".into());
            }

            let returned_port = handle
                .tcpip_forward(bind_host.clone(), remote_port as u32)
                .await
                .map_err(|e| format!("El servidor rechazó el túnel remoto: {e}"))?;
            let returned_port = if returned_port == 0 {
                remote_port as u32
            } else {
                returned_port
            };

            if let Ok(mut map) = remote_forwards.lock() {
                map.insert(
                    (bind_host.clone(), returned_port),
                    host_keys::RemoteForwardTarget {
                        host: local_host.clone(),
                        port: config.local_port,
                        session_id: session_id.to_string(),
                        tunnel_id: id.clone(),
                        app_handle: app_handle.clone(),
                    },
                );
            }

            let info = SshTunnelInfo {
                id: id.clone(),
                name: config.name,
                tunnel_type: SshTunnelType::Remote,
                bind_host,
                local_port: config.local_port,
                remote_host: Some(local_host),
                remote_port: Some(returned_port as u16),
                status: "running".into(),
                bytes_up: 0,
                bytes_down: 0,
            };
            tunnels.insert(id, ActiveTunnel::from_info(info.clone(), None));
            Ok(info)
        }
    }
}

async fn stop_tunnel_runtime(
    handle: &mut client::Handle<host_keys::KnownHostsClient>,
    tunnels: &mut HashMap<String, ActiveTunnel>,
    remote_forwards: host_keys::RemoteForwardMap,
    tunnel_id: &str,
) -> Result<(), String> {
    let Some(tunnel) = tunnels.remove(tunnel_id) else {
        return Ok(());
    };
    if let Some(task) = tunnel.local_task {
        task.abort();
    }
    if tunnel.info.tunnel_type == SshTunnelType::Remote {
        if let Some(remote_port) = tunnel.info.remote_port {
            let _ = handle
                .cancel_tcpip_forward(tunnel.info.bind_host.clone(), remote_port as u32)
                .await;
            if let Ok(mut map) = remote_forwards.lock() {
                map.remove(&(tunnel.info.bind_host, remote_port as u32));
            }
        }
    }
    Ok(())
}

async fn read_socks5_target(mut stream: TcpStream) -> std::io::Result<(TcpStream, String, u16)> {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "SOCKS no soportado",
        ));
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await?;
    stream.write_all(&[0x05, 0x00]).await?;

    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await?;
    if req[0] != 0x05 || req[1] != 0x01 {
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "SOCKS solo soporta CONNECT",
        ));
    }

    let host = match req[3] {
        0x01 => {
            let mut ip = [0u8; 4];
            stream.read_exact(&mut ip).await?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        0x04 => {
            let mut ip = [0u8; 16];
            stream.read_exact(&mut ip).await?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        _ => {
            let _ = stream
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ATYP SOCKS inválido",
            ));
        }
    };
    let mut port_bytes = [0u8; 2];
    stream.read_exact(&mut port_bytes).await?;
    let port = u16::from_be_bytes(port_bytes);
    stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await?;
    Ok((stream, host, port))
}

async fn pump_tunnel(
    mut channel: russh::Channel<russh::client::Msg>,
    stream: TcpStream,
    session_id: String,
    tunnel_id: String,
    app_handle: AppHandle,
) {
    let (mut local_rx, mut local_tx) = tokio::io::split(stream);
    let mut buf = vec![0u8; 16384];
    let mut bytes_up = 0u64;
    let mut bytes_down = 0u64;
    loop {
        tokio::select! {
            read = local_rx.read(&mut buf) => {
                match read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if channel.data(&buf[..n]).await.is_err() {
                            break;
                        }
                        bytes_up = bytes_up.saturating_add(n as u64);
                        let _ = app_handle.emit(
                            &format!("ssh-tunnel-traffic-{}", session_id),
                            SshTunnelTrafficEvent { id: tunnel_id.clone(), bytes_up, bytes_down },
                        );
                    }
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if local_tx.write_all(&data).await.is_err() {
                            break;
                        }
                        bytes_down = bytes_down.saturating_add(data.len() as u64);
                        let _ = app_handle.emit(
                            &format!("ssh-tunnel-traffic-{}", session_id),
                            SshTunnelTrafficEvent { id: tunnel_id.clone(), bytes_up, bytes_down },
                        );
                    }
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => break,
                    Some(_) => {}
                    None => break,
                }
            }
        }
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
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
    if !keys
        .iter()
        .any(|k| matches!(k, Algorithm::Rsa { hash: None }))
    {
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

/// Parsea un spec de jump host con formato `[user@]host[:port]`.
/// Si el `user` no se especifica, hereda el del perfil destino. Puerto por
/// defecto: 22.
fn parse_jump_spec(spec: &str, default_user: &str) -> (String, String, u16) {
    let s = spec.trim();
    let (user, rest) = match s.split_once('@') {
        Some((u, r)) => (u.to_string(), r),
        None => (default_user.to_string(), s),
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => {
            let port: u16 = p.parse().unwrap_or(22);
            (h.to_string(), port)
        }
        None => (rest.to_string(), 22u16),
    };
    (user, host, port)
}

/// Autentica un `client::Handle` aplicando el `auth_type` con las credenciales
/// dadas. Reusable para el bastion (ProxyJump) y para el destino. La auth por
/// clave pública requiere `key_path`.
async fn authenticate_handle(
    handle: &mut client::Handle<host_keys::KnownHostsClient>,
    auth_type: &AuthType,
    username: &str,
    password: Option<&String>,
    passphrase: Option<&String>,
    key_path: Option<&str>,
) -> Result<AuthResult, AppError> {
    match auth_type {
        AuthType::Password => {
            let pass = password
                .cloned()
                .ok_or_else(|| AppError::Auth("Se requiere contraseña".into()))?;
            handle
                .authenticate_password(username.to_string(), pass)
                .await
                .map_err(|e| AppError::Auth(format!("Autenticación por contraseña fallida: {e}")))
        }
        AuthType::PublicKey => {
            let key_path = key_path
                .ok_or_else(|| AppError::Auth("Se requiere ruta de clave privada".into()))?;
            let key = load_secret_key(Path::new(key_path), passphrase.map(|s| s.as_str()))
                .map_err(|e| AppError::Auth(format!("Clave inválida: {e}")))?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            handle
                .authenticate_publickey(
                    username.to_string(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| AppError::Auth(format!("Autenticación por clave fallida: {e}")))
        }
        AuthType::Agent => authenticate_with_agent(handle, username).await,
    }
}

/// Genera una cookie hex aleatoria de 16 bytes para MIT-MAGIC-COOKIE-1.
fn generate_x11_cookie() -> String {
    use sha2::Digest;
    let nonce = uuid::Uuid::new_v4();
    let digest = sha2::Sha256::digest(nonce.as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}
