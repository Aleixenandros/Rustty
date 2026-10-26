//! Pool de conexiones a los saltos: las sesiones que van por el mismo salto
//! comparten su conexión SSH (como el `ControlMaster` de OpenSSH), con una sola
//! autenticación y una sola pregunta de contraseña o de host key.
//!
//! Cada **prefijo** de una ruta es una entrada: la ruta `A → B` deja viva la
//! conexión con A (clave `[A]`) y la de B a través de A (clave `[A, B]`), así
//! que otra conexión por `A → C` reutiliza A. Una entrada guarda el `Handle` de
//! su último salto (russh no lo deja clonar: va en `Arc`) y un arrendamiento de
//! la anterior, que la mantiene viva mientras ella viva.
//!
//! Quien usa una cadena tiene un [`JumpLease`] mientras vive su conexión. Al
//! quedarse una entrada sin arrendamientos se cierra tras `idle_secs`; si antes
//! llega otra conexión, la reutiliza. Una entrada cuyo handle se cerró (el
//! salto se cayó, los keepalives fallaron) se reconstruye al pedirla. Hay un
//! candado por clave: dos conexiones simultáneas por el mismo salto no lo
//! construyen dos veces, la segunda espera y reutiliza (y solo sale una
//! pregunta). Con `reuse = false` no se comparte nada: cada conexión tiene su
//! cadena y la cierra al terminar.
//!
//! Las sesiones de los saltos viven en un runtime propio ([`jump_runtime`]):
//! cada sesión SSH de Rustty corre en su hilo con su runtime, y una conexión
//! compartida no puede morir con el hilo de la primera que la abrió.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::client;
use serde::{Deserialize, Serialize};

use crate::host_keys::KnownHostsClient;
use crate::jump_route::{HopKey, JumpRoute, StoredSecrets};
use crate::locks::MutexExt;
use crate::ssh_transport::{
    hop_info, open_hop, ConnectError, ConnectFailure, Hop, HostKeyFactory, JumpStage, StageLog,
};

// ─── Ajustes (contrato IPC) ───────────────────────────────────────────────────

/// Fichero de los ajustes en el directorio de datos: la CLI lee de aquí el
/// salto activo. Caché derivada, como `host-key-policy.json`: si falta, rigen
/// los valores por defecto y no hay salto activo.
pub const SETTINGS_FILE_NAME: &str = "jump-settings.json";

/// Segundos que una conexión a un salto sigue abierta sin uso, por defecto.
pub const DEFAULT_IDLE_SECS: u32 = 60;

/// Tras decir `jump_pool_ready` que una conexión está lista, cuánto se la
/// guarda como mínimo aunque nadie la use: lo que tarda la interfaz en conectar
/// sin pedir la contraseña que ya no hace falta.
pub(crate) const READY_GRACE: Duration = Duration::from_secs(30);

/// Ajustes del salto que manda la interfaz (`jump_settings_set`) al arrancar y
/// cada vez que cambian.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JumpSettings {
    /// Compartir la conexión de un salto entre las sesiones que van por él.
    #[serde(default = "default_reuse")]
    pub reuse: bool,
    /// Segundos que una conexión a un salto sigue abierta sin sesiones.
    #[serde(default = "default_idle_secs")]
    pub idle_secs: u32,
    /// Perfil del salto activo («todo por aquí»), si hay uno.
    #[serde(default)]
    pub active_profile_id: Option<String>,
    /// El salto activo sobrevive al reinicio (`activeJumpKeep`). Opcional: con
    /// `Some(false)` la app lo retira del fichero al cerrarse, para que la CLI
    /// no siga saliendo por un salto que la interfaz ya no tendrá puesto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep: Option<bool>,
}

fn default_reuse() -> bool {
    true
}

fn default_idle_secs() -> u32 {
    DEFAULT_IDLE_SECS
}

impl Default for JumpSettings {
    fn default() -> Self {
        JumpSettings {
            reuse: true,
            idle_secs: DEFAULT_IDLE_SECS,
            active_profile_id: None,
            keep: None,
        }
    }
}

impl JumpSettings {
    /// Id del salto activo, si hay uno (vacío = ninguno).
    pub fn active(&self) -> Option<&str> {
        self.active_profile_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

/// Escribe los ajustes en el directorio de datos, solo si cambiaron. Escritura
/// atómica. Devuelve si escribió.
pub fn save_settings(data_dir: &Path, settings: &JumpSettings) -> std::io::Result<bool> {
    let path = data_dir.join(SETTINGS_FILE_NAME);
    let payload = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    if std::fs::read(&path)
        .map(|cur| cur == payload)
        .unwrap_or(false)
    {
        return Ok(false);
    }
    crate::atomic_file::write(&path, &payload, false)?;
    Ok(true)
}

/// Lee los ajustes que dejó la interfaz. `None` si no hay fichero o no se
/// entiende.
#[must_use]
pub fn load_settings(data_dir: &Path) -> Option<JumpSettings> {
    let raw = std::fs::read(data_dir.join(SETTINGS_FILE_NAME)).ok()?;
    serde_json::from_slice(&raw).ok()
}

// ─── Runtime de los saltos ────────────────────────────────────────────────────

/// Runtime donde viven las sesiones de los saltos del pool y sus cierres por
/// inactividad. Se crea al primer uso y dura lo que el proceso.
pub(crate) fn jump_runtime() -> &'static tokio::runtime::Handle {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("rustty-saltos")
                .enable_all()
                .build()
                // Sin runtime no hay saltos posibles: es el mismo fallo que no
                // poder crear el runtime de una sesión, que ya aborta el hilo.
                .unwrap_or_else(|e| panic!("no se pudo crear el runtime de los saltos: {e}"))
        })
        .handle()
}

// ─── Conexiones y arrendamientos ──────────────────────────────────────────────

/// Conexión abierta con un salto.
pub(crate) struct HopConn {
    handle: client::Handle<KnownHostsClient>,
    /// Nombre del salto (para los mensajes de los que van detrás).
    name: String,
    /// Secretos con los que se entró: los aprende la ruta de quien reutiliza la
    /// conexión, para poder reconstruirla si muere.
    secrets: StoredSecrets,
    /// Arrendamiento del salto anterior: lo mantiene vivo mientras viva este.
    parent: Option<JumpLease>,
}

/// Uso de una cadena de saltos: mientras exista, la conexión con el último
/// salto (y con los anteriores) sigue abierta. Se suelta solo al soltarlo.
pub(crate) struct JumpLease {
    conn: Arc<HopConn>,
    pooled: Option<PooledRef>,
}

struct PooledRef {
    pool: Arc<PoolInner>,
    key: Vec<HopKey>,
    slot: Arc<Slot>,
}

impl JumpLease {
    /// El handle del último salto: por él se abre el `direct-tcpip` siguiente.
    pub(crate) fn handle(&self) -> &client::Handle<KnownHostsClient> {
        &self.conn.handle
    }

    /// Nombre del último salto.
    pub(crate) fn name(&self) -> &str {
        &self.conn.name
    }

    /// La conexión con el último salto se cerró (caída, keepalives fallidos).
    pub(crate) fn is_closed(&self) -> bool {
        self.conn.handle.is_closed()
    }

    /// Los secretos de cada salto de la cadena, del primero al último.
    fn chain_secrets(&self) -> Vec<StoredSecrets> {
        let mut out = vec![self.conn.secrets.clone()];
        let mut parent = self.conn.parent.as_ref();
        while let Some(lease) = parent {
            out.push(lease.conn.secrets.clone());
            parent = lease.conn.parent.as_ref();
        }
        out.reverse();
        out
    }

    /// Enseña a la ruta los secretos de la cadena que se le ha dado (ver
    /// `ResolvedHop::learned`).
    fn teach(&self, route: &JumpRoute) {
        for (hop, saved) in route.hops.iter().zip(self.chain_secrets()) {
            hop.learn(&saved);
        }
    }

    /// El último salto dejó de contestar aunque su conexión no conste cerrada
    /// todavía (los keepalives tardan en declararla muerta): se saca del pool
    /// para que la siguiente conexión construya otra en vez de colgarse en
    /// esta. Quien ya la usa la conserva hasta soltarla.
    pub(crate) fn invalidate(&self) {
        let Some(pooled) = &self.pooled else { return };
        let mut state = pooled.slot.state.lock_recover();
        if state
            .conn
            .as_ref()
            .is_some_and(|c| Arc::ptr_eq(c, &self.conn))
        {
            log::warn!("salto {}: no contesta, se reconstruirá", self.conn.name);
            state.conn = None;
        }
    }
}

impl Drop for JumpLease {
    fn drop(&mut self) {
        if let Some(pooled) = self.pooled.take() {
            pooled.pool.release(pooled.key, pooled.slot);
        }
    }
}

/// Entrada del pool: candado de construcción y estado.
struct Slot {
    /// Serializa la construcción de esta entrada (incluidas sus preguntas).
    build: tokio::sync::Mutex<()>,
    state: Mutex<SlotState>,
}

#[derive(Default)]
struct SlotState {
    conn: Option<Arc<HopConn>>,
    leases: usize,
    /// Sube con cada arrendamiento nuevo: un cierre por inactividad programado
    /// antes no se aplica si la generación cambió.
    generation: u64,
    /// Secretos con los que se construyó la conexión. Sobreviven a su caída
    /// (no a la entrada): si muere y otra sesión la pide sin secretos (la
    /// interfaz no los manda cuando `jump_pool_ready` dijo que estaba lista),
    /// se reconstruye con estos.
    secrets: Option<StoredSecrets>,
}

struct PoolInner {
    slots: Mutex<HashMap<Vec<HopKey>, Arc<Slot>>>,
    settings: Mutex<JumpSettings>,
    /// Conexiones con saltos abiertas desde que existe el pool (las
    /// reutilizadas no cuentan). Para el registro y los tests.
    opened: AtomicUsize,
}

impl PoolInner {
    /// Suelta un arrendamiento; si era el último, programa el cierre.
    fn release(self: &Arc<Self>, key: Vec<HopKey>, slot: Arc<Slot>) {
        let generation = {
            let mut state = slot.state.lock_recover();
            state.leases = state.leases.saturating_sub(1);
            if state.leases > 0 {
                return;
            }
            state.generation += 1;
            state.generation
        };
        let idle = self.idle();
        self.schedule_close(key, slot, generation, idle);
    }

    fn idle(&self) -> Duration {
        Duration::from_secs(u64::from(self.settings.lock_recover().idle_secs))
    }

    /// Cierra la entrada dentro de `delay` si para entonces sigue sin uso desde
    /// `generation`.
    fn schedule_close(
        self: &Arc<Self>,
        key: Vec<HopKey>,
        slot: Arc<Slot>,
        generation: u64,
        delay: Duration,
    ) {
        let pool = Arc::clone(self);
        jump_runtime().spawn(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            pool.close_if_idle(&key, &slot, generation).await;
        });
    }

    /// Cierra la entrada si sigue sin uso desde el arrendamiento `generation`.
    async fn close_if_idle(&self, key: &[HopKey], slot: &Arc<Slot>, generation: u64) {
        let conn = {
            let mut state = slot.state.lock_recover();
            if state.leases > 0 || state.generation != generation {
                return;
            }
            state.conn.take()
        };
        {
            let mut slots = self.slots.lock_recover();
            if slots.get(key).is_some_and(|s| Arc::ptr_eq(s, slot)) {
                slots.remove(key);
            }
        }
        if let Some(conn) = conn {
            log::info!("salto {}: conexión cerrada por inactividad", conn.name);
            let _ = conn
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "es")
                .await;
        }
    }
}

/// Pool compartido de conexiones a los saltos (estado gestionado por Tauri).
/// Clonarlo es barato: todos los clones son el mismo pool.
#[derive(Clone)]
pub struct JumpPool {
    inner: Arc<PoolInner>,
}

impl Default for JumpPool {
    fn default() -> Self {
        Self::new()
    }
}

impl JumpPool {
    pub fn new() -> Self {
        JumpPool {
            inner: Arc::new(PoolInner {
                slots: Mutex::new(HashMap::new()),
                settings: Mutex::new(JumpSettings::default()),
                opened: AtomicUsize::new(0),
            }),
        }
    }

    pub fn settings(&self) -> JumpSettings {
        self.inner.settings.lock_recover().clone()
    }

    pub fn set_settings(&self, settings: JumpSettings) {
        *self.inner.settings.lock_recover() = settings;
    }

    /// Conexiones con saltos abiertas hasta ahora (las reutilizadas no suman).
    #[cfg(test)]
    pub(crate) fn connections_opened(&self) -> usize {
        self.inner.opened.load(Ordering::Relaxed)
    }

    /// ¿Sigue la entrada en el pool (con o sin conexión viva)? Sin el efecto
    /// de [`Self::ready`], que aplaza su cierre.
    #[cfg(test)]
    fn has_entry(&self, key: &[HopKey]) -> bool {
        self.inner.slots.lock_recover().contains_key(key)
    }

    /// ¿Hay una conexión viva para exactamente esta secuencia de saltos?
    ///
    /// Con un «sí», la interfaz conecta sin pedir contraseñas: una entrada sin
    /// uso no se cierra hasta pasado al menos [`READY_GRACE`], para que esa
    /// conexión llegue a tiempo de reutilizarla.
    pub(crate) fn ready(&self, key: &[HopKey]) -> bool {
        if key.is_empty() || !self.settings().reuse {
            return false;
        }
        let Some(slot) = self.inner.slots.lock_recover().get(key).cloned() else {
            return false;
        };
        let postponed = {
            let mut state = slot.state.lock_recover();
            if !state.conn.as_ref().is_some_and(|c| !c.handle.is_closed()) {
                return false;
            }
            (state.leases == 0).then(|| {
                state.generation += 1;
                state.generation
            })
        };
        if let Some(generation) = postponed {
            let delay = self.inner.idle().max(READY_GRACE);
            self.inner
                .schedule_close(key.to_vec(), slot, generation, delay);
        }
        true
    }

    fn slot(&self, key: &[HopKey]) -> Arc<Slot> {
        let mut slots = self.inner.slots.lock_recover();
        Arc::clone(slots.entry(key.to_vec()).or_insert_with(|| {
            Arc::new(Slot {
                build: tokio::sync::Mutex::new(()),
                state: Mutex::new(SlotState::default()),
            })
        }))
    }

    /// Arrendamiento de la entrada si su conexión está viva. Una conexión
    /// cerrada se descarta (se reconstruirá).
    fn lease_slot(&self, key: &[HopKey], slot: &Arc<Slot>) -> Option<JumpLease> {
        let mut state = slot.state.lock_recover();
        let conn = state.conn.clone()?;
        if conn.handle.is_closed() {
            state.conn = None;
            return None;
        }
        state.leases += 1;
        state.generation += 1;
        Some(JumpLease {
            conn,
            pooled: Some(PooledRef {
                pool: Arc::clone(&self.inner),
                key: key.to_vec(),
                slot: Arc::clone(slot),
            }),
        })
    }

    /// Retira una entrada que no llegó a tener conexión (falló al construirla)
    /// para que el mapa no acumule claves vacías.
    fn forget_if_unused(&self, key: &[HopKey], slot: &Arc<Slot>) {
        let unused = {
            let state = slot.state.lock_recover();
            state.conn.is_none() && state.leases == 0
        };
        if unused {
            let mut slots = self.inner.slots.lock_recover();
            if slots.get(key).is_some_and(|s| Arc::ptr_eq(s, slot)) {
                slots.remove(key);
            }
        }
    }

    fn try_lease(&self, key: &[HopKey]) -> Option<JumpLease> {
        let slot = self.inner.slots.lock_recover().get(key).cloned()?;
        self.lease_slot(key, &slot)
    }

    /// La cadena de saltos de `route`: reutiliza el prefijo vivo más largo y
    /// construye el resto (cada salto bajo el candado de su clave). Con
    /// `reuse = false`, una cadena propia que no se comparte.
    pub(crate) async fn acquire(
        &self,
        route: &JumpRoute,
        host_key_check: HostKeyFactory<'_>,
        on_stage: StageLog<'_>,
    ) -> Result<JumpLease, ConnectError> {
        if !self.settings().reuse {
            let lease = build_private(route, Some(jump_runtime()), host_key_check, on_stage).await;
            if lease.is_ok() {
                self.inner.opened.fetch_add(route.len(), Ordering::Relaxed);
            }
            return lease;
        }
        let total = route.len();
        let mut lease: Option<JumpLease> = None;
        let mut start = 0;
        for upto in (1..=total).rev() {
            if let Some(found) = self.try_lease(&route.key(upto)) {
                let addr = route.hops[upto - 1].addr();
                on_stage(JumpStage::Reused(hop_info(route, upto, &addr)));
                lease = Some(found);
                start = upto;
                break;
            }
        }
        for upto in start + 1..=total {
            let key = route.key(upto);
            let slot = self.slot(&key);
            let _building = slot.build.lock().await;
            let addr = route.hops[upto - 1].addr();
            let info = hop_info(route, upto, &addr);
            // Otra conexión pudo construirla mientras se esperaba el candado.
            if let Some(found) = self.lease_slot(&key, &slot) {
                on_stage(JumpStage::Reused(info));
                lease = Some(found);
                continue;
            }
            let saved = slot.state.lock_recover().secrets.clone();
            let hop = route.hops[upto - 1].with_fallback(saved.as_ref());
            let opened = open_hop(
                &hop,
                info,
                lease.as_ref().map(|l| (l.handle(), l.name())),
                Some(jump_runtime()),
                host_key_check,
                on_stage,
            )
            .await;
            let handle = match opened {
                Ok(handle) => handle,
                Err(err) => {
                    // El salto anterior no contestó al abrir el túnel: fuera
                    // del pool, que el reintento lo reconstruya.
                    if err.failure == ConnectFailure::Transport
                        && err.hop
                            == (Hop::Jump {
                                index: upto - 1,
                                total,
                            })
                    {
                        if let Some(previous) = &lease {
                            previous.invalidate();
                        }
                    }
                    self.forget_if_unused(&key, &slot);
                    return Err(err);
                }
            };
            self.inner.opened.fetch_add(1, Ordering::Relaxed);
            let secrets = hop.stored_secrets();
            let conn = Arc::new(HopConn {
                handle,
                name: hop.name.clone(),
                secrets: secrets.clone(),
                parent: lease.take(),
            });
            {
                let mut state = slot.state.lock_recover();
                state.conn = Some(Arc::clone(&conn));
                state.leases += 1;
                state.generation += 1;
                state.secrets = Some(secrets);
            }
            // Un cierre por inactividad de la conexión anterior pudo sacar la
            // entrada del mapa mientras se construía esta: vuelve a él para que
            // la compartan las siguientes.
            self.inner
                .slots
                .lock_recover()
                .entry(key.clone())
                .or_insert_with(|| Arc::clone(&slot));
            lease = Some(JumpLease {
                conn,
                pooled: Some(PooledRef {
                    pool: Arc::clone(&self.inner),
                    key,
                    slot: Arc::clone(&slot),
                }),
            });
        }
        let lease = lease.ok_or_else(empty_route_error)?;
        lease.teach(route);
        Ok(lease)
    }
}

/// La ruta de una conexión y el pool donde compartir sus saltos: lo que lleva
/// cada sesión (y su reconexión) para volver a salir por el mismo camino.
#[derive(Clone, Default)]
pub(crate) struct Routing {
    pub route: JumpRoute,
    pub pool: Option<JumpPool>,
}

impl Routing {
    /// Sin saltos (y sin pool).
    pub(crate) fn direct() -> Self {
        Self::default()
    }
}

fn empty_route_error() -> ConnectError {
    ConnectError {
        hop: Hop::Target,
        failure: ConnectFailure::Transport,
        message: "La ruta no tiene saltos".to_string(),
    }
}

/// Cadena de saltos propia (sin pool, o con `reuse = false`): se cierra al
/// soltar el arrendamiento. `runtime` es donde viven sus sesiones (`None` = el
/// actual, como en la CLI).
pub(crate) async fn build_private(
    route: &JumpRoute,
    runtime: Option<&tokio::runtime::Handle>,
    host_key_check: HostKeyFactory<'_>,
    on_stage: StageLog<'_>,
) -> Result<JumpLease, ConnectError> {
    let mut lease: Option<JumpLease> = None;
    for (index, hop) in route.hops.iter().enumerate() {
        let addr = hop.addr();
        let info = hop_info(route, index + 1, &addr);
        let hop = hop.with_fallback(None);
        let handle = open_hop(
            &hop,
            info,
            lease.as_ref().map(|l| (l.handle(), l.name())),
            runtime,
            host_key_check,
            on_stage,
        )
        .await?;
        lease = Some(JumpLease {
            conn: Arc::new(HopConn {
                handle,
                name: hop.name.clone(),
                secrets: hop.stored_secrets(),
                parent: lease.take(),
            }),
            pooled: None,
        });
    }
    let lease = lease.ok_or_else(empty_route_error)?;
    lease.teach(route);
    Ok(lease)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn los_ajustes_tienen_defaults_sensatos_y_viajan_al_fichero() {
        // Un objeto vacío (o al que le falten campos) toma los defaults.
        let parsed: JumpSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed, JumpSettings::default());
        assert!(parsed.reuse);
        assert_eq!(parsed.idle_secs, DEFAULT_IDLE_SECS);
        assert_eq!(parsed.active(), None);
        // El formato del contrato: snake_case, `keep` opcional.
        let parsed: JumpSettings = serde_json::from_str(
            r#"{"reuse": false, "idle_secs": 5, "active_profile_id": " salto "}"#,
        )
        .unwrap();
        assert!(!parsed.reuse);
        assert_eq!(parsed.idle_secs, 5);
        assert_eq!(parsed.active(), Some("salto"));
        assert_eq!(parsed.keep, None);

        let dir = std::env::temp_dir().join(format!("rustty-jumps-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load_settings(&dir), None, "sin fichero no hay ajustes");
        assert!(
            save_settings(&dir, &parsed).unwrap(),
            "la primera vez escribe"
        );
        assert!(
            !save_settings(&dir, &parsed).unwrap(),
            "sin cambios no reescribe"
        );
        assert_eq!(load_settings(&dir), Some(parsed));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sin_conexiones_el_pool_no_esta_listo() {
        let pool = JumpPool::new();
        let key = vec![HopKey {
            profile_id: "a".into(),
            host: "a.lan".into(),
            port: 22,
            user: "ana".into(),
        }];
        assert!(!pool.ready(&key));
        assert!(!pool.ready(&[]));
        assert_eq!(pool.connections_opened(), 0);
    }

    /// Espera (como mucho 10 s) a que se cumpla `done`.
    async fn wait_until(what: &str, done: impl Fn() -> bool) {
        for _ in 0..200 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no llegó a pasar: {what}");
    }

    /// Una conexión del pool que se usaba **sin** contraseña (la interfaz no
    /// la manda cuando `jump_pool_ready` dijo «lista») y que muere se
    /// reconstruye con los secretos con los que se abrió: los de su entrada
    /// mientras siga en el pool, y los que aprendió la ruta de la sesión
    /// cuando ya no. Contra el servidor russh en proceso, que pide la
    /// contraseña por `keyboard-interactive` (el camino de PAM).
    #[tokio::test]
    async fn un_salto_que_muere_se_reconstruye_con_los_secretos_con_que_se_abrio() {
        use crate::jump_route::{HopSecrets, ResolvedHop};
        use crate::kbd_fixture::{KbdServer, Rounds};
        use crate::profiles::AuthType;

        let server = KbdServer::start(Rounds {
            password: "secreto".into(),
            otp: None,
            double_prompt: false,
        })
        .await;
        let fingerprint = server.fingerprint.clone();
        // Huella fijada: el test no toca ningún known_hosts.
        let check = move |_hop: Hop, host: &str, port: u16| {
            let (mut handler, failure) =
                crate::host_keys::client(host.to_string(), port, false, false);
            handler.expect_fingerprint(Some(fingerprint.clone()));
            (handler, failure)
        };
        let route = |password: Option<&str>| JumpRoute {
            hops: vec![ResolvedHop {
                profile_id: Some("salto".into()),
                name: "salto".into(),
                host: "127.0.0.1".into(),
                port: server.port,
                username: "ana".into(),
                auth_type: AuthType::Password,
                key_path: None,
                secrets: HopSecrets {
                    password: password.map(str::to_string),
                    ..HopSecrets::default()
                },
                allow_legacy_algorithms: false,
                legacy_algorithms: None,
                learned: Arc::default(),
            }],
        };
        let no_log = |_stage: JumpStage<'_>| {};
        let pool = JumpPool::new();
        let key = route(None).key(1);

        let with_password = route(Some("secreto"));
        let first = pool
            .acquire(&with_password, &check, &no_log)
            .await
            .expect("con contraseña entra");
        // Otra sesión sin contraseña: reutiliza la conexión y aprende sus
        // secretos.
        let session = route(None);
        let second = pool
            .acquire(&session, &check, &no_log)
            .await
            .expect("sin contraseña reutiliza");
        assert_eq!(pool.connections_opened(), 1);

        // La conexión muere con las dos sesiones dentro.
        let _ = first
            .handle()
            .disconnect(russh::Disconnect::ByApplication, "", "es")
            .await;
        wait_until("la conexión con el salto se cierra", || first.is_closed()).await;
        drop(first);
        drop(second);

        // Una tercera ruta sin contraseña y que no aprendió nada: la entrada
        // sigue en el pool (60 s sin uso) y reconstruye con sus secretos.
        let third_route = route(None);
        let third = pool
            .acquire(&third_route, &check, &no_log)
            .await
            .expect("la entrada reconstruye con los secretos con que se abrió");
        assert_eq!(pool.connections_opened(), 2);

        // Ahora la entrada sale del pool (cierre inmediato al quedar sin uso):
        // la sesión que aprendió los secretos vuelve a entrar igual.
        pool.set_settings(JumpSettings {
            idle_secs: 0,
            ..JumpSettings::default()
        });
        drop(third);
        wait_until("la entrada sale del pool", || !pool.has_entry(&key)).await;
        let again = pool
            .acquire(&session, &check, &no_log)
            .await
            .expect("la ruta de la sesión aprendió los secretos");
        assert_eq!(pool.connections_opened(), 3);
        drop(again);
        wait_until("la entrada vuelve a salir", || !pool.has_entry(&key)).await;

        // Sin entrada y sin nada aprendido no hay con qué entrar.
        let err = pool
            .acquire(&route(None), &check, &no_log)
            .await
            .err()
            .expect("sin secretos no entra");
        assert_eq!(err.failure, ConnectFailure::Auth, "{err:?}");
        // Las tres que entraron lo intentaron una vez; la última ni lo intenta
        // (no tiene contraseña que mandar).
        assert_eq!(server.password_attempts(), 3);
    }

    /// **Integración** con `sshd` reales (bastión, cadenas, pool, túneles
    /// prohibidos, reenvío local), por los mismos caminos que la app. Ignorados
    /// por defecto: necesitan `sshd` y `ssh-keygen`; se corren con `--ignored`.
    #[cfg(target_os = "linux")]
    mod real {
        use super::*;
        use crate::host_keys;
        use crate::jump_route::{route_with, HopSecrets, JumpRoute};
        use crate::profiles::{AuthType, ConnectionProfile};
        use crate::ssh_fixture::{self, FakeSshServer};
        use crate::ssh_manager::authenticate_handle;
        use crate::ssh_transport::{connect_routed, ConnectFailure, HostKeyCheck, JumpStage};
        use russh::client::AuthResult;
        use std::path::{Path, PathBuf};

        /// Comparten la política TOFU global y el rango de puertos efímeros con
        /// el resto de tests de integración SSH: se serializan entre sí.
        static JUMP_IT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

        /// Perfil SSH por clave pública contra el fixture: cada `sshd` solo
        /// autoriza **su** clave, así que cada salto tiene credenciales propias.
        fn profile_for(id: &str, server: &FakeSshServer) -> ConnectionProfile {
            let mut profile: ConnectionProfile = serde_json::from_value(serde_json::json!({
                "id": id,
                "name": format!("salto-{id}"),
                "host": "127.0.0.1",
                "port": server.port,
                "username": server.username,
                "connection_type": "ssh",
                "domain": null,
                "auth_type": "public_key",
                "key_path": server.user_key.to_string_lossy(),
                "group": null,
                "created_at": "2026-10-25T00:00:00Z"
            }))
            .expect("perfil de prueba");
            profile.auth_type = AuthType::PublicKey;
            profile
        }

        fn with_jump(mut profile: ConnectionProfile, via: &str) -> ConnectionProfile {
            profile.proxy_jump_profile_id = Some(via.to_string());
            profile
        }

        /// Ruta de `target` como la arma la app, sin catálogo de credenciales
        /// (las claves de los perfiles no llevan passphrase).
        fn route(profiles: &[ConnectionProfile], target: &ConnectionProfile) -> JumpRoute {
            route_with(
                profiles,
                target,
                HopSecrets::default(),
                None,
                &mut |p| p.clone(),
                &mut |_| HopSecrets::default(),
            )
            .expect("ruta")
        }

        /// Verificador con known_hosts aislado (no el del usuario).
        fn isolated(known_hosts: &Path) -> impl Fn(Hop, &str, u16) -> HostKeyCheck + '_ {
            move |_hop, host: &str, port| {
                host_keys::client_with_known_hosts(
                    host.to_string(),
                    port,
                    known_hosts.to_path_buf(),
                )
            }
        }

        fn known_hosts_in_temp() -> PathBuf {
            let dir = std::env::temp_dir().join(format!("rustty-jump-kh-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("directorio temporal");
            dir.join("known_hosts")
        }

        /// Conecta `target` por su ruta y lo autentica con su clave. Devuelve
        /// el handle (con su arrendamiento) y las etapas que registró.
        async fn connect_and_auth(
            route: &JumpRoute,
            pool: Option<&JumpPool>,
            target: &ConnectionProfile,
            known_hosts: &Path,
        ) -> (crate::ssh_transport::RoutedHandle, Vec<String>) {
            let stages = std::sync::Mutex::new(Vec::new());
            let log = |stage: JumpStage<'_>| stages.lock_recover().push(stage.message());
            let check = isolated(known_hosts);
            let mut routed = connect_routed(
                route,
                pool,
                &target.host,
                target.port,
                Arc::new(client::Config::default()),
                &check,
                &log,
            )
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "no conectó por la ruta: {e}. Etapas: {:?}",
                    stages.lock_recover()
                )
            });
            let auth = authenticate_handle(
                &mut routed.handle,
                &target.auth_type,
                &target.username,
                &target.host,
                None,
                None,
                target.key_path.as_deref(),
            )
            .await
            .expect("auth del destino");
            assert!(
                matches!(auth, AuthResult::Success),
                "auth del destino: {auth:?}"
            );
            let stages = stages.into_inner().unwrap_or_default();
            (routed, stages)
        }

        /// Un destino a través de un perfil-bastión con credenciales **distintas**
        /// (cada `sshd` solo autoriza su clave), y dos sesiones por el mismo
        /// salto que comparten una sola conexión con él. Con el bastión como
        /// texto (credenciales del destino) el salto rechaza la entrada: prueba
        /// que el salto de perfil usa las suyas.
        #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
        #[tokio::test]
        async fn salto_de_perfil_con_sus_credenciales_y_una_conexion_compartida() {
            let _guard = JUMP_IT_LOCK.lock().await;
            let (Some(bastion), Some(target)) = (
                ssh_fixture::start().expect("arrancar bastión"),
                ssh_fixture::start().expect("arrancar destino"),
            ) else {
                eprintln!("sshd/ssh-keygen no disponibles; test omitido");
                return;
            };
            host_keys::set_strict_first_connect(false);
            let known_hosts = known_hosts_in_temp();

            let b = profile_for("b", &bastion);
            let t = with_jump(profile_for("t", &target), "b");
            let profiles = vec![b.clone(), t.clone()];
            let route = route(&profiles, &t);
            assert_eq!(route.len(), 1);
            assert_eq!(
                route.hops[0].key_path, b.key_path,
                "el salto usa la clave del bastión"
            );

            let pool = JumpPool::new();
            let (first, stages) = connect_and_auth(&route, Some(&pool), &t, &known_hosts).await;
            assert!(
                stages
                    .iter()
                    .any(|m| m.starts_with("Autenticado en el salto 1/1")),
                "etapas: {stages:?}"
            );
            assert!(
                pool.ready(&route.key(1)),
                "la conexión con el salto queda en el pool"
            );

            // Segunda sesión por el mismo salto: no se abre otra conexión.
            let (second, stages) = connect_and_auth(&route, Some(&pool), &t, &known_hosts).await;
            assert!(
                stages
                    .iter()
                    .any(|m| m.starts_with("Reutilizando la conexión con el salto")),
                "etapas: {stages:?}"
            );
            assert!(
                !stages.iter().any(|m| m.starts_with("Conectando al salto")),
                "no debía reconectar con el salto: {stages:?}"
            );
            assert_eq!(
                pool.connections_opened(),
                1,
                "una sola conexión con el salto"
            );
            drop(first);
            drop(second);

            // El mismo bastión como texto entra con la clave del destino, que
            // el bastión no autoriza: falla en el salto, por autenticación.
            let mut texted = profile_for("t2", &target);
            texted.proxy_jump = Some(format!("{}@127.0.0.1:{}", bastion.username, bastion.port));
            let text_route = route_with(
                &[],
                &texted,
                HopSecrets::default(),
                None,
                &mut |p| p.clone(),
                &mut |_| HopSecrets::default(),
            )
            .expect("ruta de texto");
            let check = isolated(&known_hosts);
            let err = connect_routed(
                &text_route,
                None,
                &texted.host,
                texted.port,
                Arc::new(client::Config::default()),
                &check,
                &|_| {},
            )
            .await
            .err()
            .expect("el bastión no autoriza la clave del destino");
            assert_eq!(err.failure, ConnectFailure::Auth, "{err:?}");
            assert!(
                matches!(err.hop, Hop::Jump { index: 1, total: 1 }),
                "{err:?}"
            );
        }

        /// Cadena de dos saltos de perfil: t → b → a, cada uno con su clave.
        #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
        #[tokio::test]
        async fn cadena_de_dos_saltos() {
            let _guard = JUMP_IT_LOCK.lock().await;
            let (Some(first), Some(second), Some(target)) = (
                ssh_fixture::start().expect("arrancar el primer salto"),
                ssh_fixture::start().expect("arrancar el segundo salto"),
                ssh_fixture::start().expect("arrancar destino"),
            ) else {
                eprintln!("sshd/ssh-keygen no disponibles; test omitido");
                return;
            };
            host_keys::set_strict_first_connect(false);
            let known_hosts = known_hosts_in_temp();

            let a = profile_for("a", &first);
            let b = with_jump(profile_for("b", &second), "a");
            let t = with_jump(profile_for("t", &target), "b");
            let profiles = vec![a, b, t.clone()];
            let route = route(&profiles, &t);
            assert_eq!(route.len(), 2);
            assert_eq!(route.describe(), "salto-a → salto-b");

            // Sin pool, como la CLI: la cadena es de la conexión.
            let (routed, stages) = connect_and_auth(&route, None, &t, &known_hosts).await;
            assert!(
                stages
                    .iter()
                    .any(|m| m.starts_with("Autenticado en el salto 2/2")),
                "etapas: {stages:?}"
            );
            // Los tres servidores pasaron por la verificación de host key.
            let recorded = std::fs::read_to_string(&known_hosts).expect("known_hosts");
            for server in [&first, &second, &target] {
                assert!(
                    recorded.contains(&format!("[127.0.0.1]:{}", server.port)),
                    "falta la host key de {}:\n{recorded}",
                    server.port
                );
            }
            drop(routed);
        }

        /// Un salto con `AllowTcpForwarding no`: el destino falla con un
        /// mensaje que nombra el salto y la opción, y la prueba del salto lo
        /// detecta. Un salto normal la pasa con túneles.
        #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
        #[tokio::test]
        async fn un_salto_sin_tuneles_da_un_error_claro_y_la_prueba_lo_detecta() {
            let _guard = JUMP_IT_LOCK.lock().await;
            let (Some(closed), Some(open), Some(target)) = (
                ssh_fixture::start_with_config("AllowTcpForwarding no").expect("arrancar salto"),
                ssh_fixture::start().expect("arrancar salto normal"),
                ssh_fixture::start().expect("arrancar destino"),
            ) else {
                eprintln!("sshd/ssh-keygen no disponibles; test omitido");
                return;
            };
            host_keys::set_strict_first_connect(false);
            let known_hosts = known_hosts_in_temp();

            let c = profile_for("c", &closed);
            let t = with_jump(profile_for("t", &target), "c");
            let profiles = vec![c.clone(), t.clone()];
            let route = route(&profiles, &t);
            let check = isolated(&known_hosts);
            let err = connect_routed(
                &route,
                None,
                &t.host,
                t.port,
                Arc::new(client::Config::default()),
                &check,
                &|_| {},
            )
            .await
            .err()
            .expect("el salto no deja abrir túneles");
            assert_eq!(err.failure, ConnectFailure::Tunnel, "{err:?}");
            assert!(
                err.message.contains("salto-c") && err.message.contains("AllowTcpForwarding"),
                "{}",
                err.message
            );

            let pool = JumpPool::new();
            let only_jump = route_with(
                &profiles,
                &profile_for("libre", &target),
                HopSecrets::default(),
                Some(&["c".to_string()]),
                &mut |p| p.clone(),
                &mut |_| HopSecrets::default(),
            )
            .expect("ruta del salto");
            let report = crate::ssh_transport::probe_route(&only_jump, Some(&pool), &check).await;
            assert!(report.ok, "{report:?}");
            assert!(!report.forwarding, "{report:?}");
            assert!(report.message.contains("AllowTcpForwarding"), "{report:?}");
            assert_eq!(report.hops.len(), 1);
            assert!(report.hops[0].starts_with("salto-c ("), "{report:?}");

            let o = profile_for("o", &open);
            let open_route = route_with(
                &[o],
                &profile_for("libre", &target),
                HopSecrets::default(),
                Some(&["o".to_string()]),
                &mut |p| p.clone(),
                &mut |_| HopSecrets::default(),
            )
            .expect("ruta del salto normal");
            let report = crate::ssh_transport::probe_route(&open_route, Some(&pool), &check).await;
            assert!(report.ok && report.forwarding, "{report:?}");
        }

        /// Un destino que descarta la conexión sin contestar (aquí, un puerto
        /// con la cola de escucha llena: el kernel tira los SYN nuevos, como un
        /// cortafuegos) a través de un salto **vivo**: el túnel falla como fallo
        /// del destino y la conexión con el salto se queda. Con el salto muerto,
        /// el mismo fallo es de transporte (reintentable).
        #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
        #[tokio::test]
        async fn un_destino_que_no_contesta_no_tira_un_salto_vivo() {
            let _guard = JUMP_IT_LOCK.lock().await;
            let Some(bastion) = ssh_fixture::start().expect("arrancar bastión") else {
                eprintln!("sshd/ssh-keygen no disponibles; test omitido");
                return;
            };
            host_keys::set_strict_first_connect(false);
            let known_hosts = known_hosts_in_temp();

            // Puerto que nunca acepta: backlog 0 y lo llenamos.
            let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::STREAM, None)
                .expect("socket");
            socket
                .bind(&std::net::SocketAddr::from(([127, 0, 0, 1], 0)).into())
                .expect("bind");
            socket.listen(0).expect("listen");
            let silent: std::net::SocketAddr = socket
                .local_addr()
                .expect("addr")
                .as_socket()
                .expect("ipv4");
            let mut held = Vec::new();
            for _ in 0..8 {
                match std::net::TcpStream::connect_timeout(&silent, Duration::from_millis(300)) {
                    Ok(stream) => held.push(stream),
                    Err(_) => break, // cola llena: los SYN siguientes se descartan
                }
            }

            let b = profile_for("b", &bastion);
            let route = route_with(
                &[b],
                &profile_for("destino", &bastion),
                HopSecrets::default(),
                Some(&["b".to_string()]),
                &mut |p| p.clone(),
                &mut |_| HopSecrets::default(),
            )
            .expect("ruta");
            let pool = JumpPool::new();
            let check = isolated(&known_hosts);
            let lease = pool.acquire(&route, &check, &|_| {}).await.expect("salto");

            let hop = Hop::Jump { index: 1, total: 1 };
            let err = crate::ssh_transport::open_tunnel_within(
                lease.handle(),
                lease.name(),
                hop,
                "127.0.0.1",
                silent.port(),
                0,
                Duration::from_secs(2),
            )
            .await
            .expect_err("el destino no contesta");
            assert_eq!(err.failure, ConnectFailure::Tunnel, "{err:?}");
            assert!(
                err.message.contains("no consiguió llegar"),
                "{}",
                err.message
            );
            assert!(!lease.is_closed(), "el salto sigue vivo");
            assert!(pool.ready(&route.key(1)), "y sigue en el pool");

            // Con el salto muerto, es transporte.
            let _ = lease
                .handle()
                .disconnect(russh::Disconnect::ByApplication, "", "es")
                .await;
            for _ in 0..100 {
                if lease.is_closed() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let err = crate::ssh_transport::open_tunnel_within(
                lease.handle(),
                lease.name(),
                hop,
                "127.0.0.1",
                silent.port(),
                0,
                Duration::from_secs(2),
            )
            .await
            .expect_err("salto muerto");
            assert_eq!(err.failure, ConnectFailure::Transport, "{err:?}");
            drop(held);
        }

        /// El reenvío local de RDP/VNC/Telnet: una conexión TCP a su puerto en
        /// 127.0.0.1 llega al destino por el salto (se lee el banner `SSH-2.0`
        /// del `sshd` de destino), y al soltarlo deja de escuchar.
        #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
        #[tokio::test]
        async fn el_reenvio_local_llega_al_destino_por_el_salto() {
            use tokio::io::AsyncReadExt;
            let _guard = JUMP_IT_LOCK.lock().await;
            let (Some(bastion), Some(target)) = (
                ssh_fixture::start().expect("arrancar bastión"),
                ssh_fixture::start().expect("arrancar destino"),
            ) else {
                eprintln!("sshd/ssh-keygen no disponibles; test omitido");
                return;
            };
            host_keys::set_strict_first_connect(false);
            let known_hosts = known_hosts_in_temp();

            let b = profile_for("b", &bastion);
            let profiles = vec![b];
            let route = route_with(
                &profiles,
                &profile_for("destino", &target),
                HopSecrets::default(),
                Some(&["b".to_string()]),
                &mut |p| p.clone(),
                &mut |_| HopSecrets::default(),
            )
            .expect("ruta");
            let routing = Routing {
                route,
                pool: Some(JumpPool::new()),
            };
            let registry = crate::jump_forward::ForwardRegistry::new();
            let kh = known_hosts.clone();
            let check: crate::jump_forward::SharedHostKeyCheck =
                Arc::new(move |_hop, host: &str, port| {
                    host_keys::client_with_known_hosts(host.to_string(), port, kh.clone())
                });
            let forward = crate::jump_forward::open_forward(
                &registry,
                &routing,
                "127.0.0.1",
                target.port,
                check.clone(),
            )
            .await
            .expect("abrir el reenvío");
            let port = forward.port();
            let local = forward.host().to_string();

            // Una segunda sesión al mismo destino por la misma ruta comparte
            // el reenvío (y su puerto).
            let again = crate::jump_forward::open_forward(
                &registry,
                &routing,
                "127.0.0.1",
                target.port,
                check,
            )
            .await
            .expect("reutilizar el reenvío");
            assert_eq!(again.port(), port);
            assert_eq!(again.host(), local);

            let mut tcp = tokio::net::TcpStream::connect((local.as_str(), port))
                .await
                .expect("conectar al reenvío");
            let mut banner = vec![0u8; 64];
            let n = tokio::time::timeout(Duration::from_secs(10), tcp.read(&mut banner))
                .await
                .expect("el destino no contestó por el reenvío")
                .expect("leer el banner");
            let text = String::from_utf8_lossy(&banner[..n]);
            assert!(text.starts_with("SSH-2.0"), "banner inesperado: {text:?}");
            drop(tcp);

            // Soltar las dos sesiones cierra el reenvío.
            drop(again);
            drop(forward);
            let mut closed = false;
            for _ in 0..50 {
                if std::net::TcpStream::connect((local.as_str(), port)).is_err() {
                    closed = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(closed, "el reenvío debía dejar de escuchar en {port}");
        }
    }
}
