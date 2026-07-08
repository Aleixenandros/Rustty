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
}
