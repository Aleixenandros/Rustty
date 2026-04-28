use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};

enum ShellCommand {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

struct ShellHandle {
    cmd_tx: mpsc::Sender<ShellCommand>,
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
            .insert(session_id.clone(), ShellHandle { cmd_tx });

        // ── Hilo de lectura: shell → frontend ────────────────────
        let sid_r = session_id.clone();
        let app_r = app_handle;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = app_r.emit(&format!("shell-closed-{sid_r}"), ());
                        break;
                    }
                    Ok(n) => {
                        let _ = app_r.emit(&format!("shell-data-{sid_r}"), buf[..n].to_vec());
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
