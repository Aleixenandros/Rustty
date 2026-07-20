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
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use zeroize::Zeroizing;

use crate::locks::MutexExt;
use std::thread;
use std::time::Duration;

use std::borrow::Cow;

use russh::client::{self, AuthResult};
use russh::keys::ssh_key::Algorithm;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{cipher, kex, mac, ChannelMsg, Preferred};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::host_keys;
use crate::ipc::{event_name, EventKind};
use crate::profiles::{AuthType, ConnectionProfile, SshTunnelType};

/// Timeout TCP por defecto al abrir la conexión inicial. Sin techo russh
/// puede colgarse minutos si el destino no responde (puerto filtrado, host
/// inalcanzable). 30 s es agresivo pero permite reintentos rápidos.
pub(crate) const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Intervalo SSH keepalive cuando el perfil no especifica `keep_alive_secs`.
/// 30 s es suficientemente frecuente para mantener vivas conexiones detrás de
/// NAT con timeout típico de 60-120 s.
pub(crate) const DEFAULT_SSH_KEEPALIVE_SECS: u64 = 30;
/// Tras N keepalives sin respuesta russh tira la conexión. Con keepalive_max=4
/// y un intervalo de 30 s sobrevivimos a ~2 min de microcortes antes de
/// declarar la sesión muerta.
pub(crate) const DEFAULT_SSH_KEEPALIVE_MAX: usize = 4;
/// Intentos del connect inicial. Con backoff 1s/2s/4s la latencia añadida en
/// el peor caso es ~7 s.
pub(crate) const TCP_CONNECT_MAX_ATTEMPTS: u32 = 3;

/// Umbral de coalescing del caudal SSH. `russh` entrega `ChannelMsg::Data` de
/// tamaño variable (a menudo < 32 KiB); acumulamos bytes contiguos hasta este
/// tamaño antes de enviarlos por el `Channel` para cruzar holgadamente el
/// umbral del canal binario nativo de Tauri (1 KiB) y reducir el nº de mensajes
/// IPC en salidas masivas (`cat` de un log grande, `journalctl -f`, `yes`).
const SSH_DATA_FLUSH_THRESHOLD: usize = 32 * 1024;
/// Ventana de inactividad tras la cual se vacía el buffer aunque no se haya
/// alcanzado el umbral. Mantiene la latencia del eco interactivo imperceptible
/// (un frame son ~16 ms) sin penalizar el coalescing de ráfagas: durante una
/// ráfaga continua el temporizador se reinicia y domina el corte por tamaño.
const SSH_DATA_FLUSH_QUIET: Duration = Duration::from_millis(4);

/// Tiempo máximo para que un cliente SOCKS complete el handshake. El handshake
/// corre en su propia tarea, pero sin techo un cliente que conecta y calla
/// (preconexión de navegador, escáner de puertos) acumularía tareas y sockets
/// abiertos indefinidamente.
const SOCKS5_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Tiempo máximo de espera del open de canal direct-tcpip. Se espera dentro del
/// bucle de sesión (el `Handle` russh no es clonable), así que debe estar
/// acotado para que un servidor que no responde al open no congele el terminal.
const TUNNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// Abre un `TcpStream` al destino con SO_KEEPALIVE activo y timeout. La
/// detección de microcortes a nivel SO (TCP_KEEPIDLE/INTVL) complementa al
/// keepalive de SSH cuando el peer no responde a paquetes de aplicación.
pub(crate) async fn tcp_connect_robust(addr: &str) -> Result<TcpStream, String> {
    let stream = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| format!("Timeout TCP conectando a {addr}"))?
        .map_err(|e| format!("TCP {addr}: {e}"))?;
    apply_socket_keepalive(&stream);
    Ok(stream)
}

/// Reemplazo drop-in de `client::connect(config, addr, handler)` que aplica
/// TCP keepalive del SO + timeout antes de delegar en `connect_stream`. Mismo
/// tipo de retorno que `client::connect` para no romper los call-sites.
pub(crate) async fn russh_connect_addr<H>(
    config: Arc<client::Config>,
    addr: &str,
    handler: H,
) -> Result<client::Handle<H>, russh::Error>
where
    H: client::Handler<Error = russh::Error> + Send + 'static,
{
    let stream = tcp_connect_robust(addr)
        .await
        .map_err(|e| russh::Error::IO(std::io::Error::other(e)))?;
    client::connect_stream(config, stream, handler).await
}

/// Activa SO_KEEPALIVE con probes a 30 s de idle y 15 s entre probes en
/// plataformas donde socket2 lo soporta. Cualquier fallo se ignora: el
/// socket sigue funcionando, solo perdemos la detección temprana de cortes.
fn apply_socket_keepalive(stream: &TcpStream) {
    use socket2::{SockRef, TcpKeepalive};
    let sock = SockRef::from(stream);
    let _ = sock.set_tcp_nodelay(true);
    let mut ka = TcpKeepalive::new().with_time(Duration::from_secs(30));
    // `with_interval` y `with_retries` no están disponibles en todas las
    // plataformas; aplicamos lo que el target permita.
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "freebsd",
        target_os = "android",
        target_os = "windows"
    ))]
    {
        ka = ka.with_interval(Duration::from_secs(15));
    }
    #[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "android"))]
    {
        ka = ka.with_retries(4);
    }
    let _ = sock.set_tcp_keepalive(&ka);
}

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
        &event_name(EventKind::SshLog, session_id),
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
    /// Activa/desactiva en vivo el keepalive de la sesión. `Some(n>0)` envía un
    /// `keepalive@openssh.com` cada `n` segundos; `None` o `Some(0)` lo apaga.
    SetKeepAlive(Option<u32>),
    /// Conexión TCP aceptada por un listener local o SOCKS.
    TunnelAccepted {
        tunnel_id: String,
        stream: TcpStream,
        peer_host: String,
        peer_port: u32,
    },
    /// Conexión SOCKS con el handshake ya resuelto en su propia tarea (fuera
    /// del bucle de sesión). Uso interno; nunca llega del frontend.
    TunnelHandshaken {
        tunnel_id: String,
        stream: TcpStream,
        target_host: String,
        target_port: u16,
        peer_host: String,
        peer_port: u32,
    },
}

// ─── Handle de sesión ────────────────────────────────────────────────────────

struct SessionHandle {
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
}

// ─── Estado global gestionado por Tauri ─────────────────────────────────────

/// Todo lo que define una sesión SSH desde que se pide hasta que muere.
///
/// Estos seis valores viajaban sueltos por `connect` → `run_session_with_reconnect`
/// → `run_session` (que por eso rebasaban el límite de argumentos de clippy) y se
/// re-clonaban uno a uno en cada reintento de reconexión. Agrupados, el bucle de
/// reconexión clona **una** cosa y no puede olvidarse de ninguno.
#[derive(Clone)]
pub struct SessionSpec {
    pub session_id: String,
    pub profile: ConnectionProfile,
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub app_handle: AppHandle,
    /// Canal binario del caudal del terminal (lo crea el frontend antes del invoke).
    pub on_data: Channel<Response>,
    /// Tamaño real del terminal en el momento de conectar (`terminal.cols/rows`
    /// de xterm.js, ya medido por `fitAddon.fit()` antes del invoke). Se pide
    /// como tamaño **inicial** del PTY: sin esto, `request_pty` usaba un 80x24
    /// fijo y cualquier salida remota impresa antes de que llegara el primer
    /// resize (MOTD, banners, comandos lanzados en el arranque de la shell)
    /// se formateaba para un terminal mucho más estrecho del real.
    pub cols: u32,
    pub rows: u32,
}

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
    /// Los bytes del servidor (stdout + stderr) se entregan por `on_data`
    /// (`tauri::ipc::Channel`, binario, con coalescing). El resto del protocolo
    /// se notifica al frontend con eventos Tauri:
    ///   - `ssh-connected-{id}` : conexión establecida
    ///   - `ssh-log-{id}`       : etapa de diagnóstico de conexión
    ///   - `ssh-error-{id}`     : error de conexión/autenticación
    ///   - `ssh-reconnecting-{id}` : intentando reconectar (payload: número de intento)
    ///   - `ssh-closed-{id}`    : sesión terminada
    pub fn connect(&self, spec: SessionSpec, default_log_dir: PathBuf) -> Result<(), AppError> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
        let worker_cmd_tx = cmd_tx.clone();

        let session_id = spec.session_id.clone();
        let sid = spec.session_id.clone();
        let ah = spec.app_handle.clone();

        thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ah.emit(
                        &event_name(EventKind::SshError, &sid),
                        format!("No se pudo crear runtime tokio: {e}"),
                    );
                    let _ = ah.emit(&event_name(EventKind::SshClosed, &sid), "");
                    return;
                }
            };
            rt.block_on(run_session_with_reconnect(
                spec,
                cmd_rx,
                worker_cmd_tx,
                default_log_dir,
            ));
            let _ = ah.emit(&event_name(EventKind::SshClosed, &sid), "");
        });

        self.sessions
            .lock_recover()
            .insert(session_id, SessionHandle { cmd_tx });

        Ok(())
    }

    /// Envía bytes de entrada (teclas del usuario) a la sesión activa
    pub fn send_input(&self, session_id: &str, data: Vec<u8>) -> Result<(), AppError> {
        let sessions = self.sessions.lock_recover();
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
        let sessions = self.sessions.lock_recover();
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        handle
            .cmd_tx
            .send(SessionCommand::Resize { cols, rows })
            .map_err(|_| AppError::SessionNotFound(session_id.to_string()))
    }

    /// Activa/desactiva en vivo el keepalive de una sesión (segundos; `None`/`0`
    /// = desactivado). Tiene efecto inmediato sobre la sesión en curso y se
    /// conserva a través de reconexiones automáticas.
    pub fn set_keep_alive(&self, session_id: &str, secs: Option<u32>) -> Result<(), AppError> {
        let sessions = self.sessions.lock_recover();
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        handle
            .cmd_tx
            .send(SessionCommand::SetKeepAlive(secs))
            .map_err(|_| AppError::SessionNotFound(session_id.to_string()))
    }

    pub async fn start_tunnel(
        &self,
        session_id: &str,
        config: SshTunnelConfig,
    ) -> Result<SshTunnelInfo, String> {
        let cmd_tx = {
            let sessions = self.sessions.lock_recover();
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
            let sessions = self.sessions.lock_recover();
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

    /// Cierra y elimina una sesión del mapa de estado
    pub fn disconnect(&self, session_id: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock_recover();
        if let Some(handle) = sessions.remove(session_id) {
            let _ = handle.cmd_tx.send(SessionCommand::Disconnect);
        }
        Ok(())
    }

    pub fn disconnect_all(&self) {
        let handles: Vec<_> = self
            .sessions
            .lock_recover()
            .drain()
            .map(|(_, h)| h)
            .collect();
        for handle in handles {
            let _ = handle.cmd_tx.send(SessionCommand::Disconnect);
        }
    }
}

pub async fn test_connection(
    test_id: String,
    profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    // Redacción defensiva del mensaje de error de prueba antes de devolverlo al
    // frontend (toast): ningún error actual interpola la credencial, pero
    // enmascaramos por si una capa inferior llegara a hacerlo.
    // `Zeroizing`: estas copias del secreto (para redacción) se borran de memoria
    // al liberarse, en vez de quedar en el heap tras el drop.
    let secret_values: Vec<Zeroizing<String>> = [password.clone(), passphrase.clone()]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .map(Zeroizing::new)
        .collect();
    run_connection_test(test_id, profile, password, passphrase, app_handle)
        .await
        .map_err(|e| crate::subst::redact_secrets(&e.to_string(), &secret_values))
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
    spec: SessionSpec,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    default_log_dir: PathBuf,
) {
    let SessionSpec {
        session_id,
        profile,
        password,
        passphrase,
        app_handle,
        ..
    } = spec.clone();
    let max_attempts = profile.auto_reconnect.unwrap_or(0);
    let mut attempt: u32 = 0;
    let log_path = if profile.session_log {
        Some(resolve_log_path(&profile, &default_log_dir))
    } else {
        None
    };
    // Valores secretos efectivamente usados en esta sesión (contraseña/passphrase
    // resueltas, que pueden venir de `${master:}`/`${secret:}`). Se usan para
    // redactar defensivamente cualquier mensaje de error antes de emitirlo a un
    // canal no confiable, por si una capa inferior llegara a interpolarlos.
    // `Zeroizing`: estas copias del secreto (para redacción) se borran de memoria
    // al liberarse, en vez de quedar en el heap tras el drop.
    let secret_values: Vec<Zeroizing<String>> = [password.clone(), passphrase.clone()]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .map(Zeroizing::new)
        .collect();

    // Estado de keepalive compartido con el worker: el toggle en vivo lo escribe
    // aquí para que sobreviva a las reconexiones automáticas (que reconstruyen
    // el worker). 0 = desactivado. Valor inicial: el del perfil (por defecto off).
    let keepalive_secs = Arc::new(AtomicU32::new(
        profile.keep_alive_secs.filter(|s| *s > 0).unwrap_or(0),
    ));

    loop {
        let exit = run_session(
            spec.clone(),
            &mut cmd_rx,
            cmd_tx.clone(),
            log_path.clone(),
            keepalive_secs.clone(),
        )
        .await;

        match exit {
            SessionExit::UserDisconnect => return,
            SessionExit::Fatal(err) => {
                // Redacción defensiva: ningún error actual interpola la
                // credencial, pero enmascaramos por si una capa inferior lo
                // hiciera, para no filtrar el valor a log/eventos.
                let msg = crate::subst::redact_secrets(&err.to_string(), &secret_values);
                emit_connection_log(&app_handle, &session_id, "error", "error", msg.clone());
                let _ = app_handle.emit(&event_name(EventKind::SshError, &session_id), msg);
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
                    &event_name(EventKind::SshReconnecting, &session_id),
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

async fn run_connection_test(
    test_id: String,
    profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    app_handle: AppHandle,
) -> Result<(), AppError> {
    let preferred = if profile.allow_legacy_algorithms {
        legacy_preferred(profile.legacy_algorithms.as_deref())
    } else {
        Preferred::default()
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(DEFAULT_SSH_KEEPALIVE_SECS)),
        keepalive_max: DEFAULT_SSH_KEEPALIVE_MAX,
        preferred,
        ..Default::default()
    });
    let addr = format!("{}:{}", profile.host, profile.port);
    let proxy_spec = profile
        .proxy_jump
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    emit_connection_log(
        &app_handle,
        &test_id,
        "resolving",
        "info",
        format!("Resolviendo {}:{}", profile.host, profile.port),
    );

    let mut handle = if let Some(spec) = proxy_spec {
        let (b_user, b_host, b_port) = parse_jump_spec(spec, &profile.username);
        let bastion_addr = format!("{}:{}", b_host, b_port);
        let (bastion_handler, bastion_failure) =
            host_keys::client(b_host.clone(), b_port, false, false);

        emit_connection_log(
            &app_handle,
            &test_id,
            "connecting",
            "info",
            format!("Conectando al bastion {bastion_addr}"),
        );
        emit_connection_log(
            &app_handle,
            &test_id,
            "verifying_host_key",
            "info",
            format!("Verificando host key del bastion {b_host}:{b_port}"),
        );
        let mut bastion = russh_connect_addr(config.clone(), &bastion_addr, bastion_handler)
            .await
            .map_err(|err| {
                host_keys::take_failure(&bastion_failure)
                    .map(AppError::Auth)
                    .unwrap_or_else(|| {
                        AppError::Io(format!(
                            "No se puede conectar al bastion {bastion_addr}: {err}"
                        ))
                    })
            })?;
        emit_connection_log(
            &app_handle,
            &test_id,
            "connecting",
            "ok",
            format!("Bastion conectado: {bastion_addr}"),
        );

        emit_connection_log(
            &app_handle,
            &test_id,
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
        .await?
        {
            AuthResult::Success => {}
            AuthResult::Failure {
                remaining_methods, ..
            } => {
                return Err(AppError::Auth(format!(
                    "Autenticación contra bastion fallida. Métodos restantes: {:?}",
                    remaining_methods
                )));
            }
        }
        emit_connection_log(
            &app_handle,
            &test_id,
            "authenticating",
            "ok",
            "Autenticación contra bastion completada",
        );

        emit_connection_log(
            &app_handle,
            &test_id,
            "connecting",
            "info",
            format!("Abriendo túnel del bastion hacia {addr}"),
        );
        let chan = bastion
            .channel_open_direct_tcpip(
                profile.host.clone(),
                profile.port as u32,
                "127.0.0.1".to_string(),
                0,
            )
            .await
            .map_err(|e| {
                AppError::Ssh(format!(
                    "No se pudo abrir canal direct-tcpip a través del bastion: {e}"
                ))
            })?;
        let stream = chan.into_stream();
        let (target_handler, target_failure) = host_keys::client(
            profile.host.clone(),
            profile.port,
            profile.agent_forwarding,
            profile.x11_forwarding,
        );
        emit_connection_log(
            &app_handle,
            &test_id,
            "verifying_host_key",
            "info",
            format!("Verificando host key de {addr}"),
        );
        client::connect_stream(config, stream, target_handler)
            .await
            .map_err(|err| {
                host_keys::take_failure(&target_failure)
                    .map(AppError::Auth)
                    .unwrap_or_else(|| {
                        AppError::Io(format!(
                            "No se puede establecer SSH con {addr} a través del bastion: {err}"
                        ))
                    })
            })?
    } else {
        let (client_handler, host_key_failure) = host_keys::client(
            profile.host.clone(),
            profile.port,
            profile.agent_forwarding,
            profile.x11_forwarding,
        );
        emit_connection_log(
            &app_handle,
            &test_id,
            "connecting",
            "info",
            format!("Conectando a {addr}"),
        );
        emit_connection_log(
            &app_handle,
            &test_id,
            "verifying_host_key",
            "info",
            format!("Verificando host key de {addr}"),
        );
        russh_connect_addr(config, &addr, client_handler)
            .await
            .map_err(|err| {
                host_keys::take_failure(&host_key_failure)
                    .map(AppError::Auth)
                    .unwrap_or_else(|| {
                        AppError::Io(format!("No se puede conectar a {addr}: {err}"))
                    })
            })?
    };

    emit_connection_log(
        &app_handle,
        &test_id,
        "connecting",
        "ok",
        format!("TCP/SSH establecido con {addr}"),
    );
    emit_connection_log(
        &app_handle,
        &test_id,
        "authenticating",
        "info",
        format!("Autenticando como {}", profile.username),
    );
    match authenticate_handle(
        &mut handle,
        &profile.auth_type,
        &profile.username,
        password.as_ref(),
        passphrase.as_ref(),
        profile.key_path.as_deref(),
    )
    .await?
    {
        AuthResult::Success => {}
        AuthResult::Failure {
            remaining_methods, ..
        } => {
            return Err(AppError::Auth(format!(
                "Autenticación fallida. Métodos restantes: {:?}",
                remaining_methods
            )));
        }
    }

    emit_connection_log(
        &app_handle,
        &test_id,
        "authenticating",
        "ok",
        "Autenticación completada",
    );
    emit_connection_log(
        &app_handle,
        &test_id,
        "opening_shell",
        "info",
        "Comprobando apertura de canal SSH/SFTP",
    );
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("No se pudo abrir canal: {e}")))?;
    match channel.request_subsystem(true, "sftp").await {
        Ok(()) => match SftpSession::new(channel.into_stream()).await {
            Ok(sftp) => {
                let _ = sftp.close().await;
                emit_connection_log(
                    &app_handle,
                    &test_id,
                    "opening_shell",
                    "ok",
                    "Subsistema SFTP disponible",
                );
            }
            Err(e) => {
                emit_connection_log(
                    &app_handle,
                    &test_id,
                    "opening_shell",
                    "warning",
                    format!("SSH válido, pero SFTP no inició: {e}"),
                );
            }
        },
        Err(e) => {
            emit_connection_log(
                &app_handle,
                &test_id,
                "opening_shell",
                "warning",
                format!("SSH válido, pero SFTP no está disponible: {e}"),
            );
        }
    }
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    emit_connection_log(
        &app_handle,
        &test_id,
        "connected",
        "ok",
        "Prueba SSH completada",
    );
    Ok(())
}

/// Abre (creando si hace falta) el log de sesión en modo append.
///
/// El fichero guarda la salida del terminal: contraseñas tecleadas por un
/// `sudo` que no ecoa no, pero sí claves mostradas por pantalla, tokens, rutas y
/// nombres internos. Es contenido privado y se crea **0600** en Unix
/// (`OpenOptionsExt::mode`), sin depender del `umask` del usuario, que podría
/// dejarlo legible por todo el sistema (`0644` con umask 022 es lo habitual).
/// Como `mode()` solo aplica a la creación, un log ya existente con permisos más
/// laxos (creado por una versión anterior de Rustty) se endurece al abrirlo.
///
/// En Windows la confidencialidad se apoya en el ACL del directorio del perfil
/// del usuario, igual que el resto de ficheros de la app (mismo límite
/// documentado en `atomic_file`).
async fn open_session_log(path: &Path) -> Option<tokio::fs::File> {
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut opts = tokio::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let file = opts.open(path).await.ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = file.metadata().await {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ =
                    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
            }
        }
    }
    Some(file)
}

/// Crea el temporizador de keepalive de aplicación: `Some(interval)` que dispara
/// cada `secs` segundos (el primer disparo a los `secs` s, no inmediato), o
/// `None` si `secs == 0` (desactivado).
fn make_keepalive_timer(secs: u32) -> Option<tokio::time::Interval> {
    if secs == 0 {
        return None;
    }
    let period = Duration::from_secs(secs as u64);
    let mut it = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    it.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    Some(it)
}

async fn run_session(
    spec: SessionSpec,
    cmd_rx: &mut mpsc::UnboundedReceiver<SessionCommand>,
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    log_path: Option<PathBuf>,
    keepalive_secs: Arc<AtomicU32>,
) -> SessionExit {
    let SessionSpec {
        session_id,
        profile,
        password,
        passphrase,
        app_handle,
        on_data,
        cols,
        rows,
    } = spec;
    // Defensivo: un pane aún no medido podría mandar 0. `request_pty` con 0
    // columnas dejaría al shell remoto sin poder formatear nada.
    let (cols, rows) = if cols == 0 || rows == 0 { (80, 24) } else { (cols, rows) };
    // Si está activado el log de sesión, abrimos el fichero en modo append.
    let mut log_file = match &log_path {
        Some(p) => open_session_log(p).await,
        None => None,
    };

    // 1. TCP + handshake SSH
    // El keepalive es de nivel de aplicación (ver el bucle de E/S): se envía
    // `keepalive@openssh.com` desde el worker según `keepalive_secs`, togglable
    // en vivo. Por eso el keepalive interno de russh queda desactivado aquí;
    // así apagar el keepalive tiene efecto inmediato (el de russh es fijo al
    // conectar y no se puede parar en caliente).
    let preferred = if profile.allow_legacy_algorithms {
        legacy_preferred(profile.legacy_algorithms.as_deref())
    } else {
        Preferred::default()
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        keepalive_interval: None,
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
            match russh_connect_addr(config.clone(), &bastion_addr, bastion_handler).await {
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
                        &event_name(EventKind::SshError, &session_id),
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
            Ok(AuthResult::Failure {
                remaining_methods, ..
            }) => {
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
        // Reintento del connect inicial con backoff. Solo reintentamos
        // errores de transporte (timeout TCP, "connection refused", etc.). Un
        // fallo de host key es fatal y se sale inmediatamente.
        let mut handle_opt = None;
        let mut last_err: String = String::new();
        let mut current_handler = Some(client_handler);
        let mut current_failure = Some(host_key_failure);
        for attempt in 0..TCP_CONNECT_MAX_ATTEMPTS {
            let handler = current_handler.take().unwrap();
            let failure = current_failure.take().unwrap();
            match russh_connect_addr(config.clone(), &addr, handler).await {
                Ok(h) => {
                    handle_opt = Some(h);
                    break;
                }
                Err(err) => {
                    if let Some(reason) = host_keys::take_failure(&failure) {
                        return SessionExit::Fatal(AppError::Auth(reason));
                    }
                    last_err = err.to_string();
                    if attempt + 1 < TCP_CONNECT_MAX_ATTEMPTS {
                        let backoff = Duration::from_secs(1u64 << attempt);
                        emit_connection_log(
                            &app_handle,
                            &session_id,
                            "connecting",
                            "warning",
                            format!(
                                "Intento {} fallido ({last_err}). Reintentando en {}s…",
                                attempt + 1,
                                backoff.as_secs()
                            ),
                        );
                        tokio::time::sleep(backoff).await;
                        let next = host_keys::client_with_remote_forwards(
                            profile.host.clone(),
                            profile.port,
                            profile.agent_forwarding,
                            profile.x11_forwarding,
                            remote_forwards.clone(),
                        );
                        current_handler = Some(next.0);
                        current_failure = Some(next.1);
                    }
                }
            }
        }
        match handle_opt {
            Some(h) => {
                emit_connection_log(
                    &app_handle,
                    &session_id,
                    "connecting",
                    "ok",
                    format!("TCP/SSH establecido con {addr}"),
                );
                h
            }
            None => {
                emit_connection_log(
                    &app_handle,
                    &session_id,
                    "connecting",
                    "error",
                    format!("No se puede conectar a {addr}: {last_err}"),
                );
                let _ = app_handle.emit(
                    &event_name(EventKind::SshError, &session_id),
                    format!("No se puede conectar a {addr}: {last_err}"),
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
        AuthResult::Failure {
            remaining_methods, ..
        } => {
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
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
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
    let _ = app_handle.emit(
        &event_name(EventKind::SshConnected, &session_id),
        &profile.name,
    );

    // 4. Bucle de E/S: multiplexa datos del servidor y comandos del frontend
    let mut exit_kind = SessionExit::ServerClosed;
    let mut tunnels: HashMap<String, ActiveTunnel> = HashMap::new();
    // Buffer de coalescing del caudal de salida. Acumula bytes contiguos
    // (stdout + stderr, en orden de llegada) y los entrega por `on_data` cuando
    // supera el umbral o tras una breve ventana de inactividad. Ver
    // `SSH_DATA_FLUSH_THRESHOLD` / `SSH_DATA_FLUSH_QUIET`.
    let mut out_buf: Vec<u8> = Vec::with_capacity(SSH_DATA_FLUSH_THRESHOLD);
    // Keepalive de aplicación togglable en vivo (ver `SessionCommand::SetKeepAlive`).
    // A 0 el temporizador queda inerte y su rama del `select!` se desactiva.
    let mut ka_timer = make_keepalive_timer(keepalive_secs.load(Ordering::Relaxed));
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if let Some(f) = log_file.as_mut() {
                            let _ = f.write_all(&data).await;
                        }
                        out_buf.extend_from_slice(&data);
                        if out_buf.len() >= SSH_DATA_FLUSH_THRESHOLD {
                            let _ = on_data.send(Response::new(std::mem::take(&mut out_buf)));
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        // stderr → lo mezclamos con stdout, como hacía ssh2.
                        if let Some(f) = log_file.as_mut() {
                            let _ = f.write_all(&data).await;
                        }
                        out_buf.extend_from_slice(&data);
                        if out_buf.len() >= SSH_DATA_FLUSH_THRESHOLD {
                            let _ = on_data.send(Response::new(std::mem::take(&mut out_buf)));
                        }
                    }
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => break,
                    Some(_) => {}
                    None => break,
                }
            }
            // Vaciado por inactividad: si hay datos pendientes y el caudal se
            // detiene durante `SSH_DATA_FLUSH_QUIET`, los entregamos sin esperar
            // a llenar el umbral. Durante una ráfaga continua el temporizador se
            // reinicia en cada iteración y nunca llega a dispararse.
            _ = tokio::time::sleep(SSH_DATA_FLUSH_QUIET), if !out_buf.is_empty() => {
                let _ = on_data.send(Response::new(std::mem::take(&mut out_buf)));
            }
            // Keepalive de aplicación: cuando está activo enviamos un
            // `keepalive@openssh.com` (sin pedir respuesta) para mantener viva la
            // conexión frente a NAT/idle. La rama se apaga con `ka_timer == None`.
            _ = async { ka_timer.as_mut().unwrap().tick().await }, if ka_timer.is_some() => {
                let _ = handle.send_keepalive(false).await;
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCommand::Input(data)) => {
                        let _ = channel.data(&data[..]).await;
                    }
                    Some(SessionCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SessionCommand::SetKeepAlive(secs)) => {
                        let n = secs.filter(|s| *s > 0).unwrap_or(0);
                        keepalive_secs.store(n, Ordering::Relaxed);
                        ka_timer = make_keepalive_timer(n);
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
                    Some(SessionCommand::TunnelAccepted { tunnel_id, stream, peer_host, peer_port }) => {
                        if let Some(tunnel) = tunnels.get(&tunnel_id) {
                            let info = tunnel.info.clone();
                            if info.tunnel_type == SshTunnelType::Dynamic {
                                // El handshake SOCKS se resuelve en su propia
                                // tarea: un cliente que conecta y no envía el
                                // greeting (preconexión de navegador, escáner)
                                // no debe congelar la E/S de la sesión. El
                                // resultado vuelve como `TunnelHandshaken`.
                                let task_tx = cmd_tx.clone();
                                tokio::spawn(async move {
                                    // Handshake inválido o timeout: se descarta
                                    // la conexión en silencio.
                                    if let Ok(Ok((stream, host, port))) = tokio::time::timeout(
                                        SOCKS5_HANDSHAKE_TIMEOUT,
                                        read_socks5_target(stream),
                                    )
                                    .await
                                    {
                                        let _ = task_tx.send(SessionCommand::TunnelHandshaken {
                                            tunnel_id,
                                            stream,
                                            target_host: host,
                                            target_port: port,
                                            peer_host,
                                            peer_port,
                                        });
                                    }
                                });
                            } else if info.tunnel_type == SshTunnelType::Local {
                                if let Some((host, port)) =
                                    info.remote_host.clone().zip(info.remote_port)
                                {
                                    open_tunnel_channel(
                                        &mut handle,
                                        &session_id,
                                        &tunnel_id,
                                        stream,
                                        host,
                                        port,
                                        peer_host,
                                        peer_port,
                                        &app_handle,
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                    Some(SessionCommand::TunnelHandshaken {
                        tunnel_id,
                        stream,
                        target_host,
                        target_port,
                        peer_host,
                        peer_port,
                    }) => {
                        // El túnel puede haberse cerrado mientras se negociaba
                        // el handshake; en ese caso se descarta la conexión.
                        if tunnels.contains_key(&tunnel_id) {
                            open_tunnel_channel(
                                &mut handle,
                                &session_id,
                                &tunnel_id,
                                stream,
                                target_host,
                                target_port,
                                peer_host,
                                peer_port,
                                &app_handle,
                            )
                            .await;
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
    // Vaciar cualquier resto del buffer de coalescing antes de cerrar, para no
    // perder el último tramo de salida si el loop terminó con datos pendientes.
    if !out_buf.is_empty() {
        let _ = on_data.send(Response::new(std::mem::take(&mut out_buf)));
    }
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
                                &event_name(EventKind::SshError, &task_session_id),
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

/// Abre el canal direct-tcpip de una conexión de túnel ya resuelta y arranca el
/// bombeo de bytes. La espera del open corre dentro del bucle de sesión (el
/// `Handle` russh no es clonable), por eso se acota con `TUNNEL_OPEN_TIMEOUT`.
#[allow(clippy::too_many_arguments)]
async fn open_tunnel_channel(
    handle: &mut client::Handle<host_keys::KnownHostsClient>,
    session_id: &str,
    tunnel_id: &str,
    stream: TcpStream,
    target_host: String,
    target_port: u16,
    peer_host: String,
    peer_port: u32,
    app_handle: &AppHandle,
) {
    match tokio::time::timeout(
        TUNNEL_OPEN_TIMEOUT,
        handle.channel_open_direct_tcpip(target_host, target_port as u32, peer_host, peer_port),
    )
    .await
    {
        Ok(Ok(channel)) => {
            tokio::spawn(pump_tunnel(
                channel,
                stream,
                session_id.to_string(),
                tunnel_id.to_string(),
                app_handle.clone(),
            ));
        }
        Ok(Err(err)) => {
            let _ = app_handle.emit(
                &event_name(EventKind::SshError, session_id),
                format!("No se pudo abrir canal de túnel: {err}"),
            );
        }
        Err(_) => {
            let _ = app_handle.emit(
                &event_name(EventKind::SshError, session_id),
                "Timeout abriendo el canal de túnel".to_string(),
            );
        }
    }
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
    // Coalescing de los eventos de tráfico: en vez de emitir por cada chunk
    // (avalancha IPC en transferencias masivas), emitimos a lo sumo cada
    // TRAFFIC_MIN_INTERVAL o cada TRAFFIC_MIN_BYTES; al final se hace un flush
    // con los totales exactos.
    let event = event_name(EventKind::SshTunnelTraffic, &session_id);
    let mut last_emit = std::time::Instant::now();
    let mut last_emit_total = 0u64;
    let mut maybe_emit = |bytes_up: u64, bytes_down: u64| {
        let total = bytes_up.saturating_add(bytes_down);
        if crate::tunnel_throttle::should_emit_traffic(
            last_emit.elapsed(),
            total.saturating_sub(last_emit_total),
        ) {
            let _ = app_handle.emit(
                &event,
                SshTunnelTrafficEvent { id: tunnel_id.clone(), bytes_up, bytes_down },
            );
            last_emit = std::time::Instant::now();
            last_emit_total = total;
        }
    };
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
                        maybe_emit(bytes_up, bytes_down);
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
                        maybe_emit(bytes_up, bytes_down);
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
    // Flush final: asegura que la UI vea los totales exactos aunque el último
    // chunk no cruzara el umbral de emisión.
    if bytes_up.saturating_add(bytes_down) != last_emit_total {
        let _ = app_handle.emit(
            &event,
            SshTunnelTrafficEvent { id: tunnel_id.clone(), bytes_up, bytes_down },
        );
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
    for identity in identities {
        let key = identity.public_key().into_owned();
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
        partial_success: false,
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

/// Tipo de un algoritmo legacy del catálogo, ligado a la lista de `Preferred`
/// a la que se anexa al negociar.
enum LegacyKind {
    Cipher(cipher::Name),
    Kex(kex::Name),
    Mac(mac::Name),
    HostKey(Algorithm),
}

/// Una entrada del catálogo de algoritmos legacy. `id` es el nombre wire que se
/// persiste en el perfil y se muestra en la UI; `category` agrupa en la interfaz.
struct LegacyEntry {
    id: &'static str,
    category: &'static str,
    kind: LegacyKind,
}

/// Catálogo único de algoritmos legacy soportados (russh no implementa otros
/// como umac-64 o hmac-ripemd160, así que no pueden ofrecerse). Es la **fuente
/// de verdad** tanto de `legacy_preferred` (lo que se negocia) como del comando
/// IPC que alimenta la UI (lo que se muestra), de modo que ambos no divergen.
/// El default de russh ya no incluye hmac-sha1, por eso debe ofrecerse aquí.
fn legacy_catalog() -> Vec<LegacyEntry> {
    vec![
        LegacyEntry {
            id: "aes256-cbc",
            category: "cipher",
            kind: LegacyKind::Cipher(cipher::AES_256_CBC),
        },
        LegacyEntry {
            id: "aes192-cbc",
            category: "cipher",
            kind: LegacyKind::Cipher(cipher::AES_192_CBC),
        },
        LegacyEntry {
            id: "aes128-cbc",
            category: "cipher",
            kind: LegacyKind::Cipher(cipher::AES_128_CBC),
        },
        LegacyEntry {
            id: "3des-cbc",
            category: "cipher",
            kind: LegacyKind::Cipher(cipher::TRIPLE_DES_CBC),
        },
        LegacyEntry {
            id: "diffie-hellman-group-exchange-sha1",
            category: "kex",
            kind: LegacyKind::Kex(kex::DH_GEX_SHA1),
        },
        LegacyEntry {
            id: "diffie-hellman-group14-sha1",
            category: "kex",
            kind: LegacyKind::Kex(kex::DH_G14_SHA1),
        },
        LegacyEntry {
            id: "diffie-hellman-group1-sha1",
            category: "kex",
            kind: LegacyKind::Kex(kex::DH_G1_SHA1),
        },
        LegacyEntry {
            id: "hmac-sha1",
            category: "mac",
            kind: LegacyKind::Mac(mac::HMAC_SHA1),
        },
        LegacyEntry {
            id: "hmac-sha1-etm@openssh.com",
            category: "mac",
            kind: LegacyKind::Mac(mac::HMAC_SHA1_ETM),
        },
        LegacyEntry {
            id: "ssh-rsa",
            category: "hostkey",
            kind: LegacyKind::HostKey(Algorithm::Rsa { hash: None }),
        },
    ]
}

/// Devuelve el catálogo legacy como pares `(id, categoría)` para que la UI
/// muestre exactamente lo que `legacy_preferred` puede negociar.
pub fn legacy_catalog_info() -> Vec<(String, String)> {
    legacy_catalog()
        .into_iter()
        .map(|e| (e.id.to_string(), e.category.to_string()))
        .collect()
}

/// Construye una lista de algoritmos preferidos que conserva los modernos como
/// prioritarios pero añade variantes legacy (CBC, 3DES, DH-SHA1, HMAC-SHA1,
/// ssh-rsa) al final para poder negociar con servidores antiguos. `selected`
/// filtra el catálogo: `None` ofrece todos; `Some(ids)` solo los nombres wire
/// indicados. Los ids del catálogo que NO se seleccionan se excluyen incluso si
/// el default de russh ya los traía (caso de `ssh-rsa`), de modo que la casilla
/// tenga efecto real.
pub(crate) fn legacy_preferred(selected: Option<&[String]>) -> Preferred {
    let default = Preferred::default();
    let catalog = legacy_catalog();

    let is_selected = |id: &str| match selected {
        Some(list) => list.iter().any(|s| s == id),
        None => true,
    };
    let excluded: Vec<&'static str> = catalog
        .iter()
        .filter(|e| !is_selected(e.id))
        .map(|e| e.id)
        .collect();

    let mut cipher: Vec<cipher::Name> = default
        .cipher
        .iter()
        .copied()
        .filter(|c| !excluded.contains(&c.as_ref()))
        .collect();
    let mut kex_list: Vec<kex::Name> = default
        .kex
        .iter()
        .copied()
        .filter(|k| !excluded.contains(&k.as_ref()))
        .collect();
    let mut macs: Vec<mac::Name> = default
        .mac
        .iter()
        .copied()
        .filter(|m| !excluded.contains(&m.as_ref()))
        .collect();
    let mut keys: Vec<Algorithm> = default
        .key
        .iter()
        .filter(|k| !excluded.contains(&k.as_str()))
        .cloned()
        .collect();

    for entry in catalog {
        if !is_selected(entry.id) {
            continue;
        }
        match entry.kind {
            LegacyKind::Cipher(c) => {
                if !cipher.contains(&c) {
                    cipher.push(c);
                }
            }
            LegacyKind::Kex(k) => {
                if !kex_list.contains(&k) {
                    kex_list.push(k);
                }
            }
            LegacyKind::Mac(m) => {
                if !macs.contains(&m) {
                    macs.push(m);
                }
            }
            LegacyKind::HostKey(a) => {
                if !keys.contains(&a) {
                    keys.push(a);
                }
            }
        }
    }

    Preferred {
        kex: Cow::Owned(kex_list),
        key: Cow::Owned(keys),
        cipher: Cow::Owned(cipher),
        mac: Cow::Owned(macs),
        compression: default.compression.clone(),
    }
}

/// Parsea un spec de jump host con formato `[user@]host[:port]`. Soporta IPv6
/// entre corchetes (`[::1]:2222`, `[fe80::1]`) y IPv6 desnuda sin puerto
/// (`fe80::1`). Si el `user` no se especifica, hereda el del perfil destino.
/// Puerto por defecto: 22.
pub(crate) fn parse_jump_spec(spec: &str, default_user: &str) -> (String, String, u16) {
    let s = spec.trim();
    let (user, rest) = match s.split_once('@') {
        Some((u, r)) => (u.to_string(), r),
        None => (default_user.to_string(), s),
    };

    // IPv6 entre corchetes: `[::1]` o `[::1]:2222`.
    if let Some(inner) = rest.strip_prefix('[') {
        if let Some((host, after)) = inner.split_once(']') {
            let port = after
                .strip_prefix(':')
                .map_or(22, |p| p.parse().unwrap_or(22));
            return (user, host.to_string(), port);
        }
        // Corchete sin cerrar: lo tratamos como host literal.
        return (user, rest.to_string(), 22);
    }

    // Sin corchetes solo separamos host:puerto cuando hay un único `:`. Si la
    // parte de host aún contiene `:`, es una IPv6 desnuda (`fe80::1`), que no
    // lleva puerto y no debe partirse.
    match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (user, h.to_string(), p.parse().unwrap_or(22)),
        _ => (user, rest.to_string(), 22u16),
    }
}

/// Autentica un `client::Handle` aplicando el `auth_type` con las credenciales
/// dadas. Reusable para el bastion (ProxyJump) y para el destino. La auth por
/// clave pública requiere `key_path`.
pub(crate) async fn authenticate_handle(
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

#[cfg(test)]
mod tests {
    use super::*;

    /// El log de sesión guarda salida del terminal: debe nacer privado (0600) y
    /// no heredar un `umask` permisivo. Y si ya existía con permisos laxos (log
    /// creado por una versión anterior), abrirlo lo endurece.
    #[cfg(unix)]
    #[tokio::test]
    async fn el_log_de_sesion_se_crea_y_endurece_a_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("rustty-log-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("sesion.log");

        // 1. Creación: 0600 aunque el umask del proceso sea permisivo.
        let file = open_session_log(&path).await.expect("crea el log");
        drop(file);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "log recién creado con modo {mode:o}");

        // 2. Log heredado con permisos laxos: al abrirlo se corrige.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let file = open_session_log(&path).await.expect("reabre el log");
        drop(file);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "log reabierto con modo {mode:o}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Parser de entrada de red NO confiable: CONNECT válido con destino por
    /// nombre de dominio. El cliente recibe el `[5,0]` del método y el reply
    /// de éxito antes de que el server devuelva el objetivo parseado.
    #[tokio::test]
    async fn read_socks5_target_parsea_connect_valido() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut c = TcpStream::connect(addr).await.unwrap();
            // Greeting: VER=5, NMETHODS=1, métodos=[no-auth]
            c.write_all(&[5, 1, 0]).await.unwrap();
            let mut resp = [0u8; 2];
            c.read_exact(&mut resp).await.unwrap();
            assert_eq!(resp, [5, 0]);
            // Request: VER=5, CMD=CONNECT, RSV, ATYP=dominio, len, host, puerto
            let mut req = vec![5u8, 1, 0, 3, 11];
            req.extend_from_slice(b"example.com");
            req.extend_from_slice(&443u16.to_be_bytes());
            c.write_all(&req).await.unwrap();
            let mut ok = [0u8; 10];
            c.read_exact(&mut ok).await.unwrap();
            assert_eq!(&ok[..2], &[5, 0]);
        });
        let (stream, _) = listener.accept().await.unwrap();
        let (_stream, host, port) = read_socks5_target(stream).await.unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);
        client.await.unwrap();
    }

    /// Versión distinta de SOCKS5 y comandos que no son CONNECT deben
    /// rechazarse (el segundo con reply 0x07 «command not supported»).
    #[tokio::test]
    async fn read_socks5_target_rechaza_version_y_comando_invalidos() {
        // Versión 4: error inmediato, sin respuesta.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut c = TcpStream::connect(addr).await.unwrap();
            c.write_all(&[4, 1, 0]).await.unwrap();
        });
        let (stream, _) = listener.accept().await.unwrap();
        assert!(read_socks5_target(stream).await.is_err());
        client.await.unwrap();

        // Comando BIND (2): reply 0x07 y error.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut c = TcpStream::connect(addr).await.unwrap();
            c.write_all(&[5, 1, 0]).await.unwrap();
            let mut resp = [0u8; 2];
            c.read_exact(&mut resp).await.unwrap();
            c.write_all(&[5, 2, 0, 1, 127, 0, 0, 1, 0, 80])
                .await
                .unwrap();
            let mut reply = [0u8; 10];
            c.read_exact(&mut reply).await.unwrap();
            assert_eq!(reply[1], 0x07);
        });
        let (stream, _) = listener.accept().await.unwrap();
        assert!(read_socks5_target(stream).await.is_err());
        client.await.unwrap();
    }

    #[test]
    fn parse_jump_spec_basico_y_puerto() {
        assert_eq!(
            parse_jump_spec("host", "yo"),
            ("yo".into(), "host".into(), 22)
        );
        assert_eq!(
            parse_jump_spec("admin@host:2222", "yo"),
            ("admin".into(), "host".into(), 2222)
        );
    }

    #[test]
    fn parse_jump_spec_ipv6() {
        // IPv6 desnuda sin puerto: no debe partirse por el último `:`.
        assert_eq!(
            parse_jump_spec("fe80::1", "yo"),
            ("yo".into(), "fe80::1".into(), 22)
        );
        // IPv6 entre corchetes con y sin puerto.
        assert_eq!(
            parse_jump_spec("[::1]:2222", "yo"),
            ("yo".into(), "::1".into(), 2222)
        );
        assert_eq!(
            parse_jump_spec("user@[fe80::1]", "yo"),
            ("user".into(), "fe80::1".into(), 22)
        );
    }

    fn has_cipher(p: &Preferred, name: &str) -> bool {
        p.cipher.iter().any(|c| c.as_ref() == name)
    }
    fn has_kex(p: &Preferred, name: &str) -> bool {
        p.kex.iter().any(|k| k.as_ref() == name)
    }
    fn has_mac(p: &Preferred, name: &str) -> bool {
        p.mac.iter().any(|m| m.as_ref() == name)
    }
    fn has_key(p: &Preferred, name: &str) -> bool {
        p.key.iter().any(|k| k.as_str() == name)
    }

    fn present(p: &Preferred, category: &str, id: &str) -> bool {
        match category {
            "cipher" => has_cipher(p, id),
            "kex" => has_kex(p, id),
            "mac" => has_mac(p, id),
            "hostkey" => has_key(p, id),
            _ => false,
        }
    }

    #[test]
    fn legacy_preferred_none_includes_whole_catalog() {
        let p = legacy_preferred(None);
        for entry in legacy_catalog() {
            assert!(
                present(&p, entry.category, entry.id),
                "legacy_preferred(None) debería incluir {} ({})",
                entry.id,
                entry.category
            );
        }
    }

    #[test]
    fn legacy_preferred_some_filters_to_selection() {
        let sel = vec!["hmac-sha1".to_string()];
        let p = legacy_preferred(Some(&sel));

        // El único legacy seleccionado está presente.
        assert!(has_mac(&p, "hmac-sha1"));

        // Ningún otro extra legacy del catálogo se añade.
        for entry in legacy_catalog() {
            if entry.id == "hmac-sha1" {
                continue;
            }
            assert!(
                !present(&p, entry.category, entry.id),
                "selección parcial no debería añadir {} ({})",
                entry.id,
                entry.category
            );
        }

        // Los algoritmos modernos del default se conservan.
        let def = Preferred::default();
        assert!(p.cipher.len() >= def.cipher.len());
        assert!(p.kex.len() >= def.kex.len());
    }

    #[test]
    fn legacy_catalog_info_matches_catalog() {
        let info = legacy_catalog_info();
        let catalog = legacy_catalog();
        assert_eq!(info.len(), catalog.len());
        // El contenido (id, categoría) debe corresponderse uno a uno con el
        // catálogo real: es lo que la UI muestra como negociable.
        for (pair, entry) in info.iter().zip(catalog.iter()) {
            assert_eq!(pair.0, entry.id);
            assert_eq!(pair.1, entry.category);
        }
        // Ids únicos: un duplicado rompería el filtrado por nombre wire.
        let mut ids: Vec<_> = info.iter().map(|(id, _)| id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), info.len());
    }
}
