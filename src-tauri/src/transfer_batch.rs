//! Transferencias de carpeta: los ficheros pequeños, varios a la vez (v2.15.0).
//!
//! Una carpeta con miles de ficheros pequeños se movía uno detrás de otro, y cada
//! uno pagaba su ida y vuelta de `open`/`close` con el servidor: el tiempo lo
//! dictaba la latencia, no el ancho de banda. Ahora, en SFTP, los ficheros de
//! hasta [`SMALL_FILE_MAX`] se agrupan en lotes que viajan a la vez.
//!
//! El umbral no es arbitrario: es el tamaño que el pipeline SFTP mueve con **un
//! solo handle** (`effective_parallelism` → 1). Así, un lote de N ficheros abre
//! exactamente N handles, y con N acotado al tope de la sesión
//! (`max_parallelism`, el mismo que protege a servidores como un StorageBox) el
//! número de handles abiertos nunca pasa de lo que ya se permitía. Los ficheros
//! mayores siguen en serie, con su propio pipelining.
//!
//! Dos reglas de este módulo, puras y con tests:
//!
//! - Un lote **reserva sus destinos**, sin distinguir mayúsculas: dos ficheros
//!   que acabarían en el mismo sitio (una renombración automática que coincide
//!   con otro nombre, o `A.txt` y `a.txt` en un disco que no las distingue)
//!   nunca viajan en el mismo lote; el segundo espera a que el primero exista y
//!   la política de conflictos decide sobre él como antes.
//! - [`run_bounded`] espera a **todos** los trabajos aunque alguno falle: cortar
//!   a medias dejaría temporales `.part` sin limpiar.

use std::collections::HashSet;
use std::future::Future;

use futures::stream::{self, StreamExt};

/// Tamaño máximo de un fichero «pequeño»: el trozo del pipeline SFTP
/// (`SFTP_CHUNK`), que se mueve con un solo handle.
pub const SMALL_FILE_MAX: u64 = 256 * 1024;

/// ¿Viaja este fichero en lote? Solo si el backend admite más de uno a la vez.
pub fn is_small(size: u64, concurrency: usize) -> bool {
    concurrency > 1 && size <= SMALL_FILE_MAX
}

/// Clave de reserva de un destino: sin distinguir mayúsculas, que es lo que
/// haría un disco que no las distingue.
fn target_key(target: &str) -> String {
    target.to_lowercase()
}

/// Lote de ficheros pequeños pendientes de enviar.
pub struct Batch<J> {
    jobs: Vec<J>,
    keys: HashSet<String>,
    cap: usize,
}

impl<J> Batch<J> {
    pub fn new(cap: usize) -> Self {
        Self {
            jobs: Vec::new(),
            keys: HashSet::new(),
            cap: cap.max(1),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    pub fn is_full(&self) -> bool {
        self.jobs.len() >= self.cap
    }

    /// ¿Iría `target` al mismo sitio que un fichero ya reservado en el lote?
    pub fn collides(&self, target: &str) -> bool {
        self.keys.contains(&target_key(target))
    }

    /// Añade un trabajo reservando su destino.
    pub fn push(&mut self, target: &str, job: J) {
        self.keys.insert(target_key(target));
        self.jobs.push(job);
    }

    /// Vacía el lote y devuelve sus trabajos.
    pub fn take(&mut self) -> Vec<J> {
        self.keys.clear();
        std::mem::take(&mut self.jobs)
    }
}

/// Ejecuta `run` sobre cada trabajo con como mucho `limit` a la vez y devuelve
/// los resultados **en el orden de los trabajos**. Espera a todos aunque alguno
/// falle.
pub async fn run_bounded<'j, J, T, F, Fut>(jobs: &'j [J], limit: usize, run: F) -> Vec<T>
where
    F: Fn(&'j J) -> Fut,
    Fut: Future<Output = T>,
{
    let mut results: Vec<(usize, T)> = stream::iter(jobs.iter().enumerate())
        .map(|(i, job)| {
            let fut = run(job);
            async move { (i, fut.await) }
        })
        .buffer_unordered(limit.max(1))
        .collect()
        .await;
    results.sort_by_key(|(i, _)| *i);
    results.into_iter().map(|(_, r)| r).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn solo_los_pequenos_viajan_en_lote_y_solo_si_hay_paralelismo() {
        assert!(is_small(0, 8));
        assert!(is_small(SMALL_FILE_MAX, 8));
        assert!(!is_small(SMALL_FILE_MAX + 1, 8));
        // FTP (o un tope de 1): todo en serie, como siempre.
        assert!(!is_small(10, 1));
    }

    #[test]
    fn el_lote_reserva_destinos_sin_distinguir_mayusculas() {
        let mut batch: Batch<u32> = Batch::new(3);
        batch.push("/descargas/A.txt", 1);
        assert!(batch.collides("/descargas/a.txt"));
        assert!(batch.collides("/descargas/A.txt"));
        assert!(!batch.collides("/descargas/b.txt"));
        batch.push("/descargas/b.txt", 2);
        assert!(!batch.is_full());
        batch.push("/descargas/c.txt", 3);
        assert!(batch.is_full());
        assert_eq!(batch.take(), vec![1, 2, 3]);
        // Vaciarlo libera las reservas.
        assert!(batch.is_empty());
        assert!(!batch.collides("/descargas/a.txt"));
    }

    #[tokio::test]
    async fn nunca_pasa_del_limite_y_conserva_el_orden() {
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs: Vec<u64> = (0..20).collect();
        let results = run_bounded(&jobs, 4, |&n| {
            let (live, peak) = (live.clone(), peak.clone());
            async move {
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                // Los primeros tardan más: si el orden de salida dependiera del
                // de llegada, se notaría.
                tokio::time::sleep(std::time::Duration::from_millis(20 - n)).await;
                live.fetch_sub(1, Ordering::SeqCst);
                n * 10
            }
        })
        .await;
        assert_eq!(results, jobs.iter().map(|n| n * 10).collect::<Vec<_>>());
        assert_eq!(peak.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn un_fallo_no_corta_a_los_demas() {
        let finished = Arc::new(AtomicUsize::new(0));
        let jobs: Vec<u32> = (0..6).collect();
        let results = run_bounded(&jobs, 3, |&n| {
            let finished = finished.clone();
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                finished.fetch_add(1, Ordering::SeqCst);
                if n == 1 {
                    Err(format!("fallo en {n}"))
                } else {
                    Ok(n)
                }
            }
        })
        .await;
        assert_eq!(finished.load(Ordering::SeqCst), 6);
        assert_eq!(results[1], Err("fallo en 1".to_string()));
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 5);
    }

    #[tokio::test]
    async fn un_limite_de_cero_se_trata_como_uno() {
        let jobs = [1, 2, 3];
        let results = run_bounded(&jobs, 0, |&n| async move { n }).await;
        assert_eq!(results, vec![1, 2, 3]);
    }
}
