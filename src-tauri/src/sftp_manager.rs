//! Gestor de transferencia de ficheros basado en SFTP (`russh-sftp`) y
//! FTP/FTPS (`suppaftp`).
//!
//! A diferencia de libssh2/ssh2-rs (que sólo expone el subsistema SFTP
//! estándar), russh nos permite abrir un canal `exec` y hablar SFTP por
//! encima de `sudo -n /usr/libexec/openssh/sftp-server`, lo que da
//! elevación real de privilegios al panel de ficheros.
//!
//! Cada sesión SFTP vive en su propio hilo con una Runtime de tokio
//! single-threaded; los comandos se envían por un `std::sync::mpsc` desde
//! el hilo principal de Tauri. Así aislamos tokio del resto del backend
//! (que sigue usando `ssh2` síncrono para el shell interactivo y `std`
//! para todo lo demás) sin forzar una migración general.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use suppaftp::list::{File as FtpListFile, ListParser};
use suppaftp::types::FileType as FtpTransferType;
use suppaftp::{rustls, FtpStream, RustlsConnector, RustlsFtpStream};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use russh::client::{self, AuthResult};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;

use crate::host_keys;
use crate::profiles::{AuthType, ConnectionProfile};

// ─── Tipos expuestos al frontend ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpLogEvent {
    stage: &'static str,
    status: &'static str,
    message: String,
    timestamp: String,
}

fn emit_sftp_log(
    app_handle: &AppHandle,
    session_id: &str,
    stage: &'static str,
    status: &'static str,
    message: impl Into<String>,
) {
    let _ = app_handle.emit(
        &format!("sftp-log-{}", session_id),
        SftpLogEvent {
            stage,
            status,
            message: message.into(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        },
    );
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>, // segundos desde epoch
    pub permissions: Option<u32>,
}

// ─── Mensajes al hilo de transferencia ──────────────────────────────────────

type Reply<T> = mpsc::SyncSender<Result<T, String>>;

enum SftpCommand {
    ListDir {
        path: String,
        reply: Reply<Vec<FileEntry>>,
    },
    Stat {
        path: String,
        reply: Reply<FileEntry>,
    },
    HomeDir {
        reply: Reply<String>,
    },
    Mkdir {
        path: String,
        reply: Reply<()>,
    },
    Remove {
        path: String,
        is_dir: bool,
        reply: Reply<()>,
    },
    Rename {
        from: String,
        to: String,
        reply: Reply<()>,
    },
    Download {
        remote: String,
        local: PathBuf,
        transfer_id: String,
        verify_size: bool,
        reply: Reply<()>,
    },
    Upload {
        local: PathBuf,
        remote: String,
        transfer_id: String,
        verify_size: bool,
        reply: Reply<()>,
    },
    DownloadDir {
        remote: String,
        local: PathBuf,
        transfer_id: String,
        conflict_policy: TransferConflictPolicy,
        verify_size: bool,
        reply: Reply<()>,
    },
    UploadDir {
        local: PathBuf,
        remote: String,
        transfer_id: String,
        conflict_policy: TransferConflictPolicy,
        verify_size: bool,
        reply: Reply<()>,
    },
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferConflictPolicy {
    Overwrite,
    Skip,
    Rename,
}

impl TransferConflictPolicy {
    pub fn from_str(policy: &str) -> Self {
        match policy {
            "skip" => Self::Skip,
            "rename" => Self::Rename,
            _ => Self::Overwrite,
        }
    }
}

#[async_trait(?Send)]
trait FileTransfer {
    async fn list_dir(&mut self, path: &str) -> Result<Vec<FileEntry>, String>;
    async fn stat(&mut self, path: &str) -> Result<FileEntry, String>;
    async fn home_dir(&mut self) -> Result<String, String>;
    async fn mkdir(&mut self, path: &str) -> Result<(), String>;
    async fn remove(&mut self, path: &str, is_dir: bool) -> Result<(), String>;
    async fn rename(&mut self, from: &str, to: &str) -> Result<(), String>;
    async fn download(
        &mut self,
        remote: &str,
        local: &Path,
        transfer_id: &str,
        verify_size: bool,
        app: &AppHandle,
        canceled_transfers: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<(), String>;
    async fn upload(
        &mut self,
        local: &Path,
        remote: &str,
        transfer_id: &str,
        verify_size: bool,
        app: &AppHandle,
        canceled_transfers: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<(), String>;
    async fn close(&mut self);
}

struct SftpBackend {
    sftp: SftpSession,
}

struct FtpBackend {
    ftp: FtpConnection,
}

struct SftpHandle {
    tx: mpsc::Sender<SftpCommand>,
    canceled_transfers: Arc<Mutex<HashSet<String>>>,
}

pub struct SftpManager {
    sessions: Mutex<HashMap<String, SftpHandle>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Abre una sesión de transferencia de ficheros.
    ///
    /// `elevated = true` arranca el servidor SFTP bajo `sudo -n` para
    /// acceder a rutas que requieren root (ej. `/root/` tras `sudo su -`).
    /// Requiere que el `sudoers` permita ejecutar `sftp-server` sin
    /// contraseña para el usuario conectado.
    pub async fn connect(
        &self,
        session_id: String,
        profile: ConnectionProfile,
        password: Option<String>,
        passphrase: Option<String>,
        elevated: bool,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<SftpCommand>();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let canceled_transfers = Arc::new(Mutex::new(HashSet::<String>::new()));

        let sid = session_id.clone();
        let worker_canceled_transfers = Arc::clone(&canceled_transfers);
        thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("No se pudo crear runtime tokio: {e}")));
                    return;
                }
            };
            rt.block_on(run_sftp_worker(
                sid,
                profile,
                password,
                passphrase,
                elevated,
                rx,
                ready_tx,
                app_handle,
                worker_canceled_transfers,
            ));
        });

        // Esperar a que la autenticación + apertura terminen sin bloquear el
        // runtime de Tauri; las transferencias largas deben dejar respirar a la UI.
        let ready_result = tauri::async_runtime::spawn_blocking(move || ready_rx.recv())
            .await
            .map_err(|e| format!("No se pudo esperar al worker de ficheros: {e}"))?;

        match ready_result {
            Ok(Ok(())) => {
                self.sessions.lock().unwrap().insert(
                    session_id,
                    SftpHandle {
                        tx,
                        canceled_transfers,
                    },
                );
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("El worker de ficheros terminó inesperadamente".into()),
        }
    }

    async fn send<T>(
        &self,
        session_id: &str,
        build: impl FnOnce(Reply<T>) -> SftpCommand + Send + 'static,
    ) -> Result<T, String>
    where
        T: Send + 'static,
    {
        let tx = {
            let map = self.sessions.lock().unwrap();
            let handle = map
                .get(session_id)
                .ok_or_else(|| format!("Sesión de ficheros no encontrada: {session_id}"))?;
            handle.tx.clone()
        };

        tauri::async_runtime::spawn_blocking(move || {
            let (reply_tx, reply_rx) = mpsc::sync_channel::<Result<T, String>>(1);
            tx.send(build(reply_tx)).map_err(|e| e.to_string())?;
            match reply_rx.recv() {
                Ok(r) => r,
                Err(_) => Err("El worker de ficheros terminó inesperadamente".into()),
            }
        })
        .await
        .map_err(|e| format!("No se pudo esperar respuesta del worker de ficheros: {e}"))?
    }

    pub async fn list_dir(&self, session_id: &str, path: String) -> Result<Vec<FileEntry>, String> {
        self.send(session_id, move |reply| SftpCommand::ListDir {
            path,
            reply,
        })
        .await
    }

    pub async fn stat(&self, session_id: &str, path: String) -> Result<FileEntry, String> {
        self.send(session_id, move |reply| SftpCommand::Stat { path, reply })
            .await
    }

    pub async fn home_dir(&self, session_id: &str) -> Result<String, String> {
        self.send(session_id, move |reply| SftpCommand::HomeDir { reply })
            .await
    }

    pub async fn mkdir(&self, session_id: &str, path: String) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::Mkdir { path, reply })
            .await
    }

    pub async fn remove(&self, session_id: &str, path: String, is_dir: bool) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::Remove {
            path,
            is_dir,
            reply,
        })
        .await
    }

    pub async fn rename(&self, session_id: &str, from: String, to: String) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::Rename {
            from,
            to,
            reply,
        })
        .await
    }

    pub async fn download(
        &self,
        session_id: &str,
        remote: String,
        local: PathBuf,
        transfer_id: String,
        verify_size: bool,
    ) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::Download {
            remote,
            local,
            transfer_id,
            verify_size,
            reply,
        })
        .await
    }

    pub async fn upload(
        &self,
        session_id: &str,
        local: PathBuf,
        remote: String,
        transfer_id: String,
        verify_size: bool,
    ) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::Upload {
            local,
            remote,
            transfer_id,
            verify_size,
            reply,
        })
        .await
    }

    pub async fn download_dir(
        &self,
        session_id: &str,
        remote: String,
        local: PathBuf,
        transfer_id: String,
        conflict_policy: TransferConflictPolicy,
        verify_size: bool,
    ) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::DownloadDir {
            remote,
            local,
            transfer_id,
            conflict_policy,
            verify_size,
            reply,
        })
        .await
    }

    pub async fn upload_dir(
        &self,
        session_id: &str,
        local: PathBuf,
        remote: String,
        transfer_id: String,
        conflict_policy: TransferConflictPolicy,
        verify_size: bool,
    ) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::UploadDir {
            local,
            remote,
            transfer_id,
            conflict_policy,
            verify_size,
            reply,
        })
        .await
    }

    pub fn cancel_transfer(&self, session_id: &str, transfer_id: String) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let Some(handle) = sessions.get(session_id) else {
            return Err("Sesión de ficheros no encontrada".to_string());
        };
        handle
            .canceled_transfers
            .lock()
            .unwrap()
            .insert(transfer_id);
        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        if let Some(handle) = self.sessions.lock().unwrap().remove(session_id) {
            let _ = handle.tx.send(SftpCommand::Close);
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
            let _ = handle.tx.send(SftpCommand::Close);
        }
    }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

async fn run_sftp_worker(
    session_id: String,
    profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    elevated: bool,
    rx: mpsc::Receiver<SftpCommand>,
    ready: mpsc::SyncSender<Result<(), String>>,
    app_handle: AppHandle,
    canceled_transfers: Arc<Mutex<HashSet<String>>>,
) {
    let mut backend = match connect_and_open_backend(
        &profile,
        password.as_deref(),
        passphrase.as_deref(),
        elevated,
        &app_handle,
        &session_id,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    // Bucle bloqueante: recibe comandos del hilo principal y ejecuta en la
    // runtime tokio de este hilo. `rx.recv()` es síncrono; tokio se usa
    // sólo para el trabajo dentro de cada comando.
    loop {
        let cmd = match rx.recv() {
            Ok(c) => c,
            Err(_) => break,
        };
        match cmd {
            SftpCommand::ListDir { path, reply } => {
                let _ = reply.send(backend.list_dir(&path).await);
            }
            SftpCommand::Stat { path, reply } => {
                let _ = reply.send(backend.stat(&path).await);
            }
            SftpCommand::HomeDir { reply } => {
                let _ = reply.send(backend.home_dir().await);
            }
            SftpCommand::Mkdir { path, reply } => {
                let _ = reply.send(backend.mkdir(&path).await);
            }
            SftpCommand::Remove {
                path,
                is_dir,
                reply,
            } => {
                let _ = reply.send(backend.remove(&path, is_dir).await);
            }
            SftpCommand::Rename { from, to, reply } => {
                let _ = reply.send(backend.rename(&from, &to).await);
            }
            SftpCommand::Download {
                remote,
                local,
                transfer_id,
                verify_size,
                reply,
            } => {
                let res = backend
                    .download(
                        &remote,
                        &local,
                        &transfer_id,
                        verify_size,
                        &app_handle,
                        &canceled_transfers,
                    )
                    .await;
                let _ = reply.send(res);
            }
            SftpCommand::Upload {
                local,
                remote,
                transfer_id,
                verify_size,
                reply,
            } => {
                let res = backend
                    .upload(
                        &local,
                        &remote,
                        &transfer_id,
                        verify_size,
                        &app_handle,
                        &canceled_transfers,
                    )
                    .await;
                let _ = reply.send(res);
            }
            SftpCommand::DownloadDir {
                remote,
                local,
                transfer_id,
                conflict_policy,
                verify_size,
                reply,
            } => {
                let res = do_download_dir(
                    backend.as_mut(),
                    &remote,
                    &local,
                    &transfer_id,
                    conflict_policy,
                    verify_size,
                    &app_handle,
                    &canceled_transfers,
                )
                .await;
                let _ = reply.send(res);
            }
            SftpCommand::UploadDir {
                local,
                remote,
                transfer_id,
                conflict_policy,
                verify_size,
                reply,
            } => {
                let res = do_upload_dir(
                    backend.as_mut(),
                    &local,
                    &remote,
                    &transfer_id,
                    conflict_policy,
                    verify_size,
                    &app_handle,
                    &canceled_transfers,
                )
                .await;
                let _ = reply.send(res);
            }
            SftpCommand::Close => break,
        }
    }

    // Cerrar sesión de transferencia ordenadamente.
    backend.close().await;
    let _ = session_id; // mantenemos por si queremos emitir eventos de cierre
}

async fn connect_and_open_backend(
    profile: &ConnectionProfile,
    password: Option<&str>,
    passphrase: Option<&str>,
    elevated: bool,
    app_handle: &AppHandle,
    session_id: &str,
) -> Result<Box<dyn FileTransfer>, String> {
    match profile.connection_type.as_str() {
        "ftp" | "ftps" => {
            emit_sftp_log(
                app_handle,
                session_id,
                "connect",
                "info",
                format!(
                    "Conectando {} a {}:{}",
                    profile.connection_type.to_uppercase(),
                    profile.host,
                    profile.port
                ),
            );
            match connect_ftp(profile, password) {
                Ok(ftp) => {
                    emit_sftp_log(
                        app_handle,
                        session_id,
                        "ready",
                        "ok",
                        format!("{} listo", profile.connection_type.to_uppercase()),
                    );
                    Ok(Box::new(FtpBackend { ftp }))
                }
                Err(e) => {
                    emit_sftp_log(app_handle, session_id, "error", "error", e.clone());
                    Err(e)
                }
            }
        }
        _ => {
            let sftp =
                connect_and_open_sftp(profile, password, passphrase, elevated, app_handle, session_id)
                    .await?;
            Ok(Box::new(SftpBackend { sftp }))
        }
    }
}

/// Abre conexión SSH con russh, autentica, abre canal y arranca subsistema
/// SFTP (o `sudo sftp-server` si `elevated`).
async fn connect_and_open_sftp(
    profile: &ConnectionProfile,
    password: Option<&str>,
    passphrase: Option<&str>,
    elevated: bool,
    app_handle: &AppHandle,
    session_id: &str,
) -> Result<SftpSession, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });

    let addr = format!("{}:{}", profile.host, profile.port);
    emit_sftp_log(
        app_handle,
        session_id,
        "connect",
        "info",
        format!("Conectando SFTP a {addr}"),
    );
    let (client_handler, host_key_failure) =
        host_keys::client(profile.host.clone(), profile.port, false, false);
    let mut handle = match client::connect(config, addr.clone(), client_handler).await {
        Ok(handle) => handle,
        Err(err) => {
            let reason = host_keys::take_failure(&host_key_failure)
                .unwrap_or_else(|| format!("No se puede conectar a {addr}: {err}"));
            emit_sftp_log(app_handle, session_id, "connect", "error", reason.clone());
            return Err(reason);
        }
    };
    emit_sftp_log(
        app_handle,
        session_id,
        "host_key",
        "ok",
        format!("Host key verificada ({addr})"),
    );

    // Autenticación
    emit_sftp_log(
        app_handle,
        session_id,
        "auth",
        "info",
        format!(
            "Autenticando como {} ({})",
            profile.username,
            match &profile.auth_type {
                AuthType::Password => "password",
                AuthType::PublicKey => "public_key",
                AuthType::Agent => "agent",
            }
        ),
    );
    let auth = match &profile.auth_type {
        AuthType::Password => {
            let pass = password.ok_or_else(|| {
                let msg = "Se requiere contraseña".to_string();
                emit_sftp_log(app_handle, session_id, "auth", "error", msg.clone());
                msg
            })?;
            handle
                .authenticate_password(profile.username.clone(), pass.to_string())
                .await
                .map_err(|e| {
                    let msg = format!("Error de autenticación: {e}");
                    emit_sftp_log(app_handle, session_id, "auth", "error", msg.clone());
                    msg
                })?
        }
        AuthType::PublicKey => {
            let key_path = profile.key_path.as_ref().ok_or_else(|| {
                let msg = "Se requiere ruta de clave privada".to_string();
                emit_sftp_log(app_handle, session_id, "auth", "error", msg.clone());
                msg
            })?;
            let key = load_secret_key(Path::new(key_path), passphrase).map_err(|e| {
                let msg = format!("Clave inválida: {e}");
                emit_sftp_log(app_handle, session_id, "auth", "error", msg.clone());
                msg
            })?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            handle
                .authenticate_publickey(
                    profile.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| {
                    let msg = format!("Error de autenticación por clave: {e}");
                    emit_sftp_log(app_handle, session_id, "auth", "error", msg.clone());
                    msg
                })?
        }
        AuthType::Agent => authenticate_with_agent(&mut handle, &profile.username)
            .await
            .map_err(|e| {
                emit_sftp_log(app_handle, session_id, "auth", "error", e.clone());
                e
            })?,
    };

    match auth {
        AuthResult::Success => {
            emit_sftp_log(app_handle, session_id, "auth", "ok", "Autenticado");
        }
        AuthResult::Failure { remaining_methods } => {
            let msg = format!(
                "Autenticación fallida. Métodos restantes: {:?}",
                remaining_methods
            );
            emit_sftp_log(app_handle, session_id, "auth", "error", msg.clone());
            return Err(msg);
        }
    }

    // Abrir canal y activar SFTP (normal o elevado)
    let channel = handle.channel_open_session().await.map_err(|e| {
        let msg = format!("No se pudo abrir canal: {e}");
        emit_sftp_log(app_handle, session_id, "channel", "error", msg.clone());
        msg
    })?;

    if elevated {
        emit_sftp_log(
            app_handle,
            session_id,
            "subsystem",
            "info",
            "Lanzando sudo sftp-server (modo elevado)",
        );
        // Probar las rutas habituales de sftp-server. Salimos con el primero
        // que sea ejecutable. El `exec` final sustituye al shell sh, así que
        // no hay wrapper que estropee el protocolo SFTP en el pipe.
        let cmd = r#"for p in /usr/libexec/openssh/sftp-server /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do [ -x "$p" ] && exec sudo -n "$p"; done; echo "sftp-server binary not found" >&2; exit 127"#;
        channel.exec(true, cmd).await.map_err(|e| {
            let msg = format!("No se pudo lanzar sftp-server elevado: {e}");
            emit_sftp_log(app_handle, session_id, "subsystem", "error", msg.clone());
            msg
        })?;
    } else {
        emit_sftp_log(
            app_handle,
            session_id,
            "subsystem",
            "info",
            "Abriendo subsistema sftp",
        );
        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            let msg = format!("No se pudo abrir el subsistema SFTP: {e}");
            emit_sftp_log(app_handle, session_id, "subsystem", "error", msg.clone());
            msg
        })?;
    }

    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
        let msg = if elevated {
            format!(
                "No se pudo iniciar SFTP elevado ({e}). \
                     Comprueba que /etc/sudoers permita NOPASSWD sobre sftp-server."
            )
        } else {
            format!("No se pudo iniciar sesión SFTP: {e}")
        };
        emit_sftp_log(app_handle, session_id, "subsystem", "error", msg.clone());
        msg
    })?;
    emit_sftp_log(
        app_handle,
        session_id,
        "ready",
        "ok",
        if elevated {
            "Sesión SFTP elevada lista"
        } else {
            "Sesión SFTP lista"
        },
    );

    Ok(sftp)
}

/// Autenticación vía agente SSH. Probamos cada identidad hasta que una
/// funcione o se acaben.
#[cfg(unix)]
async fn authenticate_with_agent(
    handle: &mut client::Handle<host_keys::KnownHostsClient>,
    username: &str,
) -> Result<AuthResult, String> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| format!("No se pudo contactar con el agente SSH: {e}"))?
        .dynamic();
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("No se pudieron listar identidades del agente: {e}"))?;

    if identities.is_empty() {
        return Err("El agente SSH no tiene claves cargadas".into());
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
            Err(e) => return Err(format!("Error al firmar con agente: {e}")),
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
) -> Result<AuthResult, String> {
    Err("Autenticación vía agente SSH no soportada en esta plataforma".into())
}

#[async_trait(?Send)]
impl FileTransfer for SftpBackend {
    async fn list_dir(&mut self, path: &str) -> Result<Vec<FileEntry>, String> {
        do_list_dir(&self.sftp, path).await
    }

    async fn stat(&mut self, path: &str) -> Result<FileEntry, String> {
        do_stat(&self.sftp, path).await
    }

    async fn home_dir(&mut self) -> Result<String, String> {
        do_home_dir(&self.sftp).await
    }

    async fn mkdir(&mut self, path: &str) -> Result<(), String> {
        self.sftp
            .create_dir(path.to_string())
            .await
            .map_err(|e| e.to_string())
    }

    async fn remove(&mut self, path: &str, is_dir: bool) -> Result<(), String> {
        let res = if is_dir {
            self.sftp.remove_dir(path.to_string()).await
        } else {
            self.sftp.remove_file(path.to_string()).await
        };
        res.map_err(|e| e.to_string())
    }

    async fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        self.sftp
            .rename(from.to_string(), to.to_string())
            .await
            .map_err(|e| e.to_string())
    }

    async fn download(
        &mut self,
        remote: &str,
        local: &Path,
        transfer_id: &str,
        verify_size: bool,
        app: &AppHandle,
        canceled_transfers: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<(), String> {
        do_download(
            &self.sftp,
            remote,
            local,
            transfer_id,
            verify_size,
            app,
            canceled_transfers,
        )
        .await
    }

    async fn upload(
        &mut self,
        local: &Path,
        remote: &str,
        transfer_id: &str,
        verify_size: bool,
        app: &AppHandle,
        canceled_transfers: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<(), String> {
        do_upload(
            &self.sftp,
            local,
            remote,
            transfer_id,
            verify_size,
            app,
            canceled_transfers,
        )
        .await
    }

    async fn close(&mut self) {
        let _ = self.sftp.close().await;
    }
}

enum FtpConnection {
    Plain(FtpStream),
    ExplicitTls(RustlsFtpStream),
}

impl FtpConnection {
    fn connect(profile: &ConnectionProfile, password: Option<&str>) -> Result<Self, String> {
        let addr = format!("{}:{}", profile.host, profile.port);
        let username = if profile.username.trim().is_empty() {
            "anonymous"
        } else {
            profile.username.trim()
        };
        let pass = password.unwrap_or(if username == "anonymous" {
            "anonymous@"
        } else {
            ""
        });

        if profile.connection_type == "ftps" {
            let root_store =
                rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let config = rustls::ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth();
            let connector = RustlsConnector::from(Arc::new(config));
            let mut ftp = RustlsFtpStream::connect(addr.as_str())
                .map_err(|e| format!("No se puede conectar FTPS a {addr}: {e}"))?
                .into_secure(connector, profile.host.as_str())
                .map_err(|e| format!("No se pudo iniciar TLS explícito: {e}"))?;
            ftp.login(username, pass)
                .map_err(|e| format!("Error de autenticación FTPS: {e}"))?;
            ftp.transfer_type(FtpTransferType::Binary)
                .map_err(|e| format!("No se pudo activar modo binario FTPS: {e}"))?;
            Ok(Self::ExplicitTls(ftp))
        } else {
            let mut ftp = FtpStream::connect(addr.as_str())
                .map_err(|e| format!("No se puede conectar FTP a {addr}: {e}"))?;
            ftp.login(username, pass)
                .map_err(|e| format!("Error de autenticación FTP: {e}"))?;
            ftp.transfer_type(FtpTransferType::Binary)
                .map_err(|e| format!("No se pudo activar modo binario FTP: {e}"))?;
            Ok(Self::Plain(ftp))
        }
    }

    fn pwd(&mut self) -> Result<String, String> {
        match self {
            Self::Plain(ftp) => ftp.pwd(),
            Self::ExplicitTls(ftp) => ftp.pwd(),
        }
        .map_err(|e| e.to_string())
    }

    fn mkdir(&mut self, path: &str) -> Result<(), String> {
        match self {
            Self::Plain(ftp) => ftp.mkdir(path),
            Self::ExplicitTls(ftp) => ftp.mkdir(path),
        }
        .map_err(|e| e.to_string())
    }

    fn remove(&mut self, path: &str, is_dir: bool) -> Result<(), String> {
        match (self, is_dir) {
            (Self::Plain(ftp), true) => ftp.rmdir(path),
            (Self::Plain(ftp), false) => ftp.rm(path),
            (Self::ExplicitTls(ftp), true) => ftp.rmdir(path),
            (Self::ExplicitTls(ftp), false) => ftp.rm(path),
        }
        .map_err(|e| e.to_string())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        match self {
            Self::Plain(ftp) => ftp.rename(from, to),
            Self::ExplicitTls(ftp) => ftp.rename(from, to),
        }
        .map_err(|e| e.to_string())
    }

    fn mlsd(&mut self, path: &str) -> Result<Vec<String>, String> {
        match self {
            Self::Plain(ftp) => ftp.mlsd(Some(path)),
            Self::ExplicitTls(ftp) => ftp.mlsd(Some(path)),
        }
        .map_err(|e| e.to_string())
    }

    fn list(&mut self, path: &str) -> Result<Vec<String>, String> {
        match self {
            Self::Plain(ftp) => ftp.list(Some(path)),
            Self::ExplicitTls(ftp) => ftp.list(Some(path)),
        }
        .map_err(|e| e.to_string())
    }

    fn mlst(&mut self, path: &str) -> Result<String, String> {
        match self {
            Self::Plain(ftp) => ftp.mlst(Some(path)),
            Self::ExplicitTls(ftp) => ftp.mlst(Some(path)),
        }
        .map_err(|e| e.to_string())
    }

    fn size(&mut self, path: &str) -> Result<u64, String> {
        match self {
            Self::Plain(ftp) => ftp.size(path),
            Self::ExplicitTls(ftp) => ftp.size(path),
        }
        .map(|n| n as u64)
        .map_err(|e| e.to_string())
    }

    fn mdtm(&mut self, path: &str) -> Result<u64, String> {
        let dt = match self {
            Self::Plain(ftp) => ftp.mdtm(path),
            Self::ExplicitTls(ftp) => ftp.mdtm(path),
        }
        .map_err(|e| e.to_string())?;
        Ok(dt.and_utc().timestamp().max(0) as u64)
    }

    fn download_to(
        &mut self,
        remote: &str,
        local: &Path,
        total: u64,
        transfer_id: &str,
        app: &AppHandle,
        canceled_transfers: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<(), String> {
        if let Some(parent) = local.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut local_file = std::fs::File::create(local).map_err(|e| e.to_string())?;

        match self {
            Self::Plain(ftp) => {
                let mut remote_file = ftp.retr_as_stream(remote).map_err(|e| e.to_string())?;
                transfer_copy_blocking(
                    &mut remote_file,
                    &mut local_file,
                    total,
                    transfer_id,
                    app,
                    canceled_transfers,
                )?;
                ftp.finalize_retr_stream(remote_file)
                    .map_err(|e| e.to_string())?;
            }
            Self::ExplicitTls(ftp) => {
                let mut remote_file = ftp.retr_as_stream(remote).map_err(|e| e.to_string())?;
                transfer_copy_blocking(
                    &mut remote_file,
                    &mut local_file,
                    total,
                    transfer_id,
                    app,
                    canceled_transfers,
                )?;
                ftp.finalize_retr_stream(remote_file)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn upload_from(
        &mut self,
        local: &Path,
        remote: &str,
        total: u64,
        transfer_id: &str,
        app: &AppHandle,
        canceled_transfers: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<(), String> {
        let mut local_file = std::fs::File::open(local).map_err(|e| e.to_string())?;
        match self {
            Self::Plain(ftp) => {
                let mut remote_file = ftp.put_with_stream(remote).map_err(|e| e.to_string())?;
                transfer_copy_blocking(
                    &mut local_file,
                    &mut remote_file,
                    total,
                    transfer_id,
                    app,
                    canceled_transfers,
                )?;
                ftp.finalize_put_stream(remote_file)
                    .map_err(|e| e.to_string())?;
            }
            Self::ExplicitTls(ftp) => {
                let mut remote_file = ftp.put_with_stream(remote).map_err(|e| e.to_string())?;
                transfer_copy_blocking(
                    &mut local_file,
                    &mut remote_file,
                    total,
                    transfer_id,
                    app,
                    canceled_transfers,
                )?;
                ftp.finalize_put_stream(remote_file)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn quit(&mut self) {
        let _ = match self {
            Self::Plain(ftp) => ftp.quit(),
            Self::ExplicitTls(ftp) => ftp.quit(),
        };
    }
}

fn connect_ftp(
    profile: &ConnectionProfile,
    password: Option<&str>,
) -> Result<FtpConnection, String> {
    FtpConnection::connect(profile, password)
}

#[async_trait(?Send)]
impl FileTransfer for FtpBackend {
    async fn list_dir(&mut self, path: &str) -> Result<Vec<FileEntry>, String> {
        ftp_list_dir(&mut self.ftp, path)
    }

    async fn stat(&mut self, path: &str) -> Result<FileEntry, String> {
        ftp_stat(&mut self.ftp, path)
    }

    async fn home_dir(&mut self) -> Result<String, String> {
        self.ftp.pwd()
    }

    async fn mkdir(&mut self, path: &str) -> Result<(), String> {
        self.ftp.mkdir(path)
    }

    async fn remove(&mut self, path: &str, is_dir: bool) -> Result<(), String> {
        self.ftp.remove(path, is_dir)
    }

    async fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        self.ftp.rename(from, to)
    }

    async fn download(
        &mut self,
        remote: &str,
        local: &Path,
        transfer_id: &str,
        verify_size: bool,
        app: &AppHandle,
        canceled_transfers: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<(), String> {
        let entry = ftp_stat(&mut self.ftp, remote)?;
        let total = entry.size;
        self.ftp
            .download_to(remote, local, total, transfer_id, app, canceled_transfers)?;
        if verify_size {
            let written = std::fs::metadata(local)
                .map_err(|e| format!("verificación local: {e}"))?
                .len();
            if written != total {
                return Err(format!(
                    "verificación fallida: tamaño local {written} B, esperado {total} B"
                ));
            }
        }
        Ok(())
    }

    async fn upload(
        &mut self,
        local: &Path,
        remote: &str,
        transfer_id: &str,
        verify_size: bool,
        app: &AppHandle,
        canceled_transfers: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<(), String> {
        let total = std::fs::metadata(local).map_err(|e| e.to_string())?.len();
        self.ftp
            .upload_from(local, remote, total, transfer_id, app, canceled_transfers)?;
        if verify_size {
            let written = self
                .ftp
                .size(remote)
                .map_err(|e| format!("verificación remota: {e}"))?;
            if written != total {
                return Err(format!(
                    "verificación fallida: tamaño remoto {written} B, esperado {total} B"
                ));
            }
        }
        Ok(())
    }

    async fn close(&mut self) {
        self.ftp.quit();
    }
}

// ─── Operaciones ────────────────────────────────────────────────────────────

async fn do_list_dir(sftp: &SftpSession, path: &str) -> Result<Vec<FileEntry>, String> {
    let read = sftp
        .read_dir(path.to_string())
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in read {
        let name = entry.file_name();
        let meta = entry.metadata();
        let ft = entry.file_type();
        let full_path = join_remote(path, &name);
        out.push(FileEntry {
            name,
            path: full_path,
            is_dir: ft.is_dir(),
            is_symlink: ft.is_symlink(),
            size: meta.len(),
            modified: meta.mtime.map(|t| t as u64),
            permissions: meta.permissions,
        });
    }
    // Carpetas primero, luego por nombre (case-insensitive)
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

async fn do_stat(sftp: &SftpSession, path: &str) -> Result<FileEntry, String> {
    let meta = sftp
        .metadata(path.to_string())
        .await
        .map_err(|e| e.to_string())?;
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let ft = meta.file_type();
    Ok(FileEntry {
        name,
        path: path.to_string(),
        is_dir: ft.is_dir(),
        is_symlink: ft.is_symlink(),
        size: meta.len(),
        modified: meta.mtime.map(|t| t as u64),
        permissions: meta.permissions,
    })
}

async fn do_home_dir(sftp: &SftpSession) -> Result<String, String> {
    // Resuelve "." en el servidor: normalmente $HOME para el usuario que
    // autenticó. En modo elevado (sudo) sí apunta al home de root.
    sftp.canonicalize(".".to_string())
        .await
        .map_err(|e| e.to_string())
}

fn ftp_list_dir(ftp: &mut FtpConnection, path: &str) -> Result<Vec<FileEntry>, String> {
    let mut out = match ftp.mlsd(path) {
        Ok(lines) => lines
            .into_iter()
            .filter_map(|line| ListParser::parse_mlsd(&line).ok())
            .filter(|file| file.name() != "." && file.name() != "..")
            .map(|file| ftp_file_entry(path, &file))
            .collect::<Vec<_>>(),
        Err(_) => ftp
            .list(path)?
            .into_iter()
            .filter_map(|line| line.parse::<FtpListFile>().ok())
            .filter(|file| file.name() != "." && file.name() != "..")
            .map(|file| ftp_file_entry(path, &file))
            .collect::<Vec<_>>(),
    };
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

fn ftp_stat(ftp: &mut FtpConnection, path: &str) -> Result<FileEntry, String> {
    if let Ok(raw) = ftp.mlst(path) {
        if let Ok(file) = ListParser::parse_mlst(raw.trim()) {
            let mut entry = ftp_file_entry(remote_parent(path).as_str(), &file);
            entry.name = remote_name(path);
            entry.path = path.to_string();
            return Ok(entry);
        }
    }

    if let Ok(size) = ftp.size(path) {
        return Ok(FileEntry {
            name: remote_name(path),
            path: path.to_string(),
            is_dir: false,
            is_symlink: false,
            size,
            modified: ftp.mdtm(path).ok(),
            permissions: None,
        });
    }

    let parent = remote_parent(path);
    let name = remote_name(path);
    ftp_list_dir(ftp, &parent)?
        .into_iter()
        .find(|entry| entry.name == name || entry.path == path)
        .ok_or_else(|| format!("No se pudo consultar {path}"))
}

fn ftp_file_entry(base: &str, file: &FtpListFile) -> FileEntry {
    FileEntry {
        name: file.name().to_string(),
        path: join_remote(base, file.name()),
        is_dir: file.is_directory(),
        is_symlink: file.is_symlink(),
        size: file.size() as u64,
        modified: file
            .modified()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs()),
        permissions: None,
    }
}

async fn do_download(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    transfer_id: &str,
    verify_size: bool,
    app: &AppHandle,
    canceled_transfers: &Arc<Mutex<HashSet<String>>>,
) -> Result<(), String> {
    let meta = sftp
        .metadata(remote.to_string())
        .await
        .map_err(|e| e.to_string())?;
    let total = meta.len();

    let mut remote_file = sftp
        .open(remote.to_string())
        .await
        .map_err(|e| e.to_string())?;
    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut local_file = tokio::fs::File::create(local)
        .await
        .map_err(|e| e.to_string())?;

    transfer_copy(
        &mut remote_file,
        &mut local_file,
        total,
        transfer_id,
        app,
        canceled_transfers,
    )
    .await?;
    drop(local_file);

    if verify_size {
        let written = tokio::fs::metadata(local)
            .await
            .map_err(|e| format!("verificación local: {e}"))?
            .len();
        if written != total {
            return Err(format!(
                "verificación fallida: tamaño local {written} B, esperado {total} B"
            ));
        }
    }

    Ok(())
}

async fn do_upload(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    transfer_id: &str,
    verify_size: bool,
    app: &AppHandle,
    canceled_transfers: &Arc<Mutex<HashSet<String>>>,
) -> Result<(), String> {
    let meta = tokio::fs::metadata(local)
        .await
        .map_err(|e| e.to_string())?;
    let total = meta.len();

    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| e.to_string())?;
    let mut remote_file = sftp
        .open_with_flags(
            remote.to_string(),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| e.to_string())?;

    transfer_copy(
        &mut local_file,
        &mut remote_file,
        total,
        transfer_id,
        app,
        canceled_transfers,
    )
    .await?;
    drop(remote_file);

    if verify_size {
        let written = sftp
            .metadata(remote.to_string())
            .await
            .map_err(|e| format!("verificación remota: {e}"))?
            .len();
        if written != total {
            return Err(format!(
                "verificación fallida: tamaño remoto {written} B, esperado {total} B"
            ));
        }
    }

    Ok(())
}

/// Copia con emisión de progreso. Buffer de 64 KiB; emite cada ~256 KiB o al EOF.
async fn transfer_copy<R, W>(
    src: &mut R,
    dst: &mut W,
    total: u64,
    transfer_id: &str,
    app: &AppHandle,
    canceled_transfers: &Arc<Mutex<HashSet<String>>>,
) -> Result<(), String>
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut buf = vec![0u8; 65_536];
    let mut transferred: u64 = 0;
    let mut last_emit: u64 = 0;
    let event = format!("sftp-progress-{transfer_id}");

    // Progreso inicial
    let _ = app.emit(
        &event,
        serde_json::json!({
            "transferred": 0u64, "total": total, "done": false,
        }),
    );

    loop {
        if canceled_transfers.lock().unwrap().remove(transfer_id) {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": true, "canceled": true,
                }),
            );
            return Err("transferencia cancelada".to_string());
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;

        if transferred - last_emit >= 262_144 {
            last_emit = transferred;
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": false,
                }),
            );
        }
    }

    dst.flush().await.map_err(|e| e.to_string())?;
    let _ = app.emit(
        &event,
        serde_json::json!({
            "transferred": transferred, "total": total, "done": true,
        }),
    );
    Ok(())
}

fn transfer_copy_blocking<R, W>(
    src: &mut R,
    dst: &mut W,
    total: u64,
    transfer_id: &str,
    app: &AppHandle,
    canceled_transfers: &Arc<Mutex<HashSet<String>>>,
) -> Result<(), String>
where
    R: Read,
    W: Write,
{
    let mut buf = vec![0u8; 65_536];
    let mut transferred: u64 = 0;
    let mut last_emit: u64 = 0;
    let event = format!("sftp-progress-{transfer_id}");

    let _ = app.emit(
        &event,
        serde_json::json!({
            "transferred": 0u64, "total": total, "done": false,
        }),
    );

    loop {
        if canceled_transfers.lock().unwrap().remove(transfer_id) {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": true, "canceled": true,
                }),
            );
            return Err("transferencia cancelada".to_string());
        }

        let n = src.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        transferred += n as u64;

        if transferred - last_emit >= 262_144 {
            last_emit = transferred;
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": false,
                }),
            );
        }
    }

    dst.flush().map_err(|e| e.to_string())?;
    let _ = app.emit(
        &event,
        serde_json::json!({
            "transferred": transferred, "total": total, "done": true,
        }),
    );
    Ok(())
}

/// Une un path remoto + nombre sin depender de convenciones locales.
fn join_remote(base: &str, name: &str) -> String {
    if base.is_empty() || base == "." {
        name.to_string()
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

fn remote_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", _)) => "/".to_string(),
        Some((parent, _)) if !parent.is_empty() => parent.to_string(),
        _ => ".".to_string(),
    }
}

fn remote_name(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

async fn auto_rename_local_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archivo".to_string());
    let ext = path.extension().map(|e| e.to_string_lossy().into_owned());

    for i in 1..10_000 {
        let name = match &ext {
            Some(ext) if !ext.is_empty() => format!("{stem} ({i}).{ext}"),
            _ => format!("{stem} ({i})"),
        };
        let candidate = parent.join(name);
        if tokio::fs::metadata(&candidate).await.is_err() {
            return candidate;
        }
    }

    parent.join(format!(
        "{stem} ({})",
        chrono::Utc::now().timestamp_millis()
    ))
}

async fn auto_rename_remote_path(backend: &mut dyn FileTransfer, remote: &str) -> String {
    let (parent, name) = remote.rsplit_once('/').unwrap_or(("", remote));
    let dot = name
        .rfind('.')
        .filter(|idx| *idx > 0 && *idx < name.len() - 1);
    let (stem, ext) = match dot {
        Some(idx) => (&name[..idx], &name[idx..]),
        None => (name, ""),
    };

    for i in 1..10_000 {
        let candidate_name = format!("{stem} ({i}){ext}");
        let candidate = if parent.is_empty() {
            candidate_name
        } else {
            join_remote(parent, &candidate_name)
        };
        if backend.stat(&candidate).await.is_err() {
            return candidate;
        }
    }

    let fallback = format!("{stem} ({}){ext}", chrono::Utc::now().timestamp_millis());
    if parent.is_empty() {
        fallback
    } else {
        join_remote(parent, &fallback)
    }
}

/// Recorre un directorio remoto y descarga su contenido al `local`,
/// preservando la estructura. Cada archivo emite progreso en su propio evento
/// `sftp-progress-{transfer_id}-{idx}` y al final se emite el resumen en
/// `sftp-progress-{transfer_id}` con `done: true`.
async fn do_download_dir(
    backend: &mut dyn FileTransfer,
    remote: &str,
    local: &Path,
    transfer_id: &str,
    conflict_policy: TransferConflictPolicy,
    verify_size: bool,
    app: &AppHandle,
    canceled_transfers: &Arc<Mutex<HashSet<String>>>,
) -> Result<(), String> {
    tokio::fs::create_dir_all(local)
        .await
        .map_err(|e| e.to_string())?;
    let summary_event = format!("sftp-progress-{transfer_id}");
    let mut idx: u32 = 0;

    let mut stack = vec![(remote.to_string(), local.to_path_buf())];
    while let Some((rdir, ldir)) = stack.pop() {
        let entries = backend.list_dir(&rdir).await?;
        for e in entries {
            let mut local_target = ldir.join(&e.name);
            if e.is_dir {
                tokio::fs::create_dir_all(&local_target)
                    .await
                    .map_err(|err| err.to_string())?;
                stack.push((e.path.clone(), local_target));
            } else if !e.is_symlink {
                if let Ok(meta) = tokio::fs::metadata(&local_target).await {
                    match conflict_policy {
                        TransferConflictPolicy::Skip => continue,
                        TransferConflictPolicy::Rename => {
                            local_target = auto_rename_local_path(&local_target).await;
                        }
                        TransferConflictPolicy::Overwrite => {
                            if meta.is_dir() {
                                local_target = auto_rename_local_path(&local_target).await;
                            }
                        }
                    }
                }
                idx += 1;
                let sub_id = format!("{transfer_id}-{idx}");
                backend
                    .download(
                        &e.path,
                        &local_target,
                        &sub_id,
                        verify_size,
                        app,
                        canceled_transfers,
                    )
                    .await?;
            }
        }
    }
    let _ = app.emit(
        &summary_event,
        serde_json::json!({
            "transferred": idx as u64, "total": idx as u64, "done": true, "kind": "dir",
        }),
    );
    Ok(())
}

/// Sube recursivamente un directorio local al `remote`. Crea las carpetas
/// remotas conforme avanza y reusa `do_upload` para los archivos.
async fn do_upload_dir(
    backend: &mut dyn FileTransfer,
    local: &Path,
    remote: &str,
    transfer_id: &str,
    conflict_policy: TransferConflictPolicy,
    verify_size: bool,
    app: &AppHandle,
    canceled_transfers: &Arc<Mutex<HashSet<String>>>,
) -> Result<(), String> {
    let _ = backend.mkdir(remote).await; // ignorar si ya existe
    let summary_event = format!("sftp-progress-{transfer_id}");
    let mut idx: u32 = 0;

    let mut stack = vec![(local.to_path_buf(), remote.to_string())];
    while let Some((ldir, rdir)) = stack.pop() {
        let mut read = tokio::fs::read_dir(&ldir)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = read.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let mut remote_target = join_remote(&rdir, &name);
            let ft = entry.file_type().await.map_err(|e| e.to_string())?;
            if ft.is_dir() {
                let _ = backend.mkdir(&remote_target).await;
                stack.push((path, remote_target));
            } else if ft.is_file() {
                if let Ok(meta) = backend.stat(&remote_target).await {
                    match conflict_policy {
                        TransferConflictPolicy::Skip => continue,
                        TransferConflictPolicy::Rename => {
                            remote_target = auto_rename_remote_path(backend, &remote_target).await;
                        }
                        TransferConflictPolicy::Overwrite => {
                            if meta.is_dir {
                                remote_target =
                                    auto_rename_remote_path(backend, &remote_target).await;
                            }
                        }
                    }
                }
                idx += 1;
                let sub_id = format!("{transfer_id}-{idx}");
                backend
                    .upload(
                        &path,
                        &remote_target,
                        &sub_id,
                        verify_size,
                        app,
                        canceled_transfers,
                    )
                    .await?;
            }
        }
    }
    let _ = app.emit(
        &summary_event,
        serde_json::json!({
            "transferred": idx as u64, "total": idx as u64, "done": true, "kind": "dir",
        }),
    );
    Ok(())
}
