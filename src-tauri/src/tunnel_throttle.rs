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

use std::sync::atomic::{AtomicU64, Ordering};
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
}

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
}
