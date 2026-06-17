use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter};

use crate::ipc::{event_name, EventKind};

enum ShellCommand {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

struct ShellHandle {
    cmd_tx: mpsc::Sender<ShellCommand>,
    /// PID del proceso shell (el proceso raíz del PTY).
    /// Se usa para detectar si hay procesos hijos activos antes de cerrar.
    shell_pid: Option<u32>,
}

/// Gestor de sesiones de shell local.
/// Usa un PTY nativo para una experiencia de terminal completa
/// (colores, readline, vim, top, etc.).
pub struct LocalShellManager {
    // `Arc` para que el hilo de lectura pueda retirar su propia entrada del mapa
    // cuando el shell termina, sin dejar handles muertos acumulados.
    sessions: Arc<Mutex<HashMap<String, ShellHandle>>>,
}

impl LocalShellManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Abre una nueva sesión de shell local.
    ///
    /// Los bytes del shell se entregan por `on_data` (`tauri::ipc::Channel`),
    /// que viaja como `ArrayBuffer` binario sin pasar por JSON. El lector usa
    /// bloques de 64 KiB, muy por encima del umbral de Tauri para el canal
    /// binario nativo (1 KiB), así que no requiere coalescing adicional.
    ///
    /// Emite (vía eventos, baja frecuencia):
    ///   `shell-closed-{id}` → el proceso del shell terminó
    pub fn open(
        &self,
        session_id: String,
        app_handle: AppHandle,
        on_data: Channel<Response>,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Error al abrir PTY: {e}"))?;

        let shell = get_default_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        // Color verdadero en apps que lo detectan por COLORTERM (vim, bat, delta…).
        cmd.env("COLORTERM", "truecolor");
        // Locale UTF-8 cuando el entorno no define ninguno, para que readline y
        // las TUIs no caigan a ASCII/Latin-1. Solo Unix: en Windows ConPTY usa
        // UTF-16/UTF-8 y forzar un locale rompería más de lo que arregla.
        #[cfg(unix)]
        if std::env::var_os("LC_ALL").is_none()
            && std::env::var_os("LC_CTYPE").is_none()
            && std::env::var_os("LANG").is_none()
        {
            cmd.env("LANG", "C.UTF-8");
            cmd.env("LC_CTYPE", "C.UTF-8");
        }
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Error al iniciar {shell}: {e}"))?;

        // Capturar el PID del shell antes de mover `child` al hilo de control.
        let shell_pid = child.process_id();

        // Cerrar el extremo slave en el proceso padre (necesario en Unix)
        drop(pair.slave);

        // Si algún paso posterior al spawn falla, matamos el hijo para no dejar
        // un proceso shell huérfano sin nadie que lo lea ni lo cierre.
        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                let _ = child.kill();
                return Err(format!("Error al clonar lector PTY: {e}"));
            }
        };
        let mut writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                let _ = child.kill();
                return Err(format!("Error al tomar escritor PTY: {e}"));
            }
        };
        let master = pair.master;

        let (cmd_tx, cmd_rx) = mpsc::channel::<ShellCommand>();
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), ShellHandle { cmd_tx, shell_pid });

        // ── Hilo de lectura: shell → frontend ────────────────────
        let sid_r = session_id.clone();
        let app_r = app_handle;
        let sessions_r = Arc::clone(&self.sessions);
        std::thread::spawn(move || {
            // Buffer holgado (64 KiB): con salidas masivas (`cat` de un log
            // grande) `read` devuelve bloques cercanos al tamaño del buffer, así
            // que enviamos muchos menos mensajes IPC que con 4 KiB y aliviamos el
            // hilo de UI, que es donde se notaba el cuelgue.
            let mut buf = [0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        // El shell terminó: retira el handle muerto del mapa
                        // antes de avisar al frontend (evita acumular sesiones
                        // cerradas si el usuario no cierra la pestaña).
                        sessions_r.lock().unwrap().remove(&sid_r);
                        let _ = app_r.emit(&event_name(EventKind::ShellClosed, &sid_r), ());
                        break;
                    }
                    Ok(n) => {
                        // Bytes crudos por el Channel binario (sin JSON).
                        if on_data.send(Response::new(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // ── Hilo de escritura + control: frontend → shell ─────────
        std::thread::spawn(move || loop {
            match cmd_rx.recv() {
                Ok(ShellCommand::Input(data)) => {
                    let _ = writer.write_all(&data);
                }
                Ok(ShellCommand::Resize { cols, rows }) => {
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                Ok(ShellCommand::Close) | Err(_) => {
                    let _ = child.kill();
                    break;
                }
            }
        });

        Ok(())
    }

    pub fn send_input(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let handle = map
            .get(session_id)
            .ok_or_else(|| format!("Sesión de shell no encontrada: {session_id}"))?;
        handle
            .cmd_tx
            .send(ShellCommand::Input(data))
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let handle = map
            .get(session_id)
            .ok_or_else(|| format!("Sesión de shell no encontrada: {session_id}"))?;
        handle
            .cmd_tx
            .send(ShellCommand::Resize { cols, rows })
            .map_err(|e| e.to_string())
    }

    /// Devuelve `true` si el shell de la sesión tiene procesos hijos vivos
    /// (p. ej. `vim`, `top`, una compilación). Una consola idle devuelve `false`.
    ///
    /// El objetivo es avisar al usuario antes de cerrar una pestaña ocupada.
    ///
    /// ## Unix (Linux / macOS)
    /// Ejecuta `pgrep -P <pid>` y considera "ocupado" si reporta al menos un
    /// proceso hijo. Si `pgrep` no está disponible devuelve `false` (conservador:
    /// no molesta al usuario cuando no podemos saberlo).
    ///
    /// ## Windows
    /// Devuelve siempre `false` porque la detección fiable de hijos de un proceso
    /// PTY en Windows requiere APIs que añadirían complejidad significativa sin
    /// un beneficio claro. El build de Windows no se ve afectado.
    pub fn has_running_job(&self, session_id: &str) -> bool {
        let pid = {
            let map = self.sessions.lock().unwrap();
            match map.get(session_id) {
                Some(h) => h.shell_pid,
                None => return false,
            }
        };
        let Some(pid) = pid else { return false };
        has_child_processes(pid)
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        if let Some(handle) = self.sessions.lock().unwrap().remove(session_id) {
            let _ = handle.cmd_tx.send(ShellCommand::Close);
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let handles: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, h)| h)
            .collect();
        for handle in handles {
            let _ = handle.cmd_tx.send(ShellCommand::Close);
        }
    }
}

fn get_default_shell() -> String {
    #[cfg(windows)]
    {
        // Preferimos PowerShell moderno (pwsh) → Windows PowerShell → cmd.
        // pwsh.exe no está en una ruta fija, así que lo buscamos en el PATH;
        // powershell.exe y cmd.exe sí viven en System32 pero también se
        // resuelven por PATH, con `%COMSPEC%` como último recurso.
        for candidate in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
            if find_in_path(candidate) {
                return candidate.to_string();
            }
        }
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    }
    #[cfg(not(windows))]
    {
        // `$SHELL` es el login shell real del usuario; caemos a bash y luego a
        // sh para no quedarnos sin consola en sistemas mínimos.
        if let Ok(shell) = std::env::var("SHELL") {
            if !shell.is_empty() {
                return shell;
            }
        }
        for candidate in ["/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        "/bin/sh".to_string()
    }
}

/// Comprueba si `exe` se resuelve en alguno de los directorios del `PATH`.
/// Se usa en Windows para elegir el primer shell disponible sin lanzarlo.
#[cfg(windows)]
fn find_in_path(exe: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(exe).is_file())
}

/// Detecta si el proceso con PID `pid` tiene al menos un proceso hijo vivo.
///
/// En Unix usamos `pgrep -P <pid>`: devuelve código 0 y lista de PIDs si hay
/// hijos, código 1 si no hay ninguno, y falla con otro código o con error de
/// ejecución si `pgrep` no está disponible. En ese último caso devolvemos
/// `false` (conservador: no molestamos al usuario si no podemos comprobarlo).
///
/// En Windows devolvemos siempre `false`: la detección de hijos de un proceso
/// PTY requeriría toolhelp32 o WMI, lo que añade complejidad innecesaria.
/// El comportamiento de Windows queda documentado aquí como limitación conocida.
#[cfg(unix)]
fn has_child_processes(pid: u32) -> bool {
    match std::process::Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
    {
        Ok(out) => out.status.success(),
        // `pgrep` no disponible → conservador: no avisar
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn has_child_processes(_pid: u32) -> bool {
    // Windows: sin detección de hijos de PTY; siempre devuelve false.
    // El cierre de consolas locales en Windows no muestra aviso de proceso activo.
    false
}
