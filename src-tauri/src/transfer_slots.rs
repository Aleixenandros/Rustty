//! Techo global de transferencias de ficheros **simultáneas**.
//!
//! `sftpMaxConcurrent` ya existía, pero es otra cosa: cuántas peticiones SFTP
//! van en vuelo **dentro de una transferencia**. Lo que faltaba es un
//! presupuesto común: bajar cinco carpetas desde cinco sesiones distintas abría
//! cinco transferencias a la vez, cada una peleando por el mismo enlace y por
//! los mismos handles del servidor. Con un techo, las que sobran esperan turno
//! en vez de repartirse el ancho de banda a codazos.
//!
//! **Opcional y apagado por defecto**: `0` = sin techo, que es el
//! comportamiento de siempre.
//!
//! El techo es del conjunto de la aplicación, no de cada sesión: el cuello de
//! botella —el enlace de red y la paciencia del servidor— también lo es. Cada
//! transferencia toma un [`TransferSlot`] antes de empezar y lo suelta al
//! terminar, pase lo que pase, porque el `Drop` lo devuelve incluso si la
//! transferencia se cancela o revienta a mitad. Una transferencia de carpeta
//! entera consume **un** hueco, no uno por fichero: lo que se está limitando es
//! el número de copias en marcha, tal como las ve el usuario en el panel.
//!
//! El recuento vive en [`SlotState`], que no sabe de tareas ni de esperas —solo
//! suma y resta— y por eso se prueba sin concurrencia de por medio.

use std::sync::{LazyLock, Mutex};

use tokio::sync::Notify;

use crate::locks::MutexExt;

/// Cuenta de huecos: cuántos caben (`limit`, `0` = sin techo) y cuántos están
/// ocupados ahora mismo.
#[derive(Debug, Clone, Copy)]
pub struct SlotState {
    limit: u32,
    in_use: u32,
}

impl SlotState {
    #[must_use]
    pub fn new(limit: u32) -> Self {
        Self { limit, in_use: 0 }
    }

    /// Ocupa un hueco si queda alguno. `false` = hay que esperar.
    pub fn try_take(&mut self) -> bool {
        if self.limit != 0 && self.in_use >= self.limit {
            return false;
        }
        self.in_use += 1;
        true
    }

    /// Devuelve un hueco. Satura en 0: soltar de más nunca debe abrir huecos
    /// que no existen.
    pub fn release(&mut self) {
        self.in_use = self.in_use.saturating_sub(1);
    }

    /// Cambia el techo. **No aborta nada**: si el usuario lo baja con
    /// transferencias en marcha, las que ya corren terminan y el techo nuevo
    /// empieza a valer para las siguientes.
    pub fn set_limit(&mut self, limit: u32) {
        self.limit = limit;
    }

    /// `true` si una transferencia más tendría que esperar turno.
    #[must_use]
    pub fn would_wait(&self) -> bool {
        self.limit != 0 && self.in_use >= self.limit
    }
}

static STATE: LazyLock<Mutex<SlotState>> = LazyLock::new(|| Mutex::new(SlotState::new(0)));

/// Se avisa aquí cada vez que se libera un hueco o sube el techo.
static FREED: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Fija el número máximo de transferencias simultáneas (`0` = sin techo). La
/// llama el frontend al cargar y al guardar preferencias.
pub fn set_max_concurrent(limit: u32) {
    STATE.lock_recover().set_limit(limit);
    // Subir el techo (o quitarlo) tiene que despertar a quien esté en cola: si
    // no, seguirían esperando un aviso de liberación que quizá no llega nunca.
    FREED.notify_waiters();
}

/// `true` si una transferencia nueva tendría que esperar turno. Se consulta
/// para avisar al usuario («en cola») **antes** de bloquearse.
#[must_use]
pub fn would_wait() -> bool {
    STATE.lock_recover().would_wait()
}

/// Hueco ocupado. Al soltarlo (`Drop`) se devuelve y se despierta a quien
/// espere; no hace falta acordarse de liberarlo en cada rama de error.
#[derive(Debug)]
pub struct TransferSlot {
    _private: (),
}

impl Drop for TransferSlot {
    fn drop(&mut self) {
        STATE.lock_recover().release();
        FREED.notify_waiters();
    }
}

/// Espera turno y devuelve el hueco ocupado. Sin techo configurado no espera
/// nunca.
pub async fn acquire() -> TransferSlot {
    loop {
        // El interés se registra **antes** de mirar el estado (`enable`): si se
        // liberara un hueco justo entre la comprobación y la espera, el aviso
        // ya estaría apuntado y no se perdería. Sin esto, una transferencia
        // podría quedarse dormida para siempre con el techo libre.
        let notified = FREED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        if STATE.lock_recover().try_take() {
            return TransferSlot { _private: () };
        }
        notified.await;
    }
}

/// Pide turno avisando antes al panel si toca esperar. Sin ese aviso, una
/// transferencia en cola sería indistinguible de una colgada: barra a cero y
/// ninguna explicación.
pub async fn take_with_notice(app: &tauri::AppHandle, transfer_id: &str) -> TransferSlot {
    use tauri::Emitter;
    if would_wait() {
        let _ = app.emit(
            &crate::ipc::event_name(crate::ipc::EventKind::SftpProgress, transfer_id),
            serde_json::json!({
                "transferred": 0u64, "total": 0u64, "done": false, "queued": true,
            }),
        );
    }
    acquire().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_techo_nunca_se_llena() {
        let mut st = SlotState::new(0);
        for _ in 0..1_000 {
            assert!(st.try_take());
        }
        assert!(!st.would_wait());
        assert_eq!(st.in_use, 1_000);
    }

    #[test]
    fn el_techo_corta_en_el_numero_pedido() {
        let mut st = SlotState::new(2);
        assert!(st.try_take());
        assert!(st.try_take());
        assert!(!st.try_take());
        assert!(st.would_wait());

        st.release();
        assert!(!st.would_wait());
        assert!(st.try_take());
    }

    #[test]
    fn soltar_de_mas_no_regala_huecos() {
        // Un `Drop` doble o un release espurio no puede dejar el contador por
        // debajo de cero y abrir huecos fantasma.
        let mut st = SlotState::new(1);
        st.release();
        st.release();
        assert_eq!(st.in_use, 0);
        assert!(st.try_take());
        assert!(!st.try_take());
    }

    #[test]
    fn bajar_el_techo_no_aborta_lo_que_ya_corre() {
        let mut st = SlotState::new(4);
        assert!(st.try_take());
        assert!(st.try_take());
        assert!(st.try_take());
        // El usuario baja el techo a 1 con tres transferencias vivas: siguen
        // vivas, pero no entra ninguna más hasta que bajen de 1.
        st.set_limit(1);
        assert!(st.would_wait());
        assert!(!st.try_take());
        st.release();
        st.release();
        assert!(st.would_wait());
        st.release();
        assert!(st.try_take());
    }

    /// Los dos tests de abajo mueven el techo **global**: si corrieran a la
    /// vez, uno le cambiaría el suelo al otro.
    static SERIE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn el_hueco_se_devuelve_al_soltarlo() {
        let _guard = SERIE.lock().await;
        set_max_concurrent(1);
        let primero = acquire().await;
        assert!(would_wait());

        // Con el único hueco ocupado, la siguiente espera; al soltar el
        // primero, entra sin que nadie tenga que avisarla a mano.
        let espera = tokio::spawn(async {
            let _slot = acquire().await;
            true
        });
        tokio::task::yield_now().await;
        assert!(!espera.is_finished());

        drop(primero);
        let entro = tokio::time::timeout(std::time::Duration::from_secs(5), espera)
            .await
            .expect("la transferencia en cola debería entrar al liberarse el hueco")
            .expect("la tarea en cola no debería entrar en pánico");
        assert!(entro);

        set_max_concurrent(0);
    }

    #[tokio::test]
    async fn quitar_el_techo_despierta_a_quien_espera() {
        let _guard = SERIE.lock().await;
        set_max_concurrent(1);
        let _ocupado = acquire().await;

        let espera = tokio::spawn(async {
            let _slot = acquire().await;
            true
        });
        tokio::task::yield_now().await;
        assert!(!espera.is_finished());

        // Nadie libera nada: es el propio cambio de preferencia el que abre
        // paso.
        set_max_concurrent(0);
        let entro = tokio::time::timeout(std::time::Duration::from_secs(5), espera)
            .await
            .expect("subir el techo debería desbloquear la cola")
            .expect("la tarea en cola no debería entrar en pánico");
        assert!(entro);
    }
}
