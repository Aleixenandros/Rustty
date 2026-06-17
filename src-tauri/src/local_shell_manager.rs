use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
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
    sessions: Mutex<HashMap<String, ShellHandle>>,
}

impl LocalShellManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Abre una nueva sesión de shell local.
    /// Emite:
    ///   `shell-data-{id}`   → Vec<u8> con bytes del shell
    ///   `shell-closed-{id}` → el proceso del shell terminó
    pub fn open(
        &self,
        session_id: String,
        app_handle: AppHandle,
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

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Error al clonar lector PTY: {e}"))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Error al tomar escritor PTY: {e}"))?;
        let master = pair.master;

        let (cmd_tx, cmd_rx) = mpsc::channel::<ShellCommand>();
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), ShellHandle { cmd_tx, shell_pid });

        // ── Hilo de lectura: shell → frontend ────────────────────
        let sid_r = session_id.clone();
        let app_r = app_handle;
        std::thread::spawn(move || {
            // Buffer holgado (64 KiB): con salidas masivas (`cat` de un log
            // grande) `read` devuelve bloques cercanos al tamaño del buffer, así
            // que emitimos muchos menos eventos IPC que con 4 KiB y aliviamos el
            // hilo de UI, que es donde se notaba el cuelgue.
            let mut buf = [0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = app_r.emit(&event_name(EventKind::ShellClosed, &sid_r), ());
                        break;
                    }
                    Ok(n) => {
                        let _ = app_r.emit(&event_name(EventKind::ShellData, &sid_r), buf[..n].to_vec());
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
    return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    #[cfg(not(windows))]
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
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
