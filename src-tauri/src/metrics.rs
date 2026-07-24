//! Núcleo **puro** del monitor de recursos por sesión SSH (agentless, estilo
//! gotop, sin instalar nada en el remoto).
//!
//! Aquí solo hay **parseo y aritmética**: convertir el texto que escupen las
//! interfaces estándar del servidor (`/proc/*`, `df`, `ps`) en tipos, y derivar
//! los valores instantáneos (%CPU, tasas de red) a partir de **dos muestras**
//! consecutivas —los contadores de `/proc` son acumulativos—. No hay E/S, ni
//! SSH, ni estado global: todo es testeable con fixtures de texto.
//!
//! El transporte (abrir un `exec` sobre la sesión viva, el intervalo, el panel)
//! vive fuera; ver la tarea del monitor en `memoria/tareas.md`.

use std::collections::BTreeMap;

use serde::Serialize;

/// Cada sección del volcado combinado va precedida de una línea con este prefijo
/// y su nombre (`@@RUSTTY-METRICS cpu`), para poder trocear una sola respuesta.
/// Es la **única fuente de verdad** del contrato con el comando remoto: el
/// generador del comando ([`linux_sample_command`]) y el troceador
/// ([`split_sections`]) lo comparten.
pub const SECTION_PREFIX: &str = "@@RUSTTY-METRICS ";

/// Comando de muestreo para Linux: emite, en **una** ejecución, cada fuente
/// precedida de su marcador. Se lanza por un `exec` sobre la sesión SSH viva.
/// `2>/dev/null` para que una fuente ausente no ensucie el volcado (el parser ya
/// tolera secciones vacías).
#[must_use]
pub fn linux_sample_command() -> String {
    let sections = [
        ("cpu", "cat /proc/stat"),
        ("mem", "cat /proc/meminfo"),
        ("load", "cat /proc/loadavg"),
        ("uptime", "cat /proc/uptime"),
        ("net", "cat /proc/net/dev"),
        ("disk", "df -P"),
        (
            "proc",
            "ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 11",
        ),
    ];
    let mut cmd = String::new();
    for (name, source) in sections {
        // `printf` en vez de `echo` para no depender de flags de shell.
        cmd.push_str(&format!("printf '%s{name}\\n'; {source} 2>/dev/null; "));
    }
    cmd.replace("%s", SECTION_PREFIX)
}

/// Tiempos acumulados de CPU en *jiffies* (una línea `cpu`/`cpuN` de
/// `/proc/stat`). Guardamos solo lo que necesita el %: total y ocioso.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuTimes {
    pub total: u64,
    /// `idle + iowait`: la CPU no estaba haciendo trabajo útil.
    pub idle: u64,
}

/// Memoria en kiB, tal cual la da `/proc/meminfo`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemInfo {
    pub total_kb: u64,
    /// `MemAvailable`: lo que el kernel estima reutilizable sin swapear.
    pub available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
}

/// Carga media de `/proc/loadavg` (1, 5, 15 minutos).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAvg {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

/// Contadores de red acumulados (suma de interfaces reales, sin `lo`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NetCounters {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

/// Uso de un sistema de ficheros (una fila de `df -P`), en kiB.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub filesystem: String,
    pub size_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
    pub mount: String,
}

/// Un proceso de la tabla top (`ps`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub cpu_pct: f64,
    pub mem_pct: f64,
    pub command: String,
}

/// Muestra **cruda**: contadores acumulados + valores instantáneos de un
/// instante. Los porcentajes/tasas se derivan comparando dos de estas.
#[derive(Debug, Clone, PartialEq)]
pub struct RawSample {
    /// Línea agregada `cpu`.
    pub cpu: Option<CpuTimes>,
    /// Líneas `cpu0`, `cpu1`… en orden.
    pub cpu_cores: Vec<CpuTimes>,
    pub mem: MemInfo,
    pub load: Option<LoadAvg>,
    /// Segundos que lleva encendido el servidor (`/proc/uptime`, primer campo).
    pub uptime_secs: f64,
    pub net: NetCounters,
    pub disks: Vec<DiskUsage>,
    pub procs: Vec<ProcInfo>,
}

/// Métricas **derivadas**, listas para pintar. Es lo que se emite al frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    /// Uso de CPU agregado, 0..100. `None` si no hay muestra previa.
    pub cpu_pct: Option<f64>,
    /// Uso por core, 0..100, en orden.
    pub cpu_cores_pct: Vec<f64>,
    pub mem: MemInfo,
    /// Memoria usada = total − disponible, en kiB.
    pub mem_used_kb: u64,
    pub load: Option<LoadAvg>,
    pub uptime_secs: f64,
    /// Bytes por segundo de bajada/subida. `None` sin muestra previa.
    pub net_rx_bps: Option<f64>,
    pub net_tx_bps: Option<f64>,
    pub disks: Vec<DiskUsage>,
    pub procs: Vec<ProcInfo>,
}

/// Trocea el volcado combinado en `nombre → cuerpo`, partiendo por las líneas
/// [`SECTION_PREFIX`]. Tolera texto antes de la primera marca (se descarta).
#[must_use]
pub fn split_sections(blob: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut current: Option<(String, String)> = None;
    for line in blob.lines() {
        if let Some(name) = line.strip_prefix(SECTION_PREFIX) {
            if let Some((key, body)) = current.take() {
                out.insert(key, body);
            }
            current = Some((name.trim().to_string(), String::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some((key, body)) = current {
        out.insert(key, body);
    }
    out
}

/// Parsea una línea `cpu`/`cpuN` de `/proc/stat`. Formato:
/// `cpu user nice system idle iowait irq softirq steal guest guest_nice`.
/// total = suma de todos; idle = idle + iowait (campos 3 y 4).
#[must_use]
pub fn parse_cpu_line(line: &str) -> Option<CpuTimes> {
    let mut it = line.split_whitespace();
    let label = it.next()?;
    if !label.starts_with("cpu") {
        return None;
    }
    let nums: Vec<u64> = it.filter_map(|f| f.parse().ok()).collect();
    if nums.len() < 4 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    Some(CpuTimes { total, idle })
}

/// Parsea `/proc/stat`: devuelve la línea agregada `cpu` y las `cpuN` por core.
#[must_use]
pub fn parse_proc_stat(text: &str) -> (Option<CpuTimes>, Vec<CpuTimes>) {
    let mut aggregate = None;
    let mut cores = Vec::new();
    for line in text.lines() {
        if line.starts_with("cpu ") || line == "cpu" {
            aggregate = parse_cpu_line(line);
        } else if line.starts_with("cpu") {
            if let Some(core) = parse_cpu_line(line) {
                cores.push(core);
            }
        }
    }
    (aggregate, cores)
}

/// Parsea `/proc/meminfo` (líneas `Clave:   <n> kB`).
#[must_use]
pub fn parse_meminfo(text: &str) -> MemInfo {
    let mut mem = MemInfo::default();
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let value = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        let Some(value) = value else { continue };
        match key.trim() {
            "MemTotal" => mem.total_kb = value,
            "MemAvailable" => mem.available_kb = value,
            "SwapTotal" => mem.swap_total_kb = value,
            "SwapFree" => mem.swap_free_kb = value,
            _ => {}
        }
    }
    mem
}

/// Parsea `/proc/loadavg` (`0.52 0.58 0.59 1/824 12345`).
#[must_use]
pub fn parse_loadavg(text: &str) -> Option<LoadAvg> {
    let mut it = text.split_whitespace();
    let one = it.next()?.parse().ok()?;
    let five = it.next()?.parse().ok()?;
    let fifteen = it.next()?.parse().ok()?;
    Some(LoadAvg { one, five, fifteen })
}

/// Segundos de encendido: primer campo de `/proc/uptime`.
#[must_use]
pub fn parse_uptime(text: &str) -> Option<f64> {
    text.split_whitespace().next()?.parse().ok()
}

/// Parsea `/proc/net/dev` sumando rx/tx de las interfaces **reales** (descarta
/// `lo`). Campos tras `iface:`: `rx_bytes` es el 1.º, `tx_bytes` el 9.º.
#[must_use]
pub fn parse_net_dev(text: &str) -> NetCounters {
    let mut net = NetCounters::default();
    for line in text.lines() {
        let Some((iface, rest)) = line.split_once(':') else {
            continue; // las dos líneas de cabecera no llevan ':'
        };
        let iface = iface.trim();
        if iface == "lo" || iface.is_empty() {
            continue;
        }
        let fields: Vec<u64> = rest.split_whitespace().filter_map(|f| f.parse().ok()).collect();
        if fields.len() >= 9 {
            net.rx_bytes += fields[0];
            net.tx_bytes += fields[8];
        }
    }
    net
}

/// Parsea la salida de `df -P` (una fila por FS gracias a `-P`). Salta la
/// cabecera y las filas de pseudo-sistemas sin bloques.
#[must_use]
pub fn parse_df(text: &str) -> Vec<DiskUsage> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        // `Filesystem 1024-blocks Used Available Capacity Mounted-on`. El punto
        // de montaje puede llevar espacios: es todo lo que sigue al 5.º campo.
        let mut it = line.split_whitespace();
        let (Some(fs), Some(size), Some(used), Some(avail), Some(_cap)) =
            (it.next(), it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let mount = it.collect::<Vec<_>>().join(" ");
        let (Ok(size_kb), Ok(used_kb), Ok(avail_kb)) =
            (size.parse(), used.parse(), avail.parse())
        else {
            continue;
        };
        out.push(DiskUsage {
            filesystem: fs.to_string(),
            size_kb,
            used_kb,
            avail_kb,
            mount,
        });
    }
    out
}

/// Parsea `ps -eo pid,pcpu,pmem,comm` (con cabecera). `comm` puede llevar
/// espacios: pid es el 1.º, pcpu/pmem los dos numéricos que siguen, y el resto
/// es el comando.
#[must_use]
pub fn parse_ps(text: &str) -> Vec<ProcInfo> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(cpu), Some(mem)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let (Ok(pid), Ok(cpu_pct), Ok(mem_pct)) = (pid.parse(), cpu.parse(), mem.parse()) else {
            continue;
        };
        let command = it.collect::<Vec<_>>().join(" ");
        if command.is_empty() {
            continue;
        }
        out.push(ProcInfo {
            pid,
            cpu_pct,
            mem_pct,
            command,
        });
    }
    out
}

impl RawSample {
    /// Construye una muestra a partir del volcado combinado del comando remoto.
    #[must_use]
    pub fn parse(blob: &str) -> Self {
        let sections = split_sections(blob);
        let get = |k: &str| sections.get(k).map(String::as_str).unwrap_or("");
        let (cpu, cpu_cores) = parse_proc_stat(get("cpu"));
        RawSample {
            cpu,
            cpu_cores,
            mem: parse_meminfo(get("mem")),
            load: parse_loadavg(get("load")),
            uptime_secs: parse_uptime(get("uptime")).unwrap_or(0.0),
            net: parse_net_dev(get("net")),
            disks: parse_df(get("disk")),
            procs: parse_ps(get("proc")),
        }
    }
}

/// %CPU a partir del delta de dos lecturas de tiempos: `100·(Δtotal−Δidle)/Δtotal`.
/// Devuelve `None` si el total no avanzó (misma lectura, o contador reiniciado).
#[must_use]
pub fn cpu_usage_pct(prev: CpuTimes, cur: CpuTimes) -> Option<f64> {
    let total = cur.total.checked_sub(prev.total)?;
    let idle = cur.idle.checked_sub(prev.idle)?;
    if total == 0 {
        return None;
    }
    let busy = total.saturating_sub(idle) as f64;
    Some((busy / total as f64 * 100.0).clamp(0.0, 100.0))
}

impl Metrics {
    /// Deriva las métricas pintables. `prev` es la muestra anterior (para %CPU y
    /// tasas de red); en la primera muestra se pasa `None` y esos campos quedan a
    /// `None` (aún no hay delta).
    #[must_use]
    pub fn derive(prev: Option<&RawSample>, cur: &RawSample) -> Self {
        let cpu_pct = match (prev.and_then(|p| p.cpu), cur.cpu) {
            (Some(p), Some(c)) => cpu_usage_pct(p, c),
            _ => None,
        };

        let cpu_cores_pct = match prev {
            Some(p) if p.cpu_cores.len() == cur.cpu_cores.len() => p
                .cpu_cores
                .iter()
                .zip(&cur.cpu_cores)
                .filter_map(|(&pc, &cc)| cpu_usage_pct(pc, cc))
                .collect(),
            _ => Vec::new(),
        };

        // Tasas de red: bytes ganados dividido por el tiempo transcurrido, que
        // tomamos del delta de uptime (monótono, inmune a saltos del reloj).
        let (net_rx_bps, net_tx_bps) = match prev {
            Some(p) => {
                let dt = cur.uptime_secs - p.uptime_secs;
                if dt > 0.0 {
                    let rx = cur.net.rx_bytes.saturating_sub(p.net.rx_bytes) as f64 / dt;
                    let tx = cur.net.tx_bytes.saturating_sub(p.net.tx_bytes) as f64 / dt;
                    (Some(rx), Some(tx))
                } else {
                    (None, None)
                }
            }
            None => (None, None),
        };

        let mem_used_kb = cur.mem.total_kb.saturating_sub(cur.mem.available_kb);

        Metrics {
            cpu_pct,
            cpu_cores_pct,
            mem: cur.mem,
            mem_used_kb,
            load: cur.load,
            uptime_secs: cur.uptime_secs,
            net_rx_bps,
            net_tx_bps,
            disks: cur.disks.clone(),
            procs: cur.procs.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cpu_line_suma_total_e_incluye_iowait_en_idle() {
        // cpu user nice system idle iowait irq softirq steal guest guest_nice
        let c = parse_cpu_line("cpu  100 5 30 800 20 0 4 0 0 0").unwrap();
        assert_eq!(c.total, 100 + 5 + 30 + 800 + 20 + 4);
        assert_eq!(c.idle, 800 + 20);
        assert!(parse_cpu_line("intr 12345").is_none());
    }

    #[test]
    fn parse_proc_stat_separa_agregado_y_cores() {
        let text = "cpu  10 0 5 100 2 0 0 0 0 0\n\
                    cpu0 5 0 2 50 1 0 0 0 0 0\n\
                    cpu1 5 0 3 50 1 0 0 0 0 0\n\
                    intr 999\nctxt 12345\n";
        let (agg, cores) = parse_proc_stat(text);
        assert!(agg.is_some());
        assert_eq!(cores.len(), 2);
    }

    #[test]
    fn parse_meminfo_lee_las_claves_que_importan() {
        let text = "MemTotal:       16384516 kB\n\
                    MemFree:          812345 kB\n\
                    MemAvailable:    9876543 kB\n\
                    SwapTotal:       2097148 kB\n\
                    SwapFree:        2000000 kB\n";
        let m = parse_meminfo(text);
        assert_eq!(m.total_kb, 16_384_516);
        assert_eq!(m.available_kb, 9_876_543);
        assert_eq!(m.swap_total_kb, 2_097_148);
        assert_eq!(m.swap_free_kb, 2_000_000);
    }

    #[test]
    fn parse_loadavg_y_uptime() {
        let l = parse_loadavg("0.52 0.58 0.59 1/824 12345").unwrap();
        assert_eq!((l.one, l.five, l.fifteen), (0.52, 0.58, 0.59));
        assert_eq!(parse_uptime("12345.67 98765.43").unwrap(), 12345.67);
        assert!(parse_loadavg("").is_none());
    }

    #[test]
    fn parse_net_dev_suma_reales_y_descarta_lo() {
        let text = "Inter-|   Receive                                                |  Transmit\n\
                    face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets\n\
                    lo:  1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n\
                    eth0:  5000 50 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n\
                    wlan0: 3000 30 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n";
        let n = parse_net_dev(text);
        assert_eq!(n.rx_bytes, 5000 + 3000, "no debe contar lo");
        assert_eq!(n.tx_bytes, 2000 + 1000);
    }

    #[test]
    fn parse_df_salta_cabecera_y_lee_montaje_con_espacios() {
        let text = "Filesystem     1024-blocks     Used Available Capacity Mounted on\n\
                    /dev/sda1        103081248 41234567  56789012      43% /\n\
                    tmpfs              8192000        0   8192000       0% /mnt/disco externo\n";
        let d = parse_df(text);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].filesystem, "/dev/sda1");
        assert_eq!(d[0].size_kb, 103_081_248);
        assert_eq!(d[0].mount, "/");
        assert_eq!(d[1].mount, "/mnt/disco externo");
    }

    #[test]
    fn parse_ps_junta_el_comando_y_ordena_llega_del_servidor() {
        let text = "  PID %CPU %MEM COMMAND\n\
                    1234 12.5  3.2 postgres\n\
                      42  8.0  1.1 rust analyzer\n\
                    9999  0.0  0.0 sh\n";
        let p = parse_ps(text);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].pid, 1234);
        assert_eq!(p[0].cpu_pct, 12.5);
        assert_eq!(p[1].command, "rust analyzer");
    }

    #[test]
    fn split_sections_trocea_por_marcador() {
        let blob = format!(
            "basura previa\n{p}cpu\ncpu 1 2 3 4\n{p}mem\nMemTotal: 100 kB\n",
            p = SECTION_PREFIX
        );
        let s = split_sections(&blob);
        assert_eq!(s.len(), 2);
        assert!(s["cpu"].contains("cpu 1 2 3 4"));
        assert!(s["mem"].contains("MemTotal"));
    }

    #[test]
    fn cpu_usage_pct_por_deltas() {
        let prev = CpuTimes { total: 1000, idle: 800 };
        let cur = CpuTimes { total: 1100, idle: 850 }; // Δtotal=100, Δidle=50
        assert_eq!(cpu_usage_pct(prev, cur), Some(50.0));
        // Sin avance del total → None (misma lectura o contador reiniciado).
        assert_eq!(cpu_usage_pct(cur, cur), None);
        assert_eq!(cpu_usage_pct(cur, prev), None); // contador hacia atrás
    }

    /// Volcado combinado realista → parseo → derivación de dos muestras.
    #[test]
    fn muestra_completa_y_derivacion_con_previa() {
        // cpu line: `cpu 0 0 <busy> <idle> 0…` → total = busy + idle, idle = idle.
        let sample = |busy: u64, idle: u64, rx: u64, up: f64| {
            format!(
                "{p}cpu\ncpu 0 0 {busy} {idle} 0 0 0 0 0 0\n\
                 {p}mem\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n\
                 {p}load\n1.0 0.5 0.2 1/100 42\n\
                 {p}uptime\n{up} 999.0\n\
                 {p}net\neth0: {rx} 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n\
                 {p}disk\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /\n\
                 {p}proc\n  PID %CPU %MEM COMMAND\n1 5.0 1.0 init\n",
                p = SECTION_PREFIX
            )
        };

        let s0 = RawSample::parse(&sample(200, 1000, 1000, 100.0)); // total 1200, idle 1000
        let s1 = RawSample::parse(&sample(400, 1050, 3000, 102.0)); // total 1450, idle 1050; +2000 rx en 2 s

        // Primera muestra: sin delta, %CPU y tasas a None.
        let m0 = Metrics::derive(None, &s0);
        assert_eq!(m0.cpu_pct, None);
        assert_eq!(m0.net_rx_bps, None);
        assert_eq!(m0.mem_used_kb, 600); // 1000 - 400
        assert_eq!(m0.disks.len(), 1);
        assert_eq!(m0.procs[0].pid, 1);

        // Segunda: Δtotal=250, Δidle=50 → 80% ; rx 2000 B / 2 s = 1000 B/s.
        let m1 = Metrics::derive(Some(&s0), &s1);
        assert_eq!(m1.cpu_pct, Some(80.0));
        assert_eq!(m1.net_rx_bps, Some(1000.0));
        assert_eq!(m1.load.unwrap().one, 1.0);
    }

    #[test]
    fn linux_sample_command_incluye_marcadores_y_fuentes() {
        let cmd = linux_sample_command();
        assert!(cmd.contains(SECTION_PREFIX));
        assert!(cmd.contains("cat /proc/stat"));
        assert!(cmd.contains("df -P"));
        // El marcador va antes de cada fuente, no debe quedar ningún `%s` sin sustituir.
        assert!(!cmd.contains("%s"));
    }
}
