//! Limitador de velocidad de las transferencias de ficheros (SFTP/FTP/FTPS).
//!
//! Una descarga a pleno pulmón se come el enlace entero: la videollamada se
//! entrecorta, el resto de sesiones SSH van a tirones y la propia interfaz se
//! nota pesada. Poner un techo a la subida y a la bajada es lo que convierte
//! «bajar esto» en algo que se puede dejar corriendo de fondo.
//!
//! **Opcional y apagado por defecto**: `0` = sin límite, que es el
//! comportamiento de siempre y el que no cuesta nada.
//!
//! El mecanismo es un *token bucket* por sentido, **global**: el límite es del
//! enlace, no de cada transferencia, así que dos descargas a la vez se reparten
//! el mismo techo en lugar de duplicarlo. La cuenta vive en [`BucketState`],
//! que no sabe de relojes ni de tareas —recibe el instante en milisegundos— y
//! por eso puede probarse sin dormir ni un microsegundo.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::locks::MutexExt;

/// Ráfaga mínima admitida: por debajo de un chunk, un límite bajo dejaría la
/// transferencia a cero en vez de lenta (nunca reuniría fichas para pedir el
/// chunk siguiente).
const MIN_BURST: u64 = 256 * 1024;

/// Estado de un token bucket. `rate_bps` en bytes por segundo; `0` = sin
/// límite. `tokens` puede quedar **en negativo**: es deuda ya consumida que se
/// paga esperando, y así un chunk grande no se rechaza ni se parte.
#[derive(Debug, Clone)]
pub struct BucketState {
    pub rate_bps: u64,
    pub tokens: f64,
    pub last_ms: u64,
}

impl BucketState {
    #[must_use]
    pub fn new(rate_bps: u64) -> Self {
        Self {
            rate_bps,
            tokens: 0.0,
            last_ms: 0,
        }
    }
}

/// Ráfaga que el bucket puede acumular: medio segundo de caudal, nunca menos de
/// un chunk. Sin margen de ráfaga, el tráfico saldría a golpes de un chunk por
/// espera y el rendimiento efectivo caería muy por debajo del límite pedido.
#[must_use]
pub fn burst_for(rate_bps: u64) -> u64 {
    (rate_bps / 2).max(MIN_BURST)
}

/// Apunta `bytes` en el bucket y devuelve **cuántos milisegundos hay que
/// esperar** antes de mandarlos (0 = adelante).
///
/// Con `rate_bps == 0` no hay límite y siempre devuelve 0, sin tocar el estado:
/// el camino sin límite no paga nada.
pub fn take(state: &mut BucketState, now_ms: u64, bytes: u64) -> u64 {
    if state.rate_bps == 0 {
        return 0;
    }
    // Recarga por el tiempo transcurrido, con techo en la ráfaga: un bucket
    // parado media hora no puede dar media hora de caudal de golpe.
    let elapsed_s = now_ms.saturating_sub(state.last_ms) as f64 / 1000.0;
    state.last_ms = now_ms;
    let burst = burst_for(state.rate_bps) as f64;
    state.tokens = (state.tokens + elapsed_s * state.rate_bps as f64).min(burst);

    state.tokens -= bytes as f64;
    if state.tokens >= 0.0 {
        return 0;
    }
    // Deuda: el tiempo que tarda el caudal en reponer lo que falta.
    let deficit = -state.tokens;
    (deficit / state.rate_bps as f64 * 1000.0).ceil() as u64
}

// ─── Límites vivos de la aplicación ─────────────────────────────────────────

/// Origen del reloj monotónico: los `now_ms` que ve el bucket son milisegundos
/// desde aquí. Monotónico y no `SystemTime` a propósito — un ajuste de hora del
/// sistema no debe congelar ni desbocar una transferencia.
static START: LazyLock<Instant> = LazyLock::new(Instant::now);

static UPLOAD: LazyLock<Mutex<BucketState>> =
    LazyLock::new(|| Mutex::new(BucketState::new(0)));
static DOWNLOAD: LazyLock<Mutex<BucketState>> =
    LazyLock::new(|| Mutex::new(BucketState::new(0)));

/// Copia de los límites fuera del mutex, para que el camino «sin límite» —el
/// de la inmensa mayoría— no tenga que tomar un lock por chunk.
static UPLOAD_BPS: AtomicU64 = AtomicU64::new(0);
static DOWNLOAD_BPS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    START.elapsed().as_millis() as u64
}

/// Fija los techos en bytes por segundo (`0` = sin límite). La llama el
/// frontend al cargar y al guardar preferencias.
pub fn set_limits(upload_bps: u64, download_bps: u64) {
    UPLOAD_BPS.store(upload_bps, Ordering::Relaxed);
    DOWNLOAD_BPS.store(download_bps, Ordering::Relaxed);
    let now = now_ms();
    for (bucket, rate) in [(&*UPLOAD, upload_bps), (&*DOWNLOAD, download_bps)] {
        let mut st = bucket.lock_recover();
        st.rate_bps = rate;
        // Al cambiar el techo se parte de cero deuda y de cero crédito: ni se
        // arrastra un castigo del límite viejo ni se regala una ráfaga.
        st.tokens = 0.0;
        st.last_ms = now;
    }
}

fn wait_for(bucket: &Mutex<BucketState>, bytes: u64) -> Duration {
    let ms = {
        let mut st = bucket.lock_recover();
        take(&mut st, now_ms(), bytes)
    };
    Duration::from_millis(ms)
}

/// Espera lo que haga falta antes de mandar `bytes` de **subida** (async).
pub async fn throttle_upload(bytes: u64) {
    if UPLOAD_BPS.load(Ordering::Relaxed) == 0 {
        return;
    }
    let d = wait_for(&UPLOAD, bytes);
    if !d.is_zero() {
        tokio::time::sleep(d).await;
    }
}

/// Espera lo que haga falta antes de pedir `bytes` de **bajada** (async).
pub async fn throttle_download(bytes: u64) {
    if DOWNLOAD_BPS.load(Ordering::Relaxed) == 0 {
        return;
    }
    let d = wait_for(&DOWNLOAD, bytes);
    if !d.is_zero() {
        tokio::time::sleep(d).await;
    }
}

/// Versión bloqueante para el camino FTP/FTPS, que copia sobre un stream
/// síncrono en su propio hilo de worker.
pub fn throttle_blocking(bytes: u64, upload: bool) {
    let rate = if upload {
        UPLOAD_BPS.load(Ordering::Relaxed)
    } else {
        DOWNLOAD_BPS.load(Ordering::Relaxed)
    };
    if rate == 0 {
        return;
    }
    let d = wait_for(if upload { &UPLOAD } else { &DOWNLOAD }, bytes);
    if !d.is_zero() {
        std::thread::sleep(d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_limite_nunca_espera() {
        let mut st = BucketState::new(0);
        assert_eq!(take(&mut st, 0, 100 * 1024 * 1024), 0);
        assert_eq!(take(&mut st, 1_000, u64::MAX), 0);
    }

    #[test]
    fn la_primera_rafaga_pasa_sin_esperar() {
        // 1 MiB/s → ráfaga de 512 KiB. Lo que cabe en la ráfaga sale de
        // inmediato; sin este margen el caudal real se quedaría muy corto.
        let rate = 1024 * 1024;
        let mut st = BucketState::new(rate);
        st.last_ms = 0;
        // Un segundo de crédito acumulado, recortado a la ráfaga.
        assert_eq!(take(&mut st, 1_000, 256 * 1024), 0);
    }

    #[test]
    fn pasarse_del_caudal_obliga_a_esperar_lo_justo() {
        let rate = 1024 * 1024; // 1 MiB/s
        let mut st = BucketState::new(rate);
        // Sin tiempo transcurrido no hay crédito: 1 MiB son 1000 ms de deuda.
        let ms = take(&mut st, 0, rate);
        assert_eq!(ms, 1_000);
        // Y la deuda queda apuntada: pedir otro tanto en el mismo instante
        // espera el doble en total.
        let ms2 = take(&mut st, 0, rate);
        assert_eq!(ms2, 2_000);
    }

    #[test]
    fn el_credito_no_se_acumula_mas_alla_de_la_rafaga() {
        let rate = 1024 * 1024;
        let mut st = BucketState::new(rate);
        // Una hora parado no da una hora de caudal: el techo es la ráfaga.
        let burst = burst_for(rate);
        let ms = take(&mut st, 3_600_000, burst + rate);
        // Se cubre la ráfaga; el resto (1 MiB) se paga esperando.
        assert_eq!(ms, 1_000);
    }

    #[test]
    fn la_rafaga_nunca_baja_del_chunk() {
        // Con techos muy bajos, una ráfaga proporcional sería menor que un
        // chunk y la transferencia no avanzaría nunca.
        assert_eq!(burst_for(1_024), MIN_BURST);
        assert_eq!(burst_for(0), MIN_BURST);
        assert_eq!(burst_for(4 * 1024 * 1024), 2 * 1024 * 1024);
    }

    #[test]
    fn fijar_los_limites_llega_al_atajo_y_al_bucket() {
        // El atajo atómico y el estado del bucket tienen que decir lo mismo: si
        // se desincronizaran, el camino rápido dejaría pasar tráfico que el
        // bucket cree estar limitando.
        set_limits(1_000, 2_000);
        assert_eq!(UPLOAD_BPS.load(Ordering::Relaxed), 1_000);
        assert_eq!(DOWNLOAD_BPS.load(Ordering::Relaxed), 2_000);
        assert_eq!(UPLOAD.lock_recover().rate_bps, 1_000);
        assert_eq!(DOWNLOAD.lock_recover().rate_bps, 2_000);

        set_limits(0, 0);
        assert_eq!(UPLOAD_BPS.load(Ordering::Relaxed), 0);
        assert_eq!(UPLOAD.lock_recover().rate_bps, 0);
    }
}
