//! Coalescing de los eventos `ssh-tunnel-traffic-*`.
//!
//! Un túnel activo mueve datos en chunks de 8–16 KiB; emitir un evento Tauri
//! por chunk lanza miles de eventos/s hacia la WebView en una transferencia
//! masiva (la misma avalancha IPC que motivó el backpressure del terminal).
//!
//! Este módulo aísla la decisión pura de *cuándo* emitir para poder testearla
//! sin reloj real: se emite si ha pasado al menos [`TRAFFIC_MIN_INTERVAL`] desde
//! el último evento **o** si se han acumulado al menos [`TRAFFIC_MIN_BYTES`] sin
//! emitir. El llamador es responsable de emitir un evento final al terminar el
//! bombeo para que la UI muestre los totales exactos aunque el último chunk no
//! dispare el umbral.
//!
//! El evento lleva el tráfico **acumulado del túnel** ([`TunnelTraffic`]), no el
//! de la conexión que lo emite: un túnel SOCKS o `-L` atiende muchas conexiones
//! a la vez o seguidas, y con contadores por conexión el ↑/↓ saltaba entre ellas
//! y caía a unos KB en cuanto una conexión nueva informaba.
//!
//! También lleva cuántas conexiones tiene el túnel **ahora mismo**: cada canal
//! (`direct-tcpip` de un `-L`/SOCKS o `forwarded-tcpip` de un `-R`) cuenta
//! mientras vive su [`TunnelConnection`], un guard que resta al soltarse pase
//! lo que pase (fin normal, error o tarea abortada) y avisa del cambio.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Intervalo mínimo entre eventos de tráfico coalescidos (~4 por segundo),
/// alineado con el throttle del progreso SFTP.
pub const TRAFFIC_MIN_INTERVAL: Duration = Duration::from_millis(250);

/// Umbral de bytes acumulados que fuerza una emisión aunque no haya pasado el
/// intervalo, para que las ráfagas cortas pero grandes se reflejen enseguida.
pub const TRAFFIC_MIN_BYTES: u64 = 512 * 1024;

/// Decide si toca emitir un evento de tráfico de túnel.
///
/// * `elapsed` — tiempo transcurrido desde el último evento emitido.
/// * `bytes_since_last` — bytes (subida + bajada) acumulados desde el último
///   evento emitido.
#[inline]
pub fn should_emit_traffic(elapsed: Duration, bytes_since_last: u64) -> bool {
    elapsed >= TRAFFIC_MIN_INTERVAL || bytes_since_last >= TRAFFIC_MIN_BYTES
}

/// Contadores de tráfico de un túnel, compartidos por todas sus conexiones.
/// Cada bombeo suma lo suyo y emite los totales. Las tareas de una sesión
/// corren en el mismo runtime de un hilo y entre sumar y emitir no hay
/// `.await`, así que los totales salen en orden: nunca bajan.
#[derive(Debug, Default)]
pub struct TunnelTraffic {
    up: AtomicU64,
    down: AtomicU64,
    /// Conexiones abiertas ahora (una por [`TunnelConnection`] viva).
    active: AtomicU64,
}

/// Lo que se le cuenta a la interfaz de un túnel: totales y conexiones vivas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrafficSnapshot {
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub active_connections: u64,
}

/// Quien recibe las instantáneas de un túnel (en la app, el emisor del evento
/// `ssh-tunnel-traffic-*`; en los tests, lo que haga falta).
pub type TrafficSink = Arc<dyn Fn(TrafficSnapshot) + Send + Sync>;

impl TunnelTraffic {
    /// Suma `up`/`down` bytes y devuelve los totales `(subida, bajada)`.
    pub fn add(&self, up: u64, down: u64) -> (u64, u64) {
        let up = self.up.fetch_add(up, Ordering::Relaxed).saturating_add(up);
        let down = self.down.fetch_add(down, Ordering::Relaxed).saturating_add(down);
        (up, down)
    }

    /// Totales `(subida, bajada)` acumulados.
    pub fn totals(&self) -> (u64, u64) {
        (self.up.load(Ordering::Relaxed), self.down.load(Ordering::Relaxed))
    }

    /// Conexiones abiertas ahora mismo.
    pub fn active_connections(&self) -> u64 {
        self.active.load(Ordering::Relaxed)
    }

    /// Totales y conexiones vivas, para el evento.
    pub fn snapshot(&self) -> TrafficSnapshot {
        let (bytes_up, bytes_down) = self.totals();
        TrafficSnapshot {
            bytes_up,
            bytes_down,
            active_connections: self.active_connections(),
        }
    }
}

/// Una conexión viva de un túnel. Abrirla suma una conexión y soltarla la
/// resta, también si la tarea que la lleva falla o se aborta: así el contador
/// no se queda con conexiones fantasma. Las dos cosas avisan a `sink`.
pub struct TunnelConnection {
    traffic: Arc<TunnelTraffic>,
    sink: TrafficSink,
}

impl TunnelConnection {
    pub fn open(traffic: Arc<TunnelTraffic>, sink: TrafficSink) -> Self {
        traffic.active.fetch_add(1, Ordering::Relaxed);
        let conn = Self { traffic, sink };
        conn.emit();
        conn
    }

    /// El tráfico acumulado del túnel al que pertenece.
    pub fn traffic(&self) -> &TunnelTraffic {
        &self.traffic
    }

    /// Avisa a `sink` con la instantánea actual del túnel.
    pub fn emit(&self) {
        (self.sink)(self.traffic.snapshot());
    }
}

impl Drop for TunnelConnection {
    fn drop(&mut self) {
        self.traffic.active.fetch_sub(1, Ordering::Relaxed);
        self.emit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_emite_antes_del_intervalo_con_pocos_bytes() {
        assert!(!should_emit_traffic(Duration::from_millis(50), 4 * 1024));
        assert!(!should_emit_traffic(Duration::ZERO, 0));
    }

    #[test]
    fn emite_al_cumplirse_el_intervalo() {
        assert!(should_emit_traffic(TRAFFIC_MIN_INTERVAL, 0));
        assert!(should_emit_traffic(Duration::from_millis(300), 1));
    }

    #[test]
    fn emite_al_superar_el_umbral_de_bytes_aunque_no_pase_el_tiempo() {
        assert!(should_emit_traffic(Duration::from_millis(1), TRAFFIC_MIN_BYTES));
        assert!(should_emit_traffic(Duration::ZERO, TRAFFIC_MIN_BYTES + 1));
    }

    #[test]
    fn los_contadores_del_tunel_acumulan_entre_conexiones() {
        // Conexión A: una descarga de 30 MiB. Conexión B, después, una petición
        // pequeña: el total no se reinicia (antes la UI caía a lo de B).
        let t = TunnelTraffic::default();
        assert_eq!(t.add(2048, 30 << 20), (2048, 30 << 20));
        assert_eq!(t.add(512, 3000), (2560, (30 << 20) + 3000));
        assert_eq!(t.add(0, 0), (2560, (30 << 20) + 3000));
        assert_eq!(t.totals(), (2560, (30 << 20) + 3000));
    }

    #[test]
    fn los_contadores_del_tunel_suman_exacto_con_conexiones_simultaneas() {
        let t = std::sync::Arc::new(TunnelTraffic::default());
        let hilos: Vec<_> = (0..20)
            .map(|_| {
                let t = t.clone();
                std::thread::spawn(move || {
                    for _ in 0..1000 {
                        t.add(1, 2);
                    }
                })
            })
            .collect();
        for h in hilos {
            h.join().unwrap();
        }
        assert_eq!(t.totals(), (20_000, 40_000));
    }

    fn recording_sink() -> (TrafficSink, Arc<std::sync::Mutex<Vec<TrafficSnapshot>>>) {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let sink: TrafficSink = Arc::new(move |snap| log.lock().unwrap().push(snap));
        (sink, seen)
    }

    #[test]
    fn las_conexiones_del_tunel_suben_al_abrir_y_bajan_al_soltar() {
        let t = Arc::new(TunnelTraffic::default());
        let (sink, seen) = recording_sink();
        let a = TunnelConnection::open(Arc::clone(&t), Arc::clone(&sink));
        let b = TunnelConnection::open(Arc::clone(&t), Arc::clone(&sink));
        assert_eq!(t.active_connections(), 2);
        b.traffic().add(10, 20);
        drop(b);
        assert_eq!(t.active_connections(), 1);
        drop(a);
        assert_eq!(t.active_connections(), 0);
        // Cada cambio se avisa, con los totales del túnel.
        let vistos: Vec<_> = seen.lock().unwrap().iter().map(|s| s.active_connections).collect();
        assert_eq!(vistos, vec![1, 2, 1, 0]);
        assert_eq!(
            seen.lock().unwrap().last().copied(),
            Some(TrafficSnapshot { bytes_up: 10, bytes_down: 20, active_connections: 0 })
        );
    }

    /// Una conexión que acaba en error o con su tarea abortada también resta:
    /// el guard se suelta al deshacer la pila.
    #[test]
    fn una_conexion_abortada_o_con_panico_no_queda_contada() {
        let t = Arc::new(TunnelTraffic::default());
        let (sink, _) = recording_sink();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let conn = TunnelConnection::open(Arc::clone(&t), Arc::clone(&sink));
            let tarea = tokio::spawn(async move {
                let _conn = conn;
                std::future::pending::<()>().await;
            });
            tokio::task::yield_now().await;
            assert_eq!(t.active_connections(), 1);
            tarea.abort();
            let _ = tarea.await;
            assert_eq!(t.active_connections(), 0);
        });
        let t2 = Arc::clone(&t);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _conn = TunnelConnection::open(t2, sink);
            panic!("fallo a mitad de la conexión");
        }));
        assert!(r.is_err());
        assert_eq!(t.active_connections(), 0);
    }
}
