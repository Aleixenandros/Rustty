use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};

use crate::locks::MutexExt;

use portable_pty::{native_pty_system, PtySize};
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

/// Opciones de apertura de una consola local. Las dicta el `invoke` del
/// frontend (`opts` de `local_shell_open`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellOptions {
    /// Directorio inicial; vacío o inexistente = carpeta personal.
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Integración de shell (OSC 133 / OSC 7) en bash y zsh. Opt-in.
    #[serde(default)]
    pub shell_integration: bool,
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
    ///
    /// `integration_dir` es el directorio de datos donde dejar los ficheros de
    /// arranque de la integración de shell; `None` = consola sin integración.
    pub fn open(
        &self,
        session_id: String,
        app_handle: AppHandle,
        on_data: Channel<Response>,
        opts: LocalShellOptions,
        integration_dir: Option<PathBuf>,
    ) -> Result<(), String> {
        let LocalShellOptions {
            cwd, cols, rows, ..
        } = opts;
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Error al abrir PTY: {e}"))?;

        // cwd inicial: la ruta configurada si existe como directorio; en otro
        // caso (vacía, inexistente o no es carpeta) caemos a la carpeta personal.
        let resolved_cwd = cwd
            .filter(|p| !p.trim().is_empty())
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(dirs::home_dir);

        let shell = get_default_shell();
        let cmd = build_command(&shell, resolved_cwd.as_deref(), integration_dir.as_deref());
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
            .lock_recover()
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
                        // El shell terminó. Antes de avisar, la **marca de fin**:
                        // un bloque vacío por el mismo Channel que los datos. El
                        // cierre viaja por un evento y la salida por el Channel
                        // —dos caminos—, y el evento puede adelantar al último
                        // bloque; el Channel sí ordena sus mensajes, así que el
                        // frontend sabe con esta marca que ya lo ha visto todo y
                        // pinta «el shell ha terminado» DESPUÉS de la salida.
                        let _ = on_data.send(Response::new(Vec::new()));
                        // Retira el handle muerto del mapa antes de avisar al
                        // frontend (evita acumular sesiones cerradas si el
                        // usuario no cierra la pestaña).
                        sessions_r.lock_recover().remove(&sid_r);
                        let _ = app_r.emit(&event_name(EventKind::ShellClosed, &sid_r), ());
                        break;
                    }
                    Ok(n) => {
                        // Bytes crudos por el Channel binario (sin JSON).
                        if on_data.send(Response::new(buf[..n].to_vec())).is_err() {
                            // El Channel ha muerto: el webview se recargó o la
                            // ventana cayó, y con él quien leía y quien podía
                            // cerrar esta consola. Salir sin más dejaba el shell
                            // vivo y huérfano hasta cerrar la app.
                            log::warn!("consola local {sid_r}: canal de datos roto, se cierra el shell");
                            if let Some(handle) = sessions_r.lock_recover().remove(&sid_r) {
                                let _ = handle.cmd_tx.send(ShellCommand::Close);
                            }
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
                    // `kill` (SIGHUP, y SIGKILL si no basta) no recoge al hijo
                    // cuando acaba en SIGKILL: sin este `wait` quedaba un
                    // zombi por consola hasta salir de la app. Tras un kill no
                    // bloquea: el proceso ya está muerto o a punto.
                    let _ = child.wait();
                    break;
                }
            }
        });

        Ok(())
    }

    pub fn send_input(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        let map = self.sessions.lock_recover();
        let handle = map
            .get(session_id)
            .ok_or_else(|| format!("Sesión de shell no encontrada: {session_id}"))?;
        handle
            .cmd_tx
            .send(ShellCommand::Input(data))
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.sessions.lock_recover();
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
            let map = self.sessions.lock_recover();
            match map.get(session_id) {
                Some(h) => h.shell_pid,
                None => return false,
            }
        };
        let Some(pid) = pid else { return false };
        has_child_processes(pid)
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        if let Some(handle) = self.sessions.lock_recover().remove(session_id) {
            let _ = handle.cmd_tx.send(ShellCommand::Close);
        }
        Ok(())
    }

    /// Cierra todas las consolas y devuelve cuántas había.
    pub fn close_all(&self) -> usize {
        let handles: Vec<_> = self
            .sessions
            .lock_recover()
            .drain()
            .map(|(_, h)| h)
            .collect();
        let count = handles.len();
        for handle in handles {
            let _ = handle.cmd_tx.send(ShellCommand::Close);
        }
        count
    }
}

/// Comando con el que nace el shell: programa, carpeta, integración de shell
/// (opt-in) y entorno de terminal. Separado de `open` para poder probarlo sin
/// abrir un PTY.
fn build_command(
    shell: &str,
    cwd: Option<&std::path::Path>,
    integration_dir: Option<&std::path::Path>,
) -> portable_pty::CommandBuilder {
    // Dentro de Flatpak el shell nace en el host (`flatpak-spawn --host`):
    // el del contenedor no tiene los dotfiles ni las herramientas del
    // usuario. Fuera del sandbox esto es un `CommandBuilder` normal.
    let mut cmd = crate::sandbox::host_pty_command(shell, cwd);
    // Integración de shell (opt-in): marcas OSC 133 / OSC 7 sin tocar los
    // dotfiles del usuario. Si los ficheros de arranque no se pueden escribir,
    // la consola abre igual, sin marcas: un fallo de disco no puede dejar al
    // usuario sin consola.
    if let Some(dir) = integration_dir {
        let kind = crate::shell_integration::ShellKind::detect(shell);
        match crate::shell_integration::prepare(dir, kind) {
            Ok(Some(launch)) => {
                for arg in launch.args {
                    cmd.arg(arg);
                }
                for (key, value) in launch.env {
                    cmd.env(key, value);
                }
            }
            Ok(None) => {}
            Err(err) => {
                log::warn!("integración de shell no disponible para {shell}: {err}");
            }
        }
    }
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
    cmd
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
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        // `$SHELL` es el login shell real del usuario. Dentro de Flatpak esa
        // variable describe el contenedor, así que `host_login_shell` la
        // sustituye por la del sistema anfitrión (`getent passwd`).
        if let Some(shell) = crate::sandbox::host_login_shell() {
            return shell;
        }
        // Caemos a bash y luego a sh para no quedarnos sin consola en sistemas
        // mínimos. Bajo Flatpak estas rutas son las del runtime, pero solo se
        // llega aquí si la consulta al host ya ha fallado.
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
///
/// Bajo Flatpak la respuesta también es siempre `false`: el hijo del PTY es
/// `flatpak-spawn`, y el shell real vive en el espacio de PIDs del host, que
/// `pgrep` no alcanza desde el sandbox. Es la misma degradación conservadora
/// que en Windows —no se avisa de procesos activos al cerrar la consola—, no
/// un cierre forzado de nada.
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

#[cfg(test)]
mod tests {
    use super::LocalShellOptions;

    /// El frontend manda `opts` tal cual lo construye `main.js`: camelCase y
    /// con `cwd` a `null` cuando no hay carpeta configurada. Si este contrato
    /// se rompe, ninguna consola local vuelve a abrir.
    #[test]
    fn las_opciones_de_la_consola_se_leen_como_las_manda_el_frontend() {
        let opts: LocalShellOptions = serde_json::from_str(
            r#"{"cwd":null,"cols":120,"rows":30,"shellIntegration":true}"#,
        )
        .unwrap();
        assert_eq!(opts.cwd, None);
        assert_eq!((opts.cols, opts.rows), (120, 30));
        assert!(opts.shell_integration);

        // Un frontend anterior (sin el campo) sigue abriendo consolas, sin
        // integración.
        let legacy: LocalShellOptions =
            serde_json::from_str(r#"{"cwd":"/tmp","cols":80,"rows":24}"#).unwrap();
        assert_eq!(legacy.cwd.as_deref(), Some("/tmp"));
        assert!(!legacy.shell_integration);
    }

    fn argv(cmd: &portable_pty::CommandBuilder) -> Vec<String> {
        cmd.get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    /// El comando del shell sin abrir un PTY: entorno de terminal siempre, y
    /// los argumentos de la integración solo cuando se pide (es opt-in).
    #[test]
    fn el_comando_lleva_el_entorno_de_terminal_y_la_integracion_solo_si_se_pide() {
        let plain = super::build_command("/bin/bash", None, None);
        assert_eq!(argv(&plain), vec!["/bin/bash".to_string()]);
        assert_eq!(plain.get_env("TERM").and_then(|v| v.to_str()), Some("xterm-256color"));
        assert_eq!(plain.get_env("COLORTERM").and_then(|v| v.to_str()), Some("truecolor"));

        let dir = std::env::temp_dir().join(format!(
            "rustty-shell-cmd-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let integrated = super::build_command("/bin/bash", None, Some(&dir));
        let args = argv(&integrated);
        assert_eq!(args[0], "/bin/bash");
        assert_eq!(args[1], "--rcfile");
        assert!(args[2].ends_with("rustty-bash.sh"), "{args:?}");

        // Un shell sin integración (sh) arranca igual que sin ella.
        let sh = super::build_command("/bin/sh", None, Some(&dir));
        assert_eq!(argv(&sh), vec!["/bin/sh".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Cerrar una consola es matar **y recoger**. `kill` de portable-pty manda
    /// SIGHUP y, si no basta, SIGKILL sin `wait`: un hijo que ignora SIGHUP
    /// quedaba zombi hasta salir de la app, uno por consola cerrada. El hilo de
    /// control hace `kill` + `wait`; aquí se comprueba que, con ese par, del
    /// proceso no queda ni la entrada en `/proc`.
    #[cfg(target_os = "linux")]
    #[test]
    fn un_shell_que_ignora_sighup_no_queda_zombi_tras_cerrar() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("abrir PTY");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        // Ignora SIGHUP y se queda esperando: fuerza el camino SIGKILL.
        cmd.arg("trap '' HUP; sleep 60");
        let mut child = pair.slave.spawn_command(cmd).expect("lanzar sh");
        drop(pair.slave);
        let pid = child.process_id().expect("pid");
        // Margen para que el `trap` esté instalado antes del SIGHUP.
        std::thread::sleep(std::time::Duration::from_millis(200));

        let _ = child.kill();
        let _ = child.wait();

        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        assert!(
            stat.is_empty(),
            "el shell sigue en la tabla de procesos (¿zombi?): {stat}"
        );
    }
}
