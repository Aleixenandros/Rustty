use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::ipc::{event_name, EventKind};
use crate::locks::MutexExt;

/// Máximo de stdout+stderr del cliente externo que conservamos como cola
/// rodante para diagnosticar por qué murió (certificado, NLA, argumentos…).
const OUTPUT_TAIL_MAX: usize = 4096;
/// Longitud máxima del `detail` que viaja al frontend en `rdp-closed-*`.
const DETAIL_MAX: usize = 700;

/// Información de una sesión RDP activa
pub struct RdpHandle {
    pub child: std::process::Child,
    pub cleanup_path: Option<PathBuf>,
    #[allow(dead_code)]
    pub profile_id: String,
    /// Cola compartida de stdout+stderr del cliente (diagnóstico de cierre).
    output_tail: Option<Arc<Mutex<String>>>,
    /// Hilos lectores de la cola; se les hace join al detectar el cierre para
    /// no leer la cola antes de que drenen los últimos bytes.
    output_readers: Vec<std::thread::JoinHandle<()>>,
    /// Host cuya credencial `TERMSRV/<host>` inyectamos (solo Windows).
    cred_host: Option<String>,
}

struct SpawnedRdpClient {
    child: std::process::Child,
    cleanup_path: Option<PathBuf>,
    output_tail: Option<Arc<Mutex<String>>>,
    output_readers: Vec<std::thread::JoinHandle<()>>,
}

/// Payload de `rdp-closed-{id}`: motivo del cierre para la UI.
/// `code = None` es un cierre limpio; `"cert-changed"` el certificado del
/// servidor cambió respecto al recordado por el cliente; `"no-password"` el
/// cliente se quedó esperando unas credenciales que nadie podía teclear;
/// `"error"` cualquier otra terminación con fallo (el detalle lleva la cola de
/// salida del cliente).
#[derive(Clone, serde::Serialize)]
struct RdpClosePayload {
    code: Option<&'static str>,
    detail: Option<String>,
}

/// Guardia de una credencial `TERMSRV/<host>` inyectada en el Gestor de
/// credenciales de Windows. `refs` cuenta las sesiones Rustty abiertas contra
/// ese host (todas comparten la misma clave, se borra al cerrar la última);
/// `delete_on_close` recuerda si la creamos nosotros — una credencial que
/// existiera antes de Rustty no se borra jamás.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct CredGuard {
    refs: usize,
    delete_on_close: bool,
}

/// Cómo abre la ventana el cliente RDP.
///
/// El modo por defecto (`Window`) pide **resolución dinámica**: la ventana se
/// puede maximizar y arrastrar, y el escritorio remoto sigue el tamaño. Necesita
/// que el servidor hable el canal Display Control (Windows 8 / Server 2012 en
/// adelante); `Fixed` existe justo para los que no, y deja la ventana clavada al
/// tamaño con el que arrancó, que es lo que Rustty hacía siempre hasta ahora.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RdpDisplay {
    /// Ventana redimensionable de 1280×800 con resolución dinámica.
    #[default]
    Window,
    /// Arranca ocupando el monitor entero (Ctrl+Alt+Intro vuelve a ventana).
    Fullscreen,
    /// Ventana que ocupa el área de trabajo: el monitor menos las barras.
    WorkArea,
    /// Ventana de tamaño fijo, sin resolución dinámica.
    Fixed,
}

impl RdpDisplay {
    /// Líneas del fichero `.rdp` que expresan este modo para mstsc.
    /// `screen mode id:i:2` es pantalla completa, `1` ventana. `dynamic
    /// resolution` es el equivalente de `/dynamic-resolution` en el cliente de
    /// Windows: la sesión sigue el tamaño de la ventana al redimensionarla.
    #[cfg(target_os = "windows")]
    fn rdp_file_lines(self, width: u32, height: u32) -> String {
        match self {
            Self::Fullscreen => "screen mode id:i:2\r\ndynamic resolution:i:1\r\n".to_string(),
            // mstsc no tiene «área de trabajo»: la ventana maximizada con
            // resolución dinámica es lo más parecido.
            Self::WorkArea => {
                "screen mode id:i:1\r\ndynamic resolution:i:1\r\nmaximizewindow:i:1\r\n"
                    .to_string()
            }
            Self::Window => format!(
                "screen mode id:i:1\r\ndynamic resolution:i:1\r\ndesktopwidth:i:{width}\r\ndesktopheight:i:{height}\r\n"
            ),
            Self::Fixed => format!(
                "screen mode id:i:1\r\ndynamic resolution:i:0\r\ndesktopwidth:i:{width}\r\ndesktopheight:i:{height}\r\n"
            ),
        }
    }

    /// Traduce el valor que llega del perfil o de las preferencias. Cualquier
    /// cosa que no se reconozca cae en el modo por defecto: un valor viejo o
    /// corrupto en `profiles.json` no debe impedir conectar.
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("fullscreen") => Self::Fullscreen,
            Some("workarea") => Self::WorkArea,
            Some("fixed") => Self::Fixed,
            _ => Self::Window,
        }
    }

    /// Argumentos de tamaño para xfreerdp, en orden.
    fn freerdp_args(self, width: u32, height: u32) -> Vec<String> {
        match self {
            // `/dynamic-resolution` es lo que hace la ventana redimensionable:
            // sin él xfreerdp la clava al tamaño con el que negoció la sesión.
            Self::Window => vec![
                "/dynamic-resolution".into(),
                format!("/w:{width}"),
                format!("/h:{height}"),
            ],
            Self::Fullscreen => vec!["/f".into(), "/dynamic-resolution".into()],
            Self::WorkArea => vec!["/workarea".into(), "/dynamic-resolution".into()],
            Self::Fixed => vec![format!("/w:{width}"), format!("/h:{height}")],
        }
    }

    /// Equivalente para rdesktop, el cliente de respaldo. No tiene resolución
    /// dinámica, así que `Window` y `Fixed` acaban en la misma geometría fija.
    fn rdesktop_args(self, width: u32, height: u32) -> Vec<String> {
        match self {
            Self::Fullscreen => vec!["-f".into()],
            Self::WorkArea => vec!["-g".into(), "workarea".into()],
            Self::Window | Self::Fixed => vec!["-g".into(), format!("{width}x{height}")],
        }
    }
}

/// Tamaño con el que arranca una ventana RDP cuando el modo no lo deriva del
/// monitor. Es el que Rustty ha usado siempre.
const DEFAULT_RDP_WIDTH: u32 = 1280;
const DEFAULT_RDP_HEIGHT: u32 = 800;

/// A dónde y con qué credencial se conecta una sesión RDP.
///
/// Agrupa los siete parámetros que `launch` recibía sueltos (clippy:
/// `too_many_arguments`). La contraseña sigue sin viajar nunca por argv: se
/// inyecta como credencial `TERMSRV/<host>` en Windows y por stdin en Linux.
pub struct RdpTarget<'a> {
    pub session_id: String,
    pub profile_id: String,
    pub host: &'a str,
    pub port: u16,
    pub username: &'a str,
    pub domain: Option<&'a str>,
    pub password: Option<&'a str>,
    /// Cómo abre la ventana el cliente. Lo resuelve el llamador (perfil sobre
    /// preferencia global); aquí llega ya decidido.
    pub display: RdpDisplay,
}

/// Gestor de sesiones RDP.
/// Lanza el cliente RDP nativo del SO y vigila su ciclo de vida.
pub struct RdpManager {
    sessions: Arc<Mutex<HashMap<String, RdpHandle>>>,
    cred_guards: Arc<Mutex<HashMap<String, CredGuard>>>,
}

impl RdpManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            cred_guards: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Lanza el cliente RDP nativo y registra la sesión.
    /// Emite `rdp-closed-{session_id}` cuando el proceso termina.
    pub fn launch(&self, target: RdpTarget<'_>, app_handle: AppHandle) -> Result<(), String> {
        let RdpTarget {
            session_id,
            profile_id,
            host,
            port,
            username,
            domain,
            password,
            display,
        } = target;
        // Windows: mstsc no acepta la contraseña ni por argv ni por el .rdp;
        // la vía (la de mRemoteNG / Royal TS) es dejarla en el Gestor de
        // credenciales como `TERMSRV/<host>` justo antes de lanzar y retirarla
        // al cerrar la última sesión del host. Se escribe por la API nativa
        // (CredWriteW vía `keyring`), nunca por `cmdkey` con la contraseña en
        // la línea de comandos.
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut cred_host: Option<String> = None;
        #[cfg(target_os = "windows")]
        if let Some(pass) = password.filter(|p| !p.is_empty()) {
            // Best-effort: si la inyección falla, mstsc pedirá la contraseña
            // él mismo (el comportamiento previo).
            if acquire_windows_credential(&self.cred_guards, host, username, domain, pass).is_ok()
            {
                cred_host = Some(host.to_string());
            }
        }

        let spawned = match spawn_rdp_client(
            host,
            port,
            username,
            domain,
            password,
            display,
            cred_host.is_some(),
        ) {
            Ok(s) => s,
            Err(e) => {
                if let Some(h) = cred_host.take() {
                    release_windows_credential(&self.cred_guards, &h);
                }
                return Err(e);
            }
        };

        self.sessions.lock_recover().insert(
            session_id.clone(),
            RdpHandle {
                child: spawned.child,
                cleanup_path: spawned.cleanup_path,
                profile_id,
                output_tail: spawned.output_tail,
                output_readers: spawned.output_readers,
                cred_host,
            },
        );

        // Hilo vigilante: detecta cuándo el proceso externo termina
        let sessions = Arc::clone(&self.sessions);
        let cred_guards = Arc::clone(&self.cred_guards);
        let sid = session_id.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));

            // None = sigue vivo; Some((handle, status)) = terminó (status None
            // si try_wait falló y no hay código de salida fiable).
            let finished = {
                let mut map = sessions.lock_recover();
                match map.get_mut(&sid) {
                    Some(handle) => match handle.child.try_wait() {
                        Ok(None) => None,
                        Ok(Some(status)) => map.remove(&sid).map(|h| (h, Some(status))),
                        Err(_) => map.remove(&sid).map(|h| (h, None)),
                    },
                    None => break, // La sesión fue eliminada por rdp_disconnect
                }
            };

            if let Some((mut handle, status)) = finished {
                if let Some(path) = handle.cleanup_path.take() {
                    let _ = std::fs::remove_file(path);
                }
                // El hijo ya murió: sus tuberías dan EOF enseguida. El join
                // garantiza que la cola tiene hasta el último byte de salida.
                for reader in handle.output_readers.drain(..) {
                    let _ = reader.join();
                }
                if let Some(h) = handle.cred_host.take() {
                    release_windows_credential(&cred_guards, &h);
                }
                let payload = close_payload(status, handle.output_tail.as_ref());
                let _ = app_handle.emit(&event_name(EventKind::RdpClosed, &sid), payload);
                break;
            }
        });

        Ok(())
    }

    /// Termina el proceso RDP y elimina la sesión
    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        if let Some(mut handle) = self.sessions.lock_recover().remove(session_id) {
            let _ = handle.child.kill();
            if let Some(path) = handle.cleanup_path.take() {
                let _ = std::fs::remove_file(path);
            }
            if let Some(host) = handle.cred_host.take() {
                release_windows_credential(&self.cred_guards, &host);
            }
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
        for mut handle in handles {
            let _ = handle.child.kill();
            if let Some(path) = handle.cleanup_path.take() {
                let _ = std::fs::remove_file(path);
            }
            if let Some(host) = handle.cred_host.take() {
                release_windows_credential(&self.cred_guards, &host);
            }
        }
    }
}

// ─── Diagnóstico del cierre ──────────────────────────────────────────────────

/// Construye el payload de `rdp-closed-*` a partir del código de salida y la
/// cola de salida capturada del cliente.
fn close_payload(
    status: Option<std::process::ExitStatus>,
    output_tail: Option<&Arc<Mutex<String>>>,
) -> RdpClosePayload {
    if status.is_some_and(|s| s.success()) {
        return RdpClosePayload {
            code: None,
            detail: None,
        };
    }
    let tail = output_tail
        .map(|t| t.lock_recover().clone())
        .unwrap_or_default();
    let code = if is_cert_changed(&tail) {
        "cert-changed"
    } else if is_credential_prompt_failure(&tail) {
        "no-password"
    } else {
        "error"
    };
    RdpClosePayload {
        code: Some(code),
        detail: extract_error_detail(&tail),
    }
}

/// Heurística sobre la salida de xfreerdp/rdesktop: el certificado del
/// servidor no coincide con el recordado (TOFU). FreeRDP lo notifica con el
/// aviso estilo OpenSSH («host key … changed» / «certificate … changed»).
fn is_cert_changed(tail: &str) -> bool {
    let lower = tail.to_lowercase();
    let cert = lower.contains("certificate") || lower.contains("host key");
    let changed = lower.contains("changed")
        || lower.contains("mismatch")
        || lower.contains("not trusted")
        || lower.contains("identification has changed");
    cert && changed
}

/// El cliente abortó porque necesitaba que alguien tecleara una credencial y no
/// había terminal donde hacerlo. Le pasa a FreeRDP cuando el perfil no trae
/// contraseña: intenta leerla por el terminal, el `tcgetattr` falla sobre la
/// tubería («Inappropriate ioctl for device», con la errata `termianl` del
/// propio FreeRDP) y cancela la conexión. Sin traducirlo, la UI enseñaría ese
/// volcado en vez de decir lo único accionable: guarda la contraseña en el
/// perfil.
fn is_credential_prompt_failure(tail: &str) -> bool {
    let lower = tail.to_lowercase();
    let sin_terminal = lower.contains("termianl_nonblock")
        || lower.contains("terminal_nonblock")
        || (lower.contains("passphrase") && lower.contains("tcgetattr"));
    sin_terminal && lower.contains("errconnect_connect_cancelled")
}

/// Extrae las líneas útiles de la cola de salida del cliente: las marcadas
/// `[ERROR]` (formato wlog de FreeRDP, recortando el prefijo de timestamp) o,
/// si no hay ninguna, las últimas líneas no vacías. Devuelve `None` si no hay
/// nada que contar.
fn extract_error_detail(tail: &str) -> Option<String> {
    let error_lines: Vec<&str> = tail
        .lines()
        .filter_map(|l| l.find("[ERROR]").map(|i| l[i..].trim()))
        .filter(|l| !l.is_empty())
        .collect();

    let mut detail = if error_lines.is_empty() {
        tail.lines()
            .rev()
            .filter(|l| !l.trim().is_empty())
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        error_lines.join("\n")
    };

    if detail.len() > DETAIL_MAX {
        // Conservar el final (los errores últimos son los decisivos),
        // cortando en un límite de carácter válido.
        let mut cut = detail.len() - DETAIL_MAX;
        while !detail.is_char_boundary(cut) {
            cut += 1;
        }
        detail.drain(..cut);
    }

    let detail = detail.trim().to_string();
    if detail.is_empty() {
        None
    } else {
        Some(detail)
    }
}

// ─── Contraseña para FreeRDP 3 (`FREERDP_ASKPASS`) ──────────────────────────

/// Descriptor con el que el cliente hereda la contraseña. El 3 es el primero
/// libre tras stdin/stdout/stderr, que `std` ya ha colocado cuando corre
/// nuestro `pre_exec`.
#[cfg(target_os = "linux")]
const ASKPASS_FD: std::os::fd::RawFd = 3;

/// Orden que FreeRDP 3 ejecuta (a través del shell) cuando necesita la
/// contraseña: se queda con la primera línea que el programa escriba en stdout.
/// La nuestra sale del `memfd` heredado, reabierto por `/proc/self/fd` para que
/// el offset arranque en cero en cada invocación.
#[cfg(target_os = "linux")]
const ASKPASS_COMMAND: &str = "/bin/sh -c \"cat /proc/self/fd/3\"";

/// Deja `secret` en un fichero anónimo en memoria (`memfd`) para pasárselo al
/// cliente como descriptor heredado: ni disco, ni argv, ni entorno.
#[cfg(target_os = "linux")]
fn secret_memfd(secret: &str) -> std::io::Result<std::fs::File> {
    use std::io::Write;
    use std::os::fd::FromRawFd;

    // MFD_CLOEXEC: por defecto el fd no sobrevive al exec; es `pre_exec` quien
    // lo coloca a propósito en `ASKPASS_FD`.
    let fd = unsafe { libc::memfd_create(c"rustty-rdp-pass".as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `memfd_create` acaba de devolver este descriptor y nadie más lo
    // posee, así que `File` puede adueñarse de él.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    // Sin salto de línea final: el helper escribe el secreto tal cual.
    file.write_all(secret.as_bytes())?;
    Ok(file)
}

/// Programa el `dup2` que deja `file` en `ASKPASS_FD` dentro del hijo.
#[cfg(target_os = "linux")]
fn inherit_secret_fd(cmd: &mut std::process::Command, file: &std::fs::File) {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;

    let raw = file.as_raw_fd();
    // SAFETY: entre `fork` y `exec` el closure solo llama a `dup2`/`fcntl`,
    // ambas async-signal-safe, sin asignar memoria ni tomar cerrojos.
    unsafe {
        cmd.pre_exec(move || {
            if raw == ASKPASS_FD {
                // Ya está en su sitio; solo hay que quitarle el FD_CLOEXEC.
                if libc::fcntl(ASKPASS_FD, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(raw, ASKPASS_FD) < 0 {
                // `dup2` deja el destino sin FD_CLOEXEC: sobrevive al exec.
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Lector en hilo propio que acumula la salida del hijo en una cola rodante
/// acotada (`OUTPUT_TAIL_MAX`).
#[cfg(target_os = "linux")]
fn spawn_tail_reader<R: std::io::Read + Send + 'static>(
    src: R,
    tail: Arc<Mutex<String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut src = src;
        let mut buf = [0u8; 1024];
        loop {
            match src.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    let mut t = tail.lock_recover();
                    t.push_str(&chunk);
                    if t.len() > OUTPUT_TAIL_MAX {
                        let mut cut = t.len() - OUTPUT_TAIL_MAX;
                        while !t.is_char_boundary(cut) {
                            cut += 1;
                        }
                        t.drain(..cut);
                    }
                }
            }
        }
    })
}

// ─── Credencial TERMSRV en el Gestor de credenciales de Windows ─────────────

/// Inyecta (o refresca) la credencial genérica `TERMSRV/<host>` con la
/// contraseña del perfil y toma una referencia en el mapa de guardias.
/// La escribe la API nativa (`CredWriteW` vía `keyring`, blob UTF-16LE, el
/// mismo formato que crea `cmdkey /generic:`), así que nunca pasa por argv.
#[cfg(target_os = "windows")]
fn acquire_windows_credential(
    guards: &Mutex<HashMap<String, CredGuard>>,
    host: &str,
    username: &str,
    domain: Option<&str>,
    password: &str,
) -> Result<(), String> {
    let target = format!("TERMSRV/{host}");
    let user = match domain.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => format!("{d}\\{username}"),
        None => username.to_string(),
    };

    let entry = keyring::Entry::new_with_target(&target, crate::keyring_scope::SERVICE, &user)
        .map_err(|e| format!("credencial TERMSRV: {e}"))?;

    let mut guards = guards.lock_recover();
    let delete_on_close = match guards.get(host) {
        // Otra sesión Rustty ya inyectó para este host: heredar su decisión.
        Some(g) => g.delete_on_close,
        None => match entry.get_attributes() {
            // No existía: la creamos nosotros y se borra al cerrar la última.
            Err(keyring::Error::NoEntry) => true,
            // Huérfana de una ejecución anterior (el crate keyring firma el
            // comment): también es nuestra y puede borrarse al cerrar.
            Ok(attrs) => attrs
                .get("comment")
                .is_some_and(|c| c.starts_with("keyring v")),
            // Existe pero no se puede inspeccionar: no borrarla jamás.
            Err(_) => false,
        },
    };

    entry
        .set_password(password)
        .map_err(|e| format!("credencial TERMSRV: {e}"))?;

    guards
        .entry(host.to_string())
        .and_modify(|g| g.refs += 1)
        .or_insert(CredGuard {
            refs: 1,
            delete_on_close,
        });
    Ok(())
}

/// Suelta una referencia a la credencial inyectada del host; al llegar a cero
/// la retira del Gestor de credenciales **solo** si la creó Rustty.
fn release_windows_credential(guards: &Mutex<HashMap<String, CredGuard>>, host: &str) {
    #[cfg(target_os = "windows")]
    {
        let mut map = guards.lock_recover();
        let Some(g) = map.get_mut(host) else { return };
        g.refs = g.refs.saturating_sub(1);
        if g.refs > 0 {
            return;
        }
        let delete = g.delete_on_close;
        map.remove(host);
        if delete {
            let target = format!("TERMSRV/{host}");
            if let Ok(entry) = keyring::Entry::new_with_target(&target, crate::keyring_scope::SERVICE, "") {
                let _ = entry.delete_credential();
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (guards, host);
    }
}

// ─── Lanzadores por plataforma ────────────────────────────────────────────────

/// Linux: usa xfreerdp3/xfreerdp (preferido) o rdesktop como fallback.
#[cfg(target_os = "linux")]
fn spawn_rdp_client(
    host: &str,
    port: u16,
    username: &str,
    domain: Option<&str>,
    password: Option<&str>,
    display: RdpDisplay,
    _cred_injected: bool,
) -> Result<SpawnedRdpClient, String> {
    // Detectar qué binario está disponible
    let binary = ["xfreerdp3", "xfreerdp", "rdesktop"]
        .iter()
        .find(|&&bin| {
            std::process::Command::new("which")
                .arg(bin)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .copied()
        .ok_or_else(|| {
            "Cliente RDP no encontrado. Instala xfreerdp:\n  sudo dnf install freerdp  # Fedora\n  sudo apt install freerdp2-x11  # Debian/Ubuntu".to_string()
        })?;

    // La contraseña se entrega por stdin o por un descriptor heredado, nunca
    // por argv: un `/p:<pass>` o `-p <pass>` queda visible en `ps` /
    // `/proc/<pid>/cmdline` mientras dura la sesión (el propio `man rdesktop`
    // lo advierte).
    let secret = password.filter(|p| !p.is_empty());

    let mut cmd = std::process::Command::new(binary);
    if binary == "rdesktop" {
        cmd.arg("-u").arg(username);
        if let Some(d) = domain.filter(|d| !d.is_empty()) {
            cmd.arg("-d").arg(d);
        }
        if secret.is_some() {
            cmd.arg("-p").arg("-"); // lee la contraseña de stdin
        }
        cmd.args(display.rdesktop_args(DEFAULT_RDP_WIDTH, DEFAULT_RDP_HEIGHT));
        cmd.arg("-r").arg("clipboard:CLIPBOARD");
        cmd.arg(format!("{host}:{port}"));
    } else {
        cmd.arg(format!("/v:{host}:{port}"));
        cmd.arg(format!("/u:{username}"));
        // El dominio va **siempre**, vacío incluido: si el argumento falta,
        // FreeRDP lo pregunta por el terminal —no por el askpass— y sin tty esa
        // pregunta aborta la conexión antes de llegar a pedir la contraseña.
        cmd.arg(format!("/d:{}", domain.map(str::trim).unwrap_or("")));
        if secret.is_some() {
            // Solo lo entiende FreeRDP 2; la 3 usa `FREERDP_ASKPASS` (abajo).
            cmd.arg("/from-stdin");
        }
        cmd.arg("+clipboard");
        // TOFU en vez de `/cert:ignore`: xfreerdp recuerda el certificado del
        // host y avisa si cambia (coherente con el TOFU de host keys de SSH),
        // en vez de aceptar cualquier certificado en silencio.
        cmd.arg("/cert:tofu");
        // Tamaño y comportamiento de la ventana según el modo elegido.
        cmd.args(display.freerdp_args(DEFAULT_RDP_WIDTH, DEFAULT_RDP_HEIGHT));
    }

    if secret.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }

    // FreeRDP 3 dejó de aceptar la contraseña por una tubería: `/from-stdin`
    // exige que stdin sea un terminal —hace `tcgetattr`/`tcsetattr` para apagar
    // el eco— y sobre un pipe falla («Inappropriate ioctl for device») y cancela
    // la conexión: `nla_client_setup_identity: ERRCONNECT_CONNECT_CANCELLED`.
    // La vía que sí soporta es `FREERDP_ASKPASS`, un programa que escribe la
    // contraseña por stdout; el nuestro es un `cat` del `memfd` heredado, así el
    // secreto sigue sin pasar por argv, entorno ni disco. Si el `memfd` falla
    // queda el `/from-stdin` de arriba, que es lo que entiende FreeRDP 2.
    let askpass_secret = match secret {
        Some(pass) if binary != "rdesktop" => secret_memfd(pass).ok(),
        _ => None,
    };
    if let Some(file) = &askpass_secret {
        inherit_secret_fd(&mut cmd, file);
        cmd.env("FREERDP_ASKPASS", ASKPASS_COMMAND);
    }

    // Capturamos stdout+stderr: si el cliente muere al arrancar (certificado
    // cambiado, NLA rechazado, argumento no soportado…) esa salida es el único
    // diagnóstico disponible y viaja al frontend en `rdp-closed-*`. Antes se
    // descartaba y cualquier fallo se veía como un simple «sesión cerrada».
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Error al lanzar {binary}: {e}"))?;

    // El `memfd` tenía que seguir abierto durante el `spawn`; el hijo ya tiene
    // su copia en `ASKPASS_FD`, así que aquí sobra y el secreto deja de estar
    // alcanzable desde el proceso de Rustty.
    drop(askpass_secret);

    if let Some(pass) = secret {
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            // Best-effort: si la escritura falla, el cliente pedirá la
            // contraseña por su cuenta. El `drop` de `stdin` cierra la tubería
            // (EOF) para que el cliente no quede esperando más entrada.
            let _ = writeln!(stdin, "{pass}");
        }
    }

    let tail = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        readers.push(spawn_tail_reader(out, Arc::clone(&tail)));
    }
    if let Some(err) = child.stderr.take() {
        readers.push(spawn_tail_reader(err, Arc::clone(&tail)));
    }

    Ok(SpawnedRdpClient {
        child,
        cleanup_path: None,
        output_tail: Some(tail),
        output_readers: readers,
    })
}

/// Windows: escribe un archivo .rdp temporal y lo abre con mstsc.exe.
/// La contraseña no viaja por aquí: si el perfil la tiene, `launch` la dejó ya
/// inyectada como credencial `TERMSRV/<host>` (ver `acquire_windows_credential`)
/// y `cred_injected` es true, con lo que mstsc conecta directo sin preguntar.
#[cfg(target_os = "windows")]
fn spawn_rdp_client(
    host: &str,
    port: u16,
    username: &str,
    domain: Option<&str>,
    _password: Option<&str>, // mstsc no acepta contraseñas por línea de comandos
    display: RdpDisplay,
    cred_injected: bool,
) -> Result<SpawnedRdpClient, String> {
    let rdp_path = write_windows_rdp_file(host, port, username, domain, display, cred_injected)?;
    let mut errors = Vec::new();

    if let Some(mstsc) = resolve_mstsc_path() {
        match spawn_windows_mstsc(&mstsc, &rdp_path) {
            Ok(child) => {
                return Ok(SpawnedRdpClient {
                    child,
                    cleanup_path: Some(rdp_path),
                    output_tail: None,
                    output_readers: Vec::new(),
                });
            }
            Err(err) => errors.push(err),
        }

        match spawn_windows_rdp_file_via_shell(&rdp_path) {
            Ok(child) => {
                return Ok(SpawnedRdpClient {
                    child,
                    cleanup_path: Some(rdp_path),
                    output_tail: None,
                    output_readers: Vec::new(),
                });
            }
            Err(err) => errors.push(err),
        }
    } else {
        errors.push(
            "mstsc.exe no encontrado en SystemRoot/System32, Sysnative, WINDIR ni PATH".to_string(),
        );
    }

    let _ = std::fs::remove_file(&rdp_path);

    match spawn_windows_rdp_url(host, port, username, domain) {
        Ok(child) => Ok(SpawnedRdpClient {
            child,
            cleanup_path: None,
            output_tail: None,
            output_readers: Vec::new(),
        }),
        Err(url_err) => {
            errors.push(format!("fallback rdp:// falló: {url_err}"));
            Err(format!(
                "No se pudo lanzar RDP en Windows:\n- {}",
                errors.join("\n- ")
            ))
        }
    }
}

#[cfg(target_os = "windows")]
fn write_windows_rdp_file(
    host: &str,
    port: u16,
    username: &str,
    domain: Option<&str>,
    display: RdpDisplay,
    cred_injected: bool,
) -> Result<PathBuf, String> {
    let domain = domain.unwrap_or("").trim();
    let mut rdp_content =
        format!("full address:s:{host}:{port}\r\nusername:s:{username}\r\n");
    rdp_content.push_str(&display.rdp_file_lines(DEFAULT_RDP_WIDTH, DEFAULT_RDP_HEIGHT));
    if !cred_injected {
        // Sin credencial inyectada, que mstsc pida la contraseña una sola vez.
        // Con ella, esta línea sobra: forzaría el segundo prompt que motivó
        // el reporte de la doble petición de credenciales.
        rdp_content.push_str("promptcredentialonce:i:1\r\n");
    }
    if !domain.is_empty() {
        rdp_content.push_str(&format!("domain:s:{domain}\r\n"));
    }

    let rdp_path = std::env::temp_dir().join(format!("rustty_{}.rdp", uuid::Uuid::new_v4()));
    std::fs::write(&rdp_path, rdp_content)
        .map_err(|e| format!("Error al crear fichero RDP temporal: {e}"))?;
    Ok(rdp_path)
}

#[cfg(target_os = "windows")]
fn resolve_mstsc_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for var in ["SystemRoot", "WINDIR"] {
        if let Some(root) = std::env::var_os(var) {
            let root = PathBuf::from(root);
            candidates.push(root.join("System32").join("mstsc.exe"));
            candidates.push(root.join("Sysnative").join("mstsc.exe"));
        }
    }

    if let Some(path) = find_exe_on_path("mstsc.exe") {
        candidates.push(path);
    }

    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn find_exe_on_path(exe: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(exe))
        .find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn spawn_windows_mstsc(
    mstsc_path: &std::path::Path,
    rdp_path: &std::path::Path,
) -> Result<std::process::Child, String> {
    let mut child = std::process::Command::new(mstsc_path)
        .arg(rdp_path)
        .spawn()
        .map_err(|e| format!("Error al lanzar {}: {e}", mstsc_path.display()))?;

    ensure_process_did_not_fail_immediately(&mut child, "mstsc.exe", false)?;
    Ok(child)
}

#[cfg(target_os = "windows")]
fn spawn_windows_rdp_file_via_shell(
    rdp_path: &std::path::Path,
) -> Result<std::process::Child, String> {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "start", "\"\"", "/WAIT"])
        .arg(rdp_path)
        .spawn()
        .map_err(|e| format!("Error al abrir .rdp con cmd/start: {e}"))?;

    ensure_process_did_not_fail_immediately(&mut child, "cmd start /WAIT .rdp", true)?;
    Ok(child)
}

#[cfg(target_os = "windows")]
fn spawn_windows_rdp_url(
    host: &str,
    port: u16,
    username: &str,
    domain: Option<&str>,
) -> Result<std::process::Child, String> {
    let url = build_windows_rdp_url(host, port, username, domain);
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "start", "\"\"", "/WAIT"])
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Error al abrir URL rdp://: {e}"))?;

    ensure_process_did_not_fail_immediately(&mut child, "cmd start /WAIT rdp://", true)?;
    Ok(child)
}

#[cfg(target_os = "windows")]
fn build_windows_rdp_url(host: &str, port: u16, username: &str, domain: Option<&str>) -> String {
    let full_address = format!("{host}:{port}");
    let mut url = format!(
        "rdp://full%20address=s:{full_address}&username=s:{}",
        urlencoding::encode(username)
    );
    if let Some(domain) = domain.map(str::trim).filter(|d| !d.is_empty()) {
        url.push_str("&domain=s:");
        url.push_str(&urlencoding::encode(domain));
    }
    url
}

#[cfg(target_os = "windows")]
fn ensure_process_did_not_fail_immediately(
    child: &mut std::process::Child,
    label: &str,
    accept_quick_success: bool,
) -> Result<(), String> {
    std::thread::sleep(std::time::Duration::from_millis(700));
    match child.try_wait() {
        Ok(Some(status)) if status.success() && accept_quick_success => Ok(()),
        Ok(Some(status)) if status.success() => Err(format!(
            "{label} terminó inmediatamente con código 0; se probará otro método"
        )),
        Ok(Some(status)) => Err(format!(
            "{label} terminó inmediatamente con {}",
            format_exit_status(status)
        )),
        Ok(None) => Ok(()),
        Err(e) => Err(format!("No se pudo comprobar el estado de {label}: {e}")),
    }
}

#[cfg(target_os = "windows")]
fn format_exit_status(status: std::process::ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("código {code}"),
        None => "salida sin código".to_string(),
    }
}

/// macOS: abre la URL rdp:// con el cliente registrado (Microsoft Remote Desktop)
#[cfg(target_os = "macos")]
fn spawn_rdp_client(
    host: &str,
    port: u16,
    username: &str,
    _domain: Option<&str>,
    _password: Option<&str>,
    _display: RdpDisplay,
    _cred_injected: bool,
) -> Result<SpawnedRdpClient, String> {
    // Codificamos el usuario (igual que la variante Windows): un `DOMINIO\usuario`,
    // espacios o `&` romperían la URL o inyectarían parámetros sin escapar.
    let enc_user = urlencoding::encode(username);
    let url = format!("rdp://full%20address=s:{host}:{port}&username=s:{enc_user}");
    let child = std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Error al abrir cliente RDP: {e}"))?;
    Ok(SpawnedRdpClient {
        child,
        cleanup_path: None,
        output_tail: None,
        output_readers: Vec::new(),
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Cola real de un xfreerdp 3.27 que no pudo conectar (formato wlog).
    const FREERDP_CONNECT_FAIL: &str = "\
[14:16:32:577] [874587:000d585e] [WARN][com.freerdp.client.x11] - [load_map_from_xkbfile]: keycode: 0x08 -> no RDP scancode found\n\
[14:16:32:589] [874587:000d585e] [ERROR][com.freerdp.core] - [get_next_addrinfo]: ERRCONNECT_CONNECT_FAILED [0x00020006]\n\
[14:16:32:589] [874587:000d585e] [ERROR][com.freerdp.core] - [freerdp_tcp_default_connect]: Couldn't get socket ip address\n\
[14:16:32:589] [874587:000d585e] [ERROR][com.freerdp.core.nego] - [nego_connect]: Failed to connect\n";

    #[test]
    fn detail_extrae_solo_lineas_error_sin_prefijo_wlog() {
        let detail = extract_error_detail(FREERDP_CONNECT_FAIL).unwrap();
        assert!(detail.starts_with("[ERROR]"));
        assert!(detail.contains("Failed to connect"));
        assert!(!detail.contains("[WARN]"));
        assert!(!detail.contains("14:16:32"));
    }

    #[test]
    fn detail_sin_errores_toma_las_ultimas_lineas() {
        let tail = "linea 1\nlinea 2\n\nlinea 3\nlinea 4\n";
        let detail = extract_error_detail(tail).unwrap();
        assert_eq!(detail, "linea 2\nlinea 3\nlinea 4");
        assert!(extract_error_detail("").is_none());
        assert!(extract_error_detail("\n  \n").is_none());
    }

    #[test]
    fn detail_largo_conserva_el_final() {
        let mut tail = String::new();
        for i in 0..200 {
            tail.push_str(&format!("[ERROR][mod] - fallo número {i}\n"));
        }
        let detail = extract_error_detail(&tail).unwrap();
        assert!(detail.len() <= DETAIL_MAX);
        assert!(detail.ends_with("fallo número 199"));
    }

    #[test]
    fn cert_changed_detecta_aviso_de_freerdp() {
        let banner = "\
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
@           WARNING: CERTIFICATE HAS CHANGED!             @\n\
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
The certificate for host.example.com:3389 has changed\n";
        assert!(is_cert_changed(banner));
        assert!(is_cert_changed(
            "[ERROR][com.freerdp.crypto] - The host key for 10.0.0.2:3389 has changed"
        ));
        assert!(!is_cert_changed(FREERDP_CONNECT_FAIL));
        assert!(!is_cert_changed(""));
    }

    // Cola real de un FreeRDP 3.30 al que no se le pudo dar la contraseña:
    // intenta preguntarla por el terminal y, sin tty, cancela la conexión.
    const FREERDP_NO_PASSWORD: &str = "\
[20:06:58:790] [1910704:001d27b3] [ERROR][com.freerdp.utils.passphrase] - [set_termianl_nonblock]: tcgetattr() failed with Inappropriate ioctl for device\n\
[20:06:58:790] [1910704:001d27b3] [ERROR][com.freerdp.utils.passphrase] - [set_termianl_nonblock]: tcsetattr(TCSANOW) failed with Inappropriate ioctl for device\n\
[20:06:58:790] [1910704:001d27b3] [ERROR][com.freerdp.core] - [nla_client_setup_identity]: ERRCONNECT_CONNECT_CANCELLED [0x0002000B]\n\
[20:06:58:790] [1910704:001d27b3] [ERROR][com.freerdp.core.transport] - [transport_connect_nla]: NLA begin failed\n";

    #[test]
    fn modo_de_pantalla_por_defecto_deja_la_ventana_redimensionable() {
        // Lo que arregla el reporte: sin `/dynamic-resolution` xfreerdp clava la
        // ventana y no deja maximizar ni ir a pantalla completa.
        let args = RdpDisplay::default().freerdp_args(1280, 800);
        assert!(args.contains(&"/dynamic-resolution".to_string()));
        assert!(args.contains(&"/w:1280".to_string()));
        assert!(args.contains(&"/h:800".to_string()));

        // El modo heredado sigue disponible para servidores sin Display Control.
        let fijo = RdpDisplay::Fixed.freerdp_args(1280, 800);
        assert!(!fijo.contains(&"/dynamic-resolution".to_string()));
        assert_eq!(fijo, vec!["/w:1280".to_string(), "/h:800".to_string()]);

        assert!(RdpDisplay::Fullscreen.freerdp_args(1280, 800).contains(&"/f".to_string()));
        assert!(RdpDisplay::WorkArea.freerdp_args(1280, 800).contains(&"/workarea".to_string()));
    }

    #[test]
    fn modo_de_pantalla_desconocido_cae_en_el_por_defecto() {
        assert_eq!(RdpDisplay::parse(Some("fullscreen")), RdpDisplay::Fullscreen);
        assert_eq!(RdpDisplay::parse(Some(" workarea ")), RdpDisplay::WorkArea);
        assert_eq!(RdpDisplay::parse(Some("fixed")), RdpDisplay::Fixed);
        // Un perfil viejo, un valor a medio escribir o basura: se conecta igual.
        assert_eq!(RdpDisplay::parse(None), RdpDisplay::Window);
        assert_eq!(RdpDisplay::parse(Some("")), RdpDisplay::Window);
        assert_eq!(RdpDisplay::parse(Some("maximizado")), RdpDisplay::Window);
    }

    #[test]
    fn falta_de_credencial_no_se_confunde_con_otros_fallos() {
        let status = std::process::Command::new("false").status().unwrap();
        let tail = Arc::new(Mutex::new(FREERDP_NO_PASSWORD.to_string()));
        assert_eq!(close_payload(Some(status), Some(&tail)).code, Some("no-password"));

        // Un fallo de red o un certificado cambiado siguen con su propio código.
        assert!(!is_credential_prompt_failure(FREERDP_CONNECT_FAIL));
        assert!(!is_credential_prompt_failure(""));
        // El `tcsetattr` suelto que FreeRDP escribe al salir, sin cancelación
        // de por medio, no basta: eso sale también en conexiones que fueron bien.
        assert!(!is_credential_prompt_failure(
            "[ERROR][com.freerdp.utils.passphrase] - [set_termianl_nonblock]: tcsetattr(TCSANOW) failed"
        ));
    }

    /// El contrato con FreeRDP 3: la orden de `FREERDP_ASKPASS`, ejecutada como
    /// la ejecuta él (por el shell, sin stdin útil), imprime la contraseña que
    /// dejamos en el `memfd` heredado. Si alguien cambia el descriptor, la orden
    /// o el `pre_exec`, esto se cae aquí y no en una conexión real.
    #[cfg(target_os = "linux")]
    #[test]
    fn askpass_lee_la_contrasena_del_fd_heredado() {
        let secret = "contraseña con espacios y ñ";
        let file = secret_memfd(secret).expect("memfd_create");

        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(ASKPASS_COMMAND);
        cmd.stdin(std::process::Stdio::null());
        inherit_secret_fd(&mut cmd, &file);

        let out = cmd.output().expect("ejecutar el helper de askpass");
        assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout), secret);

        // Reabrirlo por `/proc/self/fd` deja el offset a cero: una segunda
        // petición de FreeRDP obtiene la misma contraseña, no una cadena vacía.
        let out = cmd.output().expect("segunda invocación");
        assert_eq!(String::from_utf8_lossy(&out.stdout), secret);
    }

    #[test]
    fn cierre_limpio_no_lleva_codigo() {
        // En Unix un ExitStatus de éxito se obtiene ejecutando un proceso real.
        let status = std::process::Command::new("true").status().unwrap();
        let payload = close_payload(Some(status), None);
        assert!(payload.code.is_none());
        assert!(payload.detail.is_none());

        let status = std::process::Command::new("false").status().unwrap();
        let tail = Arc::new(Mutex::new(FREERDP_CONNECT_FAIL.to_string()));
        let payload = close_payload(Some(status), Some(&tail));
        assert_eq!(payload.code, Some("error"));
        assert!(payload.detail.unwrap().contains("Failed to connect"));
    }
}
