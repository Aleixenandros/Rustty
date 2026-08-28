//! Log tecnico de diagnostico de la aplicacion: dónde se escribe, con qué
//! nivel, y la captura de lo que hasta ahora se perdia (panics y errores del
//! frontend).
//!
//! ## El problema que resuelve
//!
//! El plugin de log deja constancia de que la app **arranca**, pero nada
//! contaba por qué terminaba. Un panic viaja por `stderr` y en la build de
//! Windows —`windows_subsystem = "windows"`, sin consola— ese texto no existe
//! para nadie: el fichero de log se quedaba con la linea «iniciando» y ni una
//! pista mas. Aqui vive el gancho que lo arregla.
//!
//! ## Contrato
//!
//! - La configuracion (carpeta y nivel) se lee **antes** de construir el
//!   plugin, de un JSON propio en el directorio de datos. No puede vivir en las
//!   preferencias del frontend: cuando hay que decidir dónde escribe el logger
//!   todavia no hay webview.
//! - Un cambio de carpeta o de nivel se aplica **al reiniciar**. El logger se
//!   instala una sola vez por proceso.
//! - Si la carpeta configurada no se puede escribir, se cae a la de siempre en
//!   vez de arrancar sin log: perder trazas es peor que ignorar la preferencia.
//! - El log **no** lleva contenido de terminal ni secretos: solo trazas de la
//!   propia aplicacion.
//!
//! Los mensajes se escriben en ASCII a proposito: el fichero es UTF-8, pero los
//! visores de Windows (Notepad heredado, `type` en consola) lo interpretan como
//! ANSI y convierten cualquier acento en un simbolo ilegible justo cuando el
//! usuario esta leyendo un informe de fallo.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Nombre base del fichero de log (el plugin le añade la extension).
pub const LOG_FILE_STEM: &str = "rustty";
/// Fichero de log completo, tal y como queda en disco.
pub const LOG_FILE_NAME: &str = "rustty.log";
/// Configuracion del log, junto a los demas datos de la app.
const CONFIG_FILE: &str = "log_config.json";
/// Respaldo para un panic ocurrido **antes** de que el logger este en pie.
const PANIC_FALLBACK_FILE: &str = "rustty-panic.log";
/// Tope de lectura del visor del log: lo ultimo es lo que importa.
pub const TAIL_MAX_BYTES: u64 = 256 * 1024;

/// Configuracion persistente del log. Ausente o ilegible => valores por defecto.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LogConfig {
    /// Carpeta elegida por el usuario. `None` = la del sistema operativo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// Nivel: `info` (por defecto en release) o `debug`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_FILE)
}

/// Lee la configuracion del log. Nunca falla: un fichero ausente, vacio o
/// corrupto devuelve los valores por defecto, porque quedarse sin log por un
/// JSON roto seria el peor de los desenlaces.
pub fn load_config(data_dir: &Path) -> LogConfig {
    let Ok(raw) = std::fs::read_to_string(config_path(data_dir)) else {
        return LogConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Escribe la configuracion del log (atomica, como el resto de stores).
pub fn save_config(data_dir: &Path, cfg: &LogConfig) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    crate::atomic_file::write(&config_path(data_dir), &json, false).map_err(|e| e.to_string())
}

/// Traduce el nivel configurado a filtro. Sin configurar: `Debug` en desarrollo,
/// `Info` en release. Un valor desconocido no rompe nada, cae al defecto.
pub fn level_filter(cfg: &LogConfig) -> log::LevelFilter {
    let default = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    match cfg.level.as_deref().map(str::trim) {
        Some("error") => log::LevelFilter::Error,
        Some("warn") => log::LevelFilter::Warn,
        Some("info") => log::LevelFilter::Info,
        Some("debug") => log::LevelFilter::Debug,
        Some("trace") => log::LevelFilter::Trace,
        _ => default,
    }
}

/// Nombre canonico del nivel efectivo, para enseñarlo en la interfaz.
pub fn level_name(filter: log::LevelFilter) -> &'static str {
    match filter {
        log::LevelFilter::Off => "off",
        log::LevelFilter::Error => "error",
        log::LevelFilter::Warn => "warn",
        log::LevelFilter::Info => "info",
        log::LevelFilter::Debug => "debug",
        log::LevelFilter::Trace => "trace",
    }
}

/// Comprueba que se puede escribir en `dir`, creandolo si hace falta.
///
/// Un `create_dir_all` que funciona no garantiza permiso de escritura (caso
/// tipico en Windows: una carpeta dentro de `Program Files`), asi que se escribe
/// y se borra un fichero de prueba.
pub fn probe_writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let probe = dir.join(".rustty-log-probe");
    std::fs::write(&probe, b"ok").map_err(|e| format!("{}: {e}", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Carpeta a la que hay que **forzar** el log, si es que hay alguna.
///
/// Dos motivos para apartarse de la carpeta estandar del sistema:
///
/// 1. El usuario la ha configurado a mano.
/// 2. Es la build portable de Windows: sus datos viajan junto al `.exe`, y
///    dejar el log en el `%LOCALAPPDATA%` del equipo prestado contradice el
///    sentido de una portable (y esconde el fichero justo cuando se necesita).
///
/// `None` = usar la carpeta de logs del sistema operativo.
pub fn override_dir(data_dir: &Path, cfg: &LogConfig) -> Option<PathBuf> {
    if let Some(dir) = cfg.dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        let path = PathBuf::from(dir);
        match probe_writable(&path) {
            Ok(()) => return Some(path),
            Err(err) => {
                // Sin logger todavia: queda para el fallback, que si esta vivo.
                write_fallback(data_dir, &format!(
                    "carpeta de log configurada inaccesible, se usa la del sistema ({err})"
                ));
                return None;
            }
        }
    }
    if crate::is_portable() {
        let path = data_dir.join("logs");
        if probe_writable(&path).is_ok() {
            return Some(path);
        }
    }
    None
}

// ─── Captura de panics ────────────────────────────────────────────────────────

/// El logger global ya esta instalado: a partir de aqui un panic tiene dónde
/// escribirse y no hace falta el fichero de respaldo.
static LOGGER_READY: AtomicBool = AtomicBool::new(false);
/// Directorio de datos, para el respaldo de un panic muy temprano.
static FALLBACK_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Marca el logger como operativo. Se llama desde `setup()`, cuando el plugin
/// ya ha registrado el logger global.
pub fn mark_logger_ready() {
    LOGGER_READY.store(true, Ordering::Release);
}

/// Añade una linea al fichero de respaldo de panics. Best-effort: si tampoco se
/// puede escribir ahi, no queda nada por intentar.
fn write_fallback(data_dir: &Path, message: &str) {
    let path = data_dir.join(PANIC_FALLBACK_FILE);
    let _ = std::fs::create_dir_all(data_dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "[{stamp}] {message}");
    }
}

/// Texto del payload de un panic (`panic!("...")`, `unwrap`, `expect`).
fn payload_text(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "<payload no textual>".to_string()
    }
}

/// Instala el gancho que manda los panics al log.
///
/// Hasta ahora un panic solo existia en `stderr`, que en la build de Windows no
/// va a ninguna parte: la app desaparecia y el log no decia nada. El gancho
/// escribe la causa, el punto exacto y el hilo; si el panic llega antes de que
/// el logger este en pie, cae al fichero de respaldo del directorio de datos.
/// En ambos casos se delega despues en el gancho anterior, para no perder el
/// comportamiento estandar cuando si hay consola.
pub fn install_panic_hook(data_dir: PathBuf) {
    let _ = FALLBACK_DIR.set(data_dir);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "origen desconocido".to_string());
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("sin nombre").to_string();
        let message = format!(
            "PANIC en {location} (hilo: {thread_name}): {}",
            payload_text(info)
        );

        if LOGGER_READY.load(Ordering::Acquire) {
            log::error!("{message}");
            // Solo con RUST_BACKTRACE activo: `Backtrace::capture` respeta la
            // variable y evita el coste cuando nadie la ha pedido.
            let bt = std::backtrace::Backtrace::capture();
            if bt.status() == std::backtrace::BacktraceStatus::Captured {
                log::error!("backtrace:\n{bt}");
            }
        } else if let Some(dir) = FALLBACK_DIR.get() {
            write_fallback(dir, &message);
        }

        previous(info);
    }));
}

// ─── Lectura del log ──────────────────────────────────────────────────────────

/// Devuelve la cola del fichero de log (como mucho `max_bytes`).
///
/// Lee desde el final para no cargar en memoria un fichero de varios MB, y
/// descarta la primera linea del trozo leido porque casi siempre queda cortada
/// por la mitad.
pub fn tail(path: &Path, max_bytes: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        if let Some(nl) = text.find('\n') {
            return Ok(text[nl + 1..].to_string());
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nivel_por_defecto_y_configurado() {
        let vacia = LogConfig::default();
        let esperado = if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        };
        assert_eq!(level_filter(&vacia), esperado);

        let debug = LogConfig {
            dir: None,
            level: Some("debug".into()),
        };
        assert_eq!(level_filter(&debug), log::LevelFilter::Debug);

        // Un valor desconocido no puede dejar la app sin log.
        let raro = LogConfig {
            dir: None,
            level: Some("catastrofico".into()),
        };
        assert_eq!(level_filter(&raro), esperado);
    }

    #[test]
    fn config_ausente_o_corrupta_cae_al_defecto() {
        let dir = std::env::temp_dir().join(format!("rustty-log-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Ausente.
        assert!(load_config(&dir).dir.is_none());

        // Corrupta: no se propaga el error, se ignora el fichero.
        std::fs::write(config_path(&dir), b"{ esto no es json").unwrap();
        assert!(load_config(&dir).level.is_none());

        // Ida y vuelta.
        let cfg = LogConfig {
            dir: Some(dir.to_string_lossy().into_owned()),
            level: Some("debug".into()),
        };
        save_config(&dir, &cfg).unwrap();
        let leida = load_config(&dir);
        assert_eq!(leida.level.as_deref(), Some("debug"));
        assert_eq!(leida.dir, cfg.dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_devuelve_el_final_y_no_corta_lineas() {
        let dir = std::env::temp_dir().join(format!("rustty-log-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        let contenido: String = (0..500).map(|i| format!("linea {i}\n")).collect();
        std::fs::write(&path, &contenido).unwrap();

        // Sin recorte: sale entero.
        assert_eq!(tail(&path, 1_000_000).unwrap(), contenido);

        // Con recorte: solo el final, y la primera linea del trozo no queda a medias.
        let recortado = tail(&path, 64).unwrap();
        assert!(recortado.len() <= 64);
        assert!(recortado.ends_with("linea 499\n"));
        assert!(recortado.starts_with("linea "));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
