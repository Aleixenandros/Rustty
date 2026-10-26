//! Transporte SSH común: abre el `client::Handle` de un destino, directo o a
//! través de una **ruta de saltos** ([`JumpRoute`]): el primer salto por TCP,
//! cada uno de los siguientes por un canal `direct-tcpip` del anterior
//! (`connect_stream` sobre ese canal) y, al final, el destino por un
//! `direct-tcpip` del último salto.
//!
//! El salto estaba copiado en cuatro sitios (prueba de conexión y sesión de
//! `ssh_manager`, `scripts/runner.rs` y `cli::connect_handle`) más el panel
//! SFTP; desde la ruta de saltos todos pasan por aquí ([`connect_routed`]).
//!
//! Lo que decide quien llama, y por eso entra por parámetro:
//!
//! - La `client::Config` **del destino**: el panel SFTP lleva su ventana grande
//!   y el rekey por bytes desactivado, la sesión su keepalive propio. Cada salto
//!   lleva la suya ([`jump_client_config`]), con los algoritmos heredados de su
//!   perfil y el keepalive de russh encendido para detectar un salto muerto
//!   (`Config` de russh no es `Clone`: se construye una por salto).
//! - El verificador de host key de cada servidor ([`Hop`]): el destino puede
//!   llevar agent forwarding, X11, túneles remotos o la huella fijada por
//!   `--host-key`; los saltos se verifican contra known_hosts, con las mismas
//!   preguntas (clave desconocida o cambiada) que cualquier otra conexión.
//! - El registro de etapas ([`JumpStage`]), que cada llamador pinta en su log.
//! - El pool de conexiones a los saltos ([`JumpPool`]): con él, las conexiones
//!   que van por el mismo salto comparten su sesión SSH; sin él (CLI), la
//!   cadena es de la conexión y muere con ella.
//!
//! Cada salto se autentica con **sus** credenciales: las de su perfil o, en un
//! salto de texto (`proxy_jump`), las del perfil que lo declara.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult};

use crate::host_keys::{self, KnownHostsClient};
use crate::jump_pool::{JumpLease, JumpPool};
use crate::jump_route::{JumpRoute, ResolvedHop};
use crate::profiles::{AuthType, ConnectionProfile};
use crate::ssh_manager::{
    authenticate_handle, legacy_preferred, russh_connect_addr, DEFAULT_SSH_KEEPALIVE_MAX,
    DEFAULT_SSH_KEEPALIVE_SECS,
};

/// Servidor de una conexión: un salto de la ruta (1-indexado) o el destino.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hop {
    Jump { index: usize, total: usize },
    Target,
}

/// Verificador de host key de un servidor y la ranura donde deja el motivo de
/// un rechazo: lo que devuelven `host_keys::client` y compañía.
pub(crate) type HostKeyCheck = (KnownHostsClient, Arc<Mutex<Option<String>>>);

/// Construye el verificador de cada servidor a partir de su host y puerto. Con
/// ruta se llama una vez por salto y otra para el destino, en ese orden, así
/// que las preguntas de host key salen para cada servidor en su turno.
pub(crate) type HostKeyFactory<'a> = &'a dyn Fn(Hop, &str, u16) -> HostKeyCheck;

/// Registro de etapas de quien conecta.
pub(crate) type StageLog<'a> = &'a dyn Fn(JumpStage<'_>);

/// El verificador de producción para los saltos: known_hosts del usuario, sin
/// agente ni X11 (eso es cosa del destino, que lo pide quien llama).
pub(crate) fn default_host_key_check(_hop: Hop, host: &str, port: u16) -> HostKeyCheck {
    host_keys::client(host.to_string(), port, false, false)
}

/// Registro de etapas que no apunta nada.
pub(crate) fn no_stage_log(_stage: JumpStage<'_>) {}

/// Un salto tal como lo enseña el registro.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HopInfo<'a> {
    pub index: usize,
    pub total: usize,
    pub name: &'a str,
    pub addr: &'a str,
}

/// Etapas de la ruta, para el registro de quien conecta. La conexión directa
/// no pasa por ninguna: el llamador ya anuncia la suya.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JumpStage<'a> {
    /// Conectando al salto (TCP o canal del anterior, handshake y host key).
    Connecting(HopInfo<'a>),
    /// Salto conectado, con su host key verificada.
    Connected(HopInfo<'a>),
    /// Autenticando en el salto con este usuario.
    Authenticating { hop: HopInfo<'a>, user: &'a str },
    /// El salto aceptó la autenticación.
    Authenticated(HopInfo<'a>),
    /// La conexión con el salto ya estaba viva en el pool: no se repite nada.
    Reused(HopInfo<'a>),
    /// Abriendo el canal `direct-tcpip` del último salto hacia el destino.
    OpeningTunnel { hop: HopInfo<'a>, target: &'a str },
}

impl JumpStage<'_> {
    /// `info` mientras avanza, `ok` al completar un paso.
    pub(crate) fn status(&self) -> &'static str {
        match self {
            JumpStage::Connected(_) | JumpStage::Authenticated(_) | JumpStage::Reused(_) => "ok",
            JumpStage::Connecting(_)
            | JumpStage::Authenticating { .. }
            | JumpStage::OpeningTunnel { .. } => "info",
        }
    }

    /// El texto del registro, el mismo en el terminal, el panel SFTP y la
    /// prueba de conexión.
    pub(crate) fn message(&self) -> String {
        match self {
            JumpStage::Connecting(h) => format!(
                "Conectando al salto {}/{}: {} ({})",
                h.index, h.total, h.name, h.addr
            ),
            JumpStage::Connected(h) => format!(
                "Salto {}/{} conectado, host key verificada ({})",
                h.index, h.total, h.addr
            ),
            JumpStage::Authenticating { hop, user } => format!(
                "Autenticando en el salto {}/{} como {user}",
                hop.index, hop.total
            ),
            JumpStage::Authenticated(h) => {
                format!(
                    "Autenticado en el salto {}/{}: {}",
                    h.index, h.total, h.name
                )
            }
            JumpStage::Reused(h) => format!(
                "Reutilizando la conexión con el salto {} ({}/{})",
                h.name, h.index, h.total
            ),
            JumpStage::OpeningTunnel { hop, target } => {
                format!("Abriendo túnel desde {} hacia {target}", hop.name)
            }
        }
    }
}

/// Qué falló al abrir la conexión.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectFailure {
    /// Host key rechazada o sin confirmar. El mensaje empieza por el marcador
    /// de `host_keys` (`hostkey-…:`): no se le antepone nada para que
    /// `IpcError::classify` lo siga reconociendo.
    HostKey,
    /// No se llegó al servidor o falló el handshake SSH.
    Transport,
    /// El salto rechazó la autenticación (o no se pudo intentar).
    Auth,
    /// Un salto no abrió el canal `direct-tcpip` hacia el siguiente servidor.
    Tunnel,
}

/// Error de la conexión: en qué servidor, qué falló y el mensaje para el
/// usuario (que nombra el salto).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConnectError {
    pub hop: Hop,
    pub failure: ConnectFailure,
    pub message: String,
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Spec `ProxyJump` de texto del perfil, si tiene uno. Vacío o en blanco
/// equivale a no tenerlo.
pub(crate) fn jump_spec(profile: &ConnectionProfile) -> Option<&str> {
    profile
        .proxy_jump
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Un rechazo de host key conserva su marcador **al principio** (es lo que
/// busca `IpcError::classify`) y nombra el salto justo detrás.
fn name_hop_in_host_key_reason(reason: String, label: &str) -> String {
    for marker in [
        crate::ipc_error::HOSTKEY_CHANGED_MARKER,
        crate::ipc_error::HOSTKEY_UNKNOWN_MARKER,
    ] {
        if let Some(rest) = reason.strip_prefix(marker) {
            return format!("{marker} {label}: {}", rest.trim_start());
        }
    }
    format!("{label}: {reason}")
}

/// Error de conexión de un servidor: si el verificador de host key dejó un
/// motivo, es un rechazo de host key y su mensaje manda; si no, fue el
/// transporte. `label` nombra el salto («Salto 1/2 (oficina-win)»); el destino
/// va sin él, como siempre.
fn hop_error(
    hop: Hop,
    label: Option<&str>,
    failure: &Arc<Mutex<Option<String>>>,
    transport: String,
) -> ConnectError {
    match host_keys::take_failure(failure) {
        Some(reason) => ConnectError {
            hop,
            failure: ConnectFailure::HostKey,
            message: match label {
                Some(label) => name_hop_in_host_key_reason(reason, label),
                None => reason,
            },
        },
        None => ConnectError {
            hop,
            failure: ConnectFailure::Transport,
            message: transport,
        },
    }
}

/// «Salto 1/2 (oficina-win)», para los mensajes de error.
fn hop_label(info: &HopInfo<'_>) -> String {
    format!("Salto {}/{} ({})", info.index, info.total, info.name)
}

/// Config de russh de un salto. Ventana grande y sin rekey por bytes, como el
/// panel SFTP: por el salto viaja el caudal de todas las conexiones que lo
/// comparten (transferencias incluidas) y su ventana las estrangularía; el
/// rekey por tiempo (1 h) sigue activo. Keepalive de russh cada 30 s (cuatro
/// sin respuesta tiran la conexión): un salto muerto se detecta y el pool lo
/// reconstruye en vez de dar una conexión colgada. Los algoritmos heredados son
/// los del perfil del salto (o de quien declara un salto de texto).
pub(crate) fn jump_client_config(hop: &ResolvedHop) -> Arc<client::Config> {
    let preferred = if hop.allow_legacy_algorithms {
        legacy_preferred(hop.legacy_algorithms.as_deref())
    } else {
        russh::Preferred::default()
    };
    let limits = russh::Limits {
        rekey_write_limit: usize::MAX,
        rekey_read_limit: usize::MAX,
        ..russh::Limits::default()
    };
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(DEFAULT_SSH_KEEPALIVE_SECS)),
        keepalive_max: DEFAULT_SSH_KEEPALIVE_MAX,
        window_size: 32 * 1024 * 1024,
        maximum_packet_size: 65535,
        limits,
        preferred,
        ..Default::default()
    })
}

/// Plazo del saludo SSH de un salto (TCP, banner e intercambio de claves), sin
/// contar el rato en que el usuario contesta una pregunta de su host key. Sin
/// él, un servidor que acepta la conexión y no saluda retendría para siempre el
/// candado de construcción de su entrada del pool (y el de apertura del
/// reenvío local).
pub(crate) const JUMP_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(45);

/// Espera `fut` como mucho `limit`, sin contar el tiempo en que `paused` está
/// a `true` (una pregunta de host key esperando al usuario). `None` = plazo
/// agotado.
pub(crate) async fn with_paused_deadline<F: std::future::Future>(
    fut: F,
    paused: &AtomicBool,
    limit: Duration,
) -> Option<F::Output> {
    const TICK: Duration = Duration::from_millis(100);
    tokio::pin!(fut);
    let mut spent = Duration::ZERO;
    loop {
        tokio::select! {
            out = &mut fut => return Some(out),
            _ = tokio::time::sleep(TICK) => {
                if !paused.load(Ordering::Relaxed) {
                    spent += TICK;
                    if spent >= limit {
                        return None;
                    }
                }
            }
        }
    }
}

/// Ejecuta la apertura de una conexión russh en el runtime indicado (el de los
/// saltos del pool), para que la tarea de sesión que lanza russh con
/// `tokio::spawn` viva allí y no muera con el hilo de quien la pidió. Sin
/// runtime, en el actual. Con plazo ([`with_paused_deadline`]): `None` si se
/// agotó (y la apertura se cancela).
async fn connect_on<F>(
    runtime: Option<&tokio::runtime::Handle>,
    connect: F,
    prompting: &AtomicBool,
    limit: Duration,
) -> Option<Result<client::Handle<KnownHostsClient>, russh::Error>>
where
    F: std::future::Future<Output = Result<client::Handle<KnownHostsClient>, russh::Error>>
        + Send
        + 'static,
{
    match runtime {
        Some(rt) => {
            let task = rt.spawn(connect);
            let abort = task.abort_handle();
            let joined = with_paused_deadline(task, prompting, limit).await;
            if joined.is_none() {
                abort.abort();
            }
            joined.map(|joined| {
                joined
                    .map_err(|e| russh::Error::IO(std::io::Error::other(e.to_string())))
                    .and_then(|connected| connected)
            })
        }
        None => with_paused_deadline(connect, prompting, limit).await,
    }
}

/// Canal `direct-tcpip` de `via` hacia `host:port`. Si el servidor lo rechaza
/// por política (`administratively prohibited`: `AllowTcpForwarding no`), el
/// mensaje lo dice y nombra el salto.
///
/// Un rechazo del servidor es [`ConnectFailure::Tunnel`]. Si no hay respuesta a
/// tiempo, se pregunta al salto si sigue vivo ([`jump_alive`]): vivo, es que
/// no consigue llegar al siguiente servidor (apagado, o un cortafuegos que
/// descarta la conexión sin contestar) y también es `Tunnel`, sin tocar la
/// conexión con el salto; muerto (una conexión del pool caída sin avisar: corte
/// de red sin RST), o con su sesión ya cerrada, es **transporte**, reintentable:
/// quien llama la saca del pool y la reconexión la reconstruye.
pub(crate) async fn open_tunnel(
    via: &client::Handle<KnownHostsClient>,
    via_name: &str,
    via_hop: Hop,
    host: &str,
    port: u16,
) -> Result<russh::Channel<client::Msg>, ConnectError> {
    open_tunnel_within(via, via_name, via_hop, host, port, 0, TUNNEL_OPEN_TIMEOUT).await
}

/// [`open_tunnel`] con el puerto de origen que se anuncia (el del cliente, en
/// el reenvío local) y el plazo a mano (los tests no esperan medio minuto).
pub(crate) async fn open_tunnel_within(
    via: &client::Handle<KnownHostsClient>,
    via_name: &str,
    via_hop: Hop,
    host: &str,
    port: u16,
    originator_port: u32,
    limit: Duration,
) -> Result<russh::Channel<client::Msg>, ConnectError> {
    let open = via.channel_open_direct_tcpip(
        host.to_string(),
        port as u32,
        "127.0.0.1".to_string(),
        originator_port,
    );
    match tokio::time::timeout(limit, open).await {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(err @ russh::Error::ChannelOpenFailure(_))) => Err(ConnectError {
            hop: via_hop,
            failure: ConnectFailure::Tunnel,
            message: tunnel_error_message(via_name, host, port, &err),
        }),
        Ok(Err(err)) => Err(ConnectError {
            hop: via_hop,
            failure: ConnectFailure::Transport,
            message: format!(
                "Se perdió la conexión con el salto {via_name} al abrir el túnel hacia \
                 {host}:{port}: {err}"
            ),
        }),
        Err(_) if jump_alive(via).await => Err(ConnectError {
            hop: via_hop,
            failure: ConnectFailure::Tunnel,
            message: unreachable_through_message(via_name, host, port, limit),
        }),
        Err(_) => Err(ConnectError {
            hop: via_hop,
            failure: ConnectFailure::Transport,
            message: format!(
                "El salto {via_name} no contesta: no abrió el túnel hacia {host}:{port} en {} s",
                limit.as_secs()
            ),
        }),
    }
}

/// El salto vive pero no llegó a `host:port` a tiempo.
fn unreachable_through_message(via_name: &str, host: &str, port: u16, limit: Duration) -> String {
    format!(
        "El salto {via_name} no consiguió llegar a {host}:{port} en {} s: el servidor está \
         apagado o un cortafuegos descarta la conexión.",
        limit.as_secs()
    )
}

/// Plazo para que un salto confirme un canal `direct-tcpip`: el mismo que el de
/// una conexión TCP directa (un destino que no contesta tarda lo mismo en
/// darse por perdido vaya por donde vaya).
pub(crate) const TUNNEL_OPEN_TIMEOUT: Duration = crate::ssh_manager::TCP_CONNECT_TIMEOUT;

/// Plazo de la comprobación de vida de un salto.
const JUMP_PING_TIMEOUT: Duration = Duration::from_secs(5);

/// ¿Sigue vivo el salto? Su sesión no está cerrada y contesta a un keepalive
/// con respuesta (`keepalive@openssh.com`) en [`JUMP_PING_TIMEOUT`]. Un sshd
/// atiende esas peticiones mientras espera a conectar un `direct-tcpip`, así que
/// distingue «el salto no llega al destino» de «el salto se ha muerto».
pub(crate) async fn jump_alive(handle: &client::Handle<KnownHostsClient>) -> bool {
    if handle.is_closed() {
        return false;
    }
    let pinged = matches!(
        tokio::time::timeout(JUMP_PING_TIMEOUT, handle.send_ping()).await,
        Ok(Ok(()))
    );
    // `send_ping` da `Ok` también si la sesión murió mientras esperaba.
    pinged && !handle.is_closed()
}

/// ¿El servidor rechazó el canal por política (`AllowTcpForwarding no`)?
pub(crate) fn is_forwarding_prohibited(err: &russh::Error) -> bool {
    matches!(
        err,
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited)
    )
}

/// Texto del rechazo de un `direct-tcpip`.
pub(crate) fn tunnel_error_message(
    via_name: &str,
    host: &str,
    port: u16,
    err: &russh::Error,
) -> String {
    match err {
        err if is_forwarding_prohibited(err) => format!(
            "El salto {via_name} no deja abrir túneles hacia {host}:{port}: su servidor SSH los \
             tiene prohibidos. Activa AllowTcpForwarding en su sshd_config (o usa otro salto)."
        ),
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed) => format!(
            "El salto {via_name} no pudo llegar a {host}:{port}: ¿la dirección es correcta y \
             accesible desde el salto?"
        ),
        other => format!("El salto {via_name} no pudo abrir el túnel hacia {host}:{port}: {other}"),
    }
}

/// Abre y autentica **un** salto: por TCP si es el primero (`via: None`) o por
/// un canal `direct-tcpip` del anterior. `runtime` es donde vive su sesión.
pub(crate) async fn open_hop(
    hop: &ResolvedHop,
    info: HopInfo<'_>,
    via: Option<(&client::Handle<KnownHostsClient>, &str)>,
    runtime: Option<&tokio::runtime::Handle>,
    host_key_check: HostKeyFactory<'_>,
    on_stage: StageLog<'_>,
) -> Result<client::Handle<KnownHostsClient>, ConnectError> {
    let tag = Hop::Jump {
        index: info.index,
        total: info.total,
    };
    let label = hop_label(&info);
    let addr = info.addr;
    on_stage(JumpStage::Connecting(info));
    let config = jump_client_config(hop);
    let (mut handler, failure) = host_key_check(tag, &hop.host, hop.port);
    handler.mark_jump();
    let prompting = handler.prompt_flag();
    let handshake_timeout = || ConnectError {
        hop: tag,
        failure: ConnectFailure::Transport,
        message: format!(
            "El salto {} ({addr}) no completó el saludo SSH en {} s",
            info.name,
            JUMP_HANDSHAKE_TIMEOUT.as_secs()
        ),
    };
    let mut handle = match via {
        None => {
            let target = addr.to_string();
            connect_on(
                runtime,
                async move { russh_connect_addr(config, &target, handler).await },
                &prompting,
                JUMP_HANDSHAKE_TIMEOUT,
            )
            .await
            .ok_or_else(handshake_timeout)?
            .map_err(|err| {
                hop_error(
                    tag,
                    Some(&label),
                    &failure,
                    format!(
                        "No se puede conectar al salto {} ({addr}): {err}",
                        info.name
                    ),
                )
            })?
        }
        Some((previous, previous_name)) => {
            let previous_tag = Hop::Jump {
                index: info.index.saturating_sub(1),
                total: info.total,
            };
            let channel =
                open_tunnel(previous, previous_name, previous_tag, &hop.host, hop.port).await?;
            let stream = channel.into_stream();
            connect_on(
                runtime,
                async move { client::connect_stream(config, stream, handler).await },
                &prompting,
                JUMP_HANDSHAKE_TIMEOUT,
            )
            .await
            .ok_or_else(handshake_timeout)?
            .map_err(|err| {
                hop_error(
                    tag,
                    Some(&label),
                    &failure,
                    format!(
                        "No se puede establecer SSH con el salto {} ({addr}) a través de \
                         {previous_name}: {err}",
                        info.name
                    ),
                )
            })?
        }
    };
    on_stage(JumpStage::Connected(info));

    on_stage(JumpStage::Authenticating {
        hop: info,
        user: &hop.username,
    });
    let auth_error = |message: String| ConnectError {
        hop: tag,
        failure: ConnectFailure::Auth,
        message,
    };
    // Sin la contraseña que hace falta, el motivo por el que no se pudo leer
    // (KeePass bloqueada, credencial maestra borrada…) dice más que un
    // «Se requiere contraseña».
    if hop.auth_type == AuthType::Password && hop.secrets.password.is_none() {
        if let Some(reason) = &hop.secrets.unavailable {
            return Err(auth_error(format!(
                "{label}: no hay contraseña para {}: {reason}",
                hop.username
            )));
        }
    }
    let auth = authenticate_handle(
        &mut handle,
        &hop.auth_type,
        &hop.username,
        &hop.host,
        hop.secrets.password.as_ref(),
        hop.secrets.passphrase.as_ref(),
        hop.key_path.as_deref(),
    )
    .await
    .map_err(|e| auth_error(format!("{label}: {e}")))?;
    if let AuthResult::Failure {
        remaining_methods, ..
    } = auth
    {
        return Err(auth_error(format!(
            "{label}: autenticación como {} fallida. Métodos restantes: {remaining_methods:?}",
            hop.username
        )));
    }
    on_stage(JumpStage::Authenticated(info));
    Ok(handle)
}

/// Info de registro del salto `index` (1-indexado) de la ruta.
pub(crate) fn hop_info<'a>(route: &'a JumpRoute, index: usize, addr: &'a str) -> HopInfo<'a> {
    HopInfo {
        index,
        total: route.len(),
        name: &route.hops[index - 1].name,
        addr,
    }
}

/// Conexión con su ruta: el handle del destino y el arrendamiento de la cadena
/// de saltos. **El arrendamiento tiene que vivir lo que viva el handle**: es lo
/// que mantiene abierta (y, con pool, compartida) la conexión de los saltos.
pub(crate) struct RoutedHandle {
    pub handle: client::Handle<KnownHostsClient>,
    pub lease: Option<JumpLease>,
}

/// La cadena de saltos de `route`, del pool (compartida) o propia.
pub(crate) async fn acquire_chain(
    route: &JumpRoute,
    pool: Option<&JumpPool>,
    host_key_check: HostKeyFactory<'_>,
    on_stage: StageLog<'_>,
) -> Result<JumpLease, ConnectError> {
    match pool {
        Some(pool) => pool.acquire(route, host_key_check, on_stage).await,
        None => crate::jump_pool::build_private(route, None, host_key_check, on_stage).await,
    }
}

/// Abre la conexión SSH del destino `host:port` (sin autenticarlo): directa si
/// la ruta está vacía, o por sus saltos. El destino se verifica con
/// `host_key_check(Hop::Target, …)` y negocia con `config`.
pub(crate) async fn connect_routed(
    route: &JumpRoute,
    pool: Option<&JumpPool>,
    host: &str,
    port: u16,
    config: Arc<client::Config>,
    host_key_check: HostKeyFactory<'_>,
    on_stage: StageLog<'_>,
) -> Result<RoutedHandle, ConnectError> {
    let addr = format!("{host}:{port}");
    if route.is_empty() {
        let (handler, failure) = host_key_check(Hop::Target, host, port);
        let handle = russh_connect_addr(config, &addr, handler)
            .await
            .map_err(|err| {
                hop_error(
                    Hop::Target,
                    None,
                    &failure,
                    format!("No se puede conectar a {addr}: {err}"),
                )
            })?;
        return Ok(RoutedHandle {
            handle,
            lease: None,
        });
    }

    let lease = acquire_chain(route, pool, host_key_check, on_stage).await?;
    let last = route.len();
    let last_addr = route.hops[last - 1].addr();
    on_stage(JumpStage::OpeningTunnel {
        hop: hop_info(route, last, &last_addr),
        target: &addr,
    });
    let channel = open_tunnel(
        lease.handle(),
        lease.name(),
        Hop::Jump {
            index: last,
            total: last,
        },
        host,
        port,
    )
    .await
    .inspect_err(|err| {
        if err.failure == ConnectFailure::Transport {
            lease.invalidate();
        }
    })?;
    let (handler, failure) = host_key_check(Hop::Target, host, port);
    let handle = client::connect_stream(config, channel.into_stream(), handler)
        .await
        .map_err(|err| {
            hop_error(
                Hop::Target,
                None,
                &failure,
                format!(
                    "No se puede establecer SSH con {addr} a través de {}: {err}",
                    route.describe()
                ),
            )
        })?;
    Ok(RoutedHandle {
        handle,
        lease: Some(lease),
    })
}

/// «Probar el salto»: conecta la cadena (del pool, si está) y abre un
/// `direct-tcpip` de prueba desde el último salto hacia su propio sshd
/// (`127.0.0.1:<su puerto>` visto desde él) para saber si deja abrir túneles.
/// Un rechazo por política (`AllowTcpForwarding no`) es lo que se busca; si el
/// canal se acepta pero no hay nada en esa dirección (un sshd que no escucha en
/// la interfaz local, o un puerto publicado por NAT), los túneles sí se
/// permiten.
pub(crate) async fn probe_route(
    route: &JumpRoute,
    pool: Option<&JumpPool>,
    host_key_check: HostKeyFactory<'_>,
) -> crate::jump_route::JumpProbeReport {
    let hops: Vec<String> = route.hops.iter().map(ResolvedHop::display).collect();
    let report = |ok: bool, forwarding: bool, message: String| crate::jump_route::JumpProbeReport {
        ok,
        hops: hops.clone(),
        forwarding,
        message,
    };
    let Some(last) = route.hops.last() else {
        return report(false, false, "No hay ningún salto que probar.".to_string());
    };
    let lease = match acquire_chain(route, pool, host_key_check, &no_stage_log).await {
        Ok(lease) => lease,
        // Sin el marcador interno de host key: el informe es texto para leer.
        Err(err) => {
            return report(
                false,
                false,
                crate::ipc_error::IpcError::classify(err.message).message,
            )
        }
    };
    let opened = tokio::time::timeout(
        Duration::from_secs(15),
        lease.handle().channel_open_direct_tcpip(
            "127.0.0.1".to_string(),
            u32::from(last.port),
            "127.0.0.1".to_string(),
            0,
        ),
    )
    .await;
    match opened {
        Ok(Ok(channel)) => {
            let _ = channel.close().await;
            report(
                true,
                true,
                format!("Conexión correcta: {} deja abrir túneles.", last.name),
            )
        }
        Ok(Err(russh::Error::ChannelOpenFailure(
            russh::ChannelOpenFailure::ConnectFailed,
        ))) => report(
            true,
            true,
            format!(
                "Conexión correcta: {} acepta túneles (la prueba hacia 127.0.0.1:{} no encontró servicio, lo normal si su sshd no escucha en esa dirección).",
                last.name, last.port
            ),
        ),
        Ok(Err(err)) => {
            let forwarding = !is_forwarding_prohibited(&err);
            report(
                true,
                forwarding,
                tunnel_error_message(&last.name, "127.0.0.1", last.port, &err),
            )
        }
        Err(_) => report(
            true,
            false,
            format!(
                "{} no contestó a tiempo a la apertura de un túnel de prueba.",
                last.name
            ),
        ),
    }
}

/// [`connect_routed`] hacia el host y el puerto del perfil.
pub(crate) async fn connect_profile_handle(
    profile: &ConnectionProfile,
    route: &JumpRoute,
    pool: Option<&JumpPool>,
    config: Arc<client::Config>,
    host_key_check: HostKeyFactory<'_>,
    on_stage: StageLog<'_>,
) -> Result<RoutedHandle, ConnectError> {
    connect_routed(
        route,
        pool,
        &profile.host,
        profile.port,
        config,
        host_key_check,
        on_stage,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_with_jump(proxy_jump: Option<&str>) -> ConnectionProfile {
        let json = r#"{
            "id": "t",
            "name": "t",
            "host": "10.0.0.5",
            "port": 22,
            "username": "ana",
            "connection_type": "ssh",
            "domain": null,
            "auth_type": "password",
            "key_path": null,
            "group": null,
            "created_at": "2026-05-08T12:00:00Z"
        }"#;
        let mut profile: ConnectionProfile = serde_json::from_str(json).expect("perfil válido");
        profile.proxy_jump = proxy_jump.map(str::to_string);
        profile
    }

    #[test]
    fn jump_spec_vacio_o_en_blanco_es_conexion_directa() {
        assert_eq!(jump_spec(&profile_with_jump(None)), None);
        assert_eq!(jump_spec(&profile_with_jump(Some(""))), None);
        assert_eq!(jump_spec(&profile_with_jump(Some("   "))), None);
        assert_eq!(
            jump_spec(&profile_with_jump(Some("  ops@bastion:2222 "))),
            Some("ops@bastion:2222")
        );
    }

    #[test]
    fn el_motivo_de_host_key_manda_sobre_el_error_de_transporte() {
        let jump = Hop::Jump { index: 1, total: 2 };
        // Con motivo: rechazo de host key, y el marcador sigue al principio (la
        // clasificación IPC lo busca ahí) con el salto nombrado detrás.
        let failure = Arc::new(Mutex::new(Some(format!(
            "{}la clave cambió",
            crate::ipc_error::HOSTKEY_CHANGED_MARKER
        ))));
        let err = hop_error(
            jump,
            Some("Salto 1/2 (oficina)"),
            &failure,
            "TCP caído".to_string(),
        );
        assert_eq!(err.hop, jump);
        assert_eq!(err.failure, ConnectFailure::HostKey);
        assert!(err
            .message
            .starts_with(crate::ipc_error::HOSTKEY_CHANGED_MARKER));
        let classified = crate::ipc_error::IpcError::classify(err.message.clone());
        assert_eq!(
            classified.kind,
            crate::ipc_error::IpcErrorKind::HostKeyMismatch
        );
        assert_eq!(classified.message, "Salto 1/2 (oficina): la clave cambió");

        // El destino conserva el mensaje tal cual.
        let failure = Arc::new(Mutex::new(Some(format!(
            "{} sin confirmar",
            crate::ipc_error::HOSTKEY_UNKNOWN_MARKER
        ))));
        let err = hop_error(Hop::Target, None, &failure, "x".to_string());
        assert_eq!(
            err.message,
            format!("{} sin confirmar", crate::ipc_error::HOSTKEY_UNKNOWN_MARKER)
        );

        // Sin motivo: fue el transporte.
        let empty = Arc::new(Mutex::new(None));
        let err = hop_error(Hop::Target, None, &empty, "TCP caído".to_string());
        assert_eq!(err.failure, ConnectFailure::Transport);
        assert_eq!(err.to_string(), "TCP caído");
    }

    #[test]
    fn el_rechazo_de_tuneles_nombra_el_salto_y_allow_tcp_forwarding() {
        let prohibido =
            russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited);
        assert!(is_forwarding_prohibited(&prohibido));
        let msg = tunnel_error_message("oficina-win", "10.0.0.5", 22, &prohibido);
        assert!(
            msg.contains("oficina-win") && msg.contains("AllowTcpForwarding"),
            "{msg}"
        );
        let inalcanzable =
            russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed);
        assert!(!is_forwarding_prohibited(&inalcanzable));
        let msg = tunnel_error_message("oficina-win", "10.0.0.5", 22, &inalcanzable);
        assert!(msg.contains("no pudo llegar a 10.0.0.5:22"), "{msg}");
        assert!(!msg.contains("AllowTcpForwarding"));
    }

    #[tokio::test]
    async fn el_plazo_del_saludo_se_para_mientras_se_pregunta_la_host_key() {
        let paused = AtomicBool::new(false);
        // Un saludo que nunca llega agota el plazo.
        let never = std::future::pending::<()>();
        assert!(
            with_paused_deadline(never, &paused, Duration::from_millis(300))
                .await
                .is_none()
        );
        // Con una pregunta abierta el reloj no corre: tarda el triple del plazo
        // y aun así llega.
        paused.store(true, Ordering::Relaxed);
        let slow = async {
            tokio::time::sleep(Duration::from_millis(900)).await;
            7
        };
        assert_eq!(
            with_paused_deadline(slow, &paused, Duration::from_millis(300)).await,
            Some(7)
        );
        // Y lo que llega a tiempo, llega.
        paused.store(false, Ordering::Relaxed);
        assert_eq!(
            with_paused_deadline(async { 1 }, &paused, Duration::from_millis(300)).await,
            Some(1)
        );
    }

    #[test]
    fn el_salto_vivo_que_no_llega_al_destino_lo_dice() {
        let msg = unreachable_through_message("oficina", "10.0.0.5", 22, Duration::from_secs(30));
        assert!(
            msg.contains("no consiguió llegar a 10.0.0.5:22 en 30 s"),
            "{msg}"
        );
        assert!(!msg.contains("  "), "sin espacios de más: {msg}");
    }

    #[test]
    fn las_etapas_cuentan_cada_salto() {
        let info = HopInfo {
            index: 1,
            total: 2,
            name: "oficina-win",
            addr: "10.0.0.1:22",
        };
        assert_eq!(
            JumpStage::Connecting(info).message(),
            "Conectando al salto 1/2: oficina-win (10.0.0.1:22)"
        );
        assert_eq!(
            JumpStage::Authenticating {
                hop: info,
                user: "ana"
            }
            .message(),
            "Autenticando en el salto 1/2 como ana"
        );
        assert_eq!(
            JumpStage::Reused(info).message(),
            "Reutilizando la conexión con el salto oficina-win (1/2)"
        );
        assert_eq!(JumpStage::Reused(info).status(), "ok");
        assert_eq!(JumpStage::Connecting(info).status(), "info");
    }
}
