//! Portapapeles compartido de la sesión integrada (canal `CLIPRDR`): texto y
//! ficheros en los dos sentidos.
//!
//! IronRDP lleva el protocolo; aquí va lo que toca al sistema:
//!
//! - [`Proxy`] es el backend que IronRDP llama **dentro** de `ActiveStage::process`.
//!   No bloquea: convierte cada aviso en un [`ClipIn`] y lo manda al hilo del
//!   portapapeles.
//! - El hilo ([`Worker`]) es quien toca el portapapeles del sistema (`arboard`)
//!   y el disco. Responde con [`ClipOut`], que el bucle de la sesión aplica sobre
//!   el `CliprdrClient` y envía al servidor.
//!
//! **Local → remoto.** Al enfocar el escritorio (y antes de cada Ctrl+V) el
//! frontend pide sincronizar: si el portapapeles local cambió, se anuncia al
//! servidor (texto, o la lista de ficheros con sus carpetas). Los datos solo
//! viajan cuando el remoto pega: se leen del disco a trozos, a demanda.
//!
//! Si lo copiado en local parece sensible (una clave privada, algo de `~/.ssh`
//! o de la carpeta de datos), antes de anunciarlo se pregunta con un diálogo
//! **nativo** ([`UploadGate`]), igual que al subirlo por SFTP: un servidor puede
//! pedir los ficheros en cuanto se anuncian, sin esperar a que nadie pegue.
//!
//! **Remoto → local.** Cuando el remoto copia, el texto se escribe directamente
//! en el portapapeles local. Los ficheros **no** se descargan solos: se piden
//! sus nombres y tamaños, se ofrecen al usuario (aviso `files-offered`) y solo
//! se descargan si elige una carpeta en el diálogo nativo que abre el backend
//! (`rdp_embed_clipboard_save`). Nada se escribe en disco sin esa elección.
//!
//! Los nombres que llegan del servidor no son de fiar: IronRDP ya los sanea y
//! aquí, además, cada componente se valida antes de crear nada (sin `..`, sin
//! rutas absolutas, sin separadores, ni caracteres de control, ni nombres
//! reservados de Windows), todo queda dentro de la carpeta elegida, nunca se
//! sobrescribe nada que ya existiera (un nombre ocupado se guarda como
//! «nombre (2)») y la copia entera tiene un tope de tamaño y de entradas.

use std::collections::HashMap;
use std::fs::File;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc as std_mpsc, Arc};
use std::time::{Duration, Instant, UNIX_EPOCH};

use ironrdp_cliprdr::backend::CliprdrBackend;
use ironrdp_cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardFormatName,
    ClipboardGeneralCapabilityFlags, FileContentsFlags, FileContentsRequest, FileContentsResponse,
    FileDescriptor, FormatDataRequest, FormatDataResponse, LockDataId, OwnedFormatDataResponse,
};
use ironrdp_cliprdr::{CliprdrClient, MAX_LOCKED_FILE_LISTS};
use serde::Serialize;
use tokio::sync::mpsc;

/// Trozo de cada petición de descarga. Windows sirve sin problema 1 MiB.
const DOWNLOAD_CHUNK: u32 = 1024 * 1024;
/// Máximo que se sirve en una respuesta de subida, pida lo que pida el servidor.
const UPLOAD_CHUNK_MAX: u32 = 4 * 1024 * 1024;
/// Tope de una descarga (suma de los ficheros copiados en el remoto).
const MAX_DOWNLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Tope de entradas (ficheros + carpetas) de una copia del remoto.
const MAX_REMOTE_ENTRIES: usize = 20_000;
/// Tope de niveles (componentes de la ruta) de una entrada del remoto.
const MAX_REMOTE_DEPTH: usize = 32;
/// Intentos de «nombre (n)» antes de rendirse con un nombre ocupado.
const MAX_NAME_SUFFIX: u32 = 999;
/// Tope de entradas al anunciar carpetas locales (ficheros + subcarpetas).
const MAX_LOCAL_ENTRIES: usize = 20_000;
/// Profundidad máxima al recorrer carpetas locales.
const MAX_LOCAL_DEPTH: usize = 32;
/// Longitud máxima del nombre en el cable (`relative_path\name`), en caracteres.
const MAX_WIRE_NAME: usize = 259;
/// Cada cuánto, como mucho, se avisa del progreso de una descarga.
const PROGRESS_EVERY: Duration = Duration::from_millis(400);
/// Segundos entre 1601-01-01 (FILETIME) y 1970-01-01.
const FILETIME_UNIX_OFFSET: u64 = 11_644_473_600;

/// Qué se comparte por el portapapeles.
#[derive(Debug, Clone, Copy)]
pub struct ClipboardOptions {
    /// También ficheros (si no, solo texto).
    pub files: bool,
}

/// Avisos del hilo al hilo del bucle de la sesión.
#[derive(Debug)]
pub enum ClipOut {
    InitiateCopy(Vec<ClipboardFormat>),
    InitiateFileCopy(Vec<FileDescriptor>),
    InitiatePaste(ClipboardFormatId),
    FormatData(OwnedFormatDataResponse),
    FileContents(FileContentsResponse<'static>),
    RequestFileContents(FileContentsRequest),
}

/// Entradas del hilo del portapapeles.
#[derive(Debug)]
pub enum ClipIn {
    /// El canal está listo, o el servidor pide nuestra lista de formatos.
    Announce,
    /// El frontend pide comparar el portapapeles local con lo último anunciado.
    Sync,
    Capabilities(ClipboardGeneralCapabilityFlags),
    RemoteCopy(Vec<ClipboardFormat>),
    FormatDataRequest(ClipboardFormatId),
    FormatDataResponse {
        ok: bool,
        data: Vec<u8>,
    },
    RemoteFileList(Vec<FileDescriptor>, Option<u32>),
    FileContentsRequest(FileContentsRequest),
    FileContentsResponse {
        stream_id: u32,
        ok: bool,
        data: Vec<u8>,
    },
    Lock(u32),
    Unlock(u32),
    /// El usuario eligió dónde guardar los ficheros de la oferta `offer`.
    SaveTo {
        offer: u32,
        dest: PathBuf,
    },
    /// El usuario cancela la descarga en curso.
    CancelDownload,
    Shutdown,
}

/// Aviso al frontend (`rdp-embed-clip-{id}`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipNotice {
    /// `files-offered` | `files-withheld` | `download-start` |
    /// `download-progress` | `download-done` | `download-error` | `unavailable`.
    pub kind: &'static str,
    /// Con `files-offered`: id de la oferta, que vuelve en
    /// `rdp_embed_clipboard_save` (una oferta vieja ya no vale).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offer: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Con `download-done`: la carpeta donde quedaron.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

impl ClipNotice {
    fn new(kind: &'static str) -> Self {
        Self {
            kind,
            offer: None,
            files: None,
            bytes: None,
            total: None,
            reason: None,
            folder: None,
        }
    }
}

pub trait ClipNotifier: Send + Sync {
    fn notice(&self, notice: ClipNotice);
}

/// Decide si se pueden anunciar al remoto unos ficheros copiados en local.
/// Puede preguntar al usuario: bloquea el hilo del portapapeles, no la sesión.
pub trait UploadGate: Send + Sync {
    /// `true` = se pueden anunciar. `paths` son las rutas copiadas (las de
    /// primer nivel: el recorrido de las carpetas viene después).
    fn allow(&self, paths: &[PathBuf]) -> bool;
}

// ─── Backend de IronRDP ──────────────────────────────────────────────────────

/// Backend `CLIPRDR`: solo reenvía al hilo del portapapeles.
#[derive(Debug)]
struct Proxy {
    tx: std_mpsc::Sender<ClipIn>,
    files: bool,
    temp_dir: String,
}

ironrdp_core::impl_as_any!(Proxy);

impl Proxy {
    fn send(&self, msg: ClipIn) {
        let _ = self.tx.send(msg);
    }
}

impl CliprdrBackend for Proxy {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        if self.files {
            ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
                | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
                | ClipboardGeneralCapabilityFlags::CAN_LOCK_CLIPDATA
                | ClipboardGeneralCapabilityFlags::HUGE_FILE_SUPPORT_ENABLED
        } else {
            ClipboardGeneralCapabilityFlags::empty()
        }
    }

    fn on_ready(&mut self) {
        self.send(ClipIn::Announce);
    }

    fn on_request_format_list(&mut self) {
        self.send(ClipIn::Announce);
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        self.send(ClipIn::Capabilities(capabilities));
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        self.send(ClipIn::RemoteCopy(available_formats.to_vec()));
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        self.send(ClipIn::FormatDataRequest(request.format));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        self.send(ClipIn::FormatDataResponse {
            ok: !response.is_error(),
            data: response.data().to_vec(),
        });
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        self.send(ClipIn::FileContentsRequest(request));
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        self.send(ClipIn::FileContentsResponse {
            stream_id: response.stream_id(),
            ok: !response.is_error(),
            data: response.data().to_vec(),
        });
    }

    fn on_lock(&mut self, data_id: LockDataId) {
        self.send(ClipIn::Lock(data_id.0));
    }

    fn on_unlock(&mut self, data_id: LockDataId) {
        self.send(ClipIn::Unlock(data_id.0));
    }

    fn on_remote_file_list(&mut self, files: &[FileDescriptor], clip_data_id: Option<u32>) {
        self.send(ClipIn::RemoteFileList(files.to_vec(), clip_data_id));
    }
}

/// Extremo de la sesión: el canal para IronRDP y las colas del hilo.
pub struct ClipboardChannel {
    /// Para `Sync` (y `Shutdown` al soltarlo).
    pub input: std_mpsc::Sender<ClipIn>,
    /// Lo que el bucle de la sesión aplica sobre el `CliprdrClient`.
    pub output: mpsc::UnboundedReceiver<ClipOut>,
}

impl Drop for ClipboardChannel {
    fn drop(&mut self) {
        let _ = self.input.send(ClipIn::Shutdown);
    }
}

/// Crea el canal `CLIPRDR` y arranca su hilo.
pub fn start(
    options: ClipboardOptions,
    notifier: Arc<dyn ClipNotifier>,
    gate: Arc<dyn UploadGate>,
) -> (CliprdrClient, ClipboardChannel) {
    let (in_tx, in_rx) = std_mpsc::channel();
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let proxy = Proxy {
        tx: in_tx.clone(),
        files: options.files,
        temp_dir: std::env::temp_dir().to_string_lossy().into_owned(),
    };
    let worker = Worker::new(options, out_tx, notifier, gate);
    let spawned = std::thread::Builder::new()
        .name("rdp-clipboard".into())
        .spawn(move || worker.run(&in_rx));
    if let Err(e) = spawned {
        log::warn!("RDP integrado: no se pudo arrancar el hilo del portapapeles: {e}");
    }
    (
        CliprdrClient::new(Box::new(proxy)),
        ClipboardChannel {
            input: in_tx,
            output: out_rx,
        },
    )
}

/// Aplica una orden del hilo sobre el canal y devuelve los mensajes a enviar.
pub fn apply(
    cliprdr: &mut CliprdrClient,
    out: ClipOut,
) -> ironrdp_pdu::PduResult<ironrdp_cliprdr::CliprdrSvcMessages<ironrdp_cliprdr::Client>> {
    match out {
        ClipOut::InitiateCopy(formats) => cliprdr.initiate_copy(&formats),
        ClipOut::InitiateFileCopy(files) => cliprdr.initiate_file_copy(files),
        ClipOut::InitiatePaste(format) => cliprdr.initiate_paste(format),
        ClipOut::FormatData(response) => cliprdr.submit_format_data(response),
        ClipOut::FileContents(response) => cliprdr.submit_file_contents(response),
        ClipOut::RequestFileContents(request) => cliprdr.request_file_contents(request),
    }
}

// ─── Hilo del portapapeles ───────────────────────────────────────────────────

/// Huella de lo último anunciado o escrito, para no anunciar dos veces lo mismo
/// (y no devolver al remoto lo que acaba de copiar él).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Fingerprint {
    Text(u64),
    Files(Vec<PathBuf>),
}

fn text_fingerprint(text: &str) -> Fingerprint {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    Fingerprint::Text(h.finish())
}

/// Una entrada de la lista local anunciada, alineada por índice con la lista
/// de `FileDescriptor` enviada.
#[derive(Debug)]
struct LocalEntry {
    path: PathBuf,
    dir: bool,
}

/// Lo que el remoto espera del texto pedido.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingPaste {
    None,
    Text,
}

/// Una entrada de la descarga, ya con su ruta definitiva.
struct DlItem {
    index: i32,
    path: PathBuf,
    size: Option<u64>,
    dir: bool,
    /// Entrada de primer nivel: se crea sin `create_dir_all` (nunca dentro de
    /// algo que ya existía) y se apunta para poder deshacerla.
    top: bool,
}

/// Ficheros copiados en el remoto, a la espera de que el usuario elija dónde
/// guardarlos.
struct Offer {
    id: u32,
    plan: DownloadPlan,
    lock: Option<u32>,
}

struct Download {
    dest: PathBuf,
    items: Vec<DlItem>,
    /// Lo que esta descarga ha creado en la carpeta elegida (ruta, es carpeta):
    /// lo único que se borra si falla o se cancela.
    created: Vec<(PathBuf, bool)>,
    cur: usize,
    file: Option<File>,
    pos: u64,
    /// `stream_id` de la petición en vuelo.
    waiting: Option<u32>,
    lock: Option<u32>,
    total: u64,
    done: u64,
    files: usize,
    last_notice: Instant,
}

impl Download {
    /// Borra lo creado por esta descarga (nada que ya estuviera allí).
    fn undo(&mut self) {
        self.file = None;
        for (path, dir) in self.created.drain(..).rev() {
            let _ = if dir {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

struct Worker {
    options: ClipboardOptions,
    out: mpsc::UnboundedSender<ClipOut>,
    notifier: Arc<dyn ClipNotifier>,
    gate: Arc<dyn UploadGate>,
    clipboard: Option<arboard::Clipboard>,
    files_negotiated: bool,
    last: Option<Fingerprint>,
    local_text: Option<String>,
    local_files: Arc<Vec<LocalEntry>>,
    locked: HashMap<u32, Arc<Vec<LocalEntry>>>,
    /// Fichero abierto para servir la subida en curso (índice, lista, fichero).
    reader: Option<(usize, usize, File)>,
    pending: PendingPaste,
    offer: Option<Offer>,
    offer_seq: u32,
    download: Option<Download>,
    next_stream: u32,
}

impl Worker {
    fn new(
        options: ClipboardOptions,
        out: mpsc::UnboundedSender<ClipOut>,
        notifier: Arc<dyn ClipNotifier>,
        gate: Arc<dyn UploadGate>,
    ) -> Self {
        Self {
            options,
            out,
            notifier,
            gate,
            clipboard: None,
            files_negotiated: false,
            last: None,
            local_text: None,
            local_files: Arc::new(Vec::new()),
            locked: HashMap::new(),
            reader: None,
            pending: PendingPaste::None,
            offer: None,
            offer_seq: 0,
            download: None,
            next_stream: 1,
        }
    }

    fn run(mut self, rx: &std_mpsc::Receiver<ClipIn>) {
        match arboard::Clipboard::new() {
            Ok(c) => self.clipboard = Some(c),
            Err(e) => {
                log::warn!("RDP integrado: portapapeles del sistema no disponible: {e}");
                let mut n = ClipNotice::new("unavailable");
                n.reason = Some(e.to_string());
                self.notifier.notice(n);
            }
        }
        while let Ok(msg) = rx.recv() {
            match msg {
                ClipIn::Shutdown => break,
                ClipIn::Announce => self.sync(true),
                ClipIn::Sync => self.sync(false),
                ClipIn::Capabilities(flags) => {
                    self.files_negotiated = self.options.files
                        && flags.contains(ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED);
                }
                ClipIn::RemoteCopy(formats) => self.on_remote_copy(&formats),
                ClipIn::FormatDataRequest(format) => self.on_format_data_request(format),
                ClipIn::FormatDataResponse { ok, data } => self.on_format_data_response(ok, &data),
                ClipIn::RemoteFileList(files, lock) => self.on_remote_file_list(&files, lock),
                ClipIn::FileContentsRequest(req) => self.on_file_contents_request(&req),
                ClipIn::FileContentsResponse {
                    stream_id,
                    ok,
                    data,
                } => self.on_file_contents_response(stream_id, ok, &data),
                ClipIn::Lock(id) => {
                    if self.locked.len() < MAX_LOCKED_FILE_LISTS {
                        self.locked.insert(id, Arc::clone(&self.local_files));
                    }
                }
                ClipIn::Unlock(id) => {
                    self.locked.remove(&id);
                }
                ClipIn::SaveTo { offer, dest } => self.save_to(offer, dest),
                ClipIn::CancelDownload => {
                    if self.download.is_some() {
                        self.fail_download("cancelled".into());
                    }
                }
            }
        }
        // Una descarga a medias no sirve para nada: se deshace lo que creó.
        if let Some(mut dl) = self.download.take() {
            dl.undo();
        }
    }

    fn emit(&self, out: ClipOut) {
        let _ = self.out.send(out);
    }

    // ── Local → remoto ──

    /// Compara el portapapeles local con lo último anunciado y, si cambió, lo
    /// anuncia. `force`: el servidor espera una lista sí o sí (aunque sea vacía).
    fn sync(&mut self, force: bool) {
        let Some(clipboard) = self.clipboard.as_mut() else {
            if force {
                self.emit(ClipOut::InitiateCopy(Vec::new()));
            }
            return;
        };

        if self.files_negotiated {
            if let Ok(paths) = clipboard.get().file_list() {
                if !paths.is_empty() {
                    let fp = Fingerprint::Files(paths.clone());
                    if !force && self.last.as_ref() == Some(&fp) {
                        return;
                    }
                    // Algo sensible y el usuario no lo confirma: no se anuncia
                    // nada (tampoco lo anterior, que el remoto seguiría
                    // ofreciendo) y no se vuelve a preguntar hasta que cambie.
                    if self.last.as_ref() != Some(&fp) && !self.gate.allow(&paths) {
                        self.last = Some(fp);
                        self.withhold();
                        return;
                    }
                    let (descriptors, entries) = collect_local_files(&paths);
                    if !descriptors.is_empty() {
                        self.last = Some(fp);
                        self.local_text = None;
                        self.local_files = Arc::new(entries);
                        self.reader = None;
                        self.emit(ClipOut::InitiateFileCopy(descriptors));
                        return;
                    }
                }
            }
        }

        let Some(clipboard) = self.clipboard.as_mut() else {
            return;
        };
        match clipboard.get().text() {
            Ok(text) if !text.is_empty() => {
                let fp = text_fingerprint(&text);
                if !force && self.last.as_ref() == Some(&fp) {
                    return;
                }
                self.last = Some(fp);
                self.local_text = Some(text);
                self.emit(ClipOut::InitiateCopy(vec![ClipboardFormat::new(
                    ClipboardFormatId::CF_UNICODETEXT,
                )]));
            }
            _ => {
                if force {
                    self.emit(ClipOut::InitiateCopy(Vec::new()));
                }
            }
        }
    }

    /// Retira lo anunciado y avisa de que los ficheros se quedan en local.
    fn withhold(&mut self) {
        self.local_text = None;
        self.local_files = Arc::new(Vec::new());
        self.reader = None;
        self.emit(ClipOut::InitiateCopy(Vec::new()));
        self.notifier.notice(ClipNotice::new("files-withheld"));
    }

    fn on_format_data_request(&mut self, format: ClipboardFormatId) {
        let response = match (&self.local_text, format) {
            (Some(text), ClipboardFormatId::CF_UNICODETEXT) => {
                OwnedFormatDataResponse::new_unicode_string(text)
            }
            _ => OwnedFormatDataResponse::new_error(),
        };
        self.emit(ClipOut::FormatData(response));
    }

    fn on_file_contents_request(&mut self, req: &FileContentsRequest) {
        let entries = match req.data_id.and_then(|id| self.locked.get(&id)) {
            Some(list) => Arc::clone(list),
            None => Arc::clone(&self.local_files),
        };
        let response = serve_file_contents(&entries, req, &mut self.reader)
            .unwrap_or_else(|| FileContentsResponse::new_error(req.stream_id));
        self.emit(ClipOut::FileContents(response));
    }

    // ── Remoto → local ──

    fn on_remote_copy(&mut self, formats: &[ClipboardFormat]) {
        let file_list = formats.iter().find(|f| {
            f.name()
                .is_some_and(|n| n.value() == ClipboardFormatName::FILE_LIST.value())
        });
        if let (true, Some(fmt)) = (self.files_negotiated, file_list) {
            self.pending = PendingPaste::None;
            self.emit(ClipOut::InitiatePaste(fmt.id()));
            return;
        }
        if formats
            .iter()
            .any(|f| f.id() == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.pending = PendingPaste::Text;
            self.emit(ClipOut::InitiatePaste(ClipboardFormatId::CF_UNICODETEXT));
        }
    }

    fn on_format_data_response(&mut self, ok: bool, data: &[u8]) {
        if self.pending != PendingPaste::Text {
            return;
        }
        self.pending = PendingPaste::None;
        if !ok {
            return;
        }
        let text = decode_utf16z(data);
        let Some(clipboard) = self.clipboard.as_mut() else {
            return;
        };
        if clipboard.set().text(text.clone()).is_ok() {
            self.last = Some(text_fingerprint(&text));
            // Lo que hay ahora en el portapapeles local es del remoto: no se
            // vuelve a servir como si fuera nuestro.
            self.local_text = None;
        }
    }

    /// El remoto copió ficheros: se ofrecen al usuario. No se crea nada en disco
    /// hasta que elija carpeta. Una copia nueva sustituye a la oferta anterior
    /// (no a una descarga ya en marcha, que sigue con su lista bloqueada).
    fn on_remote_file_list(&mut self, files: &[FileDescriptor], lock: Option<u32>) {
        self.offer = None;
        let plan = match plan_download(files) {
            Ok(plan) => plan,
            Err(reason) => {
                self.notice_error(reason);
                return;
            }
        };
        if plan.total > MAX_DOWNLOAD_BYTES {
            self.notice_error("too-large");
            return;
        }
        self.offer_seq = self.offer_seq.wrapping_add(1).max(1);
        let mut n = ClipNotice::new("files-offered");
        n.offer = Some(self.offer_seq);
        n.files = Some(plan.files);
        n.total = Some(plan.total);
        self.notifier.notice(n);
        self.offer = Some(Offer {
            id: self.offer_seq,
            plan,
            lock,
        });
    }

    /// El usuario eligió `dest` (ya validada por el comando) para la oferta `id`.
    fn save_to(&mut self, id: u32, dest: PathBuf) {
        if self.download.is_some() {
            self.notice_error("busy");
            return;
        }
        let Some(offer) = self.offer.take_if(|o| o.id == id) else {
            self.notice_error("expired");
            return;
        };
        let (items, top_dirs) = place_plan(&offer.plan, &dest);
        let mut dl = Download {
            items,
            dest,
            created: Vec::new(),
            cur: 0,
            file: None,
            pos: 0,
            waiting: None,
            lock: offer.lock,
            total: offer.plan.total,
            done: 0,
            files: offer.plan.files,
            last_notice: Instant::now(),
        };
        // Las carpetas de primer nivel, antes que nada: lo que va dentro se
        // crea ya bajo algo nuestro.
        for dir in top_dirs {
            if let Err(e) = std::fs::create_dir(&dir) {
                dl.undo();
                self.notice_error(e.to_string());
                return;
            }
            dl.created.push((dir, true));
        }
        let mut n = ClipNotice::new("download-start");
        n.files = Some(dl.files);
        n.total = Some(dl.total);
        self.notifier.notice(n);
        self.download = Some(dl);
        self.advance_download();
    }

    fn notice_error(&self, reason: impl Into<String>) {
        let mut n = ClipNotice::new("download-error");
        n.reason = Some(reason.into());
        self.notifier.notice(n);
    }

    fn fail_download(&mut self, reason: String) {
        if let Some(mut dl) = self.download.take() {
            dl.undo();
        }
        self.notice_error(reason);
    }

    fn stream_id(&mut self) -> u32 {
        let id = self.next_stream;
        self.next_stream = self.next_stream.wrapping_add(1).max(1);
        id
    }

    /// Pide el siguiente trozo, o pasa al siguiente fichero, o termina.
    fn advance_download(&mut self) {
        loop {
            let stream_id = self.stream_id();
            let Some(dl) = self.download.as_mut() else {
                return;
            };
            let Some(item) = dl.items.get(dl.cur) else {
                self.finish_download();
                return;
            };
            if item.dir {
                if !item.top {
                    if let Err(e) = std::fs::create_dir_all(&item.path) {
                        let reason = e.to_string();
                        self.fail_download(reason);
                        return;
                    }
                }
                dl.cur += 1;
                continue;
            }
            if dl.file.is_none() {
                let opened = open_target(item);
                match opened {
                    Ok(f) => {
                        if item.top {
                            dl.created.push((item.path.clone(), false));
                        }
                        dl.file = Some(f);
                    }
                    Err(e) => {
                        let reason = e.to_string();
                        self.fail_download(reason);
                        return;
                    }
                }
                dl.pos = 0;
            }
            let request = match item.size {
                None => FileContentsRequest {
                    stream_id,
                    index: item.index,
                    flags: FileContentsFlags::SIZE,
                    position: 0,
                    requested_size: 8,
                    data_id: dl.lock,
                },
                Some(size) if dl.pos >= size => {
                    dl.file = None;
                    dl.cur += 1;
                    continue;
                }
                Some(size) => FileContentsRequest {
                    stream_id,
                    index: item.index,
                    flags: FileContentsFlags::RANGE,
                    position: dl.pos,
                    requested_size: u32::try_from((size - dl.pos).min(u64::from(DOWNLOAD_CHUNK)))
                        .unwrap_or(DOWNLOAD_CHUNK),
                    data_id: dl.lock,
                },
            };
            dl.waiting = Some(stream_id);
            self.emit(ClipOut::RequestFileContents(request));
            return;
        }
    }

    fn on_file_contents_response(&mut self, stream_id: u32, ok: bool, data: &[u8]) {
        let Some(dl) = self.download.as_mut() else {
            return;
        };
        if dl.waiting != Some(stream_id) {
            return;
        }
        dl.waiting = None;
        if !ok {
            self.fail_download("remote".into());
            return;
        }
        let Some(item) = dl.items.get_mut(dl.cur) else {
            return;
        };
        match item.size {
            None => {
                let size = data
                    .get(..8)
                    .and_then(|b| <[u8; 8]>::try_from(b).ok())
                    .map_or(0, u64::from_le_bytes);
                item.size = Some(size);
                dl.total = dl.total.saturating_add(size);
                if dl.total > MAX_DOWNLOAD_BYTES {
                    self.fail_download("too-large".into());
                    return;
                }
            }
            Some(size) => {
                if data.is_empty() {
                    // Sin avance no hay final: el fichero cambió en el remoto.
                    self.fail_download("short-read".into());
                    return;
                }
                let take = usize::try_from((size - dl.pos).min(data.len() as u64)).unwrap_or(0);
                let write = dl
                    .file
                    .as_mut()
                    .map_or(Ok(()), |f| f.write_all(&data[..take]));
                if let Err(e) = write {
                    let reason = e.to_string();
                    self.fail_download(reason);
                    return;
                }
                dl.pos += take as u64;
                dl.done += take as u64;
                if dl.last_notice.elapsed() >= PROGRESS_EVERY {
                    dl.last_notice = Instant::now();
                    let mut n = ClipNotice::new("download-progress");
                    n.bytes = Some(dl.done);
                    n.total = Some(dl.total);
                    self.notifier.notice(n);
                }
            }
        }
        self.advance_download();
    }

    fn finish_download(&mut self) {
        let Some(mut dl) = self.download.take() else {
            return;
        };
        dl.file = None;
        let mut n = ClipNotice::new("download-done");
        n.files = Some(dl.files);
        n.bytes = Some(dl.done);
        n.folder = Some(dl.dest.to_string_lossy().into_owned());
        self.notifier.notice(n);
    }
}

/// Abre el fichero de destino de una entrada: **nuevo** siempre (falla si ya
/// hay algo, también un enlace simbólico). Las carpetas intermedias de una
/// entrada anidada se crean dentro de la de primer nivel, que es nuestra.
fn open_target(item: &DlItem) -> std::io::Result<File> {
    if !item.top {
        if let Some(parent) = item.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&item.path)
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

/// Texto UTF-16LE terminado (o no) en NUL.
fn decode_utf16z(data: &[u8]) -> String {
    let units: Vec<u16> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .take_while(|&u| u != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

fn filetime(meta: &std::fs::Metadata) -> Option<u64> {
    let secs = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .unwrap_or_default();
    let ft_secs = secs.as_secs().checked_add(FILETIME_UNIX_OFFSET)?;
    ft_secs
        .checked_mul(10_000_000)?
        .checked_add(u64::from(secs.subsec_nanos() / 100))
}

/// Recorre lo copiado en local (ficheros y carpetas, en preorden) y devuelve la
/// lista para el servidor y, alineadas por índice, las rutas locales.
///
/// Lo que el protocolo no puede representar (nombres demasiado largos) o no
/// conviene seguir (enlaces simbólicos) se salta: así IronRDP no descarta nada
/// por su cuenta y los índices siguen alineados.
fn collect_local_files(paths: &[PathBuf]) -> (Vec<FileDescriptor>, Vec<LocalEntry>) {
    let mut descriptors = Vec::new();
    let mut entries = Vec::new();
    for path in paths {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        walk(path, &name, None, 0, &mut descriptors, &mut entries);
    }
    (descriptors, entries)
}

fn walk(
    path: &Path,
    name: &str,
    relative: Option<&str>,
    depth: usize,
    descriptors: &mut Vec<FileDescriptor>,
    entries: &mut Vec<LocalEntry>,
) {
    if entries.len() >= MAX_LOCAL_ENTRIES || depth > MAX_LOCAL_DEPTH {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() || name.is_empty() {
        return;
    }
    let wire = match relative {
        Some(r) => format!("{r}\\{name}"),
        None => name.to_string(),
    };
    if wire.chars().count() > MAX_WIRE_NAME {
        return;
    }
    let mut descriptor = FileDescriptor::new(name);
    if let Some(r) = relative {
        descriptor = descriptor.with_relative_path(r);
    }
    if let Some(t) = filetime(&meta) {
        descriptor = descriptor.with_last_write_time(t);
    }
    if meta.is_dir() {
        descriptors.push(descriptor.with_attributes(ClipboardFileAttributes::DIRECTORY));
        entries.push(LocalEntry {
            path: path.to_path_buf(),
            dir: true,
        });
        let Ok(read) = std::fs::read_dir(path) else {
            return;
        };
        let mut children: Vec<_> = read.filter_map(Result::ok).collect();
        children.sort_by_key(std::fs::DirEntry::file_name);
        for child in children {
            let child_name = child.file_name().to_string_lossy().into_owned();
            walk(
                &child.path(),
                &child_name,
                Some(&wire),
                depth + 1,
                descriptors,
                entries,
            );
        }
    } else if meta.is_file() {
        descriptors.push(
            descriptor
                .with_attributes(ClipboardFileAttributes::ARCHIVE)
                .with_file_size(meta.len()),
        );
        entries.push(LocalEntry {
            path: path.to_path_buf(),
            dir: false,
        });
    }
}

/// Responde a una petición del servidor sobre un fichero anunciado.
fn serve_file_contents(
    entries: &Arc<Vec<LocalEntry>>,
    req: &FileContentsRequest,
    reader: &mut Option<(usize, usize, File)>,
) -> Option<FileContentsResponse<'static>> {
    let index = usize::try_from(req.index).ok()?;
    let entry = entries.get(index)?;
    if entry.dir {
        return None;
    }
    if req.flags.contains(FileContentsFlags::SIZE) {
        let len = std::fs::metadata(&entry.path).ok()?.len();
        return Some(FileContentsResponse::new_size_response(req.stream_id, len));
    }
    // El fichero se mantiene abierto entre trozos consecutivos del mismo.
    let list_id = Arc::as_ptr(entries) as usize;
    let reuse = matches!(reader, Some((i, l, _)) if *i == index && *l == list_id);
    if !reuse {
        *reader = Some((index, list_id, File::open(&entry.path).ok()?));
    }
    let (_, _, file) = reader.as_mut()?;
    file.seek(SeekFrom::Start(req.position)).ok()?;
    let want = req.requested_size.min(UPLOAD_CHUNK_MAX) as usize;
    let mut buf = Vec::with_capacity(want);
    file.take(want as u64).read_to_end(&mut buf).ok()?;
    Some(FileContentsResponse::new_data_response(req.stream_id, buf))
}

/// Entrada validada de la copia del remoto, relativa a la carpeta de destino.
struct PlanItem {
    index: i32,
    /// Componentes de la ruta; el primero es el de primer nivel.
    parts: Vec<String>,
    size: Option<u64>,
    dir: bool,
}

/// La copia del remoto, validada entera antes de ofrecerla.
struct DownloadPlan {
    items: Vec<PlanItem>,
    /// Suma de los tamaños conocidos (los que faltan se piden al descargar).
    total: u64,
    files: usize,
    /// Nombres de primer nivel en orden, con si son carpeta.
    tops: Vec<(String, bool)>,
}

/// Caracteres que no valen en un nombre en ninguno de los sistemas donde
/// corre Rustty (los de Windows son los más restrictivos).
const FORBIDDEN_NAME_CHARS: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Un componente de ruta que llega del servidor y se puede crear sin salir de
/// la carpeta de destino ni toparse con un nombre reservado.
fn safe_component(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= 255
        && c != "."
        && c != ".."
        && !c.contains(FORBIDDEN_NAME_CHARS)
        && !c.chars().any(char::is_control)
        && !c.ends_with(['.', ' '])
        && !ironrdp_cliprdr::is_windows_device_name(c)
}

/// Valida la lista remota entera. Falla si un nombre no es seguro, si dos
/// entradas de primer nivel chocan (sin distinguir mayúsculas, como en Windows
/// y macOS) o si pasa de los topes: mejor no copiar nada que copiar a medias.
fn plan_download(files: &[FileDescriptor]) -> Result<DownloadPlan, &'static str> {
    if files.len() > MAX_REMOTE_ENTRIES {
        return Err("too-many");
    }
    let mut items = Vec::with_capacity(files.len());
    let mut total = 0u64;
    let mut count = 0usize;
    let mut tops: Vec<(String, bool)> = Vec::new();
    for (index, fd) in files.iter().enumerate() {
        let mut parts = Vec::new();
        if let Some(rel) = fd.relative_path.as_deref().filter(|r| !r.is_empty()) {
            for c in rel.split('\\') {
                if !safe_component(c) {
                    return Err("unsafe-name");
                }
                parts.push(c.to_string());
            }
        }
        if !safe_component(&fd.name) {
            return Err("unsafe-name");
        }
        parts.push(fd.name.clone());
        if parts.len() > MAX_REMOTE_DEPTH {
            return Err("too-deep");
        }
        let dir = fd
            .attributes
            .is_some_and(|a| a.contains(ClipboardFileAttributes::DIRECTORY));
        let top_is_dir = dir || parts.len() > 1;
        let top_key = parts[0].to_lowercase();
        match tops.iter().find(|(name, _)| name.to_lowercase() == top_key) {
            // La carpeta y lo que lleva dentro comparten el primer nivel.
            Some((_, true)) if top_is_dir => {}
            Some(_) => return Err("duplicate-name"),
            None => tops.push((parts[0].clone(), top_is_dir)),
        }
        let size = if dir { Some(0) } else { fd.file_size };
        total = total.saturating_add(size.unwrap_or(0));
        if !dir {
            count += 1;
        }
        items.push(PlanItem {
            index: i32::try_from(index).map_err(|_| "too-many")?,
            parts,
            size,
            dir,
        });
    }
    if tops.is_empty() {
        return Err("empty");
    }
    Ok(DownloadPlan {
        items,
        total,
        files: count,
        tops,
    })
}

fn name_taken(dest: &Path, name: &str, taken: &[String]) -> bool {
    taken.contains(&name.to_lowercase()) || std::fs::symlink_metadata(dest.join(name)).is_ok()
}

/// Nombre libre en `dest` para una entrada de primer nivel: el suyo, o
/// «nombre (2).ext», «nombre (3).ext»… Lo que ya existe no se pisa nunca.
fn unique_name(dest: &Path, name: &str, is_dir: bool, taken: &[String]) -> String {
    if !name_taken(dest, name, taken) {
        return name.to_string();
    }
    let (stem, ext) = match (is_dir, name.rsplit_once('.')) {
        (false, Some((stem, ext))) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    for n in 2..=MAX_NAME_SUFFIX {
        let candidate = format!("{stem} ({n}){ext}");
        if !name_taken(dest, &candidate, taken) {
            return candidate;
        }
    }
    // Sin hueco: el nombre original, que al crearlo fallará sin pisar nada.
    name.to_string()
}

/// Traduce el plan a rutas bajo `dest`, con los nombres de primer nivel ya
/// libres. Devuelve las entradas y las carpetas de primer nivel a crear.
fn place_plan(plan: &DownloadPlan, dest: &Path) -> (Vec<DlItem>, Vec<PathBuf>) {
    let mut taken: Vec<String> = Vec::new();
    let mut chosen: Vec<(String, String)> = Vec::new();
    let mut top_dirs = Vec::new();
    for (name, is_dir) in &plan.tops {
        let free = unique_name(dest, name, *is_dir, &taken);
        taken.push(free.to_lowercase());
        if *is_dir {
            top_dirs.push(dest.join(&free));
        }
        chosen.push((name.to_lowercase(), free));
    }
    let items = plan
        .items
        .iter()
        .map(|item| {
            let key = item.parts[0].to_lowercase();
            let top = chosen
                .iter()
                .find(|(k, _)| *k == key)
                .map_or(item.parts[0].as_str(), |(_, free)| free.as_str());
            let mut path = dest.join(top);
            for part in &item.parts[1..] {
                path.push(part);
            }
            DlItem {
                index: item.index,
                path,
                size: item.size,
                dir: item.dir,
                top: item.parts.len() == 1,
            }
        })
        .collect();
    (items, top_dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rustty-clip-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[derive(Default)]
    struct Notices(Mutex<Vec<ClipNotice>>);
    impl ClipNotifier for Notices {
        fn notice(&self, notice: ClipNotice) {
            self.0.lock().unwrap().push(notice);
        }
    }
    impl Notices {
        fn kinds(&self) -> Vec<&'static str> {
            self.0.lock().unwrap().iter().map(|n| n.kind).collect()
        }
        fn last(&self) -> ClipNotice {
            self.0.lock().unwrap().last().cloned().unwrap()
        }
    }

    struct Allow;
    impl UploadGate for Allow {
        fn allow(&self, _: &[PathBuf]) -> bool {
            true
        }
    }

    fn worker() -> (Worker, mpsc::UnboundedReceiver<ClipOut>, Arc<Notices>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let notices = Arc::new(Notices::default());
        let mut w = Worker::new(
            ClipboardOptions { files: true },
            tx,
            notices.clone(),
            Arc::new(Allow),
        );
        w.files_negotiated = true;
        (w, rx, notices)
    }

    /// Responde las peticiones de contenido del worker con `content` de cada
    /// índice hasta que deja de pedir.
    fn serve(w: &mut Worker, rx: &mut mpsc::UnboundedReceiver<ClipOut>, content: &[&[u8]]) {
        while let Ok(out) = rx.try_recv() {
            let ClipOut::RequestFileContents(req) = out else {
                continue;
            };
            let data = content[usize::try_from(req.index).unwrap()];
            let body = if req.flags.contains(FileContentsFlags::SIZE) {
                (data.len() as u64).to_le_bytes().to_vec()
            } else {
                let from = usize::try_from(req.position).unwrap();
                let to = (from + req.requested_size as usize).min(data.len());
                data[from..to].to_vec()
            };
            w.on_file_contents_response(req.stream_id, true, &body);
        }
    }

    #[test]
    fn texto_utf16_hasta_el_nul() {
        let mut data: Vec<u8> = "hola ñ".encode_utf16().flat_map(u16::to_le_bytes).collect();
        data.extend([0, 0, b'x', 0]);
        assert_eq!(decode_utf16z(&data), "hola ñ");
    }

    #[test]
    fn componentes_inseguros_rechazados() {
        for bad in [
            "", ".", "..", "a/b", "a\\b", "C:", "con", "NUL.txt", "x.", "x ", "a\nb", "a\u{7}",
            "a*b", "a?b", "a|b", "a<b", "a>b", "a\"b",
        ] {
            assert!(!safe_component(bad), "{bad:?}");
        }
        assert!(!safe_component(&"a".repeat(256)));
        for ok in ["informe.pdf", "carpeta", ".bashrc", "a b", "año (2).txt"] {
            assert!(safe_component(ok), "{ok:?}");
        }
    }

    #[test]
    fn plan_valida_la_lista_entera() {
        let files = vec![
            FileDescriptor::new("docs").with_attributes(ClipboardFileAttributes::DIRECTORY),
            FileDescriptor::new("a.txt")
                .with_relative_path("docs")
                .with_file_size(5),
            FileDescriptor::new("b.bin").with_file_size(7),
        ];
        let plan = plan_download(&files).unwrap();
        assert_eq!(plan.total, 12);
        assert_eq!(plan.files, 2);
        assert_eq!(
            plan.tops,
            vec![("docs".to_string(), true), ("b.bin".to_string(), false)]
        );

        let traversal = vec![FileDescriptor::new("x").with_relative_path("..\\..")];
        assert_eq!(plan_download(&traversal).err(), Some("unsafe-name"));
        let absolute = vec![FileDescriptor::new("x").with_relative_path("C:\\Windows")];
        assert_eq!(plan_download(&absolute).err(), Some("unsafe-name"));
        let rooted = vec![FileDescriptor::new("x").with_relative_path("\\etc")];
        assert_eq!(plan_download(&rooted).err(), Some("unsafe-name"));
        let twice = vec![FileDescriptor::new("A.txt"), FileDescriptor::new("a.txt")];
        assert_eq!(plan_download(&twice).err(), Some("duplicate-name"));
        let deep_path = vec!["d"; MAX_REMOTE_DEPTH].join("\\");
        let deep = vec![FileDescriptor::new("x").with_relative_path(deep_path)];
        assert_eq!(plan_download(&deep).err(), Some("too-deep"));
        let many = vec![FileDescriptor::new("x"); MAX_REMOTE_ENTRIES + 1];
        assert_eq!(plan_download(&many).err(), Some("too-many"));
        assert_eq!(plan_download(&[]).err(), Some("empty"));
    }

    #[test]
    fn destino_no_pisa_lo_que_ya_existe() {
        let dest = temp_dir("place");
        std::fs::write(dest.join("b.bin"), b"mio").unwrap();
        std::fs::create_dir(dest.join("docs")).unwrap();
        let files = vec![
            FileDescriptor::new("a.txt")
                .with_relative_path("docs")
                .with_file_size(5),
            FileDescriptor::new("b.bin").with_file_size(7),
            FileDescriptor::new("informe.tar.gz").with_file_size(1),
        ];
        let plan = plan_download(&files).unwrap();
        let (items, top_dirs) = place_plan(&plan, &dest);
        assert_eq!(top_dirs, vec![dest.join("docs (2)")]);
        assert_eq!(items[0].path, dest.join("docs (2)").join("a.txt"));
        assert!(!items[0].top);
        assert_eq!(items[1].path, dest.join("b (2).bin"));
        assert_eq!(items[2].path, dest.join("informe.tar.gz"));
        assert!(items.iter().all(|i| i.path.starts_with(&dest)));
        let _ = std::fs::remove_dir_all(dest);
    }

    #[test]
    fn copia_remota_se_ofrece_y_solo_se_guarda_al_elegir_carpeta() {
        let dest = temp_dir("save");
        let (mut w, mut rx, notices) = worker();
        let files = vec![
            FileDescriptor::new("docs").with_attributes(ClipboardFileAttributes::DIRECTORY),
            FileDescriptor::new("a.txt").with_relative_path("docs"),
            FileDescriptor::new("b.bin").with_file_size(3),
        ];
        w.on_remote_file_list(&files, Some(7));
        assert_eq!(notices.kinds(), vec!["files-offered"]);
        let offer = notices.last().offer.unwrap();
        // Ofrecer no escribe nada ni pide contenidos.
        assert!(rx.try_recv().is_err());
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 0);

        // Una oferta que no es la vigente no vale.
        w.save_to(offer + 1, dest.clone());
        assert_eq!(notices.last().reason.as_deref(), Some("expired"));

        w.save_to(offer, dest.clone());
        serve(&mut w, &mut rx, &[b"", b"hola", b"xyz"]);
        assert_eq!(notices.last().kind, "download-done");
        assert_eq!(notices.last().files, Some(2));
        assert_eq!(std::fs::read(dest.join("docs").join("a.txt")).unwrap(), b"hola");
        assert_eq!(std::fs::read(dest.join("b.bin")).unwrap(), b"xyz");
        // La oferta se gasta al usarla.
        w.save_to(offer, dest.clone());
        assert_eq!(notices.last().reason.as_deref(), Some("expired"));
        let _ = std::fs::remove_dir_all(dest);
    }

    #[test]
    fn descarga_fallida_o_cancelada_deshace_solo_lo_suyo() {
        let dest = temp_dir("undo");
        std::fs::write(dest.join("previo.txt"), b"no tocar").unwrap();
        let (mut w, mut rx, notices) = worker();
        let files = vec![
            FileDescriptor::new("docs").with_attributes(ClipboardFileAttributes::DIRECTORY),
            FileDescriptor::new("a.txt")
                .with_relative_path("docs")
                .with_file_size(4),
            FileDescriptor::new("b.bin").with_file_size(3),
        ];
        w.on_remote_file_list(&files, None);
        let offer = notices.last().offer.unwrap();
        w.save_to(offer, dest.clone());
        // El servidor no entrega el primer fichero.
        let Ok(ClipOut::RequestFileContents(req)) = rx.try_recv() else {
            panic!("se esperaba una petición de contenido");
        };
        w.on_file_contents_response(req.stream_id, false, &[]);
        assert_eq!(notices.last().reason.as_deref(), Some("remote"));
        let left: Vec<_> = std::fs::read_dir(&dest)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from("previo.txt")]);

        // Cancelar a medias, igual.
        w.on_remote_file_list(&files, None);
        let offer = notices.last().offer.unwrap();
        w.save_to(offer, dest.clone());
        assert!(dest.join("docs").is_dir());
        w.fail_download("cancelled".into());
        assert!(!dest.join("docs").exists());
        assert_eq!(std::fs::read(dest.join("previo.txt")).unwrap(), b"no tocar");
        let _ = std::fs::remove_dir_all(dest);
    }

    #[test]
    fn copia_demasiado_grande_no_se_ofrece() {
        let (mut w, _rx, notices) = worker();
        let files = vec![FileDescriptor::new("enorme.iso").with_file_size(MAX_DOWNLOAD_BYTES + 1)];
        w.on_remote_file_list(&files, None);
        assert_eq!(notices.kinds(), vec!["download-error"]);
        assert_eq!(notices.last().reason.as_deref(), Some("too-large"));
        assert!(w.offer.is_none());
    }

    #[test]
    fn fichero_que_crece_en_el_remoto_no_pasa_del_tope() {
        let dest = temp_dir("grow");
        let (mut w, mut rx, notices) = worker();
        // Sin tamaño en la lista: se pregunta y el remoto dice más del tope.
        w.on_remote_file_list(&[FileDescriptor::new("x.bin")], None);
        let offer = notices.last().offer.unwrap();
        w.save_to(offer, dest.clone());
        let Ok(ClipOut::RequestFileContents(req)) = rx.try_recv() else {
            panic!("se esperaba la petición de tamaño");
        };
        assert!(req.flags.contains(FileContentsFlags::SIZE));
        w.on_file_contents_response(req.stream_id, true, &(MAX_DOWNLOAD_BYTES + 1).to_le_bytes());
        assert_eq!(notices.last().reason.as_deref(), Some("too-large"));
        assert!(!dest.join("x.bin").exists());
        let _ = std::fs::remove_dir_all(dest);
    }

    #[test]
    fn lista_local_en_preorden_con_rutas_relativas() {
        let dir = std::env::temp_dir().join(format!("rustty-clip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("f.txt"), b"abc").unwrap();
        std::fs::write(dir.join("g.txt"), b"hello").unwrap();

        let (descs, entries) = collect_local_files(std::slice::from_ref(&dir));
        let _ = std::fs::remove_dir_all(&dir);

        let top = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(descs.len(), entries.len());
        assert_eq!(descs[0].name, top);
        assert!(entries[0].dir);
        let g = descs.iter().position(|d| d.name == "g.txt").unwrap();
        assert_eq!(descs[g].relative_path.as_deref(), Some(top.as_str()));
        assert_eq!(descs[g].file_size, Some(5));
        let f = descs.iter().position(|d| d.name == "f.txt").unwrap();
        let sub = descs.iter().position(|d| d.name == "sub").unwrap();
        assert!(sub < f, "la carpeta va antes que su contenido");
        assert_eq!(
            descs[f].relative_path.as_deref(),
            Some(format!("{top}\\sub").as_str())
        );
    }

    #[test]
    fn sirve_tamano_y_trozos_de_un_fichero() {
        let path = std::env::temp_dir().join(format!("rustty-clip-serve-{}", std::process::id()));
        std::fs::write(&path, b"0123456789").unwrap();
        let entries = Arc::new(vec![LocalEntry {
            path: path.clone(),
            dir: false,
        }]);
        let mut reader = None;
        let size = serve_file_contents(
            &entries,
            &FileContentsRequest {
                stream_id: 1,
                index: 0,
                flags: FileContentsFlags::SIZE,
                position: 0,
                requested_size: 8,
                data_id: None,
            },
            &mut reader,
        )
        .unwrap();
        assert_eq!(size.data_as_size().unwrap(), 10);
        let range = serve_file_contents(
            &entries,
            &FileContentsRequest {
                stream_id: 2,
                index: 0,
                flags: FileContentsFlags::RANGE,
                position: 3,
                requested_size: 4,
                data_id: None,
            },
            &mut reader,
        )
        .unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(range.data(), b"3456");
        assert!(serve_file_contents(
            &entries,
            &FileContentsRequest {
                stream_id: 3,
                index: 5,
                flags: FileContentsFlags::SIZE,
                position: 0,
                requested_size: 8,
                data_id: None,
            },
            &mut reader,
        )
        .is_none());
    }
}
