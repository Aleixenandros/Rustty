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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};

use crate::locks::MutexExt;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use async_trait::async_trait;
use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use suppaftp::list::{File as FtpListFile, ListParser};
use suppaftp::types::FileType as FtpTransferType;
use suppaftp::{rustls, FtpStream, RustlsConnector, RustlsFtpStream};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use russh::client::{self, AuthResult};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh_sftp::client::fs::File as SftpFile;
use russh_sftp::client::{Config as SftpConfig, SftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags};

use crate::host_keys;
use crate::ipc::{event_name, EventKind};
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
        &event_name(EventKind::SftpLog, session_id),
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

// ─── Control de transferencias (cancelar + pausar) ──────────────────────────

/// Estado compartido entre el `SftpHandle` (hilo principal) y el worker para
/// señalizar cancelación y pausa de transferencias por `transfer_id`. La
/// cancelación se consume al detectarla (one-shot) y abre la rama de error
/// "transferencia cancelada"; la pausa es un flag persistente que el bucle de
/// `pipelined_download`/`pipelined_upload` consulta antes de pedir más chunks.
#[derive(Default)]
pub struct TransferControls {
    canceled: Mutex<HashSet<String>>,
    paused: Mutex<HashSet<String>>,
}

/// Lo que toda transferencia arrastra: a quién identifica, a quién le informa del
/// progreso, cómo se pausa/cancela y si hay que verificar el tamaño al terminar.
///
/// Estos cuatro valores viajaban sueltos por cada firma de la cadena de
/// transferencia (`do_download` → `pipelined_download`, y sus gemelas de subida y
/// de carpeta), que por eso rebasaban el límite de argumentos de clippy. Agruparlos
/// no es solo cosmética: garantiza que una función nueva de la cadena no se olvide
/// de propagar los controles de cancelación.
#[derive(Clone, Copy)]
struct TransferCtx<'a> {
    /// Identifica la transferencia ante los eventos de progreso y los controles.
    /// En una transferencia de carpeta, cada fichero recibe un hijo `{id}-{n}`.
    transfer_id: &'a str,
    app: &'a AppHandle,
    controls: &'a Arc<TransferControls>,
    verify_size: bool,
}

impl<'a> TransferCtx<'a> {
    /// El mismo contexto para un fichero suelto dentro de una transferencia de
    /// carpeta: cambia el `transfer_id` y conserva el resto.
    fn child<'b>(self, transfer_id: &'b str) -> TransferCtx<'b>
    where
        'a: 'b,
    {
        TransferCtx {
            transfer_id,
            app: self.app,
            controls: self.controls,
            verify_size: self.verify_size,
        }
    }
}

impl TransferControls {
    fn new() -> Self {
        Self::default()
    }

    fn take_cancel(&self, transfer_id: &str) -> bool {
        self.canceled.lock_recover().remove(transfer_id)
    }

    fn is_paused(&self, transfer_id: &str) -> bool {
        self.paused.lock_recover().contains(transfer_id)
    }

    fn cancel(&self, transfer_id: String) {
        // Cancelar también levanta la pausa para que el bucle salga inmediatamente.
        self.paused.lock_recover().remove(&transfer_id);
        self.canceled.lock_recover().insert(transfer_id);
    }

    fn pause(&self, transfer_id: String) {
        self.paused.lock_recover().insert(transfer_id);
    }

    fn resume(&self, transfer_id: &str) {
        self.paused.lock_recover().remove(transfer_id);
    }
}

// ─── Mensajes al hilo de transferencia ──────────────────────────────────────

type Reply<T> = mpsc::SyncSender<Result<T, String>>;

enum SftpCommand {
    ListDir {
        path: String,
        reply: Reply<Vec<FileEntry>>,
    },
    HomeDir {
        reply: Reply<String>,
    },
    Mkdir {
        path: String,
        reply: Reply<()>,
    },
    CreateFile {
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
    Chmod {
        path: String,
        mode: u32,
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
    async fn create_file(&mut self, path: &str) -> Result<(), String>;
    async fn remove(&mut self, path: &str, is_dir: bool) -> Result<(), String>;
    async fn rename(&mut self, from: &str, to: &str) -> Result<(), String>;
    async fn chmod(&mut self, path: &str, mode: u32) -> Result<(), String>;
    async fn download(
        &mut self,
        remote: &str,
        local: &Path,
        ctx: TransferCtx<'_>,
    ) -> Result<(), String>;
    async fn upload(
        &mut self,
        local: &Path,
        remote: &str,
        ctx: TransferCtx<'_>,
    ) -> Result<(), String>;
    async fn close(&mut self);
}

struct SftpBackend {
    sftp: SftpSession,
    /// Máximo de peticiones SFTP simultáneas (handles en vuelo) por transferencia.
    /// Configurable por sesión; servidores restringidos como Hetzner Storage Box
    /// imponen un límite bajo de handles abiertos y un valor alto provoca
    /// "Handle limit reached".
    max_parallelism: usize,
}

struct FtpBackend {
    ftp: FtpConnection,
}

struct SftpHandle {
    tx: mpsc::Sender<SftpCommand>,
    controls: Arc<TransferControls>,
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
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        &self,
        session_id: String,
        profile: ConnectionProfile,
        password: Option<String>,
        passphrase: Option<String>,
        elevated: bool,
        max_parallelism: usize,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<SftpCommand>();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let controls = Arc::new(TransferControls::new());

        let sid = session_id.clone();
        let worker_controls = Arc::clone(&controls);
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
                max_parallelism,
                rx,
                ready_tx,
                app_handle,
                worker_controls,
            ));
        });

        // Esperar a que la autenticación + apertura terminen sin bloquear el
        // runtime de Tauri; las transferencias largas deben dejar respirar a la UI.
        let ready_result = tauri::async_runtime::spawn_blocking(move || ready_rx.recv())
            .await
            .map_err(|e| format!("No se pudo esperar al worker de ficheros: {e}"))?;

        match ready_result {
            Ok(Ok(())) => {
                self.sessions
                    .lock_recover()
                    .insert(session_id, SftpHandle { tx, controls });
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
            let map = self.sessions.lock_recover();
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

    pub async fn home_dir(&self, session_id: &str) -> Result<String, String> {
        self.send(session_id, move |reply| SftpCommand::HomeDir { reply })
            .await
    }

    pub async fn mkdir(&self, session_id: &str, path: String) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::Mkdir { path, reply })
            .await
    }

    pub async fn create_file(&self, session_id: &str, path: String) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::CreateFile {
            path,
            reply,
        })
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

    pub async fn chmod(&self, session_id: &str, path: String, mode: u32) -> Result<(), String> {
        self.send(session_id, move |reply| SftpCommand::Chmod {
            path,
            mode,
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
        let sessions = self.sessions.lock_recover();
        let Some(handle) = sessions.get(session_id) else {
            return Err("Sesión de ficheros no encontrada".to_string());
        };
        handle.controls.cancel(transfer_id);
        Ok(())
    }

    pub fn pause_transfer(&self, session_id: &str, transfer_id: String) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let Some(handle) = sessions.get(session_id) else {
            return Err("Sesión de ficheros no encontrada".to_string());
        };
        handle.controls.pause(transfer_id);
        Ok(())
    }

    pub fn resume_transfer(&self, session_id: &str, transfer_id: String) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let Some(handle) = sessions.get(session_id) else {
            return Err("Sesión de ficheros no encontrada".to_string());
        };
        handle.controls.resume(&transfer_id);
        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        if let Some(handle) = self.sessions.lock_recover().remove(session_id) {
            let _ = handle.tx.send(SftpCommand::Close);
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
            let _ = handle.tx.send(SftpCommand::Close);
        }
    }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn run_sftp_worker(
    session_id: String,
    profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    elevated: bool,
    max_parallelism: usize,
    rx: mpsc::Receiver<SftpCommand>,
    ready: mpsc::SyncSender<Result<(), String>>,
    app_handle: AppHandle,
    controls: Arc<TransferControls>,
) {
    let mut backend = match connect_and_open_backend(
        &profile,
        password.as_deref(),
        passphrase.as_deref(),
        elevated,
        max_parallelism,
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
            SftpCommand::HomeDir { reply } => {
                let _ = reply.send(backend.home_dir().await);
            }
            SftpCommand::Mkdir { path, reply } => {
                let _ = reply.send(backend.mkdir(&path).await);
            }
            SftpCommand::CreateFile { path, reply } => {
                let _ = reply.send(backend.create_file(&path).await);
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
            SftpCommand::Chmod { path, mode, reply } => {
                let _ = reply.send(backend.chmod(&path, mode).await);
            }
            SftpCommand::Download {
                remote,
                local,
                transfer_id,
                verify_size,
                reply,
            } => {
                let ctx = TransferCtx {
                    transfer_id: &transfer_id,
                    app: &app_handle,
                    controls: &controls,
                    verify_size,
                };
                let res = backend.download(&remote, &local, ctx).await;
                let _ = reply.send(res);
            }
            SftpCommand::Upload {
                local,
                remote,
                transfer_id,
                verify_size,
                reply,
            } => {
                let ctx = TransferCtx {
                    transfer_id: &transfer_id,
                    app: &app_handle,
                    controls: &controls,
                    verify_size,
                };
                let res = backend.upload(&local, &remote, ctx).await;
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
                let ctx = TransferCtx {
                    transfer_id: &transfer_id,
                    app: &app_handle,
                    controls: &controls,
                    verify_size,
                };
                let res =
                    do_download_dir(backend.as_mut(), &remote, &local, ctx, conflict_policy).await;
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
                let ctx = TransferCtx {
                    transfer_id: &transfer_id,
                    app: &app_handle,
                    controls: &controls,
                    verify_size,
                };
                let res =
                    do_upload_dir(backend.as_mut(), &local, &remote, ctx, conflict_policy).await;
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
    max_parallelism: usize,
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
            let sftp = connect_and_open_sftp(
                profile, password, passphrase, elevated, app_handle, session_id,
            )
            .await?;
            Ok(Box::new(SftpBackend {
                sftp,
                max_parallelism,
            }))
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
    // window_size / maximum_packet_size de la config por defecto de russh
    // (2 MiB / 32 KiB) capan el throughput a ~window_size/RTT: con 25 ms de
    // RTT el techo queda en ~80 MB/s y baja drásticamente con RTTs mayores,
    // independientemente del pipelining SFTP. Subimos la ventana del canal a
    // 32 MiB y el paquete máximo al tope permitido (65535) para que el
    // pipeline de 16 × 256 KiB no se vea estrangulado por WINDOW_ADJUST.
    //
    // Además, russh hace rekey en 1 GiB exactos (RFC 4253 §9) y con
    // pipelining + servidores reales se queda colgado en esa transición. Los
    // campos `rekey_*_limit` de `Limits` son `pub` aunque `Limits::new()`
    // tenga un `assert!(<= 1<<30)`. Los subimos a `usize::MAX` para
    // desactivar el rekey por bytes durante la sesión SFTP (el rekey por
    // tiempo de 1 h sigue activo). OpenSSH permite lo mismo con `RekeyLimit
    // none`. Para sesiones SFTP de descarga/subida grande es la solución
    // limpia: para sesiones SSH interactivas dejamos el default por
    // higiene criptográfica en sesiones de días.
    let limits = russh::Limits {
        rekey_write_limit: usize::MAX,
        rekey_read_limit: usize::MAX,
        ..russh::Limits::default()
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        window_size: 32 * 1024 * 1024,
        maximum_packet_size: 65535,
        keepalive_interval: Some(Duration::from_secs(
            crate::ssh_manager::DEFAULT_SSH_KEEPALIVE_SECS,
        )),
        keepalive_max: crate::ssh_manager::DEFAULT_SSH_KEEPALIVE_MAX,
        limits,
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
    let mut handle =
        match crate::ssh_manager::russh_connect_addr(config, &addr, client_handler).await {
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
            .inspect_err(|e| {
                emit_sftp_log(app_handle, session_id, "auth", "error", e.clone());
            })?,
    };

    match auth {
        AuthResult::Success => {
            emit_sftp_log(app_handle, session_id, "auth", "ok", "Autenticado");
        }
        AuthResult::Failure {
            remaining_methods, ..
        } => {
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

    let sftp = SftpSession::new_with_config(
        channel.into_stream(),
        SftpConfig {
            request_timeout_secs: SFTP_REQUEST_TIMEOUT_SECS,
            ..SftpConfig::default()
        },
    )
    .await
    .map_err(|e| {
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
    for identity in identities {
        let key = identity.public_key().into_owned();
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
        partial_success: false,
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

    async fn create_file(&mut self, path: &str) -> Result<(), String> {
        let file = self
            .sftp
            .open_with_flags(
                path.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            )
            .await
            .map_err(|e| e.to_string())?;
        drop(file);
        Ok(())
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

    async fn chmod(&mut self, path: &str, mode: u32) -> Result<(), String> {
        self.sftp
            .set_metadata(
                path.to_string(),
                FileAttributes {
                    size: None,
                    uid: None,
                    user: None,
                    gid: None,
                    group: None,
                    permissions: Some(mode),
                    atime: None,
                    mtime: None,
                },
            )
            .await
            .map_err(|e| e.to_string())
    }

    async fn download(
        &mut self,
        remote: &str,
        local: &Path,
        ctx: TransferCtx<'_>,
    ) -> Result<(), String> {
        do_download(&self.sftp, remote, local, ctx, self.max_parallelism).await
    }

    async fn upload(
        &mut self,
        local: &Path,
        remote: &str,
        ctx: TransferCtx<'_>,
    ) -> Result<(), String> {
        do_upload(&self.sftp, local, remote, ctx, self.max_parallelism).await
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

    fn create_file(&mut self, path: &str) -> Result<(), String> {
        // No sobrescribir si existe.
        let exists = match self {
            Self::Plain(ftp) => ftp.size(path).is_ok(),
            Self::ExplicitTls(ftp) => ftp.size(path).is_ok(),
        };
        if exists {
            return Err("ya existe".to_string());
        }
        let mut empty: &[u8] = &[];
        match self {
            Self::Plain(ftp) => ftp.put_file(path, &mut empty),
            Self::ExplicitTls(ftp) => ftp.put_file(path, &mut empty),
        }
        .map(|_| ())
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
        controls: &Arc<TransferControls>,
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
                    controls,
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
                    controls,
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
        controls: &Arc<TransferControls>,
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
                    controls,
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
                    controls,
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

    async fn create_file(&mut self, path: &str) -> Result<(), String> {
        self.ftp.create_file(path)
    }

    async fn remove(&mut self, path: &str, is_dir: bool) -> Result<(), String> {
        self.ftp.remove(path, is_dir)
    }

    async fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        self.ftp.rename(from, to)
    }

    async fn chmod(&mut self, _path: &str, _mode: u32) -> Result<(), String> {
        Err("Cambiar permisos no está soportado en conexiones FTP/FTPS".to_string())
    }

    async fn download(
        &mut self,
        remote: &str,
        local: &Path,
        ctx: TransferCtx<'_>,
    ) -> Result<(), String> {
        let entry = ftp_stat(&mut self.ftp, remote)?;
        let total = entry.size;
        // Mismo contrato que SFTP: el fichero se materializa en un `.part` y solo
        // ocupa su nombre definitivo si la transferencia y la verificación van
        // bien (ver `part_path`).
        let part = part_path(local);
        let result = self
            .ftp
            .download_to(remote, &part, total, ctx.transfer_id, ctx.app, ctx.controls)
            .and_then(|()| {
                if !ctx.verify_size {
                    return Ok(());
                }
                let written = std::fs::metadata(&part)
                    .map_err(|e| format!("verificación local: {e}"))?
                    .len();
                if written != total {
                    return Err(format!(
                        "verificación fallida: tamaño local {written} B, esperado {total} B"
                    ));
                }
                Ok(())
            });
        match result {
            Ok(()) => std::fs::rename(&part, local)
                .map_err(|e| format!("no se pudo publicar la descarga: {e}")),
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                Err(e)
            }
        }
    }

    async fn upload(
        &mut self,
        local: &Path,
        remote: &str,
        ctx: TransferCtx<'_>,
    ) -> Result<(), String> {
        let total = std::fs::metadata(local).map_err(|e| e.to_string())?.len();
        self.ftp
            .upload_from(local, remote, total, ctx.transfer_id, ctx.app, ctx.controls)?;
        if ctx.verify_size {
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

// Tamaño de cada petición SFTP (read/write). El máximo del cliente russh-sftp
// es 256 KiB; usar el tope reduce el número de round-trips frente a buffers
// más pequeños.
const SFTP_CHUNK: u64 = 256 * 1024;
// Peticiones SFTP simultáneas en vuelo durante una transferencia. Mantener N
// peticiones a la vez satura el ancho de banda real cuando el RTT no es
// despreciable (sin pipelining el techo es chunk_size / RTT).
const SFTP_PIPELINE: usize = 32;
// russh renegocia claves al cruzar 1 GiB (límite recomendado por RFC 4253).
// Durante esa ventana alguna petición SFTP puede tardar bastante más que los
// 10s por defecto de russh-sftp, especialmente con pipeline y servidores lentos.
const SFTP_REQUEST_TIMEOUT_SECS: u64 = 120;
// Tope del read-ahead en la descarga pipelined, en múltiplos de la ventana del
// pipeline (parallelism × SFTP_CHUNK). Si el chunk que toca escribir se atasca
// (rekey, servidor que completa fuera de orden), el resto de handles seguiría
// leyendo y el buffer de reordenado crecería sin límite (OOM con ficheros
// grandes en LAN rápida). ×2 mantiene el pipeline lleno y absorbe el desorden
// acotando el buffer a ~16 MiB con la ventana máxima.
const SFTP_READAHEAD_FACTOR: u64 = 2;

/// Sufijo del fichero temporal en el que se materializa una descarga antes de
/// ocupar su nombre definitivo.
const PART_SUFFIX: &str = ".rustty-part";

/// Ruta del temporal de descarga que corresponde a un destino final.
///
/// Escribir directo sobre el nombre definitivo deja, ante cualquier fallo a
/// mitad (red, cancelación, disco lleno), un fichero **truncado con aspecto de
/// completo** en el directorio del usuario —indistinguible del bueno—. Se baja
/// primero a `<nombre>.rustty-part` y solo se renombra al nombre final cuando la
/// transferencia (y la verificación de tamaño, si está activa) ha ido bien.
fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_else(|| std::ffi::OsString::from("descarga"));
    name.push(PART_SUFFIX);
    final_path.with_file_name(name)
}

async fn do_download(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    ctx: TransferCtx<'_>,
    max_parallelism: usize,
) -> Result<(), String> {
    let meta = sftp
        .metadata(remote.to_string())
        .await
        .map_err(|e| e.to_string())?;
    let total = meta.len();

    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Se baja al temporal y solo se publica (rename) si todo va bien.
    let part = part_path(local);
    let result = async {
        // `create` trunca: un `.part` superviviente de un cierre brusco de la app
        // se sobrescribe en vez de acumularse.
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| e.to_string())?;
        pipelined_download(sftp, remote, &mut file, total, ctx, max_parallelism).await?;
        // Los datos deben estar en disco antes del rename: si no, un corte de luz
        // dejaría el nombre definitivo apuntando a contenido incompleto.
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);

        if ctx.verify_size {
            let written = tokio::fs::metadata(&part)
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
    .await;

    match result {
        Ok(()) => tokio::fs::rename(&part, local)
            .await
            .map_err(|e| format!("no se pudo publicar la descarga: {e}")),
        Err(e) => {
            // Nada de restos: el usuario no debe encontrarse un fichero a medias,
            // ni con el nombre bueno ni con el `.part`.
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

async fn do_upload(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    ctx: TransferCtx<'_>,
    max_parallelism: usize,
) -> Result<(), String> {
    let meta = tokio::fs::metadata(local)
        .await
        .map_err(|e| e.to_string())?;
    let total = meta.len();

    pipelined_upload(sftp, local, remote, total, ctx, max_parallelism).await?;

    if ctx.verify_size {
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

/// Descarga con pipelining: abre N file handles SFTP sobre el mismo remoto,
/// mantiene hasta N reads simultáneos en vuelo y los escribe al fichero local
/// en el orden correcto usando una BTreeMap como buffer de reordenado.
async fn pipelined_download(
    sftp: &SftpSession,
    remote: &str,
    local_file: &mut tokio::fs::File,
    total: u64,
    ctx: TransferCtx<'_>,
    max_parallelism: usize,
) -> Result<(), String> {
    let TransferCtx {
        transfer_id,
        app,
        controls,
        ..
    } = ctx;
    let event = event_name(EventKind::SftpProgress, transfer_id);
    let _ = app.emit(
        &event,
        serde_json::json!({ "transferred": 0u64, "total": total, "done": false }),
    );

    if total == 0 {
        let _ = app.emit(
            &event,
            serde_json::json!({ "transferred": 0u64, "total": 0u64, "done": true }),
        );
        return Ok(());
    }

    // Abrir N file handles concurrentemente para no pagar N RTT secuenciales.
    let parallelism = effective_parallelism(total, max_parallelism);
    let mut idle_files: Vec<SftpFile> = open_handles(sftp, remote, parallelism, OpenFlags::READ)
        .await
        .map_err(|e| format!("No se pudieron abrir los handles SFTP: {e}"))?;

    let mut next_read: u64 = 0;
    let mut next_write: u64 = 0;
    let mut transferred: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut completed: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
    let mut in_flight: FuturesUnordered<_> = FuturesUnordered::new();

    let mut was_paused = false;
    loop {
        if controls.take_cancel(transfer_id) {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": true, "canceled": true,
                }),
            );
            return Err("transferencia cancelada".to_string());
        }

        // Pausa: dejamos terminar lo que ya está en vuelo, no encolamos nuevos
        // chunks y dormimos breves intervalos hasta que el usuario reanude o
        // cancele. Mantenemos handles SFTP abiertos para no perder posición.
        let paused = controls.is_paused(transfer_id);
        if paused && !was_paused {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": false, "paused": true,
                }),
            );
        } else if !paused && was_paused {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": false, "paused": false,
                }),
            );
        }
        was_paused = paused;

        if !paused {
            // No leer más allá de `max_ahead` por delante de lo ya escrito:
            // el chunk pendiente en `next_write` siempre está en vuelo o en
            // `completed`, así que frenar aquí no puede interbloquear el bucle.
            let max_ahead = SFTP_CHUNK * SFTP_READAHEAD_FACTOR * parallelism as u64;
            while !idle_files.is_empty() && next_read < total && next_read - next_write < max_ahead
            {
                let mut f = idle_files.pop().unwrap();
                let len = (total - next_read).min(SFTP_CHUNK);
                let off = next_read;
                next_read += len;
                in_flight.push(async move {
                    let res = read_chunk_at(&mut f, off, len).await;
                    (f, off, res)
                });
            }
        }

        if in_flight.is_empty() {
            if paused {
                tokio::time::sleep(Duration::from_millis(150)).await;
                continue;
            }
            break;
        }

        let (f, offset, result) = in_flight.next().await.unwrap();
        idle_files.push(f);
        let data = result?;
        completed.insert(offset, data);

        while let Some(data) = completed.remove(&next_write) {
            let n = data.len() as u64;
            if n == 0 {
                return Err("EOF inesperado durante la descarga".to_string());
            }
            local_file
                .write_all(&data)
                .await
                .map_err(|e| e.to_string())?;
            next_write += n;
            transferred += n;

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
    }

    local_file.flush().await.map_err(|e| e.to_string())?;
    let _ = app.emit(
        &event,
        serde_json::json!({ "transferred": transferred, "total": total, "done": true }),
    );
    Ok(())
}

/// Lee `len` bytes desde `offset` reintentando hasta cubrir el chunk o llegar
/// a EOF. El servidor puede devolver menos bytes de los pedidos.
async fn read_chunk_at(file: &mut SftpFile, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    use std::io::SeekFrom;
    file.seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]).await {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(e.to_string()),
        }
    }
    buf.truncate(filled);
    Ok(buf)
}

/// Sube con pipelining. El primer handle se abre con TRUNCATE para vaciar el
/// destino; los N-1 restantes se abren con WRITE para escribir en paralelo a
/// distintos offsets sobre el mismo fichero.
async fn pipelined_upload(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    total: u64,
    ctx: TransferCtx<'_>,
    max_parallelism: usize,
) -> Result<(), String> {
    let TransferCtx {
        transfer_id,
        app,
        controls,
        ..
    } = ctx;
    let event = event_name(EventKind::SftpProgress, transfer_id);
    let _ = app.emit(
        &event,
        serde_json::json!({ "transferred": 0u64, "total": total, "done": false }),
    );

    // Crear/truncar el remoto antes de abrir handles paralelos. El primer
    // handle también nos sirve como uno de los N en vuelo.
    let first = sftp
        .open_with_flags(
            remote.to_string(),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| e.to_string())?;

    if total == 0 {
        drop(first);
        let _ = app.emit(
            &event,
            serde_json::json!({ "transferred": 0u64, "total": 0u64, "done": true }),
        );
        return Ok(());
    }

    let parallelism = effective_parallelism(total, max_parallelism);
    let mut idle_files: Vec<SftpFile> = Vec::with_capacity(parallelism);
    idle_files.push(first);
    if parallelism > 1 {
        let extra = open_handles(sftp, remote, parallelism - 1, OpenFlags::WRITE)
            .await
            .map_err(|e| format!("No se pudieron abrir los handles SFTP: {e}"))?;
        idle_files.extend(extra);
    }

    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| e.to_string())?;

    let mut next_offset: u64 = 0;
    let mut transferred: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut in_flight: FuturesUnordered<_> = FuturesUnordered::new();
    let mut was_paused = false;

    loop {
        if controls.take_cancel(transfer_id) {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": true, "canceled": true,
                }),
            );
            return Err("transferencia cancelada".to_string());
        }

        let paused = controls.is_paused(transfer_id);
        if paused && !was_paused {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": false, "paused": true,
                }),
            );
        } else if !paused && was_paused {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": false, "paused": false,
                }),
            );
        }
        was_paused = paused;

        if !paused {
            while !idle_files.is_empty() && next_offset < total {
                let mut f = idle_files.pop().unwrap();
                let len = (total - next_offset).min(SFTP_CHUNK);
                let off = next_offset;
                next_offset += len;

                let mut buf = vec![0u8; len as usize];
                let mut filled = 0usize;
                while filled < buf.len() {
                    match local_file.read(&mut buf[filled..]).await {
                        Ok(0) => break,
                        Ok(n) => filled += n,
                        Err(e) => return Err(e.to_string()),
                    }
                }
                if filled == 0 {
                    idle_files.push(f);
                    next_offset = total; // forzar fin del bucle externo
                    break;
                }
                buf.truncate(filled);

                in_flight.push(async move {
                    let res = write_chunk_at(&mut f, off, &buf).await;
                    (f, filled as u64, res)
                });
            }
        }

        if in_flight.is_empty() {
            if paused {
                tokio::time::sleep(Duration::from_millis(150)).await;
                continue;
            }
            break;
        }

        let (f, n, result) = in_flight.next().await.unwrap();
        idle_files.push(f);
        result?;
        transferred += n;

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

    // Cerrar los handles de forma ordenada antes de informar "done" para que
    // el servidor haya flusheado al volver al main loop.
    for f in idle_files.drain(..) {
        drop(f);
    }

    let _ = app.emit(
        &event,
        serde_json::json!({ "transferred": transferred, "total": total, "done": true }),
    );
    Ok(())
}

async fn write_chunk_at(file: &mut SftpFile, offset: u64, data: &[u8]) -> Result<(), String> {
    use std::io::SeekFrom;
    // SeekFrom::Start sólo actualiza el `pos` local, no hace round-trip;
    // así cada chunk consume exactamente un WRITE remoto. Saltamos `flush`
    // a propósito: provocaría un fsync por chunk y anula el pipelining.
    file.seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| e.to_string())?;
    file.write_all(data).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Abre `count` file handles concurrentemente sobre el mismo path. Devuelve
/// el primer error si alguno falla.
async fn open_handles(
    sftp: &SftpSession,
    remote: &str,
    count: usize,
    flags: OpenFlags,
) -> Result<Vec<SftpFile>, String> {
    let mut futs = FuturesUnordered::new();
    for _ in 0..count {
        futs.push(sftp.open_with_flags(remote.to_string(), flags));
    }
    let mut handles = Vec::with_capacity(count);
    while let Some(res) = futs.next().await {
        handles.push(res.map_err(|e| e.to_string())?);
    }
    Ok(handles)
}

fn effective_parallelism(total: u64, cap: usize) -> usize {
    if total <= SFTP_CHUNK {
        return 1;
    }
    let cap = cap.clamp(1, SFTP_PIPELINE);
    let chunks = total.div_ceil(SFTP_CHUNK) as usize;
    chunks.min(cap).max(1)
}

fn transfer_copy_blocking<R, W>(
    src: &mut R,
    dst: &mut W,
    total: u64,
    transfer_id: &str,
    app: &AppHandle,
    controls: &Arc<TransferControls>,
) -> Result<(), String>
where
    R: Read,
    W: Write,
{
    let mut buf = vec![0u8; 256 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit: u64 = 0;
    let event = event_name(EventKind::SftpProgress, transfer_id);

    let _ = app.emit(
        &event,
        serde_json::json!({
            "transferred": 0u64, "total": total, "done": false,
        }),
    );

    let mut was_paused = false;
    loop {
        if controls.take_cancel(transfer_id) {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": true, "canceled": true,
                }),
            );
            return Err("transferencia cancelada".to_string());
        }

        // En FTP/FTPS el copy es serie sobre un stream síncrono. Pausamos
        // bloqueando el hilo del worker con sleeps cortos: el stream queda
        // ocioso pero la conexión sigue viva (el server puede tirarla por
        // idle si la pausa es muy larga; aceptable).
        let paused = controls.is_paused(transfer_id);
        if paused {
            if !was_paused {
                let _ = app.emit(
                    &event,
                    serde_json::json!({
                        "transferred": transferred, "total": total, "done": false, "paused": true,
                    }),
                );
                was_paused = true;
            }
            std::thread::sleep(Duration::from_millis(150));
            continue;
        } else if was_paused {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": false, "paused": false,
                }),
            );
            was_paused = false;
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
/// Emite un evento de progreso de **transferencia de carpeta** sobre el
/// `transfer_id` de la carpeta (no el del archivo individual). Lleva el archivo
/// que se está transfiriendo ahora (`current`, ruta relativa a la raíz) y el
/// contador `filesDone`/`filesTotal`, además de los bytes agregados para que la
/// barra/velocidad/ETA de la fila reflejen el total de la carpeta. Estilo
/// FileZilla: el usuario ve qué subcarpeta/archivo va transfiriéndose.
fn emit_dir_progress(
    app: &AppHandle,
    event: &str,
    bytes_done: u64,
    bytes_total: u64,
    current: &str,
    files_done: u32,
    files_total: u32,
) {
    let _ = app.emit(
        event,
        serde_json::json!({
            "transferred": bytes_done,
            "total": bytes_total,
            "done": false,
            "kind": "dir",
            "current": current,
            "filesDone": files_done,
            "filesTotal": files_total,
        }),
    );
}

/// Recuento de un árbol antes de transferirlo: archivos regulares, bytes y
/// **enlaces simbólicos que se van a omitir**. Los symlinks se saltan en ambas
/// direcciones (copiarlos tal cual apuntaría a rutas inexistentes en el otro
/// extremo, y seguirlos puede sacar la copia del árbol o meterla en un ciclo),
/// pero omitirlos en silencio hacía creer al usuario que se había copiado todo:
/// se cuentan para poder decírselo al terminar.
struct TreeCount {
    files: u32,
    bytes: u64,
    symlinks: u32,
}

/// Cuenta el árbol local (mismos criterios que el bucle de subida).
async fn count_local_tree(root: &Path) -> TreeCount {
    let mut count = TreeCount {
        files: 0,
        bytes: 0,
        symlinks: 0,
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(mut read) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = read.next_entry().await {
            let Ok(ft) = entry.file_type().await else {
                continue;
            };
            // `file_type()` de `read_dir` no sigue el enlace: un symlink nunca es
            // `is_dir`/`is_file` aquí, ni siquiera si apunta a un directorio.
            if ft.is_symlink() {
                count.symlinks += 1;
            } else if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                count.files += 1;
                if let Ok(meta) = entry.metadata().await {
                    count.bytes += meta.len();
                }
            }
        }
    }
    count
}

/// Cuenta el árbol remoto recorriéndolo con `list_dir` (mismos criterios que el
/// bucle de descarga). Hace un recorrido extra de listados; aceptable para
/// mostrar totales de progreso de carpeta.
async fn count_remote_tree(backend: &mut dyn FileTransfer, root: &str) -> TreeCount {
    let mut count = TreeCount {
        files: 0,
        bytes: 0,
        symlinks: 0,
    };
    let mut stack = vec![root.to_string()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = backend.list_dir(&dir).await else {
            continue;
        };
        for e in entries {
            if e.is_dir {
                stack.push(e.path.clone());
            } else if e.is_symlink {
                count.symlinks += 1;
            } else {
                count.files += 1;
                count.bytes += e.size;
            }
        }
    }
    count
}

/// Valida que el nombre de una entrada remota (el que devuelve el servidor en el
/// listado SFTP/FTP) sea un único componente de ruta seguro antes de usarlo para
/// construir un destino local. Un servidor malicioso o comprometido podría
/// devolver `../../.bashrc`, un nombre con separadores (`a/b`) o incluso una ruta
/// absoluta; como `Path::join` con una ruta absoluta *reemplaza* la base, eso
/// permitiría escribir ficheros fuera del directorio de descarga elegido (clase
/// CVE de rsync/scp). Se rechazan además `.`, `..` y el nombre vacío.
fn safe_entry_name(name: &str) -> Result<(), String> {
    use std::path::Component;
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!(
            "el servidor devolvió un nombre de entrada no seguro: {name:?}"
        ));
    }
    // Defensa en profundidad: cualquier cosa que no sea un único componente
    // «normal» (prefijos de unidad/raíz en Windows, etc.) también se rechaza.
    let mut comps = Path::new(name).components();
    if !matches!(
        (comps.next(), comps.next()),
        (Some(Component::Normal(_)), None)
    ) {
        return Err(format!(
            "el servidor devolvió un nombre de entrada no seguro: {name:?}"
        ));
    }
    Ok(())
}

/// Puerta de cancelación/pausa entre ficheros de una transferencia de carpeta.
/// El frontend cancela/pausa siempre con el `transfer_id` **padre**, pero los
/// ficheros individuales corren bajo sub-ids `{transfer_id}-{idx}` que nunca
/// reciben esas señales; sin esta comprobación, «Cancelar»/«Pausar» sobre una
/// carpeta no tenían ningún efecto. Se consulta el id padre antes de cada
/// fichero: cancela abortando el trabajo y pausa bloqueando hasta reanudar.
async fn gate_dir_transfer(
    transfer_id: &str,
    summary_event: &str,
    bytes_done: u64,
    bytes_total: u64,
    app: &AppHandle,
    controls: &Arc<TransferControls>,
) -> Result<(), String> {
    let mut emitted_pause = false;
    loop {
        if controls.take_cancel(transfer_id) {
            let _ = app.emit(
                summary_event,
                serde_json::json!({
                    "transferred": bytes_done, "total": bytes_total, "done": true,
                    "canceled": true, "kind": "dir",
                }),
            );
            return Err("transferencia cancelada".to_string());
        }
        if controls.is_paused(transfer_id) {
            if !emitted_pause {
                let _ = app.emit(
                    summary_event,
                    serde_json::json!({
                        "transferred": bytes_done, "total": bytes_total, "done": false,
                        "paused": true, "kind": "dir",
                    }),
                );
                emitted_pause = true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            continue;
        }
        if emitted_pause {
            let _ = app.emit(
                summary_event,
                serde_json::json!({
                    "transferred": bytes_done, "total": bytes_total, "done": false,
                    "paused": false, "kind": "dir",
                }),
            );
        }
        return Ok(());
    }
}

async fn do_download_dir(
    backend: &mut dyn FileTransfer,
    remote: &str,
    local: &Path,
    ctx: TransferCtx<'_>,
    conflict_policy: TransferConflictPolicy,
) -> Result<(), String> {
    let TransferCtx {
        transfer_id, app, ..
    } = ctx;
    tokio::fs::create_dir_all(local)
        .await
        .map_err(|e| e.to_string())?;
    let summary_event = event_name(EventKind::SftpProgress, transfer_id);
    let mut idx: u32 = 0;

    // Pre-conteo del árbol remoto para mostrar archivo actual + N/total.
    let precount = count_remote_tree(backend, remote).await;
    let (files_total, bytes_total) = (precount.files, precount.bytes);
    let mut files_done: u32 = 0;
    let mut bytes_done: u64 = 0;
    let mut skipped_symlinks: u32 = 0;
    emit_dir_progress(app, &summary_event, 0, bytes_total, "", 0, files_total);

    let mut stack = vec![(remote.to_string(), local.to_path_buf())];
    while let Some((rdir, ldir)) = stack.pop() {
        let entries = backend.list_dir(&rdir).await?;
        for e in entries {
            safe_entry_name(&e.name)?;
            gate_dir_transfer(
                transfer_id,
                &summary_event,
                bytes_done,
                bytes_total,
                app,
                ctx.controls,
            )
            .await?;
            let mut local_target = ldir.join(&e.name);
            if e.is_dir {
                tokio::fs::create_dir_all(&local_target)
                    .await
                    .map_err(|err| err.to_string())?;
                stack.push((e.path.clone(), local_target));
            } else if e.is_symlink {
                // Se omite (ver `TreeCount`), pero queda contado para avisar al final.
                skipped_symlinks += 1;
            } else {
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
                let rel = {
                    let r = e
                        .path
                        .strip_prefix(remote)
                        .unwrap_or(&e.path)
                        .trim_start_matches('/');
                    if r.is_empty() {
                        e.name.clone()
                    } else {
                        r.to_string()
                    }
                };
                emit_dir_progress(
                    app,
                    &summary_event,
                    bytes_done,
                    bytes_total,
                    &rel,
                    files_done + 1,
                    files_total,
                );
                idx += 1;
                let sub_id = format!("{transfer_id}-{idx}");
                backend
                    .download(&e.path, &local_target, ctx.child(&sub_id))
                    .await?;
                bytes_done += e.size;
                files_done += 1;
            }
        }
    }
    let _ = app.emit(
        &summary_event,
        serde_json::json!({
            "transferred": bytes_total, "total": bytes_total, "done": true, "kind": "dir",
            "filesDone": files_total, "filesTotal": files_total,
            "skippedSymlinks": skipped_symlinks,
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
    ctx: TransferCtx<'_>,
    conflict_policy: TransferConflictPolicy,
) -> Result<(), String> {
    let TransferCtx {
        transfer_id, app, ..
    } = ctx;
    let _ = backend.mkdir(remote).await; // ignorar si ya existe
    let summary_event = event_name(EventKind::SftpProgress, transfer_id);
    let mut idx: u32 = 0;

    // Pre-conteo para conocer el total (estilo FileZilla: archivo actual + N/total).
    let precount = count_local_tree(local).await;
    let (files_total, bytes_total) = (precount.files, precount.bytes);
    let mut files_done: u32 = 0;
    let mut bytes_done: u64 = 0;
    let mut skipped_symlinks: u32 = 0;
    emit_dir_progress(app, &summary_event, 0, bytes_total, "", 0, files_total);

    let mut stack = vec![(local.to_path_buf(), remote.to_string())];
    while let Some((ldir, rdir)) = stack.pop() {
        let mut read = tokio::fs::read_dir(&ldir)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = read.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name().to_string_lossy().into_owned();
            gate_dir_transfer(
                transfer_id,
                &summary_event,
                bytes_done,
                bytes_total,
                app,
                ctx.controls,
            )
            .await?;
            let path = entry.path();
            let mut remote_target = join_remote(&rdir, &name);
            let ft = entry.file_type().await.map_err(|e| e.to_string())?;
            if ft.is_symlink() {
                // Se omite (ver `TreeCount`), pero queda contado para avisar al final.
                skipped_symlinks += 1;
            } else if ft.is_dir() {
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
                let fsize = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                let rel = path
                    .strip_prefix(local)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                emit_dir_progress(
                    app,
                    &summary_event,
                    bytes_done,
                    bytes_total,
                    &rel,
                    files_done + 1,
                    files_total,
                );
                idx += 1;
                let sub_id = format!("{transfer_id}-{idx}");
                backend
                    .upload(&path, &remote_target, ctx.child(&sub_id))
                    .await?;
                bytes_done += fsize;
                files_done += 1;
            }
        }
    }
    let _ = app.emit(
        &summary_event,
        serde_json::json!({
            "transferred": bytes_total, "total": bytes_total, "done": true, "kind": "dir",
            "filesDone": files_total, "filesTotal": files_total,
            "skippedSymlinks": skipped_symlinks,
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // `effective_parallelism` decide cuántos handles SFTP abrir en paralelo
    // según el tamaño total de la transferencia. Verificamos sus ramas:
    // - total <= SFTP_CHUNK  → 1 (no merece la pena paralelizar)
    // - total mayor          → nº de chunks (div_ceil) acotado a SFTP_PIPELINE
    #[test]
    fn safe_entry_name_acepta_nombres_simples() {
        assert!(safe_entry_name("documento.txt").is_ok());
        assert!(safe_entry_name(".bashrc").is_ok());
        assert!(safe_entry_name("con espacios y ñ.log").is_ok());
    }

    #[test]
    fn safe_entry_name_rechaza_travesias_y_separadores() {
        // Nombres que un servidor malicioso podría devolver para escapar del
        // directorio de descarga elegido.
        assert!(safe_entry_name("..").is_err());
        assert!(safe_entry_name(".").is_err());
        assert!(safe_entry_name("").is_err());
        assert!(safe_entry_name("../../../.ssh/authorized_keys").is_err());
        assert!(safe_entry_name("sub/dir").is_err());
        assert!(safe_entry_name("sub\\dir").is_err());
        assert!(safe_entry_name("/etc/passwd").is_err());
    }

    #[test]
    fn part_path_es_hermano_del_destino_final() {
        let final_path = Path::new("/home/u/Descargas/informe.pdf");
        let p = part_path(final_path);
        assert_eq!(p, Path::new("/home/u/Descargas/informe.pdf.rustty-part"));
        // Mismo directorio que el destino: el rename final no cruza sistemas de
        // ficheros (que lo haría no atómico y, con /tmp en otra partición, lento).
        assert_eq!(p.parent(), final_path.parent());
        // Nombres ocultos o sin extensión también funcionan.
        assert_eq!(
            part_path(Path::new("/tmp/.bashrc")),
            Path::new("/tmp/.bashrc.rustty-part")
        );
    }

    #[tokio::test]
    async fn count_local_tree_cuenta_symlinks_aparte_de_los_ficheros() {
        let dir = std::env::temp_dir().join(format!("rustty-count-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), b"hola").unwrap();
        std::fs::write(dir.join("sub/b.txt"), b"adios!").unwrap();
        #[cfg(unix)]
        {
            // Un enlace a fichero y otro a directorio: ninguno se transfiere.
            std::os::unix::fs::symlink(dir.join("a.txt"), dir.join("enlace.txt")).unwrap();
            std::os::unix::fs::symlink(dir.join("sub"), dir.join("enlace-dir")).unwrap();
        }

        let count = count_local_tree(&dir).await;
        assert_eq!(count.files, 2, "solo los ficheros regulares se suben");
        assert_eq!(count.bytes, 4 + 6);
        #[cfg(unix)]
        assert_eq!(count.symlinks, 2, "los enlaces se cuentan como omitidos");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn paralelismo_es_uno_para_transferencias_pequenas() {
        assert_eq!(effective_parallelism(0, SFTP_PIPELINE), 1);
        assert_eq!(effective_parallelism(1, SFTP_PIPELINE), 1);
        // Justo en el límite de un chunk también devuelve 1.
        assert_eq!(effective_parallelism(SFTP_CHUNK, SFTP_PIPELINE), 1);
    }

    #[test]
    fn paralelismo_crece_con_el_numero_de_chunks() {
        // Un byte por encima de un chunk ya son 2 chunks.
        assert_eq!(effective_parallelism(SFTP_CHUNK + 1, SFTP_PIPELINE), 2);
        // Exactamente tres chunks → 3.
        assert_eq!(effective_parallelism(SFTP_CHUNK * 3, SFTP_PIPELINE), 3);
        // Tres chunks y un byte → 4 chunks (div_ceil redondea hacia arriba).
        assert_eq!(effective_parallelism(SFTP_CHUNK * 3 + 1, SFTP_PIPELINE), 4);
    }

    #[test]
    fn paralelismo_se_topa_en_el_pipeline_maximo() {
        // Muchísimos chunks: nunca supera SFTP_PIPELINE aunque el cap sea mayor.
        let enorme = SFTP_CHUNK * (SFTP_PIPELINE as u64) * 10;
        assert_eq!(effective_parallelism(enorme, 1000), SFTP_PIPELINE);
        // Justo SFTP_PIPELINE chunks → SFTP_PIPELINE.
        assert_eq!(
            effective_parallelism(SFTP_CHUNK * SFTP_PIPELINE as u64, SFTP_PIPELINE),
            SFTP_PIPELINE
        );
        // Un chunk más allá del pipeline sigue topado.
        assert_eq!(
            effective_parallelism(SFTP_CHUNK * (SFTP_PIPELINE as u64 + 5), SFTP_PIPELINE),
            SFTP_PIPELINE
        );
    }

    #[test]
    fn paralelismo_respeta_el_cap_configurado() {
        // Con muchos chunks, el cap por sesión limita los handles en vuelo.
        let enorme = SFTP_CHUNK * 50;
        assert_eq!(effective_parallelism(enorme, 4), 4);
        assert_eq!(effective_parallelism(enorme, 1), 1);
        // Un cap de 0 se sanea a 1; un cap exagerado se topa en SFTP_PIPELINE.
        assert_eq!(effective_parallelism(enorme, 0), 1);
        assert_eq!(effective_parallelism(enorme, usize::MAX), SFTP_PIPELINE);
    }
}
