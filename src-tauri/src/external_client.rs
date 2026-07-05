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
        self.sessions.lock().unwrap().insert(
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
                let mut map = sessions.lock().unwrap();
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
        if let Some(mut handle) = self.sessions.lock().unwrap().remove(session_id) {
            let _ = handle.child.kill();
            if let Some(path) = handle.cleanup_path.take() {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn disconnect_all(&self) {
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
    let child = std::process::Command::new(binary)
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
    let child = std::process::Command::new("cmd")
        .args(["/C", "start", "\"\""])
        .arg(format!("vnc://{host}:{port}"))
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

    let mut cmd = std::process::Command::new(term);
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
    let script = format!("tell application \"Terminal\" to do script \"telnet {host} {port}\"");
    let child = std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map_err(|e| format!("Error al abrir Terminal para telnet: {e}"))?;
    Ok(SpawnedExternalClient {
        child,
        cleanup_path: None,
    })
}

#[cfg(target_os = "windows")]
fn spawn_telnet_client(host: &str, port: u16) -> Result<SpawnedExternalClient, String> {
    let child = std::process::Command::new("cmd")
        .args(["/C", "start", "\"\"", "telnet"])
        .arg(host)
        .arg(port.to_string())
        .spawn()
        .map_err(|e| format!("Error al lanzar telnet: {e}"))?;
    Ok(SpawnedExternalClient {
        child,
        cleanup_path: None,
    })
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn which_exists(bin: &str) -> bool {
    std::process::Command::new("which")
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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
