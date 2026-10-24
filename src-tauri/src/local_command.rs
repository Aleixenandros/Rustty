//! Ejecución **acotada** de los «Comandos locales» del catálogo del usuario.
//!
//! El catálogo lo define el propio usuario en su equipo; qué plantilla se puede
//! ejecutar y cómo entran sus valores lo decide [`crate::local_command_policy`]
//! (autorización por equipo y valores por variables de entorno). Aquí solo se
//! acota la ejecución: un comando que no termina (`yes`, un hijo que se queda colgado,
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
//!    se usa `taskkill /T /F`, que recorre el árbol. Eso vale mientras el shell
//!    vive: si termina dejando un proceso en segundo plano que conserva las
//!    tuberías (`programa &`), el resultado se entrega tras un margen corto
//!    (`READER_GRACE`) y ese proceso sigue vivo, que es lo que pide el `&`.

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
/// Margen para recoger la salida cuando el shell ya ha salido: lo normal es
/// que los lectores lleguen al EOF en milisegundos; si no, es que un proceso
/// en segundo plano conserva las tuberías y no se le espera.
const READER_GRACE: Duration = Duration::from_millis(500);
/// Descriptor por el que `flatpak-spawn` lee los valores de los marcadores
/// (`--env-fd`): el primero libre tras stdin/stdout/stderr.
#[cfg(unix)]
const ENV_FD: i32 = 3;

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
    /// Windows) capturando su salida de forma acotada, con `env` añadido al
    /// entorno del proceso (los valores de los marcadores de la plantilla).
    /// Bloquea el hilo llamador: el comando Tauri lo llama dentro de
    /// `spawn_blocking`.
    pub fn run_blocking(
        &self,
        run_id: &str,
        command: &str,
        env: &[(String, String)],
        timeout_secs: u64,
        max_output_bytes: usize,
    ) -> std::io::Result<LocalCommandOutput> {
        let started = Instant::now();
        let mut child = spawn_shell(command, env)?;
        let pid = child.id();
        let cancel = Arc::new(AtomicBool::new(false));
        self.register(run_id, pid, Arc::clone(&cancel));

        // Lectura incremental en dos hilos: acumulan hasta el tope y siguen
        // drenando (descartando) para que el hijo nunca se bloquee escribiendo
        // en una tubería llena. Escriben en un búfer compartido para poder
        // entregar lo leído sin esperar a su EOF (ver más abajo).
        let out_buf: Arc<Mutex<Captured>> = Arc::default();
        let err_buf: Arc<Mutex<Captured>> = Arc::default();
        let out_reader = spawn_reader(child.stdout.take(), max_output_bytes, Arc::clone(&out_buf));
        let err_reader = spawn_reader(child.stderr.take(), max_output_bytes, Arc::clone(&err_buf));

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

        // El shell ya terminó, pero un proceso que dejó en segundo plano (`cmd &`,
        // `nohup`, `setsid`, una aplicación gráfica que se desvincula) hereda las
        // tuberías, y su EOF no llega hasta que ese proceso muere. Esperarlo
        // dejaba la invocación colgada sin plazo ni cancelación posibles. Se
        // espera solo un margen corto, todavía registrados (así «Cancelar» sigue
        // alcanzando al grupo), y se entrega lo leído hasta entonces. Ese
        // proceso sigue vivo, que es lo que pide el `&`; su lector sigue
        // drenando la tubería hasta que la cierre, para que no muera de SIGPIPE.
        let drain_until = Instant::now() + READER_GRACE;
        while !(out_reader.is_finished() && err_reader.is_finished())
            && Instant::now() < drain_until
        {
            std::thread::sleep(Duration::from_millis(10));
        }

        self.unregister(run_id);
        let (stdout, out_trunc) = collect_reader(out_reader, &out_buf);
        let (stderr, err_trunc) = collect_reader(err_reader, &err_buf);

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

/// Salida de un flujo, compartida entre su hilo lector y quien espera el
/// resultado.
#[derive(Default)]
struct Captured {
    data: Vec<u8>,
    truncated: bool,
    /// El resultado ya se entregó: el lector solo drena hasta el EOF, sin
    /// acumular (no retiene memoria por un proceso que sigue en segundo plano).
    taken: bool,
}

/// Lee `reader` hasta EOF acumulando en `sink` como mucho `cap` bytes y
/// marcando si hubo que descartar algo. **Siempre** consume el resto del flujo:
/// dejar de leer una tubería llena bloquearía al hijo para siempre, y cerrarla
/// mataría de SIGPIPE a quien siguiera escribiendo en ella.
fn read_capped_into<R: Read>(mut reader: R, cap: usize, sink: &Mutex<Captured>) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let mut captured = sink.lock_recover();
                if captured.taken {
                    continue; // seguimos drenando, pero ya nadie lo va a leer
                }
                let take = cap.saturating_sub(captured.data.len()).min(n);
                captured.data.extend_from_slice(&buf[..take]);
                if take < n {
                    captured.truncated = true;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Retira lo acumulado (y si se truncó) y deja al lector solo drenando.
fn take_captured(sink: &Mutex<Captured>) -> (Vec<u8>, bool) {
    let mut captured = sink.lock_recover();
    captured.taken = true;
    (std::mem::take(&mut captured.data), captured.truncated)
}

fn spawn_reader<R: Read + Send + 'static>(
    reader: Option<R>,
    cap: usize,
    sink: Arc<Mutex<Captured>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        if let Some(reader) = reader {
            read_capped_into(reader, cap, &sink);
        }
    })
}

/// Recoge la salida de un lector. Si ya llegó a su EOF se espera al hilo (y lo
/// leído está completo); si no, se suelta su `JoinHandle`: el hilo sigue
/// drenando hasta que el proceso que conserva la tubería la cierre.
fn collect_reader(
    handle: std::thread::JoinHandle<()>,
    sink: &Mutex<Captured>,
) -> (Vec<u8>, bool) {
    if handle.is_finished() {
        let _ = handle.join();
    }
    take_captured(sink)
}

/// [`read_capped_into`] sobre un búfer propio, hasta el EOF.
#[cfg(test)]
fn read_capped<R: Read>(reader: R, cap: usize) -> (Vec<u8>, bool) {
    let sink = Mutex::new(Captured::default());
    read_capped_into(reader, cap, &sink);
    take_captured(&sink)
}

/// Lanza el shell del SO con la orden del usuario, con las tuberías capturadas
/// y stdin cerrado (no es interactivo: un comando que pregunte no debe quedarse
/// esperando a un teclado que no existe).
fn spawn_shell(command: &str, env: &[(String, String)]) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    use std::process::Command;
    use std::process::Stdio;
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        // Sin consola parpadeante al lanzar el comando desde la GUI.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
        c.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        c
    };
    // Bajo Flatpak, los valores de los marcadores (`RUSTTY_ARG_n`) llegan al
    // host por `--env-fd`: un `cmd.env` se quedaría en `flatpak-spawn` (el
    // comando correría con los valores vacíos) y `--env=` los dejaría a la
    // vista en su línea de órdenes (`ps`) mientras dura el comando. El `memfd`
    // vive hasta el final de la función, después del `spawn`.
    #[cfg(target_os = "linux")]
    let env_file = if crate::sandbox::in_flatpak() && !env.is_empty() {
        Some(crate::sandbox::env_memfd(env)?)
    } else {
        None
    };
    #[cfg(all(unix, not(target_os = "linux")))]
    let env_file: Option<std::fs::File> = None;
    #[cfg(not(windows))]
    let mut cmd = {
        // Bajo Flatpak el comando se ejecuta en el host: el catálogo es «su
        // shell», y las órdenes que el usuario guarda (`ping`, `scp`, abrir su
        // editor…) son herramientas de su sistema, no del runtime.
        let mut c = crate::sandbox::host_command(
            "sh",
            crate::sandbox::HostSpawn {
                env: if env_file.is_some() { &[] } else { env },
                env_fd: env_file.as_ref().map(|_| ENV_FD),
                ..Default::default()
            },
        );
        #[cfg(target_os = "linux")]
        if let Some(file) = &env_file {
            crate::sandbox::inherit_fd(&mut c, file, ENV_FD);
        }
        c.arg("-c").arg(command);
        // Grupo de procesos propio: así la señal de terminación alcanza también
        // a los nietos (pipelines, procesos en segundo plano del shell).
        //
        // Dentro del sandbox el grupo es el de `flatpak-spawn`, no el del árbol
        // real: la terminación llega porque `flatpak-spawn` reenvía la señal al
        // proceso del host, y `--watch-bus` lo mata igualmente si Rustty muere.
        // Un nieto que el shell haya dejado suelto en el host puede sobrevivir
        // a la cancelación; fuera de Flatpak el comportamiento es el de antes.
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
        let out = reg.run_blocking("t-ok", cmd, &[], 10, 4096).expect("ejecuta");
        assert_eq!(out.code, 0);
        assert!(out.stdout.contains("hola"));
        assert!(!out.timed_out && !out.canceled && !out.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn los_valores_llegan_por_el_entorno_sin_interpretarse() {
        let reg = LocalCommandRegistry::new();
        let env = vec![("RUSTTY_ARG_0".to_string(), "a; echo inyectado".to_string())];
        let out = reg
            .run_blocking("t-env", "printf '[%s]' \"${RUSTTY_ARG_0}\"", &env, 10, 4096)
            .expect("ejecuta");
        assert_eq!(out.stdout, "[a; echo inyectado]");
    }

    #[cfg(unix)]
    #[test]
    fn comando_que_no_termina_se_corta_por_timeout() {
        let reg = LocalCommandRegistry::new();
        // `sleep 60` con 1 s de plazo: debe volver marcado como timed_out muy
        // antes de los 60 s (el grace period añade como mucho 2 s).
        let inicio = Instant::now();
        let out = reg.run_blocking("t-timeout", "sleep 60", &[], 1, 4096).unwrap();
        assert!(out.timed_out, "debería marcar timeout");
        assert!(!out.canceled);
        assert!(inicio.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn salida_enorme_no_bloquea_al_hijo() {
        let reg = LocalCommandRegistry::new();
        // `yes` escribe sin parar: sin drenaje + kill, esto no terminaría nunca.
        let out = reg.run_blocking("t-yes", "yes", &[], 1, 1024).unwrap();
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
        let out = reg.run_blocking("t-cancel", "sleep 30", &[], 0, 4096).unwrap();
        assert!(out.canceled, "debería marcar cancelado");
        assert!(!out.timed_out);
    }

    #[cfg(unix)]
    #[test]
    fn un_proceso_en_segundo_plano_no_retiene_el_resultado() {
        let reg = LocalCommandRegistry::new();
        // El `sleep` hereda las tuberías: antes el resultado esperaba a que
        // terminara (5 s), con el plazo y «Cancelar» ya fuera de juego.
        let inicio = Instant::now();
        let out = reg
            .run_blocking("t-bg", "printf antes; sleep 5 &", &[], 30, 4096)
            .unwrap();
        assert!(inicio.elapsed() < Duration::from_secs(3), "no debe esperar al nieto");
        assert_eq!(out.stdout, "antes");
        assert_eq!(out.code, 0);
        assert!(!out.timed_out && !out.canceled && !out.truncated);
        // Ya no está registrado: cancelar no encuentra nada.
        assert!(!reg.cancel("t-bg"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn un_nieto_con_setsid_no_cuelga_el_timeout() {
        let reg = LocalCommandRegistry::new();
        // El nieto sale del grupo con `setsid`: la señal del plazo no le llega
        // y conserva las tuberías. El plazo tiene que cumplirse igual.
        let inicio = Instant::now();
        let out = reg
            .run_blocking("t-setsid", "setsid sleep 5 & sleep 30", &[], 1, 4096)
            .unwrap();
        assert!(out.timed_out);
        assert!(inicio.elapsed() < Duration::from_secs(4), "{:?}", inicio.elapsed());
    }

    #[cfg(unix)]
    #[test]
    fn la_salida_completa_llega_entera() {
        let reg = LocalCommandRegistry::new();
        let out = reg
            .run_blocking("t-grande", "head -c 300000 /dev/zero", &[], 10, 512 * 1024)
            .unwrap();
        assert_eq!(out.stdout.len(), 300_000);
        assert!(!out.truncated);
    }

    #[test]
    fn el_lector_deja_de_acumular_cuando_se_entrega_el_resultado() {
        let sink = Mutex::new(Captured::default());
        read_capped_into(&b"antes"[..], 1024, &sink);
        assert_eq!(take_captured(&sink), (b"antes".to_vec(), false));
        // Lo que llega después (un proceso que sigue vivo) se drena sin guardarse.
        read_capped_into(&b"despues"[..], 1024, &sink);
        assert!(sink.lock_recover().data.is_empty());
    }

    #[test]
    fn cancelar_un_run_id_desconocido_no_falla() {
        let reg = LocalCommandRegistry::new();
        assert!(!reg.cancel("no-existe"));
    }
}
