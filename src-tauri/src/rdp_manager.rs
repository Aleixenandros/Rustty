use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Información de una sesión RDP activa
pub struct RdpHandle {
    pub child: std::process::Child,
    pub cleanup_path: Option<PathBuf>,
    #[allow(dead_code)]
    pub profile_id: String,
}

struct SpawnedRdpClient {
    child: std::process::Child,
    cleanup_path: Option<PathBuf>,
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
        let spawned = spawn_rdp_client(host, port, username, domain, password)?;

        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            RdpHandle {
                child: spawned.child,
                cleanup_path: spawned.cleanup_path,
                profile_id,
            },
        );

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
                            let handle = map.remove(&sid);
                            if let Some(path) = handle.and_then(|h| h.cleanup_path) {
                                let _ = std::fs::remove_file(path);
                            }
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
            if let Some(path) = handle.cleanup_path.take() {
                let _ = std::fs::remove_file(path);
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
        }
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

    let mut cmd = std::process::Command::new(binary);
    if binary == "rdesktop" {
        cmd.arg("-u").arg(username);
        if let Some(d) = domain.filter(|d| !d.is_empty()) {
            cmd.arg("-d").arg(d);
        }
        if let Some(p) = password.filter(|p| !p.is_empty()) {
            cmd.arg("-p").arg(p);
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
        if let Some(p) = password.filter(|p| !p.is_empty()) {
            cmd.arg(format!("/p:{p}"));
        }
        cmd.arg("+clipboard");
        cmd.arg("/cert:ignore");
        // Arrancar en ventana normal (sin fullscreen forzado)
        cmd.arg("/w:1280");
        cmd.arg("/h:800");
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Error al lanzar {binary}: {e}"))?;
    Ok(SpawnedRdpClient {
        child,
        cleanup_path: None,
    })
}

/// Windows: escribe un archivo .rdp temporal y lo abre con mstsc.exe
#[cfg(target_os = "windows")]
fn spawn_rdp_client(
    host: &str,
    port: u16,
    username: &str,
    domain: Option<&str>,
    _password: Option<&str>, // mstsc no acepta contraseñas por línea de comandos
) -> Result<SpawnedRdpClient, String> {
    let rdp_path = write_windows_rdp_file(host, port, username, domain)?;
    let mut errors = Vec::new();

    if let Some(mstsc) = resolve_mstsc_path() {
        match spawn_windows_mstsc(&mstsc, &rdp_path) {
            Ok(child) => {
                return Ok(SpawnedRdpClient {
                    child,
                    cleanup_path: Some(rdp_path),
                });
            }
            Err(err) => errors.push(err),
        }

        match spawn_windows_rdp_file_via_shell(&rdp_path) {
            Ok(child) => {
                return Ok(SpawnedRdpClient {
                    child,
                    cleanup_path: Some(rdp_path),
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
) -> Result<PathBuf, String> {
    let domain = domain.unwrap_or("").trim();
    let mut rdp_content = format!(
        "full address:s:{host}:{port}\r\nusername:s:{username}\r\npromptcredentialonce:i:1\r\n"
    );
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
) -> Result<SpawnedRdpClient, String> {
    let url = format!("rdp://full%20address=s:{host}:{port}&username=s:{username}");
    let child = std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Error al abrir cliente RDP: {e}"))?;
    Ok(SpawnedRdpClient {
        child,
        cleanup_path: None,
    })
}
