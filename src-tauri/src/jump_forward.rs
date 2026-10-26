//! Reenvío local por la ruta de saltos para los clientes externos (RDP, VNC,
//! Telnet): Rustty escucha en una dirección de loopback, cada conexión aceptada
//! se convierte en un canal `direct-tcpip` del último salto hacia el
//! `host:puerto` real, y el cliente externo se lanza contra esa dirección.
//!
//! La dirección es **propia de cada destino** ([`loopback_for`]): en Linux y
//! Windows toda la red `127.0.0.0/8` es local, así que cada servidor tiene su
//! `127.x.y.z`. Con una sola `127.0.0.1` para todos, el cliente RDP guardaría
//! los certificados de servidores distintos bajo el mismo nombre, y en Windows
//! dos RDP por túnel se pisarían la credencial `TERMSRV/127.0.0.1` que se deja
//! para mstsc. macOS solo trae `127.0.0.1` de serie: allí se usa esa, y si una
//! `127.x.y.z` no se deja abrir (algún contenedor), también.
//!
//! El puerto es **estable** ([`stable_port`]): sale de un hash de la ruta y del
//! destino, en un rango alto. Así el cliente RDP, que recuerda el certificado
//! del servidor por `host:puerto` (`/cert:tofu`), ve siempre la misma dirección
//! para el mismo servidor y no vuelve a preguntar cada vez. Si está ocupado se
//! prueban unos pocos siguientes y, en último caso, uno cualquiera.
//!
//! El reenvío vive lo que el cliente: se cierra al cerrar la sesión
//! (`*_disconnect`) y al terminar su proceso. Pero en Windows y macOS (y con el
//! Telnet de un `gnome-terminal`) el proceso que se lanza es un **lanzador**
//! (`cmd /c start`, `open`, el emulador de terminal) que sale enseguida y deja
//! al cliente de verdad por su cuenta: si el proceso muere a los pocos
//! segundos, el reenvío espera a que el cliente conecte y se cierra cuando lleva
//! un rato sin conexiones. Dos sesiones al mismo servidor por la misma ruta
//! comparten el reenvío (y su puerto).
//!
//! Cada reenvío corre en su hilo con su runtime, como las sesiones SSH; la
//! conexión con los saltos es del pool, así que se comparte con el resto.

use std::cell::RefCell;
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::jump_pool::{JumpLease, Routing};
use crate::jump_route::JumpRoute;
use crate::locks::MutexExt;
use crate::ssh_transport::{acquire_chain, no_stage_log, Hop, HostKeyCheck};

/// Verificador de host key de los saltos de un reenvío. Va en `Arc` porque el
/// hilo del reenvío lo necesita para reconstruir una cadena caída; en la app es
/// `ssh_transport::default_host_key_check` (ver [`production_host_key_check`]).
pub(crate) type SharedHostKeyCheck = Arc<dyn Fn(Hop, &str, u16) -> HostKeyCheck + Send + Sync>;

/// El verificador de la app: known_hosts del usuario.
pub(crate) fn production_host_key_check() -> SharedHostKeyCheck {
    Arc::new(crate::ssh_transport::default_host_key_check)
}

/// Primer puerto del rango de los reenvíos estables.
pub(crate) const FORWARD_PORT_BASE: u16 = 40000;
/// Tamaño del rango (40000–59999).
pub(crate) const FORWARD_PORT_SPAN: u16 = 20000;
/// Puertos siguientes que se prueban si el estable está ocupado.
const FORWARD_PORT_TRIES: u16 = 8;
/// Un proceso que termina antes de esto era un lanzador, no el cliente.
const LAUNCHER_MAX_LIFETIME: Duration = Duration::from_secs(5);
/// Tras un lanzador, plazo para que el cliente de verdad conecte.
const LINGER_BEFORE_FIRST: Duration = Duration::from_secs(60);
/// Tras la última conexión de un cliente suelto, plazo antes de cerrar (deja
/// reconectar a un cliente que reintenta).
const LINGER_AFTER_LAST: Duration = Duration::from_secs(15);

/// Clave de un reenvío: la secuencia de saltos y el destino.
pub(crate) fn forward_key(route: &JumpRoute, host: &str, port: u16) -> String {
    let hops: Vec<String> = route
        .key(route.len())
        .iter()
        .map(|k| format!("{}/{}@{}:{}", k.profile_id, k.user, k.host, k.port))
        .collect();
    format!("{}|{}:{}", hops.join(">"), host.to_ascii_lowercase(), port)
}

/// Puerto estable de un reenvío: el mismo para la misma ruta y destino, en
/// `FORWARD_PORT_BASE..FORWARD_PORT_BASE + FORWARD_PORT_SPAN`.
pub(crate) fn stable_port(key: &str) -> u16 {
    let digest = Sha256::digest(key.as_bytes());
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    FORWARD_PORT_BASE + (n % u32::from(FORWARD_PORT_SPAN)) as u16
}

/// Dirección de loopback estable de un reenvío (ver el módulo): una
/// `127.x.y.z` por destino, fuera de `127.0.x.x` (donde viven `127.0.0.1`, el
/// `127.0.0.53` de systemd-resolved o el `127.0.1.1` de Debian). En macOS,
/// `127.0.0.1`.
pub(crate) fn loopback_for(key: &str) -> Ipv4Addr {
    if cfg!(target_os = "macos") {
        return Ipv4Addr::LOCALHOST;
    }
    let digest = Sha256::digest(key.as_bytes());
    Ipv4Addr::new(127, 1 + digest[4] % 254, digest[5], 1 + digest[6] % 254)
}

/// Escucha en `addr`, en el puerto estable o en uno de los siguientes; si no se
/// puede, lo mismo en `127.0.0.1`, y en último caso en un puerto cualquiera.
fn bind_listener(addr: Ipv4Addr, preferred: u16) -> std::io::Result<std::net::TcpListener> {
    let offset = preferred.saturating_sub(FORWARD_PORT_BASE);
    let mut addrs = vec![addr];
    if addr != Ipv4Addr::LOCALHOST {
        addrs.push(Ipv4Addr::LOCALHOST);
    }
    for ip in addrs {
        for step in 0..FORWARD_PORT_TRIES {
            let port = FORWARD_PORT_BASE + (offset + step) % FORWARD_PORT_SPAN;
            if let Ok(listener) = std::net::TcpListener::bind((ip, port)) {
                return Ok(listener);
            }
        }
    }
    std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
}

/// Estado compartido de un reenvío.
struct ForwardShared {
    key: String,
    /// Dirección y puerto locales donde escucha.
    host: String,
    port: u16,
    /// Sesiones (clientes lanzados) que lo usan.
    sessions: Mutex<usize>,
    /// Sin sesiones, pero esperando a un cliente suelto (ver el módulo).
    lingering: AtomicBool,
    /// Conexiones abiertas ahora mismo.
    active: AtomicUsize,
    /// Ya hubo al menos una conexión.
    ever_connected: AtomicBool,
    /// Última vez que se abrió o se cerró una conexión (o empezó la espera).
    last_activity: Mutex<Instant>,
    /// Aviso de parada al hilo del reenvío.
    stop: watch::Sender<bool>,
}

impl ForwardShared {
    fn touch(&self) {
        *self.last_activity.lock_recover() = Instant::now();
    }
}

/// Reenvíos vivos por clave (estado gestionado por Tauri).
#[derive(Clone, Default)]
pub struct ForwardRegistry {
    forwards: Arc<Mutex<HashMap<String, Arc<ForwardShared>>>>,
    /// Un candado de apertura **por clave**: dos clientes al mismo destino a la
    /// vez abren un solo reenvío, y una apertura lenta (un salto que pregunta su
    /// host key o su contraseña) no detiene las de otros destinos.
    opening: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

/// El candado de apertura de una clave mientras se usa; al soltarlo, si nadie
/// más lo espera, sale del mapa.
struct OpeningGate {
    registry: ForwardRegistry,
    key: String,
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl OpeningGate {
    fn new(registry: &ForwardRegistry, key: &str) -> Self {
        let lock = Arc::clone(
            registry
                .opening
                .lock_recover()
                .entry(key.to_string())
                .or_default(),
        );
        OpeningGate {
            registry: registry.clone(),
            key: key.to_string(),
            lock,
        }
    }
}

impl Drop for OpeningGate {
    fn drop(&mut self) {
        let mut opening = self.registry.opening.lock_recover();
        // El del mapa y el nuestro: nadie más espera.
        if Arc::strong_count(&self.lock) <= 2 {
            opening.remove(&self.key);
        }
    }
}

impl ForwardRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn remove(&self, shared: &Arc<ForwardShared>) {
        remove_from(&mut self.forwards.lock_recover(), shared);
    }
}

/// Quita el reenvío del mapa si sigue siendo ese (y no otro con su clave).
fn remove_from(forwards: &mut HashMap<String, Arc<ForwardShared>>, shared: &Arc<ForwardShared>) {
    if forwards
        .get(&shared.key)
        .is_some_and(|f| Arc::ptr_eq(f, shared))
    {
        forwards.remove(&shared.key);
    }
}

/// Uso de un reenvío por una sesión. Soltarlo lo cierra si era la última (ver
/// [`LocalForward::release_after_exit`] para el caso de los lanzadores).
pub(crate) struct LocalForward {
    shared: Arc<ForwardShared>,
    registry: ForwardRegistry,
    released: bool,
}

impl LocalForward {
    /// Dirección local (de loopback) contra la que se lanza el cliente.
    pub(crate) fn host(&self) -> &str {
        &self.shared.host
    }

    /// Puerto local contra el que se lanza el cliente.
    pub(crate) fn port(&self) -> u16 {
        self.shared.port
    }

    /// El proceso del cliente terminó tras `lived`. Si fue enseguida, era un
    /// lanzador y el cliente de verdad sigue (o va a conectar): el reenvío
    /// espera a que deje de usarlo en vez de cerrarse ya.
    pub(crate) fn release_after_exit(mut self, lived: Duration) {
        self.release(lived < LAUNCHER_MAX_LIFETIME);
    }

    fn release(&mut self, linger: bool) {
        if self.released {
            return;
        }
        self.released = true;
        // Bajo el candado del mapa (y en ese orden, como la apertura y el fin
        // de la espera): una apertura simultánea o se suma antes y el reenvío
        // sigue, o ya no lo encuentra y abre otro.
        let mut forwards = self.registry.forwards.lock_recover();
        let mut sessions = self.shared.sessions.lock_recover();
        *sessions = sessions.saturating_sub(1);
        if *sessions > 0 {
            return;
        }
        if linger {
            self.shared.touch();
            self.shared.lingering.store(true, Ordering::Relaxed);
        } else {
            remove_from(&mut forwards, &self.shared);
            let _ = self.shared.stop.send(true);
        }
    }
}

impl Drop for LocalForward {
    fn drop(&mut self) {
        self.release(false);
    }
}

/// Abre (o reutiliza) el reenvío local hacia `host:port` por la ruta de
/// `routing`. Conecta la cadena de saltos **antes** de devolver: una host key
/// rechazada, una contraseña mala o un salto sin túneles se dicen aquí, no
/// cuando el cliente ya está abierto contra un puerto que no lleva a nada.
pub(crate) async fn open_forward(
    registry: &ForwardRegistry,
    routing: &Routing,
    host: &str,
    port: u16,
    host_key_check: SharedHostKeyCheck,
) -> Result<LocalForward, String> {
    let key = forward_key(&routing.route, host, port);
    let gate = OpeningGate::new(registry, &key);
    let _opening = gate.lock.lock().await;
    let existing = {
        let forwards = registry.forwards.lock_recover();
        forwards.get(&key).cloned().inspect(|shared| {
            *shared.sessions.lock_recover() += 1;
            shared.lingering.store(false, Ordering::Relaxed);
        })
    };
    if let Some(shared) = existing {
        return Ok(LocalForward {
            shared,
            registry: registry.clone(),
            released: false,
        });
    }

    let lease = acquire_chain(
        &routing.route,
        routing.pool.as_ref(),
        &*host_key_check,
        &no_stage_log,
    )
    .await
    // Sin el marcador interno de host key: el texto va tal cual al aviso.
    .map_err(|err| crate::ipc_error::IpcError::classify(err.message).message)?;
    let listener = bind_listener(loopback_for(&key), stable_port(&key))
        .map_err(|e| format!("No se pudo abrir el puerto local del túnel: {e}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("No se pudo abrir el puerto local del túnel: {e}"))?;
    let local_host = local_addr.ip().to_string();
    let local_port = local_addr.port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("No se pudo preparar el puerto local del túnel: {e}"))?;
    let (stop, stop_rx) = watch::channel(false);
    let shared = Arc::new(ForwardShared {
        key: key.clone(),
        host: local_host.clone(),
        port: local_port,
        sessions: Mutex::new(1),
        lingering: AtomicBool::new(false),
        active: AtomicUsize::new(0),
        ever_connected: AtomicBool::new(false),
        last_activity: Mutex::new(Instant::now()),
        stop,
    });
    registry
        .forwards
        .lock_recover()
        .insert(key, Arc::clone(&shared));

    let worker = ForwardWorker {
        shared: Arc::clone(&shared),
        registry: registry.clone(),
        routing: routing.clone(),
        lease,
        host_key_check,
        host: host.to_string(),
        port,
    };
    let spawned = std::thread::Builder::new()
        .name("rustty-reenvio".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("reenvío local: no se pudo crear el runtime: {e}");
                    worker.registry.remove(&worker.shared);
                    return;
                }
            };
            // `LocalSet`: cada conexión se atiende en su propia tarea, y abrir su
            // túnel (quizá reconstruyendo la cadena y autenticando) no tiene por
            // qué ser `Send`.
            tokio::task::LocalSet::new().block_on(&runtime, worker.run(listener, stop_rx));
        });
    if let Err(e) = spawned {
        registry.remove(&shared);
        return Err(format!("No se pudo arrancar el túnel local: {e}"));
    }
    log::info!(
        "reenvío local {local_host}:{local_port} → {host}:{port} a través de {}",
        routing.route.describe()
    );
    Ok(LocalForward {
        shared,
        registry: registry.clone(),
        released: false,
    })
}

/// Como [`open_forward`], desde un contexto que no puede bloquearse ni exige
/// futuros `Send` (los comandos de Tauri): conecta en un hilo propio, con su
/// runtime, y espera el resultado.
pub(crate) async fn open_forward_detached(
    registry: ForwardRegistry,
    routing: Routing,
    host: String,
    port: u16,
) -> Result<LocalForward, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let result = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt.block_on(open_forward(
                &registry,
                &routing,
                &host,
                port,
                production_host_key_check(),
            )),
            Err(e) => Err(format!("No se pudo crear runtime tokio: {e}")),
        };
        let _ = tx.send(result);
    });
    rx.await
        .map_err(|e| format!("El túnel local no respondió: {e}"))?
}

/// El hilo de un reenvío: acepta conexiones y las cruza con el salto.
struct ForwardWorker {
    shared: Arc<ForwardShared>,
    registry: ForwardRegistry,
    routing: Routing,
    lease: JumpLease,
    host_key_check: SharedHostKeyCheck,
    host: String,
    port: u16,
}

impl ForwardWorker {
    async fn run(self, listener: std::net::TcpListener, mut stop: watch::Receiver<bool>) {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                log::error!("reenvío local: no se pudo escuchar: {e}");
                self.registry.remove(&self.shared);
                return;
            }
        };
        let ctx = Rc::new(ServeCtx {
            shared: Arc::clone(&self.shared),
            routing: self.routing,
            lease: RefCell::new(Rc::new(self.lease)),
            rebuilding: tokio::sync::Mutex::new(()),
            host_key_check: self.host_key_check,
            host: self.host,
            port: self.port,
        });
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break;
                    }
                }
                _ = tick.tick() => {
                    let mut forwards = self.registry.forwards.lock_recover();
                    if linger_expired(&self.shared) {
                        remove_from(&mut forwards, &self.shared);
                        break;
                    }
                }
                accepted = listener.accept() => match accepted {
                    // Cada conexión en su tarea: abrir su túnel puede tardar (o
                    // reconstruir la cadena) y no debe frenar a las demás ni a
                    // la parada.
                    Ok((tcp, peer)) => {
                        tokio::task::spawn_local(serve(Rc::clone(&ctx), tcp, peer.port()));
                    }
                    Err(e) => {
                        log::warn!(
                            "reenvío local {}:{}: {e}",
                            self.shared.host,
                            self.shared.port
                        );
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                },
            }
        }
        log::info!(
            "reenvío local {}:{} → {}:{} cerrado",
            self.shared.host,
            self.shared.port,
            ctx.host,
            ctx.port
        );
        // Al volver, el `LocalSet` del hilo se suelta y con él las conexiones
        // en curso; el arrendamiento de los saltos vuelve al pool.
    }
}

/// Sin sesiones, sin conexiones y pasado el plazo de espera.
fn linger_expired(shared: &ForwardShared) -> bool {
    if !shared.lingering.load(Ordering::Relaxed)
        || *shared.sessions.lock_recover() > 0
        || shared.active.load(Ordering::Relaxed) > 0
    {
        return false;
    }
    let grace = if shared.ever_connected.load(Ordering::Relaxed) {
        LINGER_AFTER_LAST
    } else {
        LINGER_BEFORE_FIRST
    };
    shared.last_activity.lock_recover().elapsed() >= grace
}

/// Lo que comparten las tareas de las conexiones de un reenvío (todas en el
/// mismo hilo: `Rc`/`RefCell`).
struct ServeCtx {
    shared: Arc<ForwardShared>,
    routing: Routing,
    /// La cadena de saltos en uso; se sustituye al reconstruirla.
    lease: RefCell<Rc<JumpLease>>,
    /// Una sola reconstrucción a la vez: las conexiones que llegan mientras
    /// tanto esperan y usan la nueva.
    rebuilding: tokio::sync::Mutex<()>,
    host_key_check: SharedHostKeyCheck,
    host: String,
    port: u16,
}

impl ServeCtx {
    /// Pide al pool otra cadena en lugar de `stale` (salvo que otra tarea ya
    /// la haya sustituido por una viva).
    async fn rebuild(&self, stale: &Rc<JumpLease>) -> Option<Rc<JumpLease>> {
        let _rebuilding = self.rebuilding.lock().await;
        let current = Rc::clone(&self.lease.borrow());
        if !Rc::ptr_eq(&current, stale) && !current.is_closed() {
            return Some(current);
        }
        match acquire_chain(
            &self.routing.route,
            self.routing.pool.as_ref(),
            &*self.host_key_check,
            &no_stage_log,
        )
        .await
        {
            Ok(lease) => {
                let lease = Rc::new(lease);
                *self.lease.borrow_mut() = Rc::clone(&lease);
                Some(lease)
            }
            Err(err) => {
                log::warn!(
                    "reenvío local: el salto no está disponible: {}",
                    crate::ipc_error::IpcError::classify(err.message).message
                );
                None
            }
        }
    }

    /// Canal `direct-tcpip` del último salto hacia el destino, con la misma
    /// lógica que una conexión normal (`ssh_transport::open_tunnel`): un salto
    /// que no contesta sale del pool y se reconstruye una vez; uno vivo que no
    /// llega al destino es un fallo del destino y la cadena se queda.
    async fn open_channel(&self, peer_port: u16) -> Option<russh::Channel<russh::client::Msg>> {
        let mut lease = Rc::clone(&self.lease.borrow());
        if lease.is_closed() {
            lease = self.rebuild(&lease).await?;
        }
        for retry in [true, false] {
            let opened = crate::ssh_transport::open_tunnel_within(
                lease.handle(),
                lease.name(),
                Hop::Jump {
                    index: self.routing.route.len(),
                    total: self.routing.route.len(),
                },
                &self.host,
                self.port,
                u32::from(peer_port),
                crate::ssh_transport::TUNNEL_OPEN_TIMEOUT,
            )
            .await;
            match opened {
                Ok(channel) => return Some(channel),
                Err(err)
                    if retry && err.failure == crate::ssh_transport::ConnectFailure::Transport =>
                {
                    log::warn!("reenvío local: {}", err.message);
                    lease.invalidate();
                    lease = self.rebuild(&lease).await?;
                }
                Err(err) => {
                    log::warn!("reenvío local: {}", err.message);
                    return None;
                }
            }
        }
        None
    }
}

/// Cruza una conexión aceptada con un `direct-tcpip` del último salto.
async fn serve(ctx: Rc<ServeCtx>, mut tcp: tokio::net::TcpStream, peer_port: u16) {
    let Some(channel) = ctx.open_channel(peer_port).await else {
        return;
    };
    let shared = Arc::clone(&ctx.shared);
    drop(ctx);
    shared.active.fetch_add(1, Ordering::Relaxed);
    shared.ever_connected.store(true, Ordering::Relaxed);
    shared.touch();
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
    shared.active.fetch_sub(1, Ordering::Relaxed);
    shared.touch();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_puerto_estable_no_cambia_y_cae_en_el_rango_alto() {
        let a = stable_port("a/ana@salto:22|10.0.0.5:3389");
        assert_eq!(a, stable_port("a/ana@salto:22|10.0.0.5:3389"));
        assert!((FORWARD_PORT_BASE..FORWARD_PORT_BASE + FORWARD_PORT_SPAN).contains(&a));
        // Otro destino, otro puerto (casi siempre): el hash los separa.
        assert_ne!(a, stable_port("a/ana@salto:22|10.0.0.6:3389"));
    }

    #[tokio::test]
    async fn la_apertura_se_serializa_por_clave_y_no_entre_claves() {
        let registry = ForwardRegistry::new();
        let a = OpeningGate::new(&registry, "a");
        let held = a.lock.lock().await;
        // La misma clave espera al candado que ya está tomado…
        let same = OpeningGate::new(&registry, "a");
        assert!(Arc::ptr_eq(&a.lock, &same.lock));
        assert!(same.lock.try_lock().is_err());
        // …y otra clave no.
        let other = OpeningGate::new(&registry, "b");
        assert!(other.lock.try_lock().is_ok());
        drop(other);
        assert!(!registry.opening.lock_recover().contains_key("b"));
        drop(held);
        drop(same);
        // Mientras alguien lo tenga, la entrada sigue; al soltarlo todos, sale.
        assert!(registry.opening.lock_recover().contains_key("a"));
        drop(a);
        assert!(registry.opening.lock_recover().is_empty());
    }

    #[test]
    fn la_clave_cuenta_los_saltos_y_el_destino() {
        let route = JumpRoute::default();
        assert_eq!(forward_key(&route, "Srv.LAN", 5900), "|srv.lan:5900");
    }

    #[test]
    fn cada_destino_tiene_su_direccion_de_loopback() {
        let a = loopback_for("a/ana@salto:22|10.0.0.5:3389");
        assert_eq!(a, loopback_for("a/ana@salto:22|10.0.0.5:3389"));
        assert!(a.is_loopback());
        if cfg!(target_os = "macos") {
            assert_eq!(a, Ipv4Addr::LOCALHOST);
            return;
        }
        // Fuera de 127.0.x.x y sin .0 ni .255 al final.
        let [_, second, _, last] = a.octets();
        assert_ne!(second, 0);
        assert!(last != 0 && last != 255);
        assert_ne!(a, loopback_for("a/ana@salto:22|10.0.0.6:3389"));
        // Y se puede escuchar en ella sin configurar nada.
        let listener = bind_listener(a, stable_port("x")).expect("escuchar");
        assert_eq!(listener.local_addr().unwrap().ip(), std::net::IpAddr::V4(a));
    }

    #[test]
    fn un_puerto_ocupado_cae_en_el_siguiente() {
        // Ocupamos el puerto estable de una clave y pedimos el reenvío de esa
        // misma clave: se va al siguiente libre del rango, no al azar.
        let key = format!("prueba-{}", uuid::Uuid::new_v4());
        let preferred = stable_port(&key);
        let Ok(busy) = std::net::TcpListener::bind(("127.0.0.1", preferred)) else {
            return; // otro proceso lo tenía: el caso no se puede montar.
        };
        let listener = bind_listener(Ipv4Addr::LOCALHOST, preferred).expect("escuchar");
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port, preferred);
        assert!((FORWARD_PORT_BASE..FORWARD_PORT_BASE + FORWARD_PORT_SPAN).contains(&port));
        drop(busy);
    }
}
