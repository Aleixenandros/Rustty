//! Ejecución **acotada** de los «Comandos locales» del catálogo del usuario.
//!
//! El catálogo lo define el propio usuario en su equipo (no hay allowlist: es su
//! shell), pero un comando que no termina (`yes`, un hijo que se queda colgado,
//! un `tail -f` despistado) no puede secuestrar un worker ni reventar la RAM del
//! proceso. Este módulo envuelve la ejecución con cuatro garantías:
//!
//! 1. **Timeout** configurable en Preferencias y desactivable (`0` = sin límite).
//! 2. **Cancelación** desde la UI mediante `run_id` ([`LocalCommandRegistry`]).
//! 3. **Límite de salida** por flujo, con lectura incremental: se acumulan como
//!    mucho `max_output_bytes` de stdout y otros tantos de stderr, pero se sigue
//!    **drenando** la tubería para que el hijo no se bloquee al llenarla. El
//!    resultado indica si hubo truncado.
//! 4. **Terminación del árbol de procesos**: el hijo se lanza en su propio grupo
//!    (Unix) y al cancelar/expirar se señaliza al grupo entero, de modo que los
//!    nietos que el shell haya dejado (pipelines, `&`) mueren con él. En Windows
//!    se usa `taskkill /T /F`, que recorre el árbol.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::locks::MutexExt;

/// Timeout por defecto cuando el frontend no manda uno (segundos).
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Tope duro del timeout configurable (1 hora): evita que un valor absurdo
/// convierta la opción «desactivar» en algo indistinguible de un cuelgue.
pub const MAX_TIMEOUT_SECS: u64 = 3600;
/// Salida acumulada por defecto y por flujo (stdout y stderr por separado).
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// Tope duro de la salida acumulada por flujo (8 MiB): el resto se descarta.
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
/// Margen entre la señal de terminación amable y el `SIGKILL`/`taskkill`.
const GRACE_PERIOD: Duration = Duration::from_secs(2);
/// Cadencia del bucle de espera (try_wait + comprobación de cancelación).
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Resultado de un comando local acotado.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// `true` si stdout o stderr superaron el límite y se descartó el exceso.
    pub truncated: bool,
    /// `true` si el comando se detuvo por agotar el plazo.
    pub timed_out: bool,
    /// `true` si el usuario lo canceló desde la UI.
    pub canceled: bool,
    pub duration_ms: u64,
}

/// Comando en ejecución: su PID (para matar el árbol) y la bandera que la UI
/// levanta al cancelar.
struct RunningCommand {
    pid: u32,
    cancel: Arc<AtomicBool>,
}

/// Registro de los comandos locales vivos, indexados por el `run_id` que asigna
/// el frontend. Vive como `State` de Tauri para que `local_command_cancel`
/// pueda alcanzar a un comando lanzado por otra invocación. Es `Clone` (comparte
/// el mapa) para poder llevárselo al hilo de `spawn_blocking` que ejecuta.
#[derive(Default, Clone)]
pub struct LocalCommandRegistry {
    running: Arc<Mutex<HashMap<String, RunningCommand>>>,
}

impl LocalCommandRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Marca el comando `run_id` como cancelado y mata su árbol de procesos.
    /// Devuelve `false` si ese `run_id` ya no está corriendo (terminó justo
    /// antes, o nunca existió): el llamador puede ignorarlo sin más.
    pub fn cancel(&self, run_id: &str) -> bool {
        let guard = self.running.lock_recover();
        let Some(entry) = guard.get(run_id) else {
            return false;
        };
        entry.cancel.store(true, Ordering::SeqCst);
        let pid = entry.pid;
        drop(guard);
        // El bucle de espera detecta la bandera y remata con el grace period;
        // la señal amable se manda ya para que un comando obediente termine sin
        // esperar al siguiente tick.
        terminate_tree(pid);
        true
    }

    fn register(&self, run_id: &str, pid: u32, cancel: Arc<AtomicBool>) {
        self.running
            .lock_recover()
            .insert(run_id.to_string(), RunningCommand { pid, cancel });
    }

    fn unregister(&self, run_id: &str) {
        self.running.lock_recover().remove(run_id);
    }

    /// Ejecuta `command` con el shell del SO (`sh -c` en Unix, `cmd /C` en
    /// Windows) capturando su salida de forma acotada. Bloquea el hilo llamador:
    /// el comando Tauri lo llama dentro de `spawn_blocking`.
    pub fn run_blocking(
        &self,
        run_id: &str,
        command: &str,
        timeout_secs: u64,
        max_output_bytes: usize,
    ) -> std::io::Result<LocalCommandOutput> {
        let started = Instant::now();
        let mut child = spawn_shell(command)?;
        let pid = child.id();
        let cancel = Arc::new(AtomicBool::new(false));
        self.register(run_id, pid, Arc::clone(&cancel));

        // Lectura incremental en dos hilos: acumulan hasta el tope y siguen
        // drenando (descartando) para que el hijo nunca se bloquee escribiendo
        // en una tubería llena.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let out_reader = std::thread::spawn(move || match stdout {
            Some(r) => read_capped(r, max_output_bytes),
            None => (Vec::new(), false),
        });
        let err_reader = std::thread::spawn(move || match stderr {
            Some(r) => read_capped(r, max_output_bytes),
            None => (Vec::new(), false),
        });

        let deadline = (timeout_secs > 0).then(|| started + Duration::from_secs(timeout_secs));
        let mut timed_out = false;
        let mut killed_at: Option<Instant> = None;

        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            let canceled = cancel.load(Ordering::SeqCst);
            let expired = deadline.is_some_and(|d| Instant::now() >= d);
            if (canceled || expired) && killed_at.is_none() {
                timed_out = expired && !canceled;
                terminate_tree(pid);
                killed_at = Some(Instant::now());
            }
            // Si tras el plazo de gracia sigue vivo, se remata sin contemplaciones.
            if killed_at.is_some_and(|t| t.elapsed() >= GRACE_PERIOD) {
                kill_tree(pid);
                break child.wait()?;
            }
            std::thread::sleep(POLL_INTERVAL);
        };

        self.unregister(run_id);
        let (stdout, out_trunc) = out_reader.join().unwrap_or((Vec::new(), false));
        let (stderr, err_trunc) = err_reader.join().unwrap_or((Vec::new(), false));

        Ok(LocalCommandOutput {
            code: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            truncated: out_trunc || err_trunc,
            timed_out,
            canceled: cancel.load(Ordering::SeqCst),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// Normaliza el timeout que manda el frontend: `None` → el valor por defecto,
/// `0` → sin límite (opción explícita del usuario), y cualquier otro valor se
/// acota al tope duro.
#[must_use]
pub fn effective_timeout_secs(requested: Option<u64>) -> u64 {
    match requested {
        None => DEFAULT_TIMEOUT_SECS,
        Some(0) => 0,
        Some(n) => n.min(MAX_TIMEOUT_SECS),
    }
}

/// Normaliza el límite de salida por flujo: `None` → el valor por defecto y,
/// como el 0 dejaría el resultado ciego, se sanea a 1 KiB como mínimo.
#[must_use]
pub fn effective_output_bytes(requested_kb: Option<usize>) -> usize {
    match requested_kb {
        None => DEFAULT_MAX_OUTPUT_BYTES,
        Some(kb) => kb.saturating_mul(1024).clamp(1024, MAX_OUTPUT_BYTES),
    }
}

/// Lee `reader` hasta EOF acumulando como mucho `cap` bytes. Devuelve lo
/// acumulado y si hubo que descartar algo. **Siempre** consume el resto del
/// flujo: dejar de leer una tubería llena bloquearía al hijo para siempre.
fn read_capped<R: Read>(mut reader: R, cap: usize) -> (Vec<u8>, bool) {
    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let room = cap.saturating_sub(out.len());
                if room == 0 {
                    truncated = true;
                    continue; // seguimos drenando, pero ya no acumulamos
                }
                let take = room.min(n);
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    (out, truncated)
}

/// Lanza el shell del SO con la orden del usuario, con las tuberías capturadas
/// y stdin cerrado (no es interactivo: un comando que pregunte no debe quedarse
/// esperando a un teclado que no existe).
fn spawn_shell(command: &str) -> std::io::Result<std::process::Child> {
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        // Sin consola parpadeante al lanzar el comando desde la GUI.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        // Grupo de procesos propio: así la señal de terminación alcanza también
        // a los nietos (pipelines, procesos en segundo plano del shell).
        use std::os::unix::process::CommandExt;
        c.process_group(0);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

/// Terminación amable del árbol de procesos (`SIGTERM` al grupo en Unix).
#[cfg(unix)]
fn terminate_tree(pid: u32) {
    // El hijo es líder de su propio grupo (`process_group(0)`), así que el
    // grupo tiene el mismo id que su PID y `kill(-pgid)` alcanza a todo el árbol.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

/// En Windows no hay grupos de procesos con señales: `taskkill /T` recorre el
/// árbol a partir del PID del `cmd`. No hay terminación «amable» equivalente
/// para un proceso sin ventana, así que ambas rutas hacen lo mismo.
#[cfg(windows)]
fn terminate_tree(pid: u32) {
    kill_tree(pid);
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_por_defecto_cero_y_tope() {
        assert_eq!(effective_timeout_secs(None), DEFAULT_TIMEOUT_SECS);
        // 0 es la opción explícita «sin límite»: se respeta tal cual.
        assert_eq!(effective_timeout_secs(Some(0)), 0);
        assert_eq!(effective_timeout_secs(Some(45)), 45);
        // Un valor absurdo se acota al tope duro.
        assert_eq!(effective_timeout_secs(Some(u64::MAX)), MAX_TIMEOUT_SECS);
    }

    #[test]
    fn limite_de_salida_se_sanea() {
        assert_eq!(effective_output_bytes(None), DEFAULT_MAX_OUTPUT_BYTES);
        assert_eq!(effective_output_bytes(Some(64)), 64 * 1024);
        // 0 dejaría el resultado ciego: mínimo 1 KiB.
        assert_eq!(effective_output_bytes(Some(0)), 1024);
        // Tope duro, incluso ante un desbordamiento del producto.
        assert_eq!(effective_output_bytes(Some(usize::MAX)), MAX_OUTPUT_BYTES);
    }

    #[test]
    fn read_capped_no_trunca_por_debajo_del_tope() {
        let datos = b"salida corta".to_vec();
        let (out, truncado) = read_capped(&datos[..], 1024);
        assert_eq!(out, datos);
        assert!(!truncado);
    }

    #[test]
    fn read_capped_trunca_y_sigue_drenando() {
        // 10 KiB de salida con un tope de 100 bytes: se conservan los primeros
        // 100 y se marca truncado, pero el lector consume el flujo entero (si
        // no, el hijo se bloquearía al llenar la tubería).
        let datos = vec![b'x'; 10 * 1024];
        let (out, truncado) = read_capped(&datos[..], 100);
        assert_eq!(out.len(), 100);
        assert!(truncado);
    }

    #[test]
    fn read_capped_con_tope_exacto_no_marca_truncado() {
        let datos = vec![b'y'; 256];
        let (out, truncado) = read_capped(&datos[..], 256);
        assert_eq!(out.len(), 256);
        assert!(!truncado);
    }

    #[test]
    fn comando_normal_devuelve_salida_y_codigo() {
        let reg = LocalCommandRegistry::new();
        let cmd = if cfg!(windows) {
            "echo hola"
        } else {
            "printf hola"
        };
        let out = reg.run_blocking("t-ok", cmd, 10, 4096).expect("ejecuta");
        assert_eq!(out.code, 0);
        assert!(out.stdout.contains("hola"));
        assert!(!out.timed_out && !out.canceled && !out.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn comando_que_no_termina_se_corta_por_timeout() {
        let reg = LocalCommandRegistry::new();
        // `sleep 60` con 1 s de plazo: debe volver marcado como timed_out muy
        // antes de los 60 s (el grace period añade como mucho 2 s).
        let inicio = Instant::now();
        let out = reg.run_blocking("t-timeout", "sleep 60", 1, 4096).unwrap();
        assert!(out.timed_out, "debería marcar timeout");
        assert!(!out.canceled);
        assert!(inicio.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn salida_enorme_no_bloquea_al_hijo() {
        let reg = LocalCommandRegistry::new();
        // `yes` escribe sin parar: sin drenaje + kill, esto no terminaría nunca.
        let out = reg.run_blocking("t-yes", "yes", 1, 1024).unwrap();
        assert!(out.timed_out);
        assert!(out.truncated);
        assert!(out.stdout.len() <= 1024);
    }

    #[cfg(unix)]
    #[test]
    fn cancelar_desde_otro_hilo_corta_el_comando() {
        let reg = Arc::new(LocalCommandRegistry::new());
        let canceller = Arc::clone(&reg);
        std::thread::spawn(move || {
            // El comando ya está registrado en cuanto arranca; reintentamos
            // hasta que el registro lo conozca para no depender del scheduler.
            for _ in 0..100 {
                if canceller.cancel("t-cancel") {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let out = reg.run_blocking("t-cancel", "sleep 30", 0, 4096).unwrap();
        assert!(out.canceled, "debería marcar cancelado");
        assert!(!out.timed_out);
    }

    #[test]
    fn cancelar_un_run_id_desconocido_no_falla() {
        let reg = LocalCommandRegistry::new();
        assert!(!reg.cancel("no-existe"));
    }
}
