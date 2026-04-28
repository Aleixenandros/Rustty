use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Información de una sesión RDP activa
pub struct RdpHandle {
    pub child: std::process::Child,
    #[allow(dead_code)]
    pub profile_id: String,
}

/// Gestor de sesiones RDP.
/// Lanza el cliente RDP nativo del SO y vigila su ciclo de vida.
pub struct RdpManager {
    sessions: Arc<Mutex<HashMap<String, RdpHandle>>>,
}

impl RdpManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
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
        let child = spawn_rdp_client(host, port, username, domain, password)?;

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), RdpHandle { child, profile_id });

        // Hilo vigilante: detecta cuándo el proceso externo termina
        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));

            let finished = {
                let mut map = sessions.lock().unwrap();
                if let Some(handle) = map.get_mut(&sid) {
                    match handle.child.try_wait() {
                        Ok(Some(_)) | Err(_) => {
                            map.remove(&sid);
                            true
                        }
                        Ok(None) => false,
                    }
                } else {
                    break; // La sesión fue eliminada por rdp_disconnect
                }
            };

            if finished {
                let _ = app_handle.emit(&format!("rdp-closed-{}", sid), ());
                break;
            }
        });

        Ok(())
    }

    /// Termina el proceso RDP y elimina la sesión
    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        if let Some(mut handle) = self.sessions.lock().unwrap().remove(session_id) {
            let _ = handle.child.kill();
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
        }
    }
}

// ─── Lanzadores por plataforma ────────────────────────────────────────────────

/// Linux: usa xfreerdp3 (preferido) o xfreerdp como fallback
#[cfg(target_os = "linux")]
fn spawn_rdp_client(
    host: &str,
    port: u16,
    username: &str,
    domain: Option<&str>,
    password: Option<&str>,
) -> Result<std::process::Child, String> {
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

    let mut cmd = std::process::Command::new(binary);
    cmd.arg(format!("/v:{host}:{port}"));
    cmd.arg(format!("/u:{username}"));
    if let Some(d) = domain.filter(|d| !d.is_empty()) {
        cmd.arg(format!("/d:{d}"));
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        cmd.arg(format!("/p:{p}"));
    }
    cmd.arg("+clipboard");
    cmd.arg("/cert:ignore");
    // Arrancar en ventana normal (sin fullscreen forzado)
    cmd.arg("/w:1280");
    cmd.arg("/h:800");

    cmd.spawn()
        .map_err(|e| format!("Error al lanzar {binary}: {e}"))
}

/// Windows: escribe un archivo .rdp temporal y lo abre con mstsc.exe
#[cfg(target_os = "windows")]
fn spawn_rdp_client(
    host: &str,
    port: u16,
    username: &str,
    domain: Option<&str>,
    _password: Option<&str>, // mstsc no acepta contraseñas por línea de comandos
) -> Result<std::process::Child, String> {
    let rdp_content = format!(
        "full address:s:{host}:{port}\r\nusername:s:{username}\r\ndomain:s:{domain}\r\npromptcredentialonce:i:1\r\n",
        domain = domain.unwrap_or("")
    );

    let rdp_path = std::env::temp_dir().join(format!("rustty_{}.rdp", uuid::Uuid::new_v4()));
    std::fs::write(&rdp_path, rdp_content)
        .map_err(|e| format!("Error al crear fichero RDP temporal: {e}"))?;

    std::process::Command::new("mstsc")
        .arg(rdp_path.to_string_lossy().as_ref())
        .spawn()
        .map_err(|e| format!("Error al lanzar mstsc.exe: {e}"))
}

/// macOS: abre la URL rdp:// con el cliente registrado (Microsoft Remote Desktop)
#[cfg(target_os = "macos")]
fn spawn_rdp_client(
    host: &str,
    port: u16,
    username: &str,
    _domain: Option<&str>,
    _password: Option<&str>,
) -> Result<std::process::Child, String> {
    let url = format!("rdp://full%20address=s:{host}:{port}&username=s:{username}");
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Error al abrir cliente RDP: {e}"))
}
