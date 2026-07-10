use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::ipc::{event_name, EventKind};

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
/// servidor cambió respecto al recordado por el cliente; `"error"` cualquier
/// otra terminación con fallo (el detalle lleva la cola de salida del cliente).
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
    pub fn launch(
        &self,
        session_id: String,
        profile_id: String,
        host: &str,
        port: u16,
        username: &str,
        domain: Option<&str>,
        password: Option<&str>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
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

        let spawned = match spawn_rdp_client(host, port, username, domain, password, cred_host.is_some()) {
            Ok(s) => s,
            Err(e) => {
                if let Some(h) = cred_host.take() {
                    release_windows_credential(&self.cred_guards, &h);
                }
                return Err(e);
            }
        };

        self.sessions.lock().unwrap().insert(
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
                let mut map = sessions.lock().unwrap();
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
        if let Some(mut handle) = self.sessions.lock().unwrap().remove(session_id) {
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
        .map(|t| t.lock().unwrap().clone())
        .unwrap_or_default();
    let code = if is_cert_changed(&tail) {
        "cert-changed"
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
                    let mut t = tail.lock().unwrap();
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

    let entry = keyring::Entry::new_with_target(&target, "rustty", &user)
        .map_err(|e| format!("credencial TERMSRV: {e}"))?;

    let mut guards = guards.lock().unwrap();
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
        let mut map = guards.lock().unwrap();
        let Some(g) = map.get_mut(host) else { return };
        g.refs = g.refs.saturating_sub(1);
        if g.refs > 0 {
            return;
        }
        let delete = g.delete_on_close;
        map.remove(host);
        if delete {
            let target = format!("TERMSRV/{host}");
            if let Ok(entry) = keyring::Entry::new_with_target(&target, "rustty", "") {
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

    // La contraseña se entrega por stdin, nunca por argv: un `/p:<pass>` o
    // `-p <pass>` queda visible en `ps` / `/proc/<pid>/cmdline` mientras dura
    // la sesión (el propio `man rdesktop` lo advierte).
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
        cmd.arg("-g").arg("1280x800");
        cmd.arg("-r").arg("clipboard:CLIPBOARD");
        cmd.arg(format!("{host}:{port}"));
    } else {
        cmd.arg(format!("/v:{host}:{port}"));
        cmd.arg(format!("/u:{username}"));
        if let Some(d) = domain.filter(|d| !d.is_empty()) {
            cmd.arg(format!("/d:{d}"));
        }
        if secret.is_some() {
            cmd.arg("/from-stdin"); // lee la contraseña de stdin
        }
        cmd.arg("+clipboard");
        // TOFU en vez de `/cert:ignore`: xfreerdp recuerda el certificado del
        // host y avisa si cambia (coherente con el TOFU de host keys de SSH),
        // en vez de aceptar cualquier certificado en silencio.
        cmd.arg("/cert:tofu");
        // Arrancar en ventana normal (sin fullscreen forzado)
        cmd.arg("/w:1280");
        cmd.arg("/h:800");
    }

    if secret.is_some() {
        cmd.stdin(std::process::Stdio::piped());
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
    cred_injected: bool,
) -> Result<SpawnedRdpClient, String> {
    let rdp_path = write_windows_rdp_file(host, port, username, domain, cred_injected)?;
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
    cred_injected: bool,
) -> Result<PathBuf, String> {
    let domain = domain.unwrap_or("").trim();
    let mut rdp_content =
        format!("full address:s:{host}:{port}\r\nusername:s:{username}\r\n");
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
