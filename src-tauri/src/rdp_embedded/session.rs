//! Una sesión RDP integrada: conexión, autenticación y bucle activo.
//!
//! Corre en una tarea tokio propia. Recibe órdenes (entrada, resize, cierre)
//! por un `mpsc` acotado y confirmaciones de pintado por un contador atómico,
//! y manda al canvas los fotogramas por el `Channel` de la sesión.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ironrdp_connector::{
    self as connector, ClientConnector, ConnectionResult, Credentials, DesktopSize,
};
use ironrdp_displaycontrol::client::DisplayControlClient;
use ironrdp_displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp_dvc::DrdynvcClient;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_input::Database;
use ironrdp_pdu::gcc::KeyboardType;
use ironrdp_pdu::rdp::capability_sets::{client_codecs_capabilities, MajorPlatformType};
use ironrdp_pdu::rdp::client_info::TimezoneInfo;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::{FramedWrite as _, TokioFramed};
use tauri::ipc::{Channel, Response};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
use zeroize::Zeroizing;

use super::certs;
use super::clipboard::{self, ClipNotifier, ClipboardChannel, ClipboardOptions, UploadGate};
use super::drive;
use super::frames::{self, Damage, Flow, Rect};
use super::input::InputEvent;
use super::perf::PerfProfile;
use super::resize::{self, ResizeRequest, Resizer};
use super::tls;

/// Plazo para abrir el TCP y para cada etapa de la negociación.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Plazo de la secuencia de reactivación tras un `DeactivateAll`.
const REACTIVATION_TIMEOUT: Duration = Duration::from_secs(10);
/// Cadencia del temporizador de canales: completa las E/S diferidas de la
/// carpeta compartida.
const CHANNEL_TICK: Duration = Duration::from_millis(100);
/// Cada cuántos ticks se revisan los plazos del portapapeles (~5 s).
const CLIPBOARD_TIMEOUT_TICKS: u32 = 50;

/// Órdenes del frontend hacia la sesión.
#[derive(Debug)]
pub enum SessionCmd {
    Input(Vec<InputEvent>),
    Resize {
        width: u32,
        height: u32,
        scale: Option<u32>,
    },
    /// El frontend pide comparar el portapapeles local con el remoto.
    ClipboardSync,
    /// Guardar los ficheros de la oferta `offer` en `dest` (elegida por el
    /// usuario en el diálogo del backend y ya validada).
    ClipboardSave { offer: u32, dest: PathBuf },
    /// Cancelar la descarga de ficheros en curso.
    ClipboardCancel,
    Close,
}

/// Estado compartido entre los comandos y la tarea de la sesión.
#[derive(Default)]
pub struct Shared {
    /// `seq` más alto pintado por el frontend.
    pub acked: AtomicU32,
    pub ack_notify: Notify,
}

/// Datos para conectar. La contraseña va en `Zeroizing`: se borra de memoria
/// al soltarla, justo después de la autenticación.
pub struct ConnectParams {
    /// Destino real (para el TOFU, el SNI y CredSSP).
    pub host: String,
    pub port: u16,
    /// Dónde abrir el TCP: el destino o el reenvío local del salto.
    pub dial_host: String,
    pub dial_port: u16,
    pub via_jump: bool,
    pub username: String,
    pub domain: Option<String>,
    pub password: Zeroizing<String>,
    pub width: u32,
    pub height: u32,
    /// Escala del escritorio en % (100..=500), del `devicePixelRatio`.
    pub scale: Option<u32>,
    pub cert_store: PathBuf,
    /// Portapapeles compartido (`None` = desactivado).
    pub clipboard: Option<ClipboardOptions>,
    pub clipboard_notifier: Arc<dyn ClipNotifier>,
    /// Pregunta antes de ofrecer al remoto ficheros locales sensibles.
    pub upload_gate: Arc<dyn UploadGate>,
    /// Carpeta local que se ve en el remoto como unidad.
    pub shared_folder: Option<PathBuf>,
    /// Lo que se pide al servidor para ahorrar ancho de banda.
    pub perf: PerfProfile,
    /// Preguntar si el certificado cambia (`None` = la política de SSH).
    pub cert_change_prompt: Option<bool>,
}

/// Fallo de la sesión con un código estable para el frontend.
#[derive(Debug, Clone)]
pub struct SessionError {
    pub code: &'static str,
    pub message: String,
}

impl SessionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Cómo terminó una sesión que llegó a estar activa.
#[derive(Debug, Clone)]
pub enum Ended {
    /// La cerró el usuario.
    Local,
    /// La cerró el servidor (cierre de sesión, desconexión administrativa…).
    Server(String),
}

/// Avisos de la sesión hacia el gestor (que los convierte en eventos).
pub trait Reporter: Send + Sync {
    fn connected(&self, width: u16, height: u16);
    /// El servidor admite (o no) cambiar el tamaño del escritorio en caliente.
    fn display_control(&self, supported: bool);
}

type Framed = TokioFramed<tokio_rustls::client::TlsStream<TcpStream>>;

fn os_platform() -> MajorPlatformType {
    if cfg!(windows) {
        MajorPlatformType::WINDOWS
    } else if cfg!(target_os = "macos") {
        MajorPlatformType::MACINTOSH
    } else {
        MajorPlatformType::UNIX
    }
}

/// Ajusta un tamaño a lo que admite el protocolo (200..=8192, ancho par).
#[must_use]
pub fn adjust_size(width: u32, height: u32) -> (u32, u32) {
    MonitorLayoutEntry::adjust_display_size(width, height)
}

/// `deviceScaleFactor` solo admite 100, 140 o 180.
fn device_scale(scale: u32) -> u32 {
    if scale >= 160 {
        180
    } else if scale >= 120 {
        140
    } else {
        100
    }
}

/// Separa `DOMINIO\usuario` cuando el perfil no trae dominio aparte.
fn split_domain(username: &str, domain: Option<&str>) -> (String, Option<String>) {
    let domain = domain.map(str::trim).filter(|d| !d.is_empty());
    if domain.is_none() {
        if let Some((d, u)) = username.split_once('\\') {
            if !d.is_empty() && !u.is_empty() {
                return (u.to_string(), Some(d.to_string()));
            }
        }
    }
    (username.to_string(), domain.map(str::to_string))
}

fn build_config(p: &ConnectParams) -> Result<connector::Config, SessionError> {
    let (width, height) = adjust_size(p.width, p.height);
    let (username, domain) = split_domain(&p.username, p.domain.as_deref());
    let codecs = client_codecs_capabilities(&[])
        .map_err(|e| SessionError::new("internal", format!("códecs: {e}")))?;
    let scale = p.scale.filter(|s| (100..=500).contains(s));
    let perf = p.perf.settings();
    Ok(connector::Config {
        credentials: Credentials::UsernamePassword {
            username,
            // Copia para IronRDP: vive dentro del conector, que se consume en la
            // autenticación. Nuestra copia sí se borra (`Zeroizing`).
            password: p.password.as_str().to_owned(),
        },
        domain,
        enable_tls: true,
        enable_credssp: true,
        enable_standard_rdp_security: false,
        keyboard_type: KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        // 0 = la distribución del servidor: los scancodes son posicionales.
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        connection_type: perf.connection_type,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize {
            width: u16::try_from(width).unwrap_or(1280),
            height: u16::try_from(height).unwrap_or(800),
        },
        monitor_layout: None,
        bitmap: Some(connector::BitmapConfig {
            lossy_compression: true,
            color_depth: 32,
            codecs,
        }),
        client_build: 0,
        client_name: "rustty".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: os_platform(),
        enable_server_pointer: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        enable_audio_capture: false,
        compression_type: perf.compression,
        // El puntero lo pinta el webview como cursor CSS (`PointerBitmap`): se
        // mueve sin esperar al servidor y no ensucia el framebuffer. Con `true`
        // IronRDP lo dibujaría en la imagen y cada movimiento sería un fotograma.
        pointer_software_rendering: false,
        multitransport_flags: None,
        support_dyn_vc_gfx_protocol: true,
        performance_flags: perf.flags,
        desktop_scale_factor: scale.unwrap_or(0),
        desktop_physical_size: None,
        desktop_orientation: None,
        device_scale_factor: scale.map(device_scale),
        monitor_extended_layout: None,
        relative_mouse_input: false,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        remote_application_mode: false,
        rail_support_level: ironrdp_pdu::rdp::capability_sets::RailSupportLevel::empty(),
    })
}

/// Canal gráfico (MS-RDPEGFX) sin decodificador H.264: el servidor elige
/// entre los códecs que IronRDP decodifica solo (RemoteFX progresivo,
/// ClearCodec, plano). `ActiveStage` compone lo decodificado en la imagen.
struct GfxHandler;

impl ironrdp_egfx::client::GraphicsPipelineHandler for GfxHandler {}

/// Cliente de red de CredSSP. Solo lo usa Kerberos para hablar con un KDC,
/// que esta versión no soporta: con NTLM nunca se llama.
struct NoKdc;

impl ironrdp_tokio::NetworkClient for NoKdc {
    async fn send(
        &mut self,
        _request: &ironrdp_connector::sspi::generator::NetworkRequest,
    ) -> connector::ConnectorResult<Vec<u8>> {
        Err(connector::general_err!(
            "Kerberos con KDC no soportado en el cliente integrado"
        ))
    }
}

fn classify_connect_error(err: &connector::ConnectorError) -> SessionError {
    // El texto de IronRDP no es estable; se busca lo justo para distinguir lo
    // que el usuario puede arreglar (credenciales) de lo que no.
    let text = format!("{err}");
    let lower = text.to_ascii_lowercase();
    let code = if lower.contains("logon")
        || lower.contains("credential")
        || lower.contains("access denied")
        || lower.contains("authentication")
    {
        "auth-failed"
    } else if lower.contains("negotiation") || lower.contains("security protocol") {
        "unsupported"
    } else {
        "protocol"
    };
    SessionError::new(code, text)
}

async fn with_timeout<T, E>(
    what: &str,
    fut: impl std::future::Future<Output = Result<T, E>>,
    map: impl FnOnce(E) -> SessionError,
) -> Result<T, SessionError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, fut).await {
        Ok(r) => r.map_err(map),
        Err(_) => Err(SessionError::new(
            "timeout",
            format!("{what}: tiempo agotado"),
        )),
    }
}

/// Conecta, comprueba el certificado (TOFU) y autentica.
/// Canales opcionales abiertos en esta sesión.
struct Channels {
    clipboard: Option<ClipboardChannel>,
    drive: bool,
}

async fn connect(
    params: ConnectParams,
) -> Result<(ConnectionResult, Framed, Channels), SessionError> {
    let tcp = with_timeout(
        "Conexión TCP",
        TcpStream::connect((params.dial_host.as_str(), params.dial_port)),
        |e| SessionError::new("unreachable", e.to_string()),
    )
    .await?;
    let _ = tcp.set_nodelay(true);
    let client_addr = tcp
        .local_addr()
        .map_err(|e| SessionError::new("unreachable", e.to_string()))?;

    let config = build_config(&params)?;
    let drdynvc = DrdynvcClient::new()
        .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())))
        .with_dynamic_channel(ironrdp_egfx::client::GraphicsPipelineClient::new(
            Box::new(GfxHandler),
            None,
        ));
    let mut connector = ClientConnector::new(config, client_addr).with_static_channel(drdynvc);
    let mut channels = Channels {
        clipboard: None,
        drive: false,
    };
    if let Some(options) = params.clipboard {
        let (cliprdr, channel) = clipboard::start(
            options,
            params.clipboard_notifier.clone(),
            params.upload_gate.clone(),
        );
        connector = connector.with_static_channel(cliprdr);
        channels.clipboard = Some(channel);
    }
    if let Some(folder) = params.shared_folder.as_deref() {
        // Una carpeta que ya no vale no impide conectar: la sesión sigue sin ella.
        match drive::build(folder, "rustty") {
            Ok(rdpdr) => {
                connector = connector.with_static_channel(rdpdr);
                channels.drive = true;
            }
            Err(e) => log::warn!("RDP integrado: carpeta compartida desactivada: {e}"),
        }
    }

    let mut framed = TokioFramed::new(tcp);
    let should_upgrade = with_timeout(
        "Negociación",
        ironrdp_tokio::connect_begin(&mut framed, &mut connector),
        |e| classify_connect_error(&e),
    )
    .await?;

    let tcp = framed.into_inner_no_leftover();
    let upgraded = with_timeout("TLS", tls::upgrade(tcp, &params.host), |e| {
        SessionError::new("tls", e.to_string())
    })
    .await?;

    // TOFU **antes** de CredSSP: sin certificado confirmado no sale ninguna
    // credencial. Sin plazo propio: el diálogo tiene el suyo.
    certs::verify(
        &params.cert_store,
        &params.host,
        params.port,
        &upgraded.cert_der,
        params.via_jump,
        certs::Policy::current(params.cert_change_prompt),
    )
    .await
    .map_err(|r| SessionError::new(r.code, r.message))?;

    let marker = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = TokioFramed::new(upgraded.stream);
    let server_name = params.host.clone();
    let outcome = with_timeout(
        "Autenticación",
        ironrdp_tokio::connect_finalize(
            marker,
            connector,
            &mut framed,
            &mut NoKdc,
            server_name.into(),
            upgraded.server_public_key,
            None,
        ),
        |e| classify_connect_error(&e),
    )
    .await?;
    // La contraseña ya no hace falta: se borra aquí (no al final de la sesión).
    drop(params.password);
    let result = outcome
        .into_connected()
        .map_err(|e| SessionError::new("redirect", e.to_string()))?;
    Ok((result, framed, channels))
}

/// Cada cuánto se escriben las estadísticas de envío (nivel `debug`).
const STATS_INTERVAL: Duration = Duration::from_secs(5);

/// Contadores de lo enviado al canvas, para saber dónde se va el tiempo.
struct SinkStats {
    since: Instant,
    bytes: u64,
    messages: u32,
    rects: u32,
    encode: Duration,
    /// Veces que había daños pero el frontend no había confirmado.
    stalled: u32,
}

impl Default for SinkStats {
    fn default() -> Self {
        Self {
            since: Instant::now(),
            bytes: 0,
            messages: 0,
            rects: 0,
            encode: Duration::ZERO,
            stalled: 0,
        }
    }
}

impl SinkStats {
    fn maybe_log(&mut self) {
        let elapsed = self.since.elapsed();
        if elapsed < STATS_INTERVAL {
            return;
        }
        if self.messages > 0 {
            let secs = elapsed.as_secs_f64();
            #[allow(clippy::cast_precision_loss)]
            let mib_s = self.bytes as f64 / secs / (1024.0 * 1024.0);
            log::debug!(
                "RDP integrado: {mib_s:.1} MiB/s, {:.1} msg/s, {:.1} rects/msg, codificar {:.2} ms/msg, {} esperas al canvas",
                f64::from(self.messages) / secs,
                f64::from(self.rects) / f64::from(self.messages),
                self.encode.as_secs_f64() * 1000.0 / f64::from(self.messages),
                self.stalled,
            );
        }
        *self = Self::default();
    }
}

/// Emisor de fotogramas con contrapresión.
struct Sink {
    channel: Channel<Response>,
    flow: Flow,
    damage: Damage,
    stats: SinkStats,
    /// Tamaño del escritorio que conoce el canvas.
    size: (u16, u16),
}

impl Sink {
    fn send(&mut self, bytes: Vec<u8>) -> bool {
        self.stats.bytes += bytes.len() as u64;
        self.stats.messages += 1;
        self.stats.maybe_log();
        self.channel.send(Response::new(bytes)).is_ok()
    }

    /// Avisa al canvas del tamaño del escritorio y lo repinta entero.
    fn send_desktop_size(&mut self, width: u16, height: u16) {
        self.size = (width, height);
        self.damage.clear();
        let seq = self.flow.next_seq();
        self.send(frames::encode_desktop_size(seq, width, height));
    }

    /// Sigue un cambio de tamaño del framebuffer que no pasó por una
    /// reactivación: con el canal gráfico, el servidor cambia de resolución con
    /// un `ResetGraphics` que IronRDP aplica dentro de `process`. `true` si
    /// cambió.
    fn follow_size(&mut self, image: &DecodedImage) -> bool {
        let (width, height) = (image.width(), image.height());
        if self.size == (width, height) {
            return false;
        }
        log::debug!(
            "RDP integrado: el escritorio pasa de {}x{} a {width}x{height}",
            self.size.0,
            self.size.1
        );
        self.send_desktop_size(width, height);
        if let Some(full) =
            Rect::from_inclusive(0, 0, width.saturating_sub(1), height.saturating_sub(1))
        {
            self.damage.add(full);
        }
        true
    }

    fn control(&mut self, kind: u8) -> bool {
        let seq = self.flow.next_seq();
        self.send(frames::encode_simple(kind, seq))
    }

    /// Manda lo pendiente si el frontend va al día. `false` = canal cerrado.
    fn flush(&mut self, image: &DecodedImage) -> bool {
        if self.damage.is_empty() {
            return true;
        }
        if !self.flow.can_send() {
            self.stats.stalled += 1;
            return true;
        }
        let rects = self.damage.take(image.width(), image.height());
        if rects.is_empty() {
            return true;
        }
        let seq = self.flow.next_seq();
        let started = Instant::now();
        let msg = frames::encode_rects(seq, &rects, image.data(), image.stride());
        self.stats.encode += started.elapsed();
        self.stats.rects += u32::try_from(rects.len()).unwrap_or(u32::MAX);
        self.send(msg)
    }
}

/// Ejecuta la sesión completa. Vuelve cuando termina.
pub async fn run(
    params: ConnectParams,
    channel: Channel<Response>,
    mut cmds: mpsc::Receiver<SessionCmd>,
    shared: Arc<Shared>,
    reporter: Arc<dyn Reporter>,
) -> Result<Ended, SessionError> {
    // Una orden de cierre durante la conexión (incluido el diálogo del
    // certificado) la corta en seco.
    let (result, mut framed, mut channels) = tokio::select! {
        r = connect(params) => r?,
        cmd = wait_close(&mut cmds) => {
            let () = cmd;
            return Ok(Ended::Local);
        }
    };

    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        result.desktop_size.width,
        result.desktop_size.height,
    );
    let activation_factory = result.activation_factory.clone();
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();

    let mut sink = Sink {
        channel,
        flow: Flow::default(),
        damage: Damage::default(),
        stats: SinkStats::default(),
        size: (0, 0),
    };
    let mut input_db = Database::new();

    sink.send_desktop_size(image.width(), image.height());
    reporter.connected(image.width(), image.height());

    let mut resizer = Resizer::default();
    let mut dc_deadline = Some(tokio::time::Instant::now() + resize::GRACE);

    let mut tick = tokio::time::interval(CHANNEL_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks: u32 = 0;
    let has_timers = channels.drive || channels.clipboard.is_some();

    loop {
        if !sink.flush(&image) {
            // El frontend cerró el canal (pestaña cerrada): cierre ordenado.
            shutdown(&mut stage, &mut framed).await;
            return Ok(Ended::Local);
        }

        tokio::select! {
            cmd = cmds.recv() => match cmd {
                None | Some(SessionCmd::Close) => {
                    shutdown(&mut stage, &mut framed).await;
                    return Ok(Ended::Local);
                }
                Some(SessionCmd::Input(events)) => {
                    let fastpath = to_fastpath(&mut input_db, events);
                    if !fastpath.is_empty() {
                        let outputs = stage
                            .process_fastpath_input(&mut image, &fastpath)
                            .map_err(|e| SessionError::new("protocol", e.to_string()))?;
                        if let Some(end) = handle_outputs(outputs, &mut framed, &mut sink, &mut image, &mut stage, &activation_factory).await? {
                            return Ok(end);
                        }
                    }
                }
                Some(SessionCmd::Resize { width, height, scale }) => {
                    let req = ResizeRequest::normalized(width, height, scale);
                    match resizer.request(req) {
                        Some(req) => send_resize(&mut stage, &mut resizer, &mut framed, req).await?,
                        None => log::debug!(
                            "RDP integrado: tamaño {}x{} pendiente (Display Control aún no está listo)",
                            req.width,
                            req.height
                        ),
                    }
                }
                Some(SessionCmd::ClipboardSync) => {
                    if let Some(clip) = channels.clipboard.as_ref() {
                        let _ = clip.input.send(clipboard::ClipIn::Sync);
                    }
                }
                Some(SessionCmd::ClipboardSave { offer, dest }) => {
                    if let Some(clip) = channels.clipboard.as_ref() {
                        let _ = clip.input.send(clipboard::ClipIn::SaveTo { offer, dest });
                    }
                }
                Some(SessionCmd::ClipboardCancel) => {
                    if let Some(clip) = channels.clipboard.as_ref() {
                        let _ = clip.input.send(clipboard::ClipIn::CancelDownload);
                    }
                }
            },
            Some(out) = recv_clip(&mut channels.clipboard) => {
                let frame = apply_clipboard(&mut stage, out);
                write_frame(&mut framed, frame).await?;
            }
            _ = tick.tick(), if has_timers => {
                ticks = ticks.wrapping_add(1);
                if channels.drive {
                    let frame = poll_drive(&mut stage);
                    write_frame(&mut framed, frame).await?;
                }
                if channels.clipboard.is_some() && ticks.is_multiple_of(CLIPBOARD_TIMEOUT_TICKS) {
                    let frame = clipboard_timeouts(&mut stage);
                    write_frame(&mut framed, frame).await?;
                }
            }
            () = shared.ack_notify.notified() => {
                sink.flow.ack(shared.acked.load(Ordering::Acquire));
            }
            () = sleep_until_opt(dc_deadline), if resizer.awaiting() => {
                dc_deadline = None;
                if let Some(supported) = resizer.give_up() {
                    log::debug!("RDP integrado: el servidor no ofrece Display Control");
                    reporter.display_control(supported);
                }
            }
            pdu = framed.read_pdu() => {
                let (action, payload) = match pdu {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        return Ok(Ended::Server(String::new()));
                    }
                    Err(e) => return Err(SessionError::new("network", e.to_string())),
                };
                let received_at = framed.last_read_at();
                let outputs = stage
                    .process(&mut image, action, &payload, received_at)
                    .map_err(|e| SessionError::new("protocol", e.to_string()))?;
                // Un `ResetGraphics` del canal gráfico ya cambió el tamaño de
                // `image`: el canvas lo sabe antes de los rectángulos nuevos.
                sink.follow_size(&image);
                if let Some(end) = handle_outputs(outputs, &mut framed, &mut sink, &mut image, &mut stage, &activation_factory).await? {
                    return Ok(end);
                }
                if resizer.needs_poll() {
                    poll_display_control(&mut stage, &mut resizer, reporter.as_ref(), &mut framed).await?;
                }
            }
        }
    }
}

/// Duerme hasta `deadline`; sin plazo, nunca vuelve.
async fn sleep_until_opt(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

/// Mira si el canal Display Control ya tiene las capacidades del servidor: lo
/// avisa al frontend y manda la petición que estuviera guardada.
async fn poll_display_control(
    stage: &mut ActiveStage,
    resizer: &mut Resizer,
    reporter: &dyn Reporter,
    framed: &mut Framed,
) -> Result<(), SessionError> {
    let ready = stage.display_control_ready() == Some(true);
    let observed = resizer.observe(ready);
    if let Some(supported) = observed.report {
        if supported {
            log::debug!(
                "RDP integrado: Display Control listo ({:?})",
                stage.display_control_capabilities()
            );
        }
        reporter.display_control(supported);
    }
    if let Some(req) = observed.send {
        send_resize(stage, resizer, framed, req).await?;
    }
    Ok(())
}

/// Pide al servidor el tamaño `req` por Display Control. Un fallo al
/// codificarlo no tumba la sesión; si el canal no está, queda guardada.
async fn send_resize(
    stage: &mut ActiveStage,
    resizer: &mut Resizer,
    framed: &mut Framed,
    req: ResizeRequest,
) -> Result<(), SessionError> {
    match stage.encode_resize(req.width, req.height, req.scale, None) {
        Some(Ok(frame)) => {
            log::debug!(
                "RDP integrado: se pide el tamaño {}x{} (escala {:?})",
                req.width,
                req.height,
                req.scale
            );
            write_frame(framed, frame).await
        }
        Some(Err(e)) => {
            log::debug!("RDP integrado: no se pudo pedir el tamaño nuevo: {e}");
            Ok(())
        }
        None => {
            resizer.requeue(req);
            Ok(())
        }
    }
}

/// Siguiente orden del hilo del portapapeles (nunca vuelve si no hay canal).
async fn recv_clip(clip: &mut Option<ClipboardChannel>) -> Option<clipboard::ClipOut> {
    match clip {
        Some(c) => c.output.recv().await,
        None => std::future::pending().await,
    }
}

/// Un fallo del portapapeles o de la carpeta no tumba la sesión: se registra y
/// se sigue sin enviar nada.
fn apply_clipboard(stage: &mut ActiveStage, out: clipboard::ClipOut) -> Vec<u8> {
    let Some(cliprdr) = stage.get_svc_processor_mut::<ironrdp_cliprdr::CliprdrClient>() else {
        return Vec::new();
    };
    let messages = match clipboard::apply(cliprdr, out) {
        Ok(m) => m,
        Err(e) => {
            log::debug!("RDP integrado: portapapeles: {e}");
            return Vec::new();
        }
    };
    stage
        .process_svc_processor_messages(messages)
        .unwrap_or_else(|e| {
            log::debug!("RDP integrado: portapapeles: {e}");
            Vec::new()
        })
}

fn clipboard_timeouts(stage: &mut ActiveStage) -> Vec<u8> {
    let Some(cliprdr) = stage.get_svc_processor_mut::<ironrdp_cliprdr::CliprdrClient>() else {
        return Vec::new();
    };
    match cliprdr.drive_timeouts() {
        Ok(messages) => stage
            .process_svc_processor_messages(messages)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn poll_drive(stage: &mut ActiveStage) -> Vec<u8> {
    let Some(rdpdr) = stage.get_svc_processor_mut::<ironrdp_rdpdr::Rdpdr>() else {
        return Vec::new();
    };
    match rdpdr.poll_deferred_messages() {
        Ok(messages) if !messages.is_empty() => stage
            .process_svc_processor_messages(
                ironrdp_svc::SvcProcessorMessages::<ironrdp_rdpdr::Rdpdr>::new(messages),
            )
            .unwrap_or_else(|e| {
                log::debug!("RDP integrado: carpeta compartida: {e}");
                Vec::new()
            }),
        Ok(_) => Vec::new(),
        Err(e) => {
            log::debug!("RDP integrado: carpeta compartida: {e}");
            Vec::new()
        }
    }
}

async fn write_frame(framed: &mut Framed, frame: Vec<u8>) -> Result<(), SessionError> {
    if frame.is_empty() {
        return Ok(());
    }
    framed
        .write_all(&frame)
        .await
        .map_err(|e| SessionError::new("network", e.to_string()))
}

async fn wait_close(cmds: &mut mpsc::Receiver<SessionCmd>) {
    loop {
        match cmds.recv().await {
            None | Some(SessionCmd::Close) => return,
            // Entrada o resize antes de estar conectados: se descartan.
            Some(_) => {}
        }
    }
}

fn to_fastpath(
    db: &mut Database,
    events: Vec<InputEvent>,
) -> Vec<ironrdp_pdu::input::fast_path::FastPathInputEvent> {
    let mut out = Vec::new();
    let mut ops = Vec::new();
    for ev in events {
        match ev {
            InputEvent::Op(op) => {
                if let Some(op) = op.to_operation() {
                    ops.push(op);
                }
            }
            InputEvent::ReleaseAll => {
                out.extend(db.apply(ops.drain(..)));
                out.extend(db.release_all());
            }
            InputEvent::Sync {
                scroll,
                num,
                caps,
                kana,
            } => {
                out.extend(db.apply(ops.drain(..)));
                out.push(ironrdp_input::synchronize_event(scroll, num, caps, kana));
            }
        }
    }
    out.extend(db.apply(ops));
    out
}

async fn shutdown(stage: &mut ActiveStage, framed: &mut Framed) {
    if let Ok(outputs) = stage.graceful_shutdown() {
        for out in outputs {
            if let ActiveStageOutput::ResponseFrame(frame) = out {
                let _ =
                    tokio::time::timeout(Duration::from_secs(2), framed.write_all(&frame)).await;
            }
        }
    }
}

async fn handle_outputs(
    outputs: Vec<ActiveStageOutput>,
    framed: &mut Framed,
    sink: &mut Sink,
    image: &mut DecodedImage,
    stage: &mut ActiveStage,
    activation_factory: &connector::connection_activation::ConnectionActivationFactory,
) -> Result<Option<Ended>, SessionError> {
    for out in outputs {
        match out {
            ActiveStageOutput::ResponseFrame(frame) => {
                framed
                    .write_all(&frame)
                    .await
                    .map_err(|e| SessionError::new("network", e.to_string()))?;
            }
            ActiveStageOutput::GraphicsUpdate(r) => {
                if let Some(rect) = Rect::from_inclusive(r.left, r.top, r.right, r.bottom) {
                    sink.damage.add(rect);
                }
            }
            ActiveStageOutput::PointerDefault => {
                sink.control(frames::MSG_POINTER_DEFAULT);
            }
            ActiveStageOutput::PointerHidden => {
                sink.control(frames::MSG_POINTER_HIDDEN);
            }
            ActiveStageOutput::PointerBitmap(p) => {
                let seq = sink.flow.next_seq();
                let msg = frames::encode_pointer_bitmap(
                    seq,
                    p.width,
                    p.height,
                    p.hotspot_x,
                    p.hotspot_y,
                    &p.bitmap_data,
                );
                sink.send(msg);
            }
            ActiveStageOutput::DeactivateAll => {
                reactivate(framed, sink, image, stage, activation_factory).await?;
            }
            ActiveStageOutput::Terminate(reason) => {
                return Ok(Some(Ended::Server(reason.to_string())));
            }
            ActiveStageOutput::ServerRedirection(_) => {
                return Err(SessionError::new(
                    "redirect",
                    "El servidor pide redirigir la sesión, y el cliente integrado no lo soporta",
                ));
            }
            _ => {}
        }
    }
    Ok(None)
}

/// Secuencia de desactivación-reactivación (cambio de resolución, reconexión
/// del escritorio). El canvas cambia de tamaño **aquí** y no al pedir el
/// resize: hasta este punto aún pueden llegar fotogramas del tamaño anterior.
async fn reactivate(
    framed: &mut Framed,
    sink: &mut Sink,
    image: &mut DecodedImage,
    stage: &mut ActiveStage,
    factory: &connector::connection_activation::ConnectionActivationFactory,
) -> Result<(), SessionError> {
    use connector::connection_activation::ConnectionActivationState;
    use ironrdp_core::WriteBuf;

    let mut seq = factory.create();
    let mut buf = WriteBuf::new();
    let fut = async {
        loop {
            let written = ironrdp_tokio::single_sequence_step_read(framed, &mut seq, &mut buf)
                .await
                .map_err(|e| SessionError::new("protocol", e.to_string()))?;
            if written.size().is_some() {
                framed
                    .write_all(buf.filled())
                    .await
                    .map_err(|e| SessionError::new("network", e.to_string()))?;
            }
            if let ConnectionActivationState::Finalized {
                desktop_size,
                share_id,
                enable_server_pointer,
                pointer_software_rendering,
                static_channel_chunk_size,
                window_support_level,
                ..
            } = seq.connection_activation_state()
            {
                return Ok::<_, SessionError>((
                    desktop_size,
                    share_id,
                    enable_server_pointer,
                    pointer_software_rendering,
                    static_channel_chunk_size,
                    window_support_level,
                ));
            }
        }
    };
    let (size, share_id, server_pointer, sw_pointer, chunk, window_level) =
        match tokio::time::timeout(REACTIVATION_TIMEOUT, fut).await {
            Ok(r) => r?,
            Err(_) => {
                return Err(SessionError::new(
                    "reactivation-timeout",
                    "La reactivación no terminó a tiempo",
                ))
            }
        };

    // Suelta el framebuffer viejo antes de reservar el nuevo.
    *image = DecodedImage::new(PixelFormat::RgbA32, 1, 1);
    *image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    if !stage.reactivate(
        seq.io_channel_id(),
        seq.user_channel_id(),
        share_id,
        server_pointer,
        sw_pointer,
        chunk,
    ) {
        return Err(SessionError::new(
            "protocol",
            "Tamaño de bloque de canal inválido",
        ));
    }
    stage.set_window_support_level(window_level);
    sink.send_desktop_size(size.width, size.height);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoNotice;
    impl ClipNotifier for NoNotice {
        fn notice(&self, _: clipboard::ClipNotice) {}
    }

    struct Deny;
    impl UploadGate for Deny {
        fn allow(&self, _: &[PathBuf]) -> bool {
            false
        }
    }

    struct Connected(std::sync::Mutex<Option<(u16, u16)>>);
    impl Reporter for Connected {
        fn connected(&self, width: u16, height: u16) {
            *self.0.lock().unwrap() = Some((width, height));
        }
        fn display_control(&self, _supported: bool) {}
    }

    /// Conexión de punta a punta contra un servidor RDP **real**: TCP, TLS con
    /// el proveedor `ring`, TOFU, NLA (CredSSP/NTLM), canal gráfico, portapapeles
    /// y carpeta compartida negociados, sesión activa, imagen y cierre ordenado. Se salta sin `RUSTTY_RDP_TEST_ADDR` (`host:puerto`);
    /// pide además `RUSTTY_RDP_TEST_USER`, `RUSTTY_RDP_TEST_PASS` y
    /// `RUSTTY_RDP_TEST_CERT` (el PEM del servidor, para fijar su huella: sin
    /// ventana no hay a quién preguntar). Vale, por ejemplo, un GNOME Remote
    /// Desktop en modo `--headless` con un `mutter --headless` y PipeWire.
    #[tokio::test]
    #[ignore = "necesita un servidor RDP real (RUSTTY_RDP_TEST_*)"]
    async fn conecta_de_verdad_y_recibe_imagen() {
        let Ok(addr) = std::env::var("RUSTTY_RDP_TEST_ADDR") else {
            eprintln!("RUSTTY_RDP_TEST_ADDR sin definir: se salta");
            return;
        };
        let (host, port) = addr.rsplit_once(':').expect("host:puerto");
        let port: u16 = port.parse().expect("puerto");
        let user = std::env::var("RUSTTY_RDP_TEST_USER").expect("RUSTTY_RDP_TEST_USER");
        let pass = std::env::var("RUSTTY_RDP_TEST_PASS").expect("RUSTTY_RDP_TEST_PASS");
        let pem = std::fs::read_to_string(std::env::var("RUSTTY_RDP_TEST_CERT").expect("RUSTTY_RDP_TEST_CERT"))
            .expect("PEM del servidor");
        let der = crate::rdp_certs::pem_first_der(&pem).expect("certificado en el PEM");

        let dir = std::env::temp_dir().join(format!("rustty-rdpreal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("compartida")).unwrap();
        let store = certs::store_path(&dir);
        certs::remember(&store, host, port, &crate::ftps_certs::fingerprint_sha256_hex(&der)).unwrap();

        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
                let _ = frame_tx.send(bytes);
            }
            Ok(())
        });
        let params = ConnectParams {
            host: host.into(),
            port,
            dial_host: host.into(),
            dial_port: port,
            via_jump: false,
            username: user,
            domain: None,
            password: Zeroizing::new(pass),
            width: 1024,
            height: 768,
            scale: None,
            cert_store: store,
            clipboard: Some(ClipboardOptions { files: true }),
            clipboard_notifier: Arc::new(NoNotice),
            upload_gate: Arc::new(Deny),
            shared_folder: Some(dir.join("compartida")),
            perf: PerfProfile::Balanced,
            cert_change_prompt: Some(false),
        };
        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let shared = Arc::new(Shared::default());
        let reporter = Arc::new(Connected(std::sync::Mutex::new(None)));
        let session = tokio::spawn(run(params, channel, cmd_rx, shared.clone(), reporter.clone()));

        // Primero el tamaño del escritorio y después, píxeles de verdad. Cada
        // mensaje se confirma como haría el canvas, o el backend se para.
        let mut size = None;
        let mut pixels = 0usize;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut session = session;
        while pixels == 0 {
            let msg = tokio::select! {
                msg = tokio::time::timeout_at(deadline, frame_rx.recv()) => msg,
                ended = &mut session => panic!("la sesión terminó antes de la imagen: {ended:?}"),
            };
            let msg = msg
                .expect("el servidor no mandó imagen a tiempo")
                .expect("canal de fotogramas cerrado");
            let seq = u32::from_le_bytes(msg[1..5].try_into().unwrap());
            shared.acked.store(seq, Ordering::Release);
            shared.ack_notify.notify_one();
            match msg[0] {
                frames::MSG_DESKTOP_SIZE => {
                    size = Some((
                        u16::from_le_bytes([msg[5], msg[6]]),
                        u16::from_le_bytes([msg[7], msg[8]]),
                    ));
                }
                frames::MSG_RECTS => pixels += msg.len() - 7,
                _ => {}
            }
        }
        let (width, height) = size.expect("el tamaño llega antes que la imagen");
        assert!(width >= 200 && height >= 200, "{width}x{height}");
        assert_eq!(*reporter.0.lock().unwrap(), Some((width, height)));

        // Un poco de entrada: mover el ratón y pulsar/soltar Mayús.
        cmd_tx
            .send(SessionCmd::Input(vec![
                InputEvent::Op(super::super::input::OpKind::MouseMove { x: 10, y: 10 }),
                InputEvent::Op(super::super::input::OpKind::Key { scancode: 0x2A, pressed: true }),
                InputEvent::Op(super::super::input::OpKind::Key { scancode: 0x2A, pressed: false }),
            ]))
            .await
            .unwrap();
        cmd_tx.send(SessionCmd::Close).await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(10), session)
            .await
            .expect("la sesión no se cerró a tiempo")
            .expect("tarea de la sesión")
            .expect("la sesión terminó con error");
        assert!(matches!(ended, Ended::Local), "{ended:?}");
        eprintln!("RDP real: {width}x{height}, {pixels} bytes de imagen");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn separa_dominio_del_usuario() {
        assert_eq!(
            split_domain("CORP\\ana", None),
            ("ana".to_string(), Some("CORP".to_string()))
        );
        assert_eq!(
            split_domain("CORP\\ana", Some("OTRO")),
            ("CORP\\ana".to_string(), Some("OTRO".to_string()))
        );
        assert_eq!(split_domain("ana", Some("  ")), ("ana".to_string(), None));
        assert_eq!(
            split_domain("ana@corp.local", None),
            ("ana@corp.local".to_string(), None)
        );
    }

    #[test]
    fn escala_de_dispositivo_por_tramos() {
        assert_eq!(device_scale(100), 100);
        assert_eq!(device_scale(125), 140);
        assert_eq!(device_scale(150), 140);
        assert_eq!(device_scale(200), 180);
    }

    #[test]
    fn tamano_ajustado_al_protocolo() {
        assert_eq!(adjust_size(1921, 100), (1920, 200));
        assert_eq!(adjust_size(9000, 9000), (8192, 8192));
    }

    #[test]
    fn configuracion_lleva_credenciales_y_tamano() {
        let p = ConnectParams {
            host: "srv".into(),
            port: 3389,
            dial_host: "srv".into(),
            dial_port: 3389,
            via_jump: false,
            username: "DOM\\u".into(),
            domain: None,
            password: Zeroizing::new("x".into()),
            width: 1001,
            height: 700,
            scale: Some(150),
            cert_store: PathBuf::new(),
            clipboard: None,
            clipboard_notifier: Arc::new(NoNotice),
            upload_gate: Arc::new(Deny),
            shared_folder: None,
            perf: PerfProfile::Speed,
            cert_change_prompt: None,
        };
        let c = build_config(&p).unwrap();
        assert!(!c.pointer_software_rendering);
        assert_eq!(c.performance_flags, PerfProfile::Speed.settings().flags);
        assert_eq!(c.compression_type, PerfProfile::Speed.settings().compression);
        assert_eq!(c.desktop_size.width, 1000);
        assert_eq!(c.domain.as_deref(), Some("DOM"));
        assert_eq!(c.desktop_scale_factor, 150);
        assert_eq!(c.device_scale_factor, Some(140));
        assert!(c.enable_credssp);
        assert!(!c.enable_standard_rdp_security);
        // Sin canal gráfico, GNOME Remote Desktop (y otros) cortan la conexión.
        assert!(c.support_dyn_vc_gfx_protocol);
    }
}
