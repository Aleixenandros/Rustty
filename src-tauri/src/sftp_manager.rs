//! Gestor de transferencia de ficheros basado en SFTP (`russh-sftp`) y
//! FTP/FTPS (`suppaftp`).
//!
//! A diferencia de libssh2/ssh2-rs (que sólo expone el subsistema SFTP
//! estándar), russh nos permite abrir un canal `exec` y hablar SFTP por
//! encima de `sudo -n /usr/libexec/openssh/sftp-server`, lo que da
//! elevación real de privilegios al panel de ficheros.
//!
//! Cada sesión SFTP vive en su propio hilo con una Runtime de tokio
//! single-threaded; los comandos llegan por un canal de tokio desde el hilo
//! principal de Tauri. Entre comando y comando el worker **espera con `await`**:
//! la sesión SSH (keepalives, respuestas a los sondeos del servidor, rekey) y el
//! lector SFTP son tareas de esa misma runtime, y una espera síncrona las
//! congelaba con el panel ocioso hasta que el servidor cortaba la conexión.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use russh::client::{self, AuthResult};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh_sftp::client::fs::File as SftpFile;
use russh_sftp::client::{Config as SftpConfig, SftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags};

use crate::host_keys;
use crate::ipc::{event_name, EventKind};
use crate::profiles::{AuthType, ConnectionProfile};
use crate::transfer_batch::{self, Batch};
use crate::transfer_resume;

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
    /// La sesión se está cerrando: **toda** transferencia suya cuenta como
    /// cancelada (también los ficheros de una carpeta y las pausadas), sin
    /// consumirse. Sin esto, cerrar la pestaña o el panel dejaba la copia en
    /// marcha en segundo plano, ya sin fila desde la que pararla.
    closing: AtomicBool,
}

/// Pausa global: afecta a **todas** las transferencias de todas las sesiones a
/// la vez. Vive fuera de `TransferControls` —que es por sesión— porque el
/// gesto que la enciende («pausa todo, necesito el ancho de banda») no es de
/// una sesión concreta. Una transferencia está pausada si lo está ella o si lo
/// está el mundo entero; reanudar todo no despausa las que el usuario había
/// pausado una a una.
static PAUSE_ALL: AtomicBool = AtomicBool::new(false);

/// Enciende o apaga la pausa global de transferencias.
pub fn set_pause_all(paused: bool) {
    PAUSE_ALL.store(paused, Ordering::Relaxed);
}

/// `true` si la pausa global está activa.
#[must_use]
pub fn pause_all_active() -> bool {
    PAUSE_ALL.load(Ordering::Relaxed)
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
    /// En un fichero de una transferencia de carpeta, el id de la carpeta: es
    /// con el que el frontend pausa y cancela. `None` en una transferencia suelta.
    parent_id: Option<&'a str>,
    app: &'a AppHandle,
    controls: &'a Arc<TransferControls>,
    verify_size: bool,
}

impl<'a> TransferCtx<'a> {
    /// El mismo contexto para un fichero suelto dentro de una transferencia de
    /// carpeta: cambia el `transfer_id`, recuerda el de la carpeta y conserva el
    /// resto.
    fn child<'b>(self, transfer_id: &'b str) -> TransferCtx<'b>
    where
        'a: 'b,
    {
        TransferCtx {
            transfer_id,
            parent_id: Some(self.transfer_id),
            app: self.app,
            controls: self.controls,
            verify_size: self.verify_size,
        }
    }

    /// ¿Hay que cancelar esta transferencia? Ver
    /// [`TransferControls::cancel_requested`].
    fn cancel_requested(&self) -> bool {
        self.controls.cancel_requested(self.transfer_id, self.parent_id)
    }

    /// ¿Está en pausa esta transferencia, o la carpeta a la que pertenece?
    fn paused(&self) -> bool {
        self.controls.paused_for(self.transfer_id, self.parent_id)
    }
}

impl TransferControls {
    fn new() -> Self {
        Self::default()
    }

    fn take_cancel(&self, transfer_id: &str) -> bool {
        self.closing.load(Ordering::Relaxed) || self.canceled.lock_recover().remove(transfer_id)
    }

    /// Cancela todo lo de la sesión, de una vez y para siempre: se llama al
    /// cerrarla. Cada `connect` crea controles nuevos, así que no se arrastra a
    /// una reconexión.
    fn close(&self) {
        self.closing.store(true, Ordering::Relaxed);
    }

    fn is_paused(&self, transfer_id: &str) -> bool {
        PAUSE_ALL.load(Ordering::Relaxed) || self.paused.lock_recover().contains(transfer_id)
    }

    /// Cancelación de `transfer_id` o, en un fichero de una carpeta, de la
    /// carpeta `parent` (el frontend cancela siempre con el id de la carpeta).
    /// La propia se consume (one-shot); la de la carpeta solo se consulta, para
    /// que paren a la vez todos sus ficheros en curso (los de un lote van en
    /// paralelo). La de la carpeta la consume el worker al terminarla, salga
    /// como salga.
    fn cancel_requested(&self, transfer_id: &str, parent: Option<&str>) -> bool {
        self.take_cancel(transfer_id)
            || parent.is_some_and(|p| self.canceled.lock_recover().contains(p))
    }

    /// Pausa de `transfer_id` o de la carpeta `parent` a la que pertenece.
    fn paused_for(&self, transfer_id: &str, parent: Option<&str>) -> bool {
        self.is_paused(transfer_id)
            || parent.is_some_and(|p| self.paused.lock_recover().contains(p))
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
        /// Permiso explícito para pisar un destino que ya exista.
        overwrite: bool,
        reply: Reply<()>,
    },
    Upload {
        local: PathBuf,
        remote: String,
        transfer_id: String,
        verify_size: bool,
        overwrite: bool,
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

    /// Cuántos ficheros pequeños puede mover a la vez en una transferencia de
    /// carpeta (ver [`crate::transfer_batch`]). Por defecto 1: en serie, como FTP,
    /// que tiene una sola conexión de control.
    fn small_file_concurrency(&self) -> usize {
        1
    }

    /// Mueve un lote de ficheros pequeños y devuelve un resultado por fichero.
    /// Por defecto, uno detrás de otro, parando en el primer error.
    async fn transfer_small_batch(
        &mut self,
        direction: BatchDirection,
        jobs: &[BatchJob],
        ctx: TransferCtx<'_>,
    ) -> Vec<Result<(), String>> {
        let mut results = Vec::with_capacity(jobs.len());
        for job in jobs {
            let result = match direction {
                BatchDirection::Download => {
                    self.download(&job.remote, &job.local, ctx.child(&job.sub_id))
                        .await
                }
                BatchDirection::Upload => {
                    self.upload(&job.local, &job.remote, ctx.child(&job.sub_id))
                        .await
                }
            };
            let failed = result.is_err();
            results.push(result);
            if failed {
                break;
            }
        }
        results
    }
}

struct SftpBackend {
    sftp: SftpSession,
    /// Máximo de peticiones SFTP simultáneas (handles en vuelo) por transferencia.
    /// Configurable por sesión; servidores restringidos como Hetzner Storage Box
    /// imponen un límite bajo de handles abiertos y un valor alto provoca
    /// "Handle limit reached".
    max_parallelism: usize,
    /// La cadena de saltos por la que va el panel: mientras viva la sesión, la
    /// conexión con los saltos sigue abierta (y compartida en el pool).
    _jump: Option<crate::jump_pool::JumpLease>,
}

struct FtpBackend {
    ftp: FtpConnection,
}

struct SftpHandle {
    tx: tokio::sync::mpsc::UnboundedSender<SftpCommand>,
    controls: Arc<TransferControls>,
    /// Copia del handle de la app: con ella, una transferencia que espera turno
    /// puede decírselo al panel sin arrastrar el `AppHandle` por las firmas de
    /// todos los comandos.
    app: AppHandle,
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
        routing: crate::jump_pool::Routing,
    ) -> Result<(), String> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<SftpCommand>();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let controls = Arc::new(TransferControls::new());

        let sid = session_id.clone();
        let worker_controls = Arc::clone(&controls);
        let handle_app = app_handle.clone();
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
                OpenRequest {
                    profile: &profile,
                    password: password.as_deref(),
                    passphrase: passphrase.as_deref(),
                    elevated,
                    routing: &routing,
                },
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
                self.sessions.lock_recover().insert(
                    session_id,
                    SftpHandle {
                        tx,
                        controls,
                        app: handle_app,
                    },
                );
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("El worker de ficheros terminó inesperadamente".into()),
        }
    }

    /// Pide turno bajo el techo global de transferencias simultáneas.
    ///
    /// Se hace en el lado del llamador y no dentro del worker a propósito: el
    /// worker de una sesión atiende **todo** lo de esa sesión, así que
    /// bloquearlo esperando turno congelaría también su panel de ficheros. Aquí
    /// la espera solo detiene a la transferencia que la sufre. El hueco se
    /// suelta cuando el comando termina, que es cuando termina la copia.
    ///
    /// Una cancelación mientras espera (o justo al entrar) corta aquí, antes de
    /// mandar nada al worker: así una subida cancelada en cola no llega a abrir
    /// —y truncar— el fichero remoto cuando le toca el turno. `Ok(None)` = la
    /// sesión no existe; lo dirá `send`.
    async fn wait_for_turn(
        &self,
        session_id: &str,
        transfer_id: &str,
    ) -> Result<Option<crate::transfer_slots::TransferSlot>, String> {
        let Some((app, controls)) = self
            .sessions
            .lock_recover()
            .get(session_id)
            .map(|h| (h.app.clone(), Arc::clone(&h.controls)))
        else {
            return Ok(None);
        };
        let slot = crate::transfer_slots::take_with_notice(&app, transfer_id, || {
            controls.take_cancel(transfer_id)
        })
        .await;
        match slot {
            Some(slot) if !controls.take_cancel(transfer_id) => Ok(Some(slot)),
            _ => Err("transferencia cancelada".to_string()),
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
        overwrite: bool,
    ) -> Result<(), String> {
        let _slot = self.wait_for_turn(session_id, &transfer_id).await?;
        self.send(session_id, move |reply| SftpCommand::Download {
            remote,
            local,
            transfer_id,
            verify_size,
            overwrite,
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
        overwrite: bool,
    ) -> Result<(), String> {
        let _slot = self.wait_for_turn(session_id, &transfer_id).await?;
        self.send(session_id, move |reply| SftpCommand::Upload {
            local,
            remote,
            transfer_id,
            verify_size,
            overwrite,
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
        let _slot = self.wait_for_turn(session_id, &transfer_id).await?;
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
        let _slot = self.wait_for_turn(session_id, &transfer_id).await?;
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
            // El worker atiende `Close` cuando acaba lo que tenga entre manos:
            // primero se cancela, para que eso acabe ya.
            handle.controls.close();
            let _ = handle.tx.send(SftpCommand::Close);
        }
        Ok(())
    }

    /// Sesiones vivas ahora mismo (para el barrido de huérfanas al arrancar).
    pub fn session_count(&self) -> usize {
        self.sessions.lock_recover().len()
    }

    pub fn disconnect_all(&self) {
        let handles: Vec<_> = self
            .sessions
            .lock_recover()
            .drain()
            .map(|(_, h)| h)
            .collect();
        for handle in handles {
            handle.controls.close();
            let _ = handle.tx.send(SftpCommand::Close);
        }
    }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

async fn run_sftp_worker(
    session_id: String,
    request: OpenRequest<'_>,
    max_parallelism: usize,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<SftpCommand>,
    ready: mpsc::SyncSender<Result<(), String>>,
    app_handle: AppHandle,
    controls: Arc<TransferControls>,
) {
    let mut backend = match connect_and_open_backend(request, max_parallelism, &app_handle, &session_id)
    .await
    {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    // Recibe comandos del hilo principal y los ejecuta de uno en uno en la
    // runtime tokio de este hilo. La espera es asíncrona a propósito (ver
    // `next_command`): la runtime sigue atendiendo la sesión SSH mientras tanto.
    while let Some(cmd) = next_command(&mut rx).await {
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
                overwrite,
                reply,
            } => {
                let ctx = TransferCtx {
                    transfer_id: &transfer_id,
                    parent_id: None,
                    app: &app_handle,
                    controls: &controls,
                    verify_size,
                };
                // El destino se mira antes de pedir nada al servidor: sin
                // permiso para sobrescribir, lo que ya existe no se toca.
                let res = match check_download_target(&local, overwrite).await {
                    Ok(()) => backend.download(&remote, &local, ctx).await,
                    Err(e) => Err(e),
                };
                let _ = reply.send(res);
            }
            SftpCommand::Upload {
                local,
                remote,
                transfer_id,
                verify_size,
                overwrite,
                reply,
            } => {
                let ctx = TransferCtx {
                    transfer_id: &transfer_id,
                    parent_id: None,
                    app: &app_handle,
                    controls: &controls,
                    verify_size,
                };
                let res = match check_upload_target(backend.as_mut(), &remote, overwrite).await {
                    Ok(()) => backend.upload(&local, &remote, ctx).await,
                    Err(e) => Err(e),
                };
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
                    parent_id: None,
                    app: &app_handle,
                    controls: &controls,
                    verify_size,
                };
                let res =
                    do_download_dir(backend.as_mut(), &remote, &local, ctx, conflict_policy).await;
                // Sus ficheros solo consultan la cancelación de la carpeta (ver
                // `TransferCtx::cancel_requested`): se consume aquí, para que
                // «Reintentar», que reusa el id, no arranque ya cancelado.
                controls.take_cancel(&transfer_id);
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
                    parent_id: None,
                    app: &app_handle,
                    controls: &controls,
                    verify_size,
                };
                let res =
                    do_upload_dir(backend.as_mut(), &local, &remote, ctx, conflict_policy).await;
                controls.take_cancel(&transfer_id);
                let _ = reply.send(res);
            }
            SftpCommand::Close => break,
        }
    }

    // Cerrar sesión de transferencia ordenadamente.
    backend.close().await;
    let _ = session_id; // mantenemos por si queremos emitir eventos de cierre
}

/// Espera el siguiente comando del worker **sin bloquear su runtime**. russh
/// lanza el bucle de la sesión SSH con `tokio::spawn` en esta misma runtime de
/// un hilo, y russh-sftp su lector: con la antigua espera síncrona
/// (`std::sync::mpsc::Receiver::recv`) nada de eso avanzaba con el panel ocioso.
/// No salían los keepalives ni se contestaban los del servidor, y uno con
/// `ClientAliveInterval` acababa cortando la sesión. `None` = el canal se cerró.
async fn next_command(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<SftpCommand>,
) -> Option<SftpCommand> {
    rx.recv().await
}

/// Lo que se pide abrir: el perfil, sus secretos, el modo elevado y la ruta de
/// saltos (con el pool donde compartirlos).
#[derive(Clone, Copy)]
struct OpenRequest<'a> {
    profile: &'a ConnectionProfile,
    password: Option<&'a str>,
    passphrase: Option<&'a str>,
    elevated: bool,
    routing: &'a crate::jump_pool::Routing,
}

async fn connect_and_open_backend(
    request: OpenRequest<'_>,
    max_parallelism: usize,
    app_handle: &AppHandle,
    session_id: &str,
) -> Result<Box<dyn FileTransfer>, String> {
    let OpenRequest {
        profile, password, ..
    } = request;
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
            // Store de huellas FTPS en el directorio de datos de la app.
            let cert_store = crate::ftps_certs::CertStore::file_in(
                &app_handle.state::<crate::DataDir>().0,
            );
            match connect_ftp(profile, password, cert_store) {
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
            let log = |stage, status, message: String| {
                emit_sftp_log(app_handle, session_id, stage, status, message);
            };
            // El panel no reenvía agente ni X11: los saltos y el destino se
            // verifican contra el known_hosts del usuario, sin nada más.
            let (sftp, jump) =
                connect_and_open_sftp(request, &log, &crate::ssh_transport::default_host_key_check)
                    .await?;
            Ok(Box::new(SftpBackend {
                sftp,
                max_parallelism,
                _jump: jump,
            }))
        }
    }
}

/// Registro de etapas de la conexión del panel: `(etapa, estado, mensaje)`. En
/// la app emite los eventos `sftp-log-*` de la sesión; los tests de integración,
/// que no tienen `AppHandle`, lo recogen para comprobar las etapas.
type SftpConnectLog<'a> = &'a dyn Fn(&'static str, &'static str, String);

/// Etapa «bastion» del registro del panel para cada paso de la ruta de saltos
/// (la etapa conserva su nombre de siempre; el texto cuenta cada salto).
fn log_jump_stage(log: SftpConnectLog<'_>, stage: crate::ssh_transport::JumpStage<'_>) {
    log("bastion", stage.status(), stage.message());
}

/// Abre conexión SSH con russh (directa o por la ruta de saltos), autentica,
/// abre canal y arranca subsistema SFTP (o `sudo sftp-server` si `elevated`).
/// Devuelve también el arrendamiento de la cadena de saltos, que tiene que
/// vivir lo que viva la sesión.
async fn connect_and_open_sftp(
    request: OpenRequest<'_>,
    log: SftpConnectLog<'_>,
    host_key_check: crate::ssh_transport::HostKeyFactory<'_>,
) -> Result<(SftpSession, Option<crate::jump_pool::JumpLease>), String> {
    let OpenRequest {
        profile,
        password,
        passphrase,
        elevated,
        routing,
    } = request;
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
    // «Permitir cifrados antiguos» del perfil, como en el terminal: sin esto,
    // un servidor que solo negocia aes-cbc o ssh-rsa abría el terminal y no el
    // panel.
    let preferred = if profile.allow_legacy_algorithms {
        crate::ssh_manager::legacy_preferred(profile.legacy_algorithms.as_deref())
    } else {
        russh::Preferred::default()
    };
    // Los saltos llevan su propia config, con la misma ventana grande y sin
    // rekey por bytes (`ssh_transport::jump_client_config`): por ellos viaja
    // el mismo caudal.
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        window_size: 32 * 1024 * 1024,
        maximum_packet_size: 65535,
        keepalive_interval: Some(Duration::from_secs(
            crate::ssh_manager::DEFAULT_SSH_KEEPALIVE_SECS,
        )),
        keepalive_max: crate::ssh_manager::DEFAULT_SSH_KEEPALIVE_MAX,
        limits,
        preferred,
        ..Default::default()
    });

    let addr = format!("{}:{}", profile.host, profile.port);
    log(
        "connect",
        "info",
        if routing.route.is_empty() {
            format!("Conectando SFTP a {addr}")
        } else {
            format!(
                "Conectando SFTP a {addr} a través de {}",
                routing.route.describe()
            )
        },
    );
    let crate::ssh_transport::RoutedHandle {
        mut handle,
        lease: jump,
    } = crate::ssh_transport::connect_profile_handle(
        profile,
        &routing.route,
        routing.pool.as_ref(),
        config,
        host_key_check,
        &|stage| log_jump_stage(log, stage),
    )
    .await
    .map_err(|err| {
        let stage = match err.hop {
            crate::ssh_transport::Hop::Jump { .. } => "bastion",
            crate::ssh_transport::Hop::Target => "connect",
        };
        log(stage, "error", err.message.clone());
        err.message
    })?;
    log("host_key", "ok", format!("Host key verificada ({addr})"));

    // Autenticación
    log(
        "auth",
        "info",
        format!(
            "Autenticando como {} ({})",
            profile.username,
            match &profile.auth_type {
                AuthType::Password => "password",
                AuthType::PublicKey => "public_key",
                AuthType::Agent => "agent",
                AuthType::KeyboardInteractive => "keyboard_interactive",
            }
        ),
    );
    let auth = match &profile.auth_type {
        AuthType::Password => {
            let pass = password.ok_or_else(|| {
                let msg = "Se requiere contraseña".to_string();
                log("auth", "error", msg.clone());
                msg
            })?;
            // Con el camino de PAM (`PasswordAuthentication no`): la misma
            // contraseña va a la primera pregunta de `keyboard-interactive`.
            crate::ssh_manager::password_auth_with_fallback(
                &mut handle,
                &profile.username,
                &profile.host,
                pass.to_string(),
            )
            .await
            .map_err(|e| {
                let msg = format!("Error de autenticación: {e}");
                log("auth", "error", msg.clone());
                msg
            })?
        }
        AuthType::PublicKey => {
            let key_path = profile.key_path.as_ref().ok_or_else(|| {
                let msg = "Se requiere ruta de clave privada".to_string();
                log("auth", "error", msg.clone());
                msg
            })?;
            let key = load_secret_key(Path::new(key_path), passphrase).map_err(|e| {
                let msg = format!("Clave inválida: {e}");
                log("auth", "error", msg.clone());
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
                    log("auth", "error", msg.clone());
                    msg
                })?
        }
        AuthType::Agent => authenticate_with_agent(&mut handle, &profile.username)
            .await
            .inspect_err(|e| {
                log("auth", "error", e.clone());
            })?,
        AuthType::KeyboardInteractive => {
            crate::ssh_manager::keyboard_interactive_auth(
                &mut handle,
                &profile.username,
                &profile.host,
                None,
            )
            .await
            .map_err(|e| {
                let msg = e.to_string();
                log("auth", "error", msg.clone());
                msg
            })?
        }
    };

    // Segundo factor: igual que en el shell SSH, un `Failure` con
    // `partial_success` no es un rechazo — la credencial valió y el servidor
    // pide otro factor. Se encadena el flujo interactivo sin que el perfil
    // tenga que declararlo.
    let auth = match auth {
        AuthResult::Failure {
            ref remaining_methods,
            partial_success: true,
        } if remaining_methods.contains(&russh::MethodKind::KeyboardInteractive) => {
            log(
                "auth",
                "info",
                "El servidor pide un segundo factor".into(),
            );
            crate::ssh_manager::keyboard_interactive_auth(
                &mut handle,
                &profile.username,
                &profile.host,
                None,
            )
            .await
            .map_err(|e| {
                let msg = e.to_string();
                log("auth", "error", msg.clone());
                msg
            })?
        }
        other => other,
    };

    match auth {
        AuthResult::Success => {
            log("auth", "ok", "Autenticado".into());
        }
        AuthResult::Failure {
            remaining_methods, ..
        } => {
            let msg = format!(
                "Autenticación fallida. Métodos restantes: {:?}",
                remaining_methods
            );
            log("auth", "error", msg.clone());
            return Err(msg);
        }
    }

    // Abrir canal y activar SFTP (normal o elevado)
    let channel = handle.channel_open_session().await.map_err(|e| {
        let msg = format!("No se pudo abrir canal: {e}");
        log("channel", "error", msg.clone());
        msg
    })?;

    if elevated {
        log(
            "subsystem",
            "info",
            "Lanzando sudo sftp-server (modo elevado)".into(),
        );
        // Probar las rutas habituales de sftp-server. Salimos con el primero
        // que sea ejecutable. El `exec` final sustituye al shell sh, así que
        // no hay wrapper que estropee el protocolo SFTP en el pipe.
        let cmd = r#"for p in /usr/libexec/openssh/sftp-server /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do [ -x "$p" ] && exec sudo -n "$p"; done; echo "sftp-server binary not found" >&2; exit 127"#;
        channel.exec(true, cmd).await.map_err(|e| {
            let msg = format!("No se pudo lanzar sftp-server elevado: {e}");
            log("subsystem", "error", msg.clone());
            msg
        })?;
    } else {
        log(
            "subsystem",
            "info",
            "Abriendo subsistema sftp".into(),
        );
        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            let msg = format!("No se pudo abrir el subsistema SFTP: {e}");
            log("subsystem", "error", msg.clone());
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
        log("subsystem", "error", msg.clone());
        msg
    })?;
    log(
        "ready",
        "ok",
        if elevated {
            "Sesión SFTP elevada lista".to_string()
        } else {
            "Sesión SFTP lista".to_string()
        },
    );

    Ok((sftp, jump))
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

    /// El tope de handles de la sesión: un fichero pequeño usa exactamente uno.
    fn small_file_concurrency(&self) -> usize {
        self.max_parallelism.clamp(1, SFTP_PIPELINE)
    }

    /// Los ficheros del lote viajan a la vez sobre la misma sesión SFTP, cada
    /// uno con un solo handle (paralelismo 1 por fichero).
    async fn transfer_small_batch(
        &mut self,
        direction: BatchDirection,
        jobs: &[BatchJob],
        ctx: TransferCtx<'_>,
    ) -> Vec<Result<(), String>> {
        let sftp = &self.sftp;
        let limit = self.small_file_concurrency();
        transfer_batch::run_bounded(jobs, limit, |job| async move {
            match direction {
                BatchDirection::Download => {
                    do_download(sftp, &job.remote, &job.local, ctx.child(&job.sub_id), 1).await
                }
                BatchDirection::Upload => {
                    do_upload(sftp, &job.local, &job.remote, ctx.child(&job.sub_id), 1).await
                }
            }
        })
        .await
    }
}

/// El cliente suppaftp de una conexión: plano o con TLS explícito. Los dos
/// tipos exponen la misma API, así que [`on_stream!`] aplica un mismo cuerpo
/// al que haya.
enum FtpStreamKind {
    Plain(FtpStream),
    ExplicitTls(RustlsFtpStream),
}

/// Ejecuta `$body` con `$ftp` ligado al cliente que haya dentro de un
/// [`FtpStreamKind`], sea plano o TLS: el cuerpo se escribe una sola vez.
macro_rules! on_stream {
    ($stream:expr, |$ftp:ident| $body:expr) => {
        match $stream {
            FtpStreamKind::Plain($ftp) => $body,
            FtpStreamKind::ExplicitTls($ftp) => $body,
        }
    };
}

/// Plazos de E/S por socket de una conexión FTP/FTPS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FtpTimeouts {
    /// Canal de control (PWD, MKD, DELE, SIZE…).
    control: Duration,
    /// Canal de datos (LIST, RETR, STOR) y, mientras dura uno de esos comandos,
    /// también el de control: el 150 inicial y el 226 final son parte de la
    /// misma transferencia.
    data: Duration,
}

impl FtpTimeouts {
    /// El mismo plazo para todo (lo usan los tests).
    #[cfg(test)]
    const fn uniform(plazo: Duration) -> Self {
        Self {
            control: plazo,
            data: plazo,
        }
    }
}

/// Fallo de una operación FTP: el texto para el usuario y, si deja la
/// conexión inservible, por qué (ver [`FtpConnection`]). Mensaje y razón
/// pueden no coincidir: una cancelación que coincide con el plazo se informa
/// como cancelación, pero la conexión queda rota igual.
struct FtpFailure {
    message: String,
    broken: Option<String>,
}

impl FtpFailure {
    /// Un error que no afecta a la conexión (un 550, el fichero local).
    fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            broken: None,
        }
    }

    /// La conexión se ha perdido: el mensaje lleva el marcador que el panel
    /// traduce a «conexión perdida».
    fn lost(reason: String) -> Self {
        Self {
            message: format!("{TRANSFER_CONNECTION_LOST_MARKER} {reason}"),
            broken: Some(reason),
        }
    }

    /// El usuario canceló. Sin el marcador: el panel clasifica por «cancel».
    /// `broken`: si además la conexión se perdió por el camino.
    fn canceled(broken: Option<String>) -> Self {
        Self {
            message: "transferencia cancelada".to_string(),
            broken,
        }
    }

    /// Un error de suppaftp. Solo el de conexión (E/S del socket, plazo
    /// incluido) rompe la conexión; un rechazo del servidor (550…) no.
    fn from_ftp(error: suppaftp::FtpError, plazo: Duration) -> Self {
        match error {
            suppaftp::FtpError::ConnectionError(io) => Self::lost(ftp_io_error(&io, plazo)),
            other => Self::plain(other.to_string()),
        }
    }
}

/// Por qué paró una copia FTP ([`transfer_copy_blocking`]) antes de tiempo.
enum FtpCopyError {
    /// El usuario canceló; el evento de progreso «cancelada» ya salió.
    Canceled,
    /// Plazo agotado en el socket de datos: el servidor dejó de responder.
    /// `canceled`: había una cancelación pendiente, y eso es lo que se informa.
    Timeout { canceled: bool },
    /// Otro fallo de E/S (el fichero local, un socket de datos cerrado).
    Io {
        error: std::io::Error,
        canceled: bool,
    },
}

/// Una conexión FTP/FTPS del panel, con su estado de salud.
///
/// Cuando una operación agota su plazo o el socket de control falla, la
/// conexión queda **rota** (`broken`): sus respuestas ya no casan con las
/// peticiones (el 226 de la transferencia parada llegaría como respuesta del
/// PWD siguiente), así que cada operación posterior falla al instante con
/// [`TRANSFER_CONNECTION_LOST_MARKER`], sin tocar la red, en vez de esperar
/// otro plazo o fallar con un error desconcertante. El panel lo enseña como
/// «conexión perdida»; reconectar es abrir la conexión de nuevo.
struct FtpConnection {
    stream: FtpStreamKind,
    timeouts: FtpTimeouts,
    /// Por qué se dio por perdida, si ya lo está.
    broken: Option<String>,
}

impl FtpConnection {
    fn connect(
        profile: &ConnectionProfile,
        password: Option<&str>,
        ftps_cert_store: PathBuf,
    ) -> Result<Self, String> {
        Self::connect_with_timeouts(profile, password, ftps_cert_store, FTP_TIMEOUTS)
    }

    /// [`Self::connect`] con los plazos explícitos: los tests los bajan a
    /// segundos para no tener que esperar los de producción.
    fn connect_with_timeouts(
        profile: &ConnectionProfile,
        password: Option<&str>,
        ftps_cert_store: PathBuf,
        timeouts: FtpTimeouts,
    ) -> Result<Self, String> {
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
        let data_timeout = timeouts.data;

        let stream = if profile.connection_type == "ftps" {
            // Verificación TOFU por huella (NAS/servidor interno con certificado
            // autofirmado), en vez de exigir una cadena hasta una CA raíz: el
            // certificado se recuerda por host y un cambio se rechaza. La firma
            // del handshake sí se sigue comprobando; ver `ftps_certs`.
            let verifier = crate::ftps_certs::TofuServerCertVerifier::new(
                profile.host.clone(),
                profile.port,
                ftps_cert_store,
            );
            // Proveedor criptográfico explícito (`ring`, el mismo que usa el
            // verificador TOFU): el árbol de dependencias trae también `aws-lc-rs`
            // (vía `reqwest` del updater de Tauri), así que `builder()` a secas no
            // puede autodeterminar el proveedor de proceso y entra en pánico al
            // conectar. Fijarlo aquí lo hace determinista.
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("No se pudo inicializar TLS FTPS: {e}"))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
            let connector = RustlsConnector::from(Arc::new(config));
            let control = ftp_control_socket(profile, timeouts.control)
                .map_err(|e| format!("No se puede conectar FTPS a {addr}: {e}"))?;
            // `into_secure` conserva el constructor de sockets de datos: también
            // los canales de datos TLS heredan su plazo.
            let mut ftp = RustlsFtpStream::connect_with_stream(control)
                .map_err(|e| format!("No se puede conectar FTPS a {addr}: {e}"))?
                .passive_stream_builder(move |a| {
                    ftp_socket(a, data_timeout).map_err(suppaftp::FtpError::ConnectionError)
                })
                .into_secure(connector, profile.host.as_str())
                .map_err(|e| format!("No se pudo iniciar TLS explícito: {e}"))?;
            ftp.login(username, pass)
                .map_err(|e| format!("Error de autenticación FTPS: {e}"))?;
            ftp.transfer_type(FtpTransferType::Binary)
                .map_err(|e| format!("No se pudo activar modo binario FTPS: {e}"))?;
            FtpStreamKind::ExplicitTls(ftp)
        } else {
            let control = ftp_control_socket(profile, timeouts.control)
                .map_err(|e| format!("No se puede conectar FTP a {addr}: {e}"))?;
            let mut ftp = FtpStream::connect_with_stream(control)
                .map_err(|e| format!("No se puede conectar FTP a {addr}: {e}"))?
                .passive_stream_builder(move |a| {
                    ftp_socket(a, data_timeout).map_err(suppaftp::FtpError::ConnectionError)
                });
            ftp.login(username, pass)
                .map_err(|e| format!("Error de autenticación FTP: {e}"))?;
            ftp.transfer_type(FtpTransferType::Binary)
                .map_err(|e| format!("No se pudo activar modo binario FTP: {e}"))?;
            FtpStreamKind::Plain(ftp)
        };
        Ok(Self {
            stream,
            timeouts,
            broken: None,
        })
    }

    /// Por qué la conexión ya no sirve, si es que no sirve.
    #[cfg(test)]
    fn broken_reason(&self) -> Option<&str> {
        self.broken.as_deref()
    }

    /// Falla al instante, sin tocar la red, si la conexión está rota.
    fn check(&self) -> Result<(), String> {
        match &self.broken {
            Some(reason) => Err(format!("{TRANSFER_CONNECTION_LOST_MARKER} {reason}")),
            None => Ok(()),
        }
    }

    /// Da la conexión por perdida. Cierra el socket de control: cualquier
    /// lectura pendiente (el acuse de un stream que se está soltando, un QUIT)
    /// falla al momento en vez de esperar su plazo.
    fn mark_broken(&mut self, reason: String) {
        if self.broken.is_some() {
            return;
        }
        on_stream!(&mut self.stream, |ftp| {
            let _ = ftp.get_ref().shutdown(std::net::Shutdown::Both);
        });
        self.broken = Some(reason);
    }

    /// Aplica el resultado de una operación: marca la conexión rota si hace
    /// falta y deja el texto para el usuario.
    fn settle<T>(&mut self, result: Result<T, FtpFailure>) -> Result<T, String> {
        result.map_err(|failure| {
            if let Some(reason) = failure.broken {
                self.mark_broken(reason);
            }
            failure.message
        })
    }

    /// Un comando del canal de control (PWD, MKD, DELE…), con su plazo.
    fn run<T>(
        &mut self,
        op: impl FnOnce(&mut FtpStreamKind) -> Result<T, suppaftp::FtpError>,
    ) -> Result<T, String> {
        self.check()?;
        let plazo = self.timeouts.control;
        let result = op(&mut self.stream).map_err(|e| FtpFailure::from_ftp(e, plazo));
        self.settle(result)
    }

    /// Un comando con canal de datos (LIST, MLSD, RETR, STOR). Mientras dura,
    /// también el canal de control lee con el plazo corto: el 150 inicial y el
    /// 226 final son parte de la misma transferencia, y era en ese acuse —que
    /// suppaftp lee al soltar el stream— donde «Cancelar» con el servidor
    /// parado se quedaba esperando los dos minutos del control.
    fn run_data<T>(
        &mut self,
        op: impl FnOnce(&mut FtpStreamKind, Duration) -> Result<T, FtpFailure>,
    ) -> Result<T, String> {
        self.check()?;
        let FtpTimeouts { control, data } = self.timeouts;
        self.set_control_read_timeout(data);
        let result = op(&mut self.stream, data);
        self.set_control_read_timeout(control);
        self.settle(result)
    }

    fn set_control_read_timeout(&mut self, plazo: Duration) {
        on_stream!(&mut self.stream, |ftp| {
            let _ = ftp.get_ref().set_read_timeout(Some(plazo));
        });
    }

    fn pwd(&mut self) -> Result<String, String> {
        self.run(|s| on_stream!(s, |ftp| ftp.pwd()))
    }

    fn mkdir(&mut self, path: &str) -> Result<(), String> {
        self.run(|s| on_stream!(s, |ftp| ftp.mkdir(path)))
    }

    fn create_file(&mut self, path: &str) -> Result<(), String> {
        self.check()?;
        // No sobrescribir si existe.
        if self.size(path).is_ok() {
            return Err("ya existe".to_string());
        }
        self.run_data(|s, plazo| {
            let mut empty: &[u8] = &[];
            on_stream!(s, |ftp| ftp.put_file(path, &mut empty))
                .map(|_| ())
                .map_err(|e| FtpFailure::from_ftp(e, plazo))
        })
    }

    fn remove(&mut self, path: &str, is_dir: bool) -> Result<(), String> {
        self.run(|s| {
            on_stream!(s, |ftp| if is_dir {
                ftp.rmdir(path)
            } else {
                ftp.rm(path)
            })
        })
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        self.run(|s| on_stream!(s, |ftp| ftp.rename(from, to)))
    }

    fn mlsd(&mut self, path: &str) -> Result<Vec<String>, String> {
        self.run_data(|s, plazo| {
            on_stream!(s, |ftp| ftp.mlsd(Some(path))).map_err(|e| FtpFailure::from_ftp(e, plazo))
        })
    }

    fn list(&mut self, path: &str) -> Result<Vec<String>, String> {
        self.run_data(|s, plazo| {
            on_stream!(s, |ftp| ftp.list(Some(path))).map_err(|e| FtpFailure::from_ftp(e, plazo))
        })
    }

    fn mlst(&mut self, path: &str) -> Result<String, String> {
        self.run(|s| on_stream!(s, |ftp| ftp.mlst(Some(path))))
    }

    fn size(&mut self, path: &str) -> Result<u64, String> {
        self.run(|s| on_stream!(s, |ftp| ftp.size(path)))
            .map(|n| n as u64)
    }

    fn mdtm(&mut self, path: &str) -> Result<u64, String> {
        let dt = self.run(|s| on_stream!(s, |ftp| ftp.mdtm(path)))?;
        Ok(dt.and_utc().timestamp().max(0) as u64)
    }

    fn download_to(
        &mut self,
        remote: &str,
        local: &Path,
        total: u64,
        ctx: TransferCtx<'_>,
    ) -> Result<(), String> {
        self.check()?;
        if let Some(parent) = local.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut local_file = std::fs::File::create(local).map_err(|e| e.to_string())?;
        self.run_data(|s, plazo| {
            on_stream!(s, |ftp| {
                let mut remote_file = ftp
                    .retr_as_stream(remote)
                    .map_err(|e| FtpFailure::from_ftp(e, plazo))?;
                let copied =
                    transfer_copy_blocking(&mut remote_file, &mut local_file, total, ctx, false);
                finish_ftp_transfer(ftp, remote_file, copied, plazo)
            })
        })
    }

    fn upload_from(
        &mut self,
        local: &Path,
        remote: &str,
        total: u64,
        ctx: TransferCtx<'_>,
    ) -> Result<(), String> {
        self.check()?;
        // El STOR vacía el destino en cuanto el servidor lo acepta: una subida
        // cancelada antes de empezar no debe llegar a mandarlo.
        if ctx.cancel_requested() {
            let _ = ctx.app.emit(
                &event_name(EventKind::SftpProgress, ctx.transfer_id),
                serde_json::json!({
                    "transferred": 0u64, "total": total, "done": true, "canceled": true,
                }),
            );
            return Err("transferencia cancelada".to_string());
        }
        let mut local_file = std::fs::File::open(local).map_err(|e| e.to_string())?;
        self.run_data(|s, plazo| {
            on_stream!(s, |ftp| {
                let mut remote_file = ftp
                    .put_with_stream(remote)
                    .map_err(|e| FtpFailure::from_ftp(e, plazo))?;
                let copied =
                    transfer_copy_blocking(&mut local_file, &mut remote_file, total, ctx, true);
                finish_ftp_transfer(ftp, remote_file, copied, plazo)
            })
        })
    }

    /// Despedida ordenada. Una conexión rota no se despide: el QUIT esperaría
    /// una respuesta que no va a llegar (y su socket ya está cerrado).
    fn quit(&mut self) {
        if self.broken.is_some() {
            return;
        }
        on_stream!(&mut self.stream, |ftp| {
            let _ = ftp.quit();
        });
    }
}

/// Cierra el stream de datos de una transferencia, lee su acuse (226) y decide
/// qué se informa. Con el plazo de datos agotado el servidor no responde: se
/// corta el socket de control **antes** de soltar el stream, para que la
/// lectura del acuse falle al instante en vez de esperar otro plazo, y la
/// conexión queda perdida. En los demás fallos, leer el acuse (426 o 226) deja
/// el canal de control en orden; si tampoco llega, es la conexión la que se
/// perdió.
fn finish_ftp_transfer<T: suppaftp::TlsStream>(
    ftp: &suppaftp::ImplFtpStream<T>,
    stream: suppaftp::TransferStream<T>,
    copied: Result<(), FtpCopyError>,
    plazo: Duration,
) -> Result<(), FtpFailure> {
    let lost_on_finish = |finished: Result<(), suppaftp::FtpError>| match finished {
        Err(suppaftp::FtpError::ConnectionError(io)) => Some(ftp_io_error(&io, plazo)),
        _ => None,
    };
    match copied {
        Ok(()) => stream
            .finish()
            .map_err(|e| FtpFailure::from_ftp(e, plazo)),
        Err(FtpCopyError::Timeout { canceled }) => {
            let _ = ftp.get_ref().shutdown(std::net::Shutdown::Both);
            let _ = stream.finish();
            let reason = ftp_timeout_text(plazo);
            Err(if canceled {
                FtpFailure::canceled(Some(reason))
            } else {
                FtpFailure::lost(reason)
            })
        }
        Err(FtpCopyError::Canceled) => Err(FtpFailure::canceled(lost_on_finish(stream.finish()))),
        Err(FtpCopyError::Io { error, canceled }) => {
            let lost = lost_on_finish(stream.finish());
            Err(match (canceled, lost) {
                (true, lost) => FtpFailure::canceled(lost),
                (false, Some(reason)) => FtpFailure::lost(reason),
                (false, None) => FtpFailure::plain(error.to_string()),
            })
        }
    }
}

fn connect_ftp(
    profile: &ConnectionProfile,
    password: Option<&str>,
    ftps_cert_store: PathBuf,
) -> Result<FtpConnection, String> {
    FtpConnection::connect(profile, password, ftps_cert_store)
}

/// Plazo de E/S del canal de **control** FTP/FTPS (PWD, MKD, DELE, SIZE…), el
/// mismo que el de una petición SFTP. suppaftp no pone ninguno: un servidor
/// que deja de contestar sin cerrar (suspensión, cambio de red, proceso
/// parado) dejaba la lectura bloqueada para siempre, y con ella el worker de
/// la sesión, su «Cancelar» y el hueco del techo de transferencias simultáneas.
const FTP_IO_TIMEOUT: Duration = Duration::from_secs(SFTP_REQUEST_TIMEOUT_SECS);

/// Plazo de cada lectura o escritura del canal de **datos** (LIST, RETR, STOR),
/// y del de control mientras dura uno de esos comandos. Mucho más corto que el
/// de control: en una transferencia los bytes fluyen sin parar, así que veinte
/// segundos sin ninguno es un servidor parado, y es lo que tarda como mucho
/// «Cancelar» en responder cuando lo está (antes, los dos minutos del control).
/// No acota la transferencia entera —un fichero puede tardar horas—, solo cada
/// operación de socket. Es una constante y no una preferencia: el panel no
/// tiene ningún otro plazo configurable al que arrimarla.
const FTP_DATA_IO_TIMEOUT: Duration = Duration::from_secs(20);

/// Los plazos de producción.
const FTP_TIMEOUTS: FtpTimeouts = FtpTimeouts {
    control: FTP_IO_TIMEOUT,
    data: FTP_DATA_IO_TIMEOUT,
};

/// Abre un socket FTP (de control o de datos) con plazo de conexión, plazos de
/// lectura y escritura y keepalive TCP. El keepalive no sobra: sin él, el canal
/// de control, ocioso durante una transferencia larga, puede caducar en un NAT
/// y el plazo convertiría eso en un fallo al leer el 226 final.
fn ftp_socket(addr: std::net::SocketAddr, io: Duration) -> std::io::Result<std::net::TcpStream> {
    let stream =
        std::net::TcpStream::connect_timeout(&addr, crate::ssh_manager::TCP_CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(io))?;
    stream.set_write_timeout(Some(io))?;
    crate::ssh_manager::apply_tcp_keepalive(socket2::SockRef::from(&stream));
    Ok(stream)
}

/// El socket de control del perfil, probando cada dirección del host. Los
/// plazos van puestos **antes** de entregárselo a suppaftp, para que también
/// la lectura del saludo 220 y del login estén acotadas.
/// Host de un perfil tal como lo resuelve `ToSocketAddrs`: sin los corchetes
/// de una IPv6 (`[2001:db8::5]`, la forma que también vale para SSH). Con la
/// tupla `(host, puerto)`, std no los quita y lo manda a DNS, que no lo resuelve.
fn ftp_resolvable_host(host: &str) -> &str {
    let host = host.trim();
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

fn ftp_control_socket(
    profile: &ConnectionProfile,
    io: Duration,
) -> std::io::Result<std::net::TcpStream> {
    use std::net::ToSocketAddrs;
    let mut last_err = None;
    for addr in (ftp_resolvable_host(&profile.host), profile.port).to_socket_addrs()? {
        match ftp_socket(addr, io) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "el nombre no resuelve a ninguna dirección",
        )
    }))
}

/// `true` si el fallo de E/S es un plazo agotado (`WouldBlock` en Unix,
/// `TimedOut` en Windows).
fn is_io_timeout(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

/// Texto de un plazo agotado en un socket FTP. Sin la palabra «cancel»: el
/// panel clasifica por ella las transferencias canceladas.
fn ftp_timeout_text(plazo: Duration) -> String {
    format!(
        "el servidor FTP dejó de responder ({} s sin datos)",
        plazo.as_secs()
    )
}

/// Texto de un error de E/S de un socket FTP: un plazo agotado se cuenta como
/// lo que es; el resto, tal cual lo dice el sistema.
fn ftp_io_error(e: &std::io::Error, plazo: Duration) -> String {
    if is_io_timeout(e) {
        ftp_timeout_text(plazo)
    } else {
        e.to_string()
    }
}

/// Clasifica un fallo de E/S de la copia: el plazo agotado va aparte porque
/// deja la conexión perdida (ver [`finish_ftp_transfer`]).
fn ftp_copy_error(error: std::io::Error, canceled: bool) -> FtpCopyError {
    if is_io_timeout(&error) {
        FtpCopyError::Timeout { canceled }
    } else {
        FtpCopyError::Io { error, canceled }
    }
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
        check_file_source(entry.is_dir, remote)?;
        let total = entry.size;
        // Mismo contrato que SFTP: el fichero se materializa en un `.part` y solo
        // ocupa su nombre definitivo si la transferencia y la verificación van
        // bien (ver `part_path`).
        let part = part_path(local);
        let result = self
            .ftp
            .download_to(remote, &part, total, ctx)
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
        let meta = std::fs::metadata(local).map_err(|e| e.to_string())?;
        check_file_source(meta.is_dir(), &local.display().to_string())?;
        let total = meta.len();
        self.ftp.upload_from(local, remote, total, ctx)?;
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
// Un fichero «pequeño» de las transferencias de carpeta es el que cabe en un
// trozo: así se mueve con un solo handle y un lote nunca pasa del tope de la
// sesión (ver `transfer_batch`).
const _: () = assert!(crate::transfer_batch::SMALL_FILE_MAX == SFTP_CHUNK);
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

// ─── Reglas de las transferencias de fichero suelto ─────────────────────────

/// Marcador estable: el destino de una transferencia de fichero ya existe y
/// no se pidió sobrescribir (`overwrite`). El backend no toca nada; el panel
/// lo lee para preguntar con su diálogo de conflictos. Espejo en
/// `src/modules/ipc/errors.js`.
pub const TRANSFER_EXISTS_MARKER: &str = "transfer-exists:";

/// Marcador estable: la conexión de ficheros se dio por perdida (plazo agotado
/// o fallo del socket) y nada más va a funcionar hasta reconectar. Espejo en
/// `src/modules/ipc/errors.js`.
pub const TRANSFER_CONNECTION_LOST_MARKER: &str = "transfer-connection-lost:";

/// El origen de una transferencia de fichero tiene que ser un fichero. Una
/// carpeta pasada por aquí abría igualmente el destino —y lo dejaba creado y
/// vacío en el remoto— antes de fallar al leerla; se rechaza antes de abrir
/// nada. Las carpetas van por `sftp_download_dir`/`sftp_upload_dir`.
fn check_file_source(is_dir: bool, path: &str) -> Result<(), String> {
    if is_dir {
        Err(format!(
            "{path} es una carpeta, no un fichero: usa la transferencia de carpetas"
        ))
    } else {
        Ok(())
    }
}

/// Destino local de una descarga de fichero suelto, antes de bajar nada. Sin
/// `overwrite`, un destino que ya existe (también un enlace roto) se rechaza
/// con [`TRANSFER_EXISTS_MARKER`]; una carpeta, siempre: un fichero no puede
/// sustituirla. Las transferencias de carpeta no pasan por aquí: resuelven
/// cada hijo con su `conflict_policy`.
async fn check_download_target(local: &Path, overwrite: bool) -> Result<(), String> {
    match tokio::fs::symlink_metadata(local).await {
        Ok(meta) if meta.is_dir() => Err(format!(
            "el destino {} es una carpeta",
            local.display()
        )),
        Ok(_) if !overwrite => Err(format!("{TRANSFER_EXISTS_MARKER} {}", local.display())),
        _ => Ok(()),
    }
}

/// Destino remoto de una subida de fichero suelto, antes de abrirlo (abrirlo
/// ya lo vacía). Mismas reglas que [`check_download_target`]. Si el `stat`
/// falla por otra cosa (permisos, conexión), se deja pasar: la subida fallará
/// con su propio error.
async fn check_upload_target(
    backend: &mut dyn FileTransfer,
    remote: &str,
    overwrite: bool,
) -> Result<(), String> {
    match backend.stat(remote).await {
        Ok(entry) if entry.is_dir => Err(format!("el destino {remote} es una carpeta")),
        Ok(_) if !overwrite => Err(format!("{TRANSFER_EXISTS_MARKER} {remote}")),
        _ => Ok(()),
    }
}

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
    check_file_source(meta.file_type().is_dir(), remote)?;
    let total = meta.len();
    let remote_mtime = meta.mtime.map(u64::from);

    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Se baja al temporal y solo se publica (rename) si todo va bien.
    let part = part_path(local);
    let resume = transfer_resume::enabled();
    // Con la reanudación apagada el temporal se trunca siempre, como toda la
    // vida; con ella encendida se pregunta primero si el trozo que hay sirve.
    let plan = if resume {
        transfer_resume::plan_on_disk(&part, remote, total, remote_mtime).await
    } else {
        transfer_resume::ResumePlan::Fresh
    };
    let result = async {
        let start = match plan {
            // Ya está entero en el temporal: no se vuelve a pedir ni un byte.
            transfer_resume::ResumePlan::Complete => total,
            transfer_resume::ResumePlan::Continue(off) => off,
            transfer_resume::ResumePlan::Fresh => 0,
        };
        let mut file = if start > 0 {
            let mut f = tokio::fs::OpenOptions::new()
                .write(true)
                .open(&part)
                .await
                .map_err(|e| e.to_string())?;
            // Se corta cualquier cola por detrás del punto de reanudación y se
            // escribe justo ahí: el fichero no puede crecer por dos sitios.
            f.set_len(start).await.map_err(|e| e.to_string())?;
            f.seek(std::io::SeekFrom::Start(start))
                .await
                .map_err(|e| e.to_string())?;
            f
        } else {
            // `create` trunca: un `.part` superviviente de un cierre brusco de la app
            // se sobrescribe en vez de acumularse.
            tokio::fs::File::create(&part)
                .await
                .map_err(|e| e.to_string())?
        };
        if resume {
            // La ficha se escribe antes de bajar nada: si la app muere a mitad,
            // el intento siguiente sabrá de qué era este temporal.
            transfer_resume::write_meta(
                &part,
                &transfer_resume::PartMeta {
                    remote: remote.to_string(),
                    size: total,
                    mtime: remote_mtime,
                },
            )
            .await;
        }
        pipelined_download(sftp, remote, &mut file, total, start, ctx, max_parallelism).await?;
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
        Ok(()) => {
            transfer_resume::remove_meta(&part).await;
            tokio::fs::rename(&part, local)
                .await
                .map_err(|e| format!("no se pudo publicar la descarga: {e}"))
        }
        Err(e) => {
            if !resume {
                // Nada de restos: el usuario no debe encontrarse un fichero a medias,
                // ni con el nombre bueno ni con el `.part`.
                let _ = tokio::fs::remove_file(&part).await;
                transfer_resume::remove_meta(&part).await;
            }
            // Con la reanudación activada el temporal y su ficha se quedan a
            // propósito: son exactamente lo que permite continuar después.
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
    check_file_source(meta.is_dir(), &local.display().to_string())?;
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
/// `start` es el punto desde el que se pide: `0` en una descarga normal y el
/// tamaño del trozo ya bajado cuando se reanuda una interrumpida. El fichero
/// local llega ya colocado en ese punto y el progreso cuenta los bytes previos
/// como hechos, que es lo que el usuario ve.
async fn pipelined_download(
    sftp: &SftpSession,
    remote: &str,
    local_file: &mut tokio::fs::File,
    total: u64,
    start: u64,
    ctx: TransferCtx<'_>,
    max_parallelism: usize,
) -> Result<(), String> {
    let TransferCtx {
        transfer_id, app, ..
    } = ctx;
    let event = event_name(EventKind::SftpProgress, transfer_id);
    let _ = app.emit(
        &event,
        serde_json::json!({ "transferred": start, "total": total, "done": false }),
    );

    if total == 0 || start >= total {
        let _ = app.emit(
            &event,
            serde_json::json!({ "transferred": total, "total": total, "done": true }),
        );
        return Ok(());
    }

    // Abrir N file handles concurrentemente para no pagar N RTT secuenciales.
    // Lo que decide cuántos hacen falta es lo que **queda** por bajar, no el
    // tamaño del fichero: al reanudar los últimos 200 KiB no se abren 32.
    let parallelism = effective_parallelism(total - start, max_parallelism);
    let mut idle_files: Vec<SftpFile> = open_handles(sftp, remote, parallelism, OpenFlags::READ)
        .await
        .map_err(|e| format!("No se pudieron abrir los handles SFTP: {e}"))?;

    let mut next_read: u64 = start;
    let mut next_write: u64 = start;
    let mut transferred: u64 = start;
    let mut last_emit: u64 = start;
    let mut completed: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
    let mut in_flight: FuturesUnordered<_> = FuturesUnordered::new();

    let mut was_paused = false;
    loop {
        // Dentro de una carpeta, también la cancelación y la pausa de la
        // carpeta: si no, un fichero grande seguía a toda velocidad hasta el final.
        if ctx.cancel_requested() {
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
        let paused = ctx.paused();
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
                // El `while` ya comprobó que hay handles libres; si aun así
                // no lo hubiera, se sale del bucle de lectura — un pánico aquí
                // mataría el hilo de la transferencia y dejaría la sesión viva
                // sin nadie que la atienda.
                let Some(mut f) = idle_files.pop() else { break };
                let len = (total - next_read).min(SFTP_CHUNK);
                // Techo de bajada: se paga aquí, antes de pedir el chunk, para
                // no traerse datos que luego habría que retener. Sin límite
                // configurado no cuesta nada (ni un lock).
                crate::transfer_rate::throttle_download(len).await;
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

        // `in_flight` no está vacío (se comprobó justo arriba); si el stream
        // se agotara igualmente, terminar es lo correcto.
        let Some((f, offset, result)) = in_flight.next().await else { break };
        idle_files.push(f);
        let data = result?;
        completed.insert(offset, data);

        while let Some(data) = completed.remove(&next_write) {
            let n = data.len() as u64;
            // Un trozo corto a mitad desalinearía `next_write`: ningún trozo
            // posterior volvería a casar y la descarga acabaría «bien», truncada.
            if chunk_is_short(next_write, n, total) {
                return Err(if n == 0 {
                    "EOF inesperado durante la descarga".to_string()
                } else {
                    format!(
                        "el fichero remoto cambió de tamaño durante la descarga ({} de {total} B)",
                        next_write + n
                    )
                });
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

    // Red de seguridad: nunca se publica una descarga que no llegó a `total`.
    if next_write != total {
        return Err(format!(
            "el fichero remoto cambió de tamaño durante la descarga ({next_write} de {total} B)"
        ));
    }
    local_file.flush().await.map_err(|e| e.to_string())?;
    let _ = app.emit(
        &event,
        serde_json::json!({ "transferred": transferred, "total": total, "done": true }),
    );
    Ok(())
}

/// `true` si el trozo de `offset` trae menos de lo que se pidió para él. Cada
/// trozo pide `min(SFTP_CHUNK, total - offset)`, así que uno más corto solo sale
/// de un EOF antes de `total`: el origen encogió a mitad de la copia (un
/// `copytruncate`, una reescritura en sitio).
fn chunk_is_short(offset: u64, got: u64, total: u64) -> bool {
    got < total.saturating_sub(offset).min(SFTP_CHUNK)
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
        transfer_id, app, ..
    } = ctx;
    let event = event_name(EventKind::SftpProgress, transfer_id);
    let _ = app.emit(
        &event,
        serde_json::json!({ "transferred": 0u64, "total": total, "done": false }),
    );

    // Abrir con TRUNCATE vacía el remoto: si la cancelaron mientras esperaba su
    // turno en el worker, no se llega a tocar. Aún no hay ningún handle que
    // cerrar con `shutdown()`.
    if ctx.cancel_requested() {
        let _ = app.emit(
            &event,
            serde_json::json!({
                "transferred": 0u64, "total": total, "done": true, "canceled": true,
            }),
        );
        return Err("transferencia cancelada".to_string());
    }

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
        let mut first = first;
        close_written(&mut first).await?;
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
        if ctx.cancel_requested() {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": true, "canceled": true,
                }),
            );
            return Err("transferencia cancelada".to_string());
        }

        let paused = ctx.paused();
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
                let Some(mut f) = idle_files.pop() else { break };
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
                // En un fichero regular `read` solo se queda corto en EOF: el
                // local encogió desde que se midió. Antes se cortaba aquí y la
                // subida acababa «bien» con el remoto a medias.
                if chunk_is_short(off, filled as u64, total) {
                    return Err(format!(
                        "el fichero local cambió de tamaño durante la subida ({} de {total} B)",
                        off + filled as u64
                    ));
                }
                buf.truncate(filled);

                // Techo de subida: se paga con los bytes que de verdad van a
                // salir (el último chunk suele ser más corto que `len`).
                crate::transfer_rate::throttle_upload(filled as u64).await;

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

        let Some((f, n, result)) = in_flight.next().await else { break };
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

    // Cerrar los handles de forma ordenada antes de informar "done": que el
    // servidor haya confirmado cada escritura y cerrado el fichero.
    for mut f in idle_files.drain(..) {
        close_written(&mut f).await?;
    }

    let _ = app.emit(
        &event,
        serde_json::json!({ "transferred": transferred, "total": total, "done": true }),
    );
    Ok(())
}

/// Espera a que el servidor confirme las escrituras encoladas en `file` y lo
/// cierra.
///
/// `write` de russh-sftp **no espera** el acuse del servidor (lo encola; solo lo
/// recoge si hay demasiados pendientes) y `drop` cierra **sin esperar**. Hasta
/// v2.14.0 la subida hacía `drop` y se daba por terminada con las últimas
/// escrituras aún en vuelo: en serie casi no se notaba —el fichero siguiente
/// hacía cola detrás—, pero un error del servidor al escribirlas (disco lleno,
/// cuota) se perdía y el fichero quedaba incompleto con aviso de éxito. Lo cazó
/// el smoke E2E al subir ficheros en lote. `shutdown` recoge todos los acuses
/// (y su error, si lo hay) y cierra el handle esperando la respuesta.
async fn close_written(file: &mut SftpFile) -> Result<(), String> {
    file.shutdown()
        .await
        .map_err(|e| format!("el servidor no confirmó la escritura: {e}"))
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
    ctx: TransferCtx<'_>,
    // `upload`: `true` si los bytes salen. Decide contra qué techo se cuentan.
    upload: bool,
) -> Result<(), FtpCopyError>
where
    R: Read,
    W: Write,
{
    let TransferCtx {
        transfer_id, app, ..
    } = ctx;
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
        // Dentro de una carpeta, también la cancelación y la pausa de la carpeta.
        if ctx.cancel_requested() {
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "transferred": transferred, "total": total, "done": true, "canceled": true,
                }),
            );
            return Err(FtpCopyError::Canceled);
        }

        // En FTP/FTPS el copy es serie sobre un stream síncrono. Pausamos
        // bloqueando el hilo del worker con sleeps cortos: el stream queda
        // ocioso pero la conexión sigue viva (el server puede tirarla por
        // idle si la pausa es muy larga; aceptable).
        let paused = ctx.paused();
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

        // Un fallo de E/S (también el plazo agotado de un servidor mudo) con una
        // cancelación pendiente es esa cancelación: se informa como tal y se
        // consume, para que «Reintentar», que reutiliza el id, no salga
        // cancelado nada más empezar. El plazo agotado se distingue igualmente:
        // deja la conexión perdida (ver `finish_ftp_transfer`).
        let io_failed = |e: std::io::Error| {
            let canceled = ctx.cancel_requested();
            if canceled {
                let _ = app.emit(
                    &event,
                    serde_json::json!({
                        "transferred": transferred, "total": total, "done": true, "canceled": true,
                    }),
                );
            }
            ftp_copy_error(e, canceled)
        };
        let n = src.read(&mut buf).map_err(io_failed)?;
        if n == 0 {
            break;
        }
        // Techo de velocidad. Aquí la espera es bloqueante porque toda esta
        // copia lo es: corre en el hilo del worker FTP, no en el runtime async.
        crate::transfer_rate::throttle_blocking(n as u64, upload);
        dst.write_all(&buf[..n]).map_err(io_failed)?;
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

    dst.flush().map_err(|e| ftp_copy_error(e, false))?;
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
pub(crate) fn safe_entry_name(name: &str) -> Result<(), String> {
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

/// Progreso de una transferencia de carpeta: lo movido, lo que hay y a quién
/// contárselo. Lo comparten el bucle y [`flush_batch`].
struct DirProgress<'a> {
    app: &'a AppHandle,
    event: &'a str,
    transfer_id: &'a str,
    controls: &'a Arc<TransferControls>,
    bytes_done: u64,
    bytes_total: u64,
    files_done: u32,
    files_total: u32,
}

impl DirProgress<'_> {
    /// Punto de pausa/cancelación entre ficheros (y entre lotes).
    async fn gate(&self) -> Result<(), String> {
        gate_dir_transfer(
            self.transfer_id,
            self.event,
            self.bytes_done,
            self.bytes_total,
            self.app,
            self.controls,
        )
        .await
    }

    /// Anuncia el fichero (o el primero del lote) que empieza.
    fn starting(&self, current: &str) {
        emit_dir_progress(
            self.app,
            self.event,
            self.bytes_done,
            self.bytes_total,
            current,
            self.files_done + 1,
            self.files_total,
        );
    }

    fn finished(&mut self, bytes: u64) {
        self.bytes_done += bytes;
        self.files_done += 1;
    }

    /// Cierre de la transferencia de carpeta.
    fn done(&self, skipped_symlinks: u32) {
        let _ = self.app.emit(
            self.event,
            serde_json::json!({
                "transferred": self.bytes_total, "total": self.bytes_total, "done": true, "kind": "dir",
                "filesDone": self.files_total, "filesTotal": self.files_total,
                "skippedSymlinks": skipped_symlinks,
            }),
        );
    }
}

/// Sentido de un lote de ficheros pequeños.
#[derive(Debug, Clone, Copy)]
enum BatchDirection {
    Download,
    Upload,
}

/// Un fichero de un lote: ruta remota, ruta local, tamaño, id de progreso y
/// ruta relativa para enseñarla.
struct BatchJob {
    remote: String,
    local: PathBuf,
    size: u64,
    sub_id: String,
    rel: String,
}

/// Envía el lote pendiente y apunta lo que llegó. Si algo falló, devuelve el
/// primer error **después** de que el lote entero haya terminado.
async fn flush_batch(
    backend: &mut dyn FileTransfer,
    direction: BatchDirection,
    batch: &mut Batch<BatchJob>,
    ctx: TransferCtx<'_>,
    progress: &mut DirProgress<'_>,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let jobs = batch.take();
    progress.gate().await?;
    progress.starting(&jobs[0].rel);
    let results = backend.transfer_small_batch(direction, &jobs, ctx).await;
    let mut first_err = None;
    for (job, result) in jobs.iter().zip(results) {
        match result {
            Ok(()) => progress.finished(job.size),
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    first_err.map_or(Ok(()), Err)
}

/// Destino local de un fichero según la política de conflictos (`None` =
/// omitirlo).
async fn resolve_local_target(target: PathBuf, policy: TransferConflictPolicy) -> Option<PathBuf> {
    let Ok(meta) = tokio::fs::metadata(&target).await else {
        return Some(target);
    };
    match policy {
        TransferConflictPolicy::Skip => None,
        TransferConflictPolicy::Rename => Some(auto_rename_local_path(&target).await),
        TransferConflictPolicy::Overwrite if meta.is_dir() => {
            Some(auto_rename_local_path(&target).await)
        }
        TransferConflictPolicy::Overwrite => Some(target),
    }
}

/// Destino remoto de un fichero según la política de conflictos (`None` =
/// omitirlo).
async fn resolve_remote_target(
    backend: &mut dyn FileTransfer,
    target: String,
    policy: TransferConflictPolicy,
) -> Option<String> {
    let Ok(meta) = backend.stat(&target).await else {
        return Some(target);
    };
    match policy {
        TransferConflictPolicy::Skip => None,
        TransferConflictPolicy::Rename => Some(auto_rename_remote_path(backend, &target).await),
        TransferConflictPolicy::Overwrite if meta.is_dir => {
            Some(auto_rename_remote_path(backend, &target).await)
        }
        TransferConflictPolicy::Overwrite => Some(target),
    }
}

/// Ruta de una entrada remota relativa a la raíz de la transferencia.
fn remote_rel(root: &str, entry: &FileEntry) -> String {
    let rel = entry
        .path
        .strip_prefix(root)
        .unwrap_or(&entry.path)
        .trim_start_matches('/');
    if rel.is_empty() {
        entry.name.clone()
    } else {
        rel.to_string()
    }
}

/// Descarga recursivamente el directorio `remote` en `local`. Los ficheros
/// pequeños viajan en lotes cuando el backend lo admite (ver
/// [`crate::transfer_batch`]); los grandes, de uno en uno con su pipelining.
async fn do_download_dir(
    backend: &mut dyn FileTransfer,
    remote: &str,
    local: &Path,
    ctx: TransferCtx<'_>,
    conflict_policy: TransferConflictPolicy,
) -> Result<(), String> {
    let TransferCtx {
        transfer_id,
        app,
        controls,
        ..
    } = ctx;
    tokio::fs::create_dir_all(local)
        .await
        .map_err(|e| e.to_string())?;
    let summary_event = event_name(EventKind::SftpProgress, transfer_id);
    let mut idx: u32 = 0;

    // Pre-conteo del árbol remoto para mostrar archivo actual + N/total.
    let precount = count_remote_tree(backend, remote).await;
    let mut progress = DirProgress {
        app,
        event: &summary_event,
        transfer_id,
        controls,
        bytes_done: 0,
        bytes_total: precount.bytes,
        files_done: 0,
        files_total: precount.files,
    };
    let mut skipped_symlinks: u32 = 0;
    emit_dir_progress(app, &summary_event, 0, progress.bytes_total, "", 0, progress.files_total);
    let concurrency = backend.small_file_concurrency();
    let direction = BatchDirection::Download;

    let mut stack = vec![(remote.to_string(), local.to_path_buf())];
    while let Some((rdir, ldir)) = stack.pop() {
        let entries = backend.list_dir(&rdir).await?;
        let mut batch = Batch::new(concurrency);
        for e in entries {
            safe_entry_name(&e.name)?;
            progress.gate().await?;
            if e.is_dir {
                let target = ldir.join(&e.name);
                tokio::fs::create_dir_all(&target)
                    .await
                    .map_err(|err| err.to_string())?;
                stack.push((e.path.clone(), target));
                continue;
            }
            if e.is_symlink {
                // Se omite (ver `TreeCount`), pero queda contado para avisar al final.
                skipped_symlinks += 1;
                continue;
            }
            let small = transfer_batch::is_small(e.size, concurrency);
            if !small {
                // Uno grande no convive con un lote: cada uno gasta su cupo de
                // handles. Y su conflicto se decide con el lote ya en disco.
                flush_batch(backend, direction, &mut batch, ctx, &mut progress).await?;
            }
            let Some(mut local_target) =
                resolve_local_target(ldir.join(&e.name), conflict_policy).await
            else {
                continue;
            };
            if small && batch.collides(&local_target.to_string_lossy()) {
                // Iría al mismo sitio que uno del lote: se espera a que exista y
                // la política de conflictos decide sobre él, como en serie.
                flush_batch(backend, direction, &mut batch, ctx, &mut progress).await?;
                let Some(target) = resolve_local_target(ldir.join(&e.name), conflict_policy).await
                else {
                    continue;
                };
                local_target = target;
            }
            let rel = remote_rel(remote, &e);
            idx += 1;
            let sub_id = format!("{transfer_id}-{idx}");
            if small {
                let key = local_target.to_string_lossy().into_owned();
                batch.push(
                    &key,
                    BatchJob {
                        remote: e.path.clone(),
                        local: local_target,
                        size: e.size,
                        sub_id,
                        rel,
                    },
                );
                if batch.is_full() {
                    flush_batch(backend, direction, &mut batch, ctx, &mut progress).await?;
                }
            } else {
                progress.starting(&rel);
                backend
                    .download(&e.path, &local_target, ctx.child(&sub_id))
                    .await?;
                progress.finished(e.size);
            }
        }
        flush_batch(backend, direction, &mut batch, ctx, &mut progress).await?;
    }
    progress.done(skipped_symlinks);
    Ok(())
}

/// Sube recursivamente un directorio local al `remote`. Crea las carpetas
/// remotas conforme avanza; los ficheros pequeños viajan en lotes cuando el
/// backend lo admite y los grandes reusan `upload` de uno en uno.
async fn do_upload_dir(
    backend: &mut dyn FileTransfer,
    local: &Path,
    remote: &str,
    ctx: TransferCtx<'_>,
    conflict_policy: TransferConflictPolicy,
) -> Result<(), String> {
    let TransferCtx {
        transfer_id,
        app,
        controls,
        ..
    } = ctx;
    let _ = backend.mkdir(remote).await; // ignorar si ya existe
    let summary_event = event_name(EventKind::SftpProgress, transfer_id);
    let mut idx: u32 = 0;

    // Pre-conteo para conocer el total (estilo FileZilla: archivo actual + N/total).
    let precount = count_local_tree(local).await;
    let mut progress = DirProgress {
        app,
        event: &summary_event,
        transfer_id,
        controls,
        bytes_done: 0,
        bytes_total: precount.bytes,
        files_done: 0,
        files_total: precount.files,
    };
    let mut skipped_symlinks: u32 = 0;
    emit_dir_progress(app, &summary_event, 0, progress.bytes_total, "", 0, progress.files_total);
    let concurrency = backend.small_file_concurrency();
    let direction = BatchDirection::Upload;

    let mut stack = vec![(local.to_path_buf(), remote.to_string())];
    while let Some((ldir, rdir)) = stack.pop() {
        let mut read = tokio::fs::read_dir(&ldir)
            .await
            .map_err(|e| e.to_string())?;
        let mut batch = Batch::new(concurrency);
        while let Some(entry) = read.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name().to_string_lossy().into_owned();
            progress.gate().await?;
            let path = entry.path();
            let ft = entry.file_type().await.map_err(|e| e.to_string())?;
            if ft.is_symlink() {
                // Se omite (ver `TreeCount`), pero queda contado para avisar al final.
                skipped_symlinks += 1;
                continue;
            }
            if ft.is_dir() {
                let target = join_remote(&rdir, &name);
                let _ = backend.mkdir(&target).await;
                stack.push((path, target));
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let fsize = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
            let small = transfer_batch::is_small(fsize, concurrency);
            if !small {
                flush_batch(backend, direction, &mut batch, ctx, &mut progress).await?;
            }
            let Some(mut remote_target) =
                resolve_remote_target(backend, join_remote(&rdir, &name), conflict_policy).await
            else {
                continue;
            };
            if small && batch.collides(&remote_target) {
                flush_batch(backend, direction, &mut batch, ctx, &mut progress).await?;
                let Some(target) =
                    resolve_remote_target(backend, join_remote(&rdir, &name), conflict_policy).await
                else {
                    continue;
                };
                remote_target = target;
            }
            let rel = path
                .strip_prefix(local)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            idx += 1;
            let sub_id = format!("{transfer_id}-{idx}");
            if small {
                let key = remote_target.clone();
                batch.push(
                    &key,
                    BatchJob {
                        remote: remote_target,
                        local: path,
                        size: fsize,
                        sub_id,
                        rel,
                    },
                );
                if batch.is_full() {
                    flush_batch(backend, direction, &mut batch, ctx, &mut progress).await?;
                }
            } else {
                progress.starting(&rel);
                backend
                    .upload(&path, &remote_target, ctx.child(&sub_id))
                    .await?;
                progress.finished(fsize);
            }
        }
        flush_batch(backend, direction, &mut batch, ctx, &mut progress).await?;
    }
    progress.done(skipped_symlinks);
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
    fn la_pausa_y_la_cancelacion_de_la_carpeta_llegan_al_fichero_en_curso() {
        // Ningún test toca `PAUSE_ALL`, así que la pausa global no interfiere.
        let c = TransferControls::new();
        c.pause("t".into());
        assert!(c.paused_for("t-3", Some("t")), "la pausa de la carpeta frena al fichero");
        assert!(!c.paused_for("t-3", None), "un fichero suelto no mira a nadie más");
        c.resume("t");
        assert!(!c.paused_for("t-3", Some("t")));

        c.cancel("t".into());
        // Paran todos los ficheros de la carpeta, no solo el primero que mira.
        assert!(c.cancel_requested("t-1", Some("t")));
        assert!(c.cancel_requested("t-2", Some("t")));
        // La consume el worker al terminar la carpeta: un reintento con el mismo
        // id arranca limpio.
        assert!(c.take_cancel("t"));
        assert!(!c.cancel_requested("t-3", Some("t")));

        // La propia de cada uno se sigue consumiendo al verla.
        c.cancel("x".into());
        assert!(c.cancel_requested("x", None));
        assert!(!c.cancel_requested("x", None));
    }

    #[test]
    fn cerrar_la_sesion_cancela_cualquier_transferencia() {
        let c = TransferControls::new();
        assert!(!c.take_cancel("t"));
        c.pause("t".into());
        c.close();
        assert!(c.take_cancel("t"), "también la que estaba en pausa");
        assert!(c.take_cancel("t-3"), "también los ficheros de una carpeta");
        assert!(c.take_cancel("t"), "no se consume: vale hasta que el worker cierra");
    }

    /// Mientras el worker espera un comando, las demás tareas de su runtime
    /// (en producción, la sesión SSH y el lector SFTP) tienen que seguir
    /// avanzando.
    #[test]
    fn el_worker_no_congela_su_runtime_mientras_espera_comandos() {
        use std::sync::atomic::AtomicUsize;
        let ticks = Arc::new(AtomicUsize::new(0));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SftpCommand>();
        let contador = Arc::clone(&ticks);
        // Mismo tipo de runtime que el worker (`SftpManager::connect`).
        let worker = thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            rt.block_on(async move {
                tokio::spawn(async move {
                    let mut tic = tokio::time::interval(Duration::from_millis(10));
                    loop {
                        tic.tick().await;
                        contador.fetch_add(1, Ordering::Relaxed);
                    }
                });
                matches!(next_command(&mut rx).await, Some(SftpCommand::Close))
            })
        });
        thread::sleep(Duration::from_millis(300));
        let vistos = ticks.load(Ordering::Relaxed);
        let _ = tx.send(SftpCommand::Close);
        assert!(worker.join().expect("el worker no debe entrar en pánico"));
        assert!(vistos >= 10, "la runtime se quedó parada esperando: {vistos} ticks");
    }

    /// **Integración**: con el panel abierto y sin tocar, la sesión SFTP sigue
    /// viva frente a un `sshd` que sondea al cliente cada segundo y corta al
    /// primer sondeo sin respuesta (`ClientAliveInterval 1`,
    /// `ClientAliveCountMax 1`). Con la espera síncrona de antes, la runtime del
    /// worker no contestaba y el servidor cerraba a los ~2 s.
    #[cfg(target_os = "linux")]
    #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
    #[test]
    fn sftp_el_panel_ocioso_sigue_contestando_al_servidor() {
        let Some(server) =
            crate::ssh_fixture::start_with_config("ClientAliveInterval 1\nClientAliveCountMax 1\n")
                .expect("arrancar sshd")
        else {
            eprintln!("sshd/ssh-keygen no disponibles; test omitido");
            return;
        };
        // La host key se siembra de antemano en un known_hosts propio: así el
        // test no depende de la política TOFU global (la tocan otros tests).
        let known_hosts = server.known_hosts_path();
        let host_pub = std::fs::read_to_string(known_hosts.with_file_name("hostkey.pub"))
            .expect("leer la host key del fixture");
        let host_pub: Vec<&str> = host_pub.split_whitespace().take(2).collect();
        std::fs::write(
            &known_hosts,
            format!("{}\n", server.host_key_line_for(&host_pub.join(" "))),
        )
        .expect("sembrar known_hosts");

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SftpCommand>();
        // El siguiente comando tarda en llegar, como en un panel sin tocar.
        let remitente = thread::spawn(move || {
            thread::sleep(Duration::from_secs(4));
            let _ = tx.send(SftpCommand::Close);
        });
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let listado = rt.block_on(async move {
            let addr = format!("127.0.0.1:{}", server.port);
            let (handler, failure) =
                host_keys::client_with_known_hosts("127.0.0.1".into(), server.port, known_hosts);
            let mut handle = crate::ssh_manager::russh_connect_addr(
                Arc::new(client::Config::default()),
                &addr,
                handler,
            )
            .await
            .unwrap_or_else(|e| {
                panic!("no conectó: {e}. host_keys: {:?}", host_keys::take_failure(&failure))
            });
            let key = server.user_key.to_string_lossy().into_owned();
            let auth = crate::ssh_manager::authenticate_handle(
                &mut handle,
                &AuthType::PublicKey,
                &server.username,
                "127.0.0.1",
                None,
                None,
                Some(&key),
            )
            .await
            .expect("autenticación");
            assert!(matches!(auth, AuthResult::Success), "autenticación: {auth:?}");
            let channel = handle.channel_open_session().await.expect("abrir canal");
            channel
                .request_subsystem(true, "sftp")
                .await
                .expect("subsistema sftp");
            let sftp = SftpSession::new(channel.into_stream())
                .await
                .expect("sesión SFTP");
            // La misma espera entre comandos que el worker.
            assert!(matches!(next_command(&mut rx).await, Some(SftpCommand::Close)));
            let listado = sftp.read_dir(".".to_string()).await.map(|_| ());
            drop(server);
            listado
        });
        remitente.join().expect("el remitente no debe entrar en pánico");
        listado.expect("tras el reposo la sesión SFTP tiene que seguir viva");
    }

    #[test]
    fn un_trozo_corto_a_mitad_es_que_el_origen_encogio() {
        let total = 3 * SFTP_CHUNK;
        // Trozo completo, en cualquier punto.
        assert!(!chunk_is_short(0, SFTP_CHUNK, total));
        assert!(!chunk_is_short(2 * SFTP_CHUNK, SFTP_CHUNK, total));
        // A mitad, corto o vacío: el origen llegó a EOF antes de tiempo.
        assert!(chunk_is_short(SFTP_CHUNK, 1000, total));
        assert!(chunk_is_short(SFTP_CHUNK, 0, total));
        // El último puede ser más corto que un trozo, pero no que lo que queda.
        let total = 2 * SFTP_CHUNK + 10;
        assert!(!chunk_is_short(2 * SFTP_CHUNK, 10, total));
        assert!(chunk_is_short(2 * SFTP_CHUNK, 5, total));
        // Al reanudar, los trozos arrancan en el punto de corte, no en la rejilla.
        let start = 1234;
        assert!(!chunk_is_short(start, SFTP_CHUNK, start + SFTP_CHUNK + 1));
        assert!(!chunk_is_short(start + SFTP_CHUNK, 1, start + SFTP_CHUNK + 1));
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

    /// Perfil FTP mínimo apuntando al fixture (usuario anónimo). El resto de
    /// campos caen por sus defaults de serde, como el helper de `profiles.rs`.
    #[cfg(target_os = "linux")]
    fn ftp_profile(port: u16) -> ConnectionProfile {
        let json = format!(
            r#"{{
                "id": "ftp-test",
                "name": "FTP de prueba",
                "host": "127.0.0.1",
                "port": {port},
                "username": "",
                "connection_type": "ftp",
                "domain": null,
                "auth_type": "password",
                "key_path": null,
                "group": null,
                "created_at": "2026-05-08T12:00:00Z"
            }}"#
        );
        serde_json::from_str(&json).expect("perfil FTP válido")
    }

    /// La API de streams de suppaftp 12 debe cerrar y consumir el acuse antes
    /// de reutilizar el canal de control, tanto con FTP como con TLS.
    #[cfg(target_os = "linux")]
    fn check_ftp_stream_roundtrip(conn: &mut FtpConnection) {
        fn roundtrip<T: suppaftp::TlsStream>(ftp: &mut suppaftp::ImplFtpStream<T>) {
            let payload: Vec<u8> = (0..131_073).map(|n| (n % 251) as u8).collect();
            let mut upload = ftp.put_with_stream("stream.bin").expect("abrir STOR");
            std::io::Write::write_all(&mut upload, &payload).expect("escribir contenido");
            upload.finish().expect("acuse de subida");
            assert_eq!(ftp.size("stream.bin").expect("SIZE tras STOR"), payload.len());
            let mut download = ftp.retr_as_stream("stream.bin").expect("abrir RETR");
            let mut received = Vec::new();
            std::io::Read::read_to_end(&mut download, &mut received).expect("leer contenido");
            download.finish().expect("acuse de descarga");
            assert_eq!(received, payload, "transferencia binaria íntegra");
            assert_eq!(ftp.pwd().expect("PWD tras RETR"), "/");
            ftp.rm("stream.bin").expect("limpiar fichero remoto");
        }
        match &mut conn.stream {
            FtpStreamKind::Plain(ftp) => roundtrip(ftp),
            FtpStreamKind::ExplicitTls(ftp) => roundtrip(ftp),
        }
    }

    /// **Integración**: recorre el CRUD del backend FTP contra un servidor
    /// `libunftp` real por el camino de producción (`connect_ftp` →
    /// `FtpConnection`): login anónimo, `pwd`, crear carpeta (MKD), subir un
    /// fichero (STOR), listarlo por el canal de datos PASV (LIST), consultar su
    /// tamaño (SIZE), renombrarlo (RNFR/RNTO) y borrarlo (DELE/RMD). Cada escritura
    /// se cruza contra el **sistema de ficheros** del servidor, así que un fallo
    /// del protocolo —o una regresión al subir `suppaftp`— lo caza el CI.
    #[cfg(target_os = "linux")]
    #[ignore = "levanta un servidor FTP efímero; se corre con --ignored"]
    #[test]
    fn ftp_crud_completo_por_el_camino_real() {
        let server = crate::ftp_fixture::start().expect("arrancar el servidor FTP");
        let profile = ftp_profile(server.port);
        let cert_store = server.root.join("ftps_certs.json"); // no se usa en FTP plano

        let mut conn =
            connect_ftp(&profile, None, cert_store).expect("conectar y autenticar FTP anónimo");

        // El canal de control lleva el plazo de E/S: un servidor mudo no cuelga.
        let FtpStreamKind::Plain(ftp) = &conn.stream else {
            panic!("un perfil FTP plano debe dar una conexión plana");
        };
        assert_eq!(
            ftp.get_ref().read_timeout().expect("leer el plazo del socket"),
            Some(FTP_TIMEOUTS.control)
        );

        // Recién conectados, el directorio de trabajo es la raíz.
        assert_eq!(conn.pwd().expect("pwd"), "/");

        // MKD + STOR (fichero vacío) por el camino real.
        check_ftp_stream_roundtrip(&mut conn);
        conn.mkdir("carpeta").expect("crear carpeta");
        conn.create_file("carpeta/hola.txt").expect("crear fichero");

        // La escritura llegó de verdad al disco del servidor.
        let en_disco = server.root.join("carpeta/hola.txt");
        assert!(en_disco.exists(), "el STOR debió crear el fichero en el servidor");

        // LIST por el canal de datos PASV lo muestra; SIZE da 0 (vacío).
        let listado = conn.list("carpeta").expect("listar la carpeta").join("\n");
        assert!(
            listado.contains("hola.txt"),
            "el listado debía incluir el fichero, salió:\n{listado}"
        );
        assert_eq!(conn.size("carpeta/hola.txt").expect("size"), 0);
        // Mientras dura un comando con datos (el LIST) el control lee con el
        // plazo corto; al terminar recupera el suyo, y la conexión sigue sana.
        if let FtpStreamKind::Plain(ftp) = &conn.stream {
            assert_eq!(
                ftp.get_ref().read_timeout().expect("leer el plazo del socket"),
                Some(FTP_TIMEOUTS.control),
                "tras un comando con datos, el control recupera su plazo"
            );
        }
        assert!(conn.broken_reason().is_none(), "una sesión sana no está rota");

        // RNFR/RNTO y DELE, cruzados otra vez contra el disco del servidor.
        conn.rename("carpeta/hola.txt", "carpeta/adios.txt")
            .expect("renombrar");
        assert!(!en_disco.exists(), "tras renombrar, el nombre viejo no existe");
        assert!(server.root.join("carpeta/adios.txt").exists(), "el nombre nuevo existe");

        conn.remove("carpeta/adios.txt", false).expect("borrar fichero");
        assert!(
            !server.root.join("carpeta/adios.txt").exists(),
            "tras DELE el fichero no existe en el servidor"
        );

        conn.quit();
    }

    /// **Integración**: TOFU de certificados **FTPS** contra un servidor real con
    /// TLS explícito y certificado autofirmado (la feature de v1.61.0). Recorre
    /// las tres ramas de `ftps_certs::decide` por el camino de producción
    /// (`connect_ftp` con `connection_type = "ftps"`): (1) primera conexión →
    /// aprende la huella y la persiste; (2) reconexión con la huella recordada →
    /// se reconoce y conecta; (3) huella cambiada → se **rechaza**, como el TOFU
    /// de host keys SSH pero por el camino FTPS.
    #[cfg(target_os = "linux")]
    #[ignore = "levanta un servidor FTPS efímero; se corre con --ignored"]
    #[test]
    fn ftps_tofu_aprende_reconoce_y_rechaza_el_cambio() {
        // Aprendizaje automático: sin esto, la primera conexión pediría confirmar
        // la huella por un prompt que en un test no existe.
        crate::ftps_certs::set_strict_first_connect(false);

        let server = crate::ftp_fixture::start_ftps().expect("arrancar el servidor FTPS");
        let mut profile = ftp_profile(server.port);
        profile.connection_type = "ftps".to_string();
        let store = server.root.join("ftps_known_certs.json");

        // 1) Primera conexión: aprende la huella (TOFU) y la persiste.
        assert!(!store.exists(), "el almacén de huellas debe empezar sin existir");
        let mut conn =
            connect_ftp(&profile, None, store.clone()).expect("primera conexión FTPS autofirmada");
        assert_eq!(conn.pwd().expect("pwd"), "/");
        check_ftp_stream_roundtrip(&mut conn);
        conn.quit();
        assert!(store.exists(), "el TOFU debió guardar la huella del certificado");

        // 2) Reconexión con la huella ya recordada: Decision::Trusted.
        let mut conn2 = connect_ftp(&profile, None, store.clone())
            .expect("reconexión FTPS con la huella ya aprendida");
        assert_eq!(conn2.pwd().expect("pwd"), "/");
        conn2.quit();

        // 3) Huella cambiada: sembramos otra distinta y la conexión debe rechazarse
        //    (Decision::Changed), sin aprender la nueva en silencio.
        crate::ftps_certs::CertStore::new(store.clone())
            .insert("127.0.0.1", server.port, "AA:BB:CC:DD:EE:FF")
            .expect("sembrar una huella falsa");
        let cambiado = connect_ftp(&profile, None, store.clone());
        assert!(
            cambiado.is_err(),
            "una huella FTPS cambiada debió rechazar la conexión"
        );
    }

    /// Los tests SFTP contra `sshd` reales comparten la política TOFU global de
    /// `host_keys` y el rango de puertos efímeros: se serializan, como los de
    /// `ssh_manager` con su `SSH_IT_LOCK`.
    #[cfg(target_os = "linux")]
    static SFTP_IT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Etapas que el panel deja en su registro: `(etapa, estado, mensaje)`.
    #[cfg(target_os = "linux")]
    type LoggedStages = Vec<(&'static str, &'static str, String)>;

    /// Perfil SSH por clave pública contra el fixture `server`.
    #[cfg(target_os = "linux")]
    fn ssh_profile(server: &crate::ssh_fixture::FakeSshServer) -> ConnectionProfile {
        let mut profile = ftp_profile(server.port);
        profile.connection_type = "ssh".to_string();
        profile.username = server.username.clone();
        profile.auth_type = AuthType::PublicKey;
        profile.key_path = Some(server.user_key.to_string_lossy().into_owned());
        profile
    }

    /// Autoriza la clave de usuario de `other` en el `sshd` de `server`: el
    /// bastión se autentica con las credenciales del perfil, que son las del
    /// destino.
    #[cfg(target_os = "linux")]
    fn authorize_key_of(
        server: &crate::ssh_fixture::FakeSshServer,
        other: &crate::ssh_fixture::FakeSshServer,
    ) {
        let public = std::fs::read_to_string(other.user_key.with_extension("pub"))
            .expect("clave pública del destino");
        let mut authorized = std::fs::OpenOptions::new()
            .append(true)
            .open(server.authorized_keys_path())
            .expect("abrir authorized_keys");
        authorized
            .write_all(public.as_bytes())
            .expect("autorizar la clave");
    }

    /// Abre el panel SFTP por su camino de producción (`connect_and_open_sftp`),
    /// con las host keys de los dos saltos en un `known_hosts` aislado, y
    /// devuelve la sesión junto con las etapas que registró.
    #[cfg(target_os = "linux")]
    async fn open_panel_sftp(
        profile: &ConnectionProfile,
        known_hosts: &Path,
    ) -> (Result<SftpSession, String>, LoggedStages) {
        let stages = std::cell::RefCell::new(Vec::new());
        let log = |stage, status, message: String| {
            stages.borrow_mut().push((stage, status, message));
        };
        let host_key_check = |_hop, host: &str, port| {
            host_keys::client_with_known_hosts(host.to_string(), port, known_hosts.to_path_buf())
        };
        // La ruta como la construye la app: el bastión de texto del perfil,
        // con las credenciales del perfil.
        let route = crate::jump_route::route_with(
            &[],
            profile,
            crate::jump_route::HopSecrets::default(),
            None,
            &mut |p| p.clone(),
            &mut |_| crate::jump_route::HopSecrets::default(),
        )
        .expect("ruta del perfil");
        let routing = crate::jump_pool::Routing { route, pool: None };
        let request = OpenRequest {
            profile,
            password: None,
            passphrase: None,
            elevated: false,
            routing: &routing,
        };
        let result = connect_and_open_sftp(request, &log, &host_key_check)
            .await
            .map(|(sftp, _jump)| sftp);
        (result, stages.into_inner())
    }

    /// **Integración**: el panel SFTP de un servidor detrás de un bastión. Con
    /// dos `sshd` reales y `proxy_jump` en el perfil, el panel conecta al
    /// bastión, salta por `direct-tcpip`, abre el subsistema sftp del destino y
    /// lista un directorio. Antes conectaba directo y no miraba el bastión: el
    /// terminal entraba y el panel no.
    #[cfg(target_os = "linux")]
    #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
    #[tokio::test]
    async fn sftp_lista_un_directorio_a_traves_del_bastion() {
        let _guard = SFTP_IT_LOCK.lock().await;
        use crate::ssh_fixture;

        let (Some(bastion), Some(target)) = (
            ssh_fixture::start().expect("arrancar bastión"),
            ssh_fixture::start().expect("arrancar destino"),
        ) else {
            eprintln!("sshd/ssh-keygen no disponibles; test omitido");
            return;
        };
        host_keys::set_strict_first_connect(false);
        authorize_key_of(&bastion, &target);

        // Un directorio con contenido conocido. El `sshd` del fixture sirve el
        // sistema de ficheros del usuario que corre el test.
        let dir = std::env::temp_dir().join(format!("rustty-sftp-jump-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("crear directorio");
        std::fs::write(dir.join("hola.txt"), b"hola").expect("crear fichero");

        let mut profile = ssh_profile(&target);
        profile.proxy_jump = Some(format!("{}@127.0.0.1:{}", bastion.username, bastion.port));
        let known_hosts = target.known_hosts_path();
        let (result, stages) = open_panel_sftp(&profile, &known_hosts).await;
        let sftp = result.unwrap_or_else(|e| {
            panic!("el panel no abrió SFTP por el bastión: {e}. Registro: {stages:#?}")
        });

        let listed = do_list_dir(&sftp, &dir.to_string_lossy())
            .await
            .expect("listar el directorio por el salto");
        assert!(
            listed.iter().any(|e| e.name == "hola.txt" && !e.is_dir),
            "el listado debía incluir hola.txt, salió: {listed:?}"
        );

        // El salto quedó en el registro del panel, en su etapa propia.
        let bastion_ok: Vec<&String> = stages
            .iter()
            .filter(|(stage, status, _)| *stage == "bastion" && *status == "ok")
            .map(|(_, _, message)| message)
            .collect();
        assert!(
            bastion_ok.iter().any(|m| m.contains("Autenticado en el salto 1/1")),
            "faltan las etapas del bastión: {stages:#?}"
        );
        assert!(
            stages.iter().any(|(stage, status, _)| *stage == "ready" && *status == "ok"),
            "el panel debía quedar listo: {stages:#?}"
        );

        // Las dos host keys pasaron por la verificación: el known_hosts aislado
        // recuerda al bastión y al destino.
        let recorded = std::fs::read_to_string(&known_hosts).expect("known_hosts");
        assert!(
            recorded.contains(&format!("[127.0.0.1]:{}", bastion.port)),
            "no se verificó la host key del bastión:\n{recorded}"
        );
        assert!(
            recorded.contains(&format!("[127.0.0.1]:{}", target.port)),
            "no se verificó la host key del destino:\n{recorded}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **Integración**: «Permitir cifrados antiguos» también vale para el panel.
    /// Un `sshd` que solo negocia `aes128-cbc` rechaza el panel con la casilla
    /// apagada y lo acepta con ella; y como bastión de otro servidor, la misma
    /// config viaja a los dos saltos.
    #[cfg(target_os = "linux")]
    #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
    #[tokio::test]
    async fn sftp_negocia_los_cifrados_antiguos_del_perfil() {
        let _guard = SFTP_IT_LOCK.lock().await;
        use crate::ssh_fixture;

        let (Some(legacy), Some(target)) = (
            ssh_fixture::start_with_config("Ciphers aes128-cbc").expect("arrancar sshd antiguo"),
            ssh_fixture::start().expect("arrancar destino"),
        ) else {
            eprintln!("sshd/ssh-keygen no disponibles; test omitido");
            return;
        };
        host_keys::set_strict_first_connect(false);

        // 1) Sin la casilla no hay cifrado común: el handshake falla.
        let mut profile = ssh_profile(&legacy);
        let known_hosts = legacy.known_hosts_path();
        let (result, stages) = open_panel_sftp(&profile, &known_hosts).await;
        assert!(result.is_err(), "sin cifrados antiguos debía fallar: {stages:#?}");
        assert!(
            stages.iter().any(|(stage, status, _)| *stage == "connect" && *status == "error"),
            "el fallo debía registrarse en la etapa de conexión: {stages:#?}"
        );

        // 2) Con la casilla (solo aes128-cbc), el panel abre y lista.
        profile.allow_legacy_algorithms = true;
        profile.legacy_algorithms = Some(vec!["aes128-cbc".to_string()]);
        let (result, stages) = open_panel_sftp(&profile, &known_hosts).await;
        let sftp = result.unwrap_or_else(|e| {
            panic!("con cifrados antiguos debía abrir SFTP: {e}. Registro: {stages:#?}")
        });
        do_list_dir(&sftp, "/").await.expect("listar la raíz");

        // 3) El servidor antiguo como bastión de uno moderno.
        authorize_key_of(&legacy, &target);
        let mut via = ssh_profile(&target);
        via.proxy_jump = Some(format!("{}@127.0.0.1:{}", legacy.username, legacy.port));
        let jump_known_hosts = target.known_hosts_path();
        let (result, stages) = open_panel_sftp(&via, &jump_known_hosts).await;
        assert!(
            result.is_err(),
            "sin cifrados antiguos el bastión no debía aceptar: {stages:#?}"
        );
        assert!(
            stages.iter().any(|(stage, status, _)| *stage == "bastion" && *status == "error"),
            "el fallo debía registrarse en la etapa del bastión: {stages:#?}"
        );
        via.allow_legacy_algorithms = true;
        via.legacy_algorithms = Some(vec!["aes128-cbc".to_string()]);
        let (result, stages) = open_panel_sftp(&via, &jump_known_hosts).await;
        let sftp = result.unwrap_or_else(|e| {
            panic!("el bastión antiguo debía dejar pasar al panel: {e}. Registro: {stages:#?}")
        });
        do_list_dir(&sftp, "/").await.expect("listar la raíz por el salto");
    }

    /// Dónde se calla el servidor FTP de mentira de [`ftp_mudo`].
    #[cfg(target_os = "linux")]
    #[derive(Clone, Copy)]
    enum Mudo {
        /// Acepta la conexión y no manda ni el saludo 220.
        SinSaludo,
        /// Saluda, pero no contesta al login.
        TrasElSaludo,
        /// Empieza a mandar un fichero y se queda callado a mitad, sin el 226.
        EnLosDatos,
        /// Empieza a mandar un listado y se queda callado a mitad de línea.
        EnElListado,
    }

    /// Servidor FTP mínimo, a mano, que deja de contestar sin cerrar nada: lo
    /// que hace un servidor que se suspende, se para o se queda tras un corte de
    /// red sin RST. Devuelve el puerto.
    #[cfg(target_os = "linux")]
    fn ftp_mudo(modo: Mudo) -> u16 {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("escuchar");
        let port = listener.local_addr().expect("puerto").port();
        thread::spawn(move || {
            let Ok((control, _)) = listener.accept() else { return };
            if matches!(modo, Mudo::SinSaludo) {
                thread::sleep(Duration::from_secs(30));
                return;
            }
            let Ok(mut w) = control.try_clone() else { return };
            let _ = w.write_all(b"220 hola\r\n");
            let mut datos = None;
            // Los sockets de datos se quedan abiertos (y mudos) hasta el final.
            let mut retenidos = Vec::new();
            let mut lines = BufReader::new(control);
            let mut line = String::new();
            while lines.read_line(&mut line).is_ok_and(|n| n > 0) {
                let cmd = line.trim().to_ascii_uppercase();
                line.clear();
                let reply = if cmd.starts_with("USER") {
                    (!matches!(modo, Mudo::TrasElSaludo)).then(|| "230 dentro".to_string())
                } else if cmd.starts_with("TYPE") {
                    Some("200 vale".to_string())
                } else if cmd.starts_with("PASV") {
                    let Ok(l) = std::net::TcpListener::bind("127.0.0.1:0") else { return };
                    let Ok(p) = l.local_addr().map(|a| a.port()) else { return };
                    datos = Some(l);
                    Some(format!(
                        "227 Entering Passive Mode (127,0,0,1,{},{})",
                        p / 256,
                        p % 256
                    ))
                } else if cmd.starts_with("RETR") {
                    let Some(Ok((mut d, _))) = datos.take().map(|l| l.accept()) else { return };
                    let _ = w.write_all(b"150 ahi va\r\n");
                    let _ = d.write_all(b"hola");
                    retenidos.push(d);
                    None
                } else if cmd.starts_with("LIST") || cmd.starts_with("MLSD") {
                    let Some(Ok((mut d, _))) = datos.take().map(|l| l.accept()) else { return };
                    let _ = w.write_all(b"150 ahi va\r\n");
                    let _ = d.write_all(b"-rw-r--r-- 1 u g 4 Jan 01 00:00 ho");
                    retenidos.push(d);
                    None
                } else {
                    Some("502 no".to_string())
                };
                if let Some(r) = reply {
                    let _ = w.write_all(format!("{r}\r\n").as_bytes());
                }
            }
        });
        port
    }

    /// Corre `f` en otro hilo y falla si no vuelve en `plazo`: sin el plazo de
    /// E/S estos tests se colgarían, y así fallan en vez de bloquear la suite.
    #[cfg(target_os = "linux")]
    fn vuelve_antes_de<T: Send + 'static>(
        plazo: Duration,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> T {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(plazo)
            .expect("se quedó esperando a un servidor mudo: falta el plazo de E/S")
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ftp_un_servidor_mudo_al_conectar_no_cuelga() {
        for modo in [Mudo::SinSaludo, Mudo::TrasElSaludo] {
            let port = ftp_mudo(modo);
            let res = vuelve_antes_de(Duration::from_secs(20), move || {
                FtpConnection::connect_with_timeouts(
                    &ftp_profile(port),
                    None,
                    PathBuf::from("/nonexistent/ftps_certs.json"),
                    FtpTimeouts::uniform(Duration::from_secs(1)),
                )
                .map(|_| ())
            });
            assert!(res.is_err(), "conectar con un servidor mudo tiene que fallar");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ftp_una_descarga_atascada_falla_por_plazo() {
        let port = ftp_mudo(Mudo::EnLosDatos);
        let (recibido, error) = vuelve_antes_de(Duration::from_secs(20), move || {
            let conn = FtpConnection::connect_with_timeouts(
                &ftp_profile(port),
                None,
                PathBuf::from("/nonexistent/ftps_certs.json"),
                FtpTimeouts::uniform(Duration::from_secs(1)),
            )
            .expect("conectar con el servidor de mentira");
            let FtpStreamKind::Plain(mut ftp) = conn.stream else {
                panic!("un perfil FTP plano debe dar una conexión plana");
            };
            let mut stream = ftp.retr_as_stream("x").expect("abrir RETR");
            let mut recibido = Vec::new();
            let err = stream
                .read_to_end(&mut recibido)
                .expect_err("el canal de datos se calla: la lectura tiene que caducar");
            // Soltar el stream lee el 226, que tampoco llega: también caduca.
            drop(stream);
            (recibido, ftp_io_error(&err, Duration::from_secs(1)))
        });
        assert_eq!(recibido, b"hola", "lo que sí llegó se ha leído");
        assert!(error.contains("dejó de responder"), "{error}");
        assert!(!error.contains("cancel"), "no puede parecer una cancelación: {error}");
    }

    /// Un plazo agotado en el canal de datos (el servidor se para a mitad de
    /// un listado, como un `kill -STOP`) tiene que (a) fallar en el plazo
    /// **corto** de datos, aunque el de control sea largo —y eso incluye el
    /// acuse que suppaftp lee al soltar el stream—, y (b) dejar la conexión
    /// marcada como rota: lo siguiente falla al instante y con el marcador de
    /// «conexión perdida», en vez de esperar otro plazo o leer respuestas
    /// desincronizadas. Cerrarla tampoco espera al servidor.
    #[cfg(target_os = "linux")]
    #[test]
    fn ftp_un_plazo_agotado_deja_la_conexion_rota() {
        let port = ftp_mudo(Mudo::EnElListado);
        vuelve_antes_de(Duration::from_secs(20), move || {
            let timeouts = FtpTimeouts {
                control: Duration::from_secs(10),
                data: Duration::from_secs(1),
            };
            let mut conn = FtpConnection::connect_with_timeouts(
                &ftp_profile(port),
                None,
                PathBuf::from("/nonexistent/ftps_certs.json"),
                timeouts,
            )
            .expect("conectar con el servidor de mentira");
            assert!(conn.broken_reason().is_none());

            let t0 = std::time::Instant::now();
            let err = conn
                .list("/")
                .expect_err("el listado se queda a medias: tiene que caducar");
            assert!(
                t0.elapsed() < Duration::from_secs(5),
                "debía caducar por el plazo de datos, tardó {:?}",
                t0.elapsed()
            );
            assert!(err.contains(TRANSFER_CONNECTION_LOST_MARKER), "{err}");
            assert!(err.contains("dejó de responder"), "{err}");
            assert!(!err.contains("cancel"), "{err}");

            assert!(conn.broken_reason().is_some(), "la conexión queda rota");
            let t1 = std::time::Instant::now();
            let err2 = conn.pwd().expect_err("una conexión rota no atiende nada");
            assert!(t1.elapsed() < Duration::from_millis(200), "{:?}", t1.elapsed());
            assert!(err2.contains(TRANSFER_CONNECTION_LOST_MARKER), "{err2}");
            assert!(conn.size("x").is_err() && conn.mkdir("y").is_err());
            assert!(conn.list("/").is_err() && conn.create_file("z").is_err());

            let t2 = std::time::Instant::now();
            conn.quit();
            assert!(t2.elapsed() < Duration::from_millis(200), "{:?}", t2.elapsed());
        });
    }

    /// Un rechazo del servidor (un 550) es un error normal: la conexión sigue
    /// sana y se puede seguir usando.
    #[cfg(target_os = "linux")]
    #[ignore = "levanta un servidor FTP efímero; se corre con --ignored"]
    #[test]
    fn ftp_un_550_no_rompe_la_conexion() {
        let server = crate::ftp_fixture::start().expect("arrancar el servidor FTP");
        let mut conn = connect_ftp(&ftp_profile(server.port), None, server.root.join("c.json"))
            .expect("conectar");
        let err = conn.size("no-existe.bin").expect_err("SIZE de algo que no existe");
        assert!(!err.contains(TRANSFER_CONNECTION_LOST_MARKER), "{err}");
        assert!(conn.broken_reason().is_none());
        assert_eq!(conn.pwd().expect("la conexión sigue viva"), "/");
        conn.quit();
    }

    /// Backend de mentira para las reglas del worker: solo sabe qué rutas
    /// existen y de qué tipo son.
    struct FakeBackend {
        entries: Vec<FileEntry>,
    }

    fn fake_entry(path: &str, is_dir: bool) -> FileEntry {
        FileEntry {
            name: remote_name(path),
            path: path.to_string(),
            is_dir,
            is_symlink: false,
            size: 0,
            modified: None,
            permissions: None,
        }
    }

    #[async_trait(?Send)]
    impl FileTransfer for FakeBackend {
        async fn list_dir(&mut self, _: &str) -> Result<Vec<FileEntry>, String> {
            Err("no en el mock".into())
        }
        async fn stat(&mut self, path: &str) -> Result<FileEntry, String> {
            self.entries
                .iter()
                .find(|e| e.path == path)
                .cloned()
                .ok_or_else(|| format!("No such file: {path}"))
        }
        async fn home_dir(&mut self) -> Result<String, String> {
            Err("no en el mock".into())
        }
        async fn mkdir(&mut self, _: &str) -> Result<(), String> {
            Err("no en el mock".into())
        }
        async fn create_file(&mut self, _: &str) -> Result<(), String> {
            Err("no en el mock".into())
        }
        async fn remove(&mut self, _: &str, _: bool) -> Result<(), String> {
            Err("no en el mock".into())
        }
        async fn rename(&mut self, _: &str, _: &str) -> Result<(), String> {
            Err("no en el mock".into())
        }
        async fn chmod(&mut self, _: &str, _: u32) -> Result<(), String> {
            Err("no en el mock".into())
        }
        async fn download(&mut self, _: &str, _: &Path, _: TransferCtx<'_>) -> Result<(), String> {
            Err("no en el mock".into())
        }
        async fn upload(&mut self, _: &Path, _: &str, _: TransferCtx<'_>) -> Result<(), String> {
            Err("no en el mock".into())
        }
        async fn close(&mut self) {}
    }

    #[tokio::test]
    async fn una_subida_no_pisa_un_destino_existente_sin_permiso() {
        let mut backend = FakeBackend {
            entries: vec![fake_entry("/srv/informe.pdf", false), fake_entry("/srv/docs", true)],
        };
        let err = check_upload_target(&mut backend, "/srv/informe.pdf", false)
            .await
            .expect_err("sin permiso no se pisa");
        assert!(err.starts_with(TRANSFER_EXISTS_MARKER), "{err}");
        assert!(err.contains("/srv/informe.pdf"), "{err}");
        check_upload_target(&mut backend, "/srv/informe.pdf", true)
            .await
            .expect("con permiso explícito sí");
        check_upload_target(&mut backend, "/srv/nuevo.pdf", false)
            .await
            .expect("si no existe no hay conflicto");
        // Una carpeta no se sustituye por un fichero ni con permiso, y no es un
        // «ya existe» que el panel deba preguntar.
        let err = check_upload_target(&mut backend, "/srv/docs", true)
            .await
            .expect_err("un fichero no sustituye a una carpeta");
        assert!(!err.contains(TRANSFER_EXISTS_MARKER) && err.contains("carpeta"), "{err}");
    }

    #[tokio::test]
    async fn una_descarga_no_pisa_un_destino_existente_sin_permiso() {
        let dir = std::env::temp_dir().join(format!("rustty-exists-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("informe.pdf"), b"viejo").unwrap();

        let err = check_download_target(&dir.join("informe.pdf"), false)
            .await
            .expect_err("sin permiso no se pisa");
        assert!(err.starts_with(TRANSFER_EXISTS_MARKER), "{err}");
        assert!(err.contains("informe.pdf"), "{err}");
        assert_eq!(std::fs::read(dir.join("informe.pdf")).unwrap(), b"viejo", "no se tocó");
        check_download_target(&dir.join("informe.pdf"), true)
            .await
            .expect("con permiso explícito sí");
        check_download_target(&dir.join("nuevo.pdf"), false)
            .await
            .expect("si no existe no hay conflicto");
        let err = check_download_target(&dir.join("docs"), true)
            .await
            .expect_err("un fichero no sustituye a una carpeta");
        assert!(!err.contains(TRANSFER_EXISTS_MARKER) && err.contains("carpeta"), "{err}");
        #[cfg(unix)]
        {
            // Un enlace roto también ocupa el nombre: el rename lo pisaría.
            std::os::unix::fs::symlink(dir.join("no-existe"), dir.join("roto")).unwrap();
            let err = check_download_target(&dir.join("roto"), false)
                .await
                .expect_err("el enlace roto cuenta como existente");
            assert!(err.starts_with(TRANSFER_EXISTS_MARKER), "{err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn una_carpeta_no_vale_como_origen_de_una_transferencia_de_fichero() {
        check_file_source(false, "/x/a.txt").expect("un fichero sí");
        let err = check_file_source(true, "/x/carpeta").expect_err("una carpeta no");
        assert!(err.contains("/x/carpeta") && err.contains("carpeta"), "{err}");
    }

    #[test]
    fn los_marcadores_de_transferencia_siguen_espejados_en_el_frontend() {
        let mirror = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/modules/ipc/errors.js");
        let js = std::fs::read_to_string(&mirror).expect("espejo del frontend");
        for marker in [TRANSFER_EXISTS_MARKER, TRANSFER_CONNECTION_LOST_MARKER] {
            assert!(
                js.contains(&format!("\"{marker}\"")),
                "{} debe declarar el marcador {marker}",
                mirror.display()
            );
        }
    }

    /// Una IPv6 entre corchetes (como se escribe para SSH) vuelve a conectar por
    /// FTP: se resuelve sin los corchetes; un nombre o una IPv4 no cambian.
    #[test]
    fn el_host_ftp_se_resuelve_sin_los_corchetes_de_una_ipv6() {
        use std::net::ToSocketAddrs;
        assert_eq!(ftp_resolvable_host("[2001:db8::5]"), "2001:db8::5");
        assert_eq!(ftp_resolvable_host(" [::1] "), "::1");
        assert_eq!(ftp_resolvable_host("ftp.example"), "ftp.example");
        assert_eq!(ftp_resolvable_host("10.0.0.5"), "10.0.0.5");
        let addrs: Vec<_> = (ftp_resolvable_host("[::1]"), 21).to_socket_addrs().unwrap().collect();
        assert_eq!(addrs.len(), 1);
        assert!(addrs[0].is_ipv6());
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
