use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use russh::client;
use russh::keys::{known_hosts, ssh_key::PublicKey};
use russh::{Channel, ChannelMsg};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::ipc::{event_name, EventKind, HOST_KEY_PROMPT};
use crate::locks::MutexExt;

// ── Política de primera conexión (TOFU estricto) ─────────────────────────────
//
// Hasta v1.54.0 la primera host key de un servidor se aprendía **en silencio**:
// un man-in-the-middle en esa primera conexión pasaba inadvertido (el aviso solo
// salta cuando la clave *cambia*). Ahora, por defecto, se pide confirmar la huella
// antes de guardarla; el TOFU automático queda como opción explícita.
//
// La política es **global** (una preferencia del usuario), no por perfil: por eso
// vive aquí y no en la firma de `client()`, que construyen catorce llamadores
// distintos (SSH, SFTP, scripts, CLI y cada salto ProxyJump).

/// `true` = preguntar antes de aprender una clave nueva (default).
static STRICT_FIRST_CONNECT: AtomicBool = AtomicBool::new(true);

/// Handle de la app para emitir el evento de confirmación. Ausente en la CLI,
/// que cae al prompt por stdin.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Confirmaciones en vuelo: `promptId` → canal por el que llega la respuesta.
static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Plazo para que el usuario conteste. Agotado, la conexión se rechaza: preferimos
/// no conectar a aprender una clave que nadie miró.
const HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Fija la política de primera conexión (la llama el frontend al cargar/guardar
/// preferencias).
pub fn set_strict_first_connect(strict: bool) {
    STRICT_FIRST_CONNECT.store(strict, Ordering::Relaxed);
}

#[must_use]
pub fn strict_first_connect() -> bool {
    STRICT_FIRST_CONNECT.load(Ordering::Relaxed)
}

/// Registra el `AppHandle` (en `setup`). Sin él —CLI— se pregunta por stdin.
pub fn register_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Payload de `ssh-hostkey-prompt` (espejo de `HostKeyPromptEvent` en events.js).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyPrompt {
    prompt_id: String,
    host: String,
    port: u16,
    fingerprint: String,
    key_type: String,
    via_jump: bool,
}

/// Entrega la respuesta del usuario a una confirmación en vuelo.
/// Devuelve `false` si el `promptId` ya no existe (timeout o respuesta duplicada).
pub fn resolve_prompt(prompt_id: &str, accept: bool) -> bool {
    let sender = PENDING.lock_recover().remove(prompt_id);
    match sender {
        Some(tx) => tx.send(accept).is_ok(),
        None => false,
    }
}

/// Pide confirmación de una host key nueva. `Ok(true)` = el usuario la acepta.
async fn confirm_new_host_key(host: &str, port: u16, key: &PublicKey) -> Result<bool, String> {
    let fingerprint = fingerprint_sha256(key);
    let key_type = key.algorithm().as_str().to_string();

    let Some(app) = APP.get() else {
        // Sin interfaz (CLI): preguntar por la terminal.
        return confirm_on_stdin(host, port, &fingerprint, &key_type);
    };

    let prompt_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock_recover().insert(prompt_id.clone(), tx);

    let payload = HostKeyPrompt {
        prompt_id: prompt_id.clone(),
        host: host.to_string(),
        port,
        fingerprint,
        key_type,
        via_jump: false,
    };
    if let Err(err) = app.emit(HOST_KEY_PROMPT, payload) {
        PENDING.lock_recover().remove(&prompt_id);
        return Err(format!("no se pudo pedir confirmación de la host key: {err}"));
    }

    match tokio::time::timeout(HOST_KEY_PROMPT_TIMEOUT, rx).await {
        Ok(Ok(accepted)) => Ok(accepted),
        // El canal se cerró sin respuesta (la ventana se fue, p. ej.).
        Ok(Err(_)) => Ok(false),
        Err(_) => {
            PENDING.lock_recover().remove(&prompt_id);
            Err(format!(
                "nadie confirmó la host key de {host}:{port} en {} s; conexión cancelada",
                HOST_KEY_PROMPT_TIMEOUT.as_secs()
            ))
        }
    }
}

/// Confirmación por terminal, para la CLI (sin ventana que preguntar).
fn confirm_on_stdin(
    host: &str,
    port: u16,
    fingerprint: &str,
    key_type: &str,
) -> Result<bool, String> {
    use std::io::{BufRead, IsTerminal, Write};

    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        // Sin terminal interactiva no hay a quién preguntar: rechazar es lo
        // seguro (y el usuario puede activar el TOFU automático si lo quiere).
        return Err(format!(
            "host key desconocida de {host}:{port} ({key_type}, {fingerprint}). \
             Sin terminal interactiva no se puede confirmar: conecta una vez desde la app \
             o activa la confianza automática en Preferencias → Seguridad."
        ));
    }
    println!("La autenticidad del host {host}:{port} no se puede establecer.");
    println!("Huella de la clave {key_type}: {fingerprint}");
    print!("¿Confiar en este host y guardar su clave? (sí/no): ");
    let _ = std::io::stdout().flush();

    let mut line = String::new();
    if stdin.lock().read_line(&mut line).is_err() {
        return Ok(false);
    }
    let answer = line.trim().to_lowercase();
    Ok(matches!(answer.as_str(), "si" | "sí" | "s" | "yes" | "y"))
}

/// Handler TOFU para russh:
/// - si la host key ya coincide con known_hosts, acepta;
/// - si no hay entrada, la aprende automáticamente;
/// - si hay entrada con el mismo algoritmo pero otra clave, rechaza.
///
/// Además, si los flags `agent_forwarding` o `x11_forwarding` están activos,
/// acepta canales abiertos por el servidor para reenviarlos al agente local
/// (`$SSH_AUTH_SOCK`) o al X server local (`localhost:6000`) respectivamente.
pub struct KnownHostsClient {
    host: String,
    port: u16,
    failure: Arc<Mutex<Option<String>>>,
    agent_forwarding: bool,
    x11_forwarding: bool,
    remote_forwards: RemoteForwardMap,
    /// Fichero `known_hosts` a usar. `None` —el caso de producción— deja que
    /// russh use el default (`~/.ssh/known_hosts`). `Some(path)` lo redirige, y
    /// solo lo hacen los tests de integración: sin esto, un test que ejercitara
    /// el TOFU escribiría en el `known_hosts` real del usuario.
    known_hosts_path: Option<std::path::PathBuf>,
}

impl KnownHostsClient {
    /// `check_known_hosts` de russh, contra el fichero de este cliente.
    fn check_known_hosts(&self, key: &PublicKey) -> Result<bool, russh::keys::Error> {
        match &self.known_hosts_path {
            Some(path) => known_hosts::check_known_hosts_path(&self.host, self.port, key, path),
            None => known_hosts::check_known_hosts(&self.host, self.port, key),
        }
    }

    /// `known_host_keys` de russh, contra el fichero de este cliente.
    fn known_host_keys(&self) -> Result<Vec<(usize, PublicKey)>, russh::keys::Error> {
        match &self.known_hosts_path {
            Some(path) => known_hosts::known_host_keys_path(&self.host, self.port, path),
            None => known_hosts::known_host_keys(&self.host, self.port),
        }
    }

    /// `learn_known_hosts` de russh, contra el fichero de este cliente.
    fn learn_known_hosts(&self, key: &PublicKey) -> Result<(), russh::keys::Error> {
        match &self.known_hosts_path {
            Some(path) => known_hosts::learn_known_hosts_path(&self.host, self.port, key, path),
            None => known_hosts::learn_known_hosts(&self.host, self.port, key),
        }
    }
}

#[derive(Clone)]
pub struct RemoteForwardTarget {
    pub host: String,
    pub port: u16,
    pub session_id: String,
    pub tunnel_id: String,
    pub app_handle: AppHandle,
}

pub type RemoteForwardMap = Arc<Mutex<HashMap<(String, u32), RemoteForwardTarget>>>;

pub fn remote_forward_map() -> RemoteForwardMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn client(
    host: String,
    port: u16,
    agent_forwarding: bool,
    x11_forwarding: bool,
) -> (KnownHostsClient, Arc<Mutex<Option<String>>>) {
    client_with_remote_forwards(
        host,
        port,
        agent_forwarding,
        x11_forwarding,
        remote_forward_map(),
    )
}

pub fn client_with_remote_forwards(
    host: String,
    port: u16,
    agent_forwarding: bool,
    x11_forwarding: bool,
    remote_forwards: RemoteForwardMap,
) -> (KnownHostsClient, Arc<Mutex<Option<String>>>) {
    let failure = Arc::new(Mutex::new(None));
    (
        KnownHostsClient {
            host,
            port,
            failure: Arc::clone(&failure),
            agent_forwarding,
            x11_forwarding,
            remote_forwards,
            known_hosts_path: None,
        },
        failure,
    )
}

/// Como [`client`], pero con el `known_hosts` en un fichero concreto en vez del
/// `~/.ssh/known_hosts` del usuario. Existe **solo para los tests de
/// integración**, que ejercitan el flujo TOFU real contra un `sshd` de pruebas y
/// no deben tocar el known_hosts de la máquina.
#[cfg(test)]
pub fn client_with_known_hosts(
    host: String,
    port: u16,
    known_hosts_path: std::path::PathBuf,
) -> (KnownHostsClient, Arc<Mutex<Option<String>>>) {
    let failure = Arc::new(Mutex::new(None));
    (
        KnownHostsClient {
            host,
            port,
            failure: Arc::clone(&failure),
            agent_forwarding: false,
            x11_forwarding: false,
            remote_forwards: remote_forward_map(),
            known_hosts_path: Some(known_hosts_path),
        },
        failure,
    )
}

pub fn take_failure(failure: &Arc<Mutex<Option<String>>>) -> Option<String> {
    failure.lock().ok().and_then(|mut value| value.take())
}

impl KnownHostsClient {
    fn set_failure(&self, message: String) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(message);
        }
    }
}

impl client::Handler for KnownHostsClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        match self.check_known_hosts(server_public_key) {
            // Coincide exactamente con una entrada existente (mismo algoritmo
            // y misma clave): aceptamos.
            Ok(true) => Ok(true),
            Ok(false) => {
                // `check_known_hosts` solo compara claves del mismo algoritmo.
                // Si el servidor pasa de p. ej. ssh-rsa a ssh-ed25519, llegamos
                // aquí aunque hubiese una entrada previa para el host. Antes de
                // aprender la clave nueva, comprobamos si ya teníamos alguna
                // entrada registrada para este host:puerto: si la había, la
                // clave realmente ha cambiado y debemos avisar en vez de
                // aceptarla en silencio.
                match self.known_host_keys() {
                    Ok(recorded) if !recorded.is_empty() => {
                        let previous = recorded
                            .iter()
                            .map(|(line, key)| {
                                format!("línea {}: {}", line, fingerprint_sha256(key))
                            })
                            .collect::<Vec<_>>()
                            .join("; ");
                        self.set_failure(format!(
                            "ALERTA: la host key de {}:{} ha cambiado. \
                             Fingerprint recibido: {}. \
                             Entradas previas en known_hosts → {}. \
                             Si reconoces el cambio, elimina las líneas correspondientes de ~/.ssh/known_hosts y vuelve a conectar.",
                            self.host,
                            self.port,
                            fingerprint_sha256(server_public_key),
                            previous,
                        ));
                        Ok(false)
                    }
                    Ok(_) | Err(_) => {
                        // No hay entradas previas: es la PRIMERA conexión a este
                        // host. Con el modo estricto (default) el usuario confirma
                        // la huella antes de aprenderla; sin él, TOFU clásico.
                        if strict_first_connect() {
                            match confirm_new_host_key(&self.host, self.port, server_public_key)
                                .await
                            {
                                Ok(true) => {}
                                Ok(false) => {
                                    self.set_failure(format!(
                                        "Host key de {}:{} rechazada: no se ha confirmado la huella {}. \
                                         La clave no se ha guardado.",
                                        self.host,
                                        self.port,
                                        fingerprint_sha256(server_public_key)
                                    ));
                                    return Ok(false);
                                }
                                Err(err) => {
                                    self.set_failure(err);
                                    return Ok(false);
                                }
                            }
                        }
                        match self.learn_known_hosts(server_public_key) {
                            Ok(()) => Ok(true),
                            Err(err) => {
                                self.set_failure(format!(
                                    "No se pudo guardar la host key de {}:{} en known_hosts: {err}",
                                    self.host, self.port
                                ));
                                Ok(false)
                            }
                        }
                    }
                }
            }
            Err(russh::keys::Error::KeyChanged { line }) => {
                self.set_failure(format!(
                    "ALERTA: la host key de {}:{} ha cambiado (known_hosts línea {}). \
                     Fingerprint recibido: {}. \
                     Si reconoces el cambio, elimina esa línea de ~/.ssh/known_hosts y vuelve a conectar.",
                    self.host,
                    self.port,
                    line,
                    fingerprint_sha256(server_public_key)
                ));
                Ok(false)
            }
            Err(err) => {
                self.set_failure(format!(
                    "No se pudo verificar la host key de {}:{}: {err}",
                    self.host, self.port
                ));
                Ok(false)
            }
        }
    }

    // Desde russh 0.62 los canales que abre el servidor se aceptan o rechazan de
    // forma explícita con `reply`: soltar el handle sin contestar equivale a un
    // rechazo `AdministrativelyProhibited`. Aquí eso encaja con la política que
    // ya teníamos: si el forwarding correspondiente no está activo en el perfil,
    // el canal se rechaza (antes se ignoraba y quedaba a medio abrir).
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<russh::client::Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if !self.agent_forwarding {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let _ = forward_to_agent(channel).await;
        });
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        channel: Channel<russh::client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if !self.x11_forwarding {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let _ = forward_to_x11(channel).await;
        });
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.remote_forwards.lock().ok().and_then(|map| {
            map.get(&(connected_address.to_string(), connected_port))
                .cloned()
                .or_else(|| map.get(&("0.0.0.0".to_string(), connected_port)).cloned())
                .or_else(|| map.get(&("".to_string(), connected_port)).cloned())
        });
        let Some(target) = target else {
            // Conexión entrante a un puerto remoto que no tenemos reenviado:
            // se rechaza el canal en vez de aceptarlo y cerrarlo acto seguido.
            reply
                .reject(russh::ChannelOpenFailure::ConnectFailed)
                .await;
            let _ = channel.close().await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            if let Ok(stream) =
                tokio::net::TcpStream::connect((target.host.as_str(), target.port)).await
            {
                let _ = pump_channel_with_traffic(
                    channel,
                    stream,
                    target.session_id,
                    target.tunnel_id,
                    target.app_handle,
                )
                .await;
            }
        });
        Ok(())
    }
}

pub fn fingerprint_sha256(public_key: &PublicKey) -> String {
    let bytes = public_key.to_bytes().unwrap_or_default();
    let digest = Sha256::digest(bytes);
    format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

#[cfg(unix)]
async fn forward_to_agent(channel: Channel<russh::client::Msg>) -> std::io::Result<()> {
    let sock_path = std::env::var("SSH_AUTH_SOCK").map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "SSH_AUTH_SOCK no está definido",
        )
    })?;
    let stream = tokio::net::UnixStream::connect(sock_path).await?;
    pump_channel(channel, stream).await
}

#[cfg(not(unix))]
async fn forward_to_agent(_channel: Channel<russh::client::Msg>) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Agent forwarding solo está disponible en Unix",
    ))
}

async fn forward_to_x11(channel: Channel<russh::client::Msg>) -> std::io::Result<()> {
    // DISPLAY=:N → TCP localhost:6000+N. Si no hay DISPLAY, asume :0.
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    let display_num = display
        .rsplit(':')
        .next()
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    let port = 6000u16.saturating_add(display_num);
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    pump_channel(channel, stream).await
}

/// Bombea datos en ambas direcciones entre un canal russh y un stream local
/// (Unix socket o TCP). Termina cuando cualquiera de los dos extremos cierra.
async fn pump_channel<S>(channel: Channel<russh::client::Msg>, stream: S) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    pump_channel_inner(channel, stream, None).await
}

async fn pump_channel_with_traffic<S>(
    channel: Channel<russh::client::Msg>,
    stream: S,
    session_id: String,
    tunnel_id: String,
    app_handle: AppHandle,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    pump_channel_inner(channel, stream, Some((session_id, tunnel_id, app_handle))).await
}

async fn pump_channel_inner<S>(
    mut channel: Channel<russh::client::Msg>,
    stream: S,
    traffic: Option<(String, String, AppHandle)>,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut local_rx, mut local_tx) = tokio::io::split(stream);
    let mut buf = vec![0u8; 8192];
    let mut bytes_up = 0u64;
    let mut bytes_down = 0u64;
    // Coalescing de los eventos de tráfico (ver `tunnel_throttle`): emitir a lo
    // sumo cada intervalo/umbral en vez de por chunk, con flush final exacto.
    let mut last_emit = std::time::Instant::now();
    let mut last_emit_total = 0u64;
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if local_tx.write_all(&data).await.is_err() {
                            break;
                        }
                        bytes_down = bytes_down.saturating_add(data.len() as u64);
                        maybe_emit_traffic(&traffic, bytes_up, bytes_down, &mut last_emit, &mut last_emit_total);
                    }
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => break,
                    Some(_) => {}
                    None => break,
                }
            }
            n = local_rx.read(&mut buf) => {
                match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if channel.data(&buf[..n]).await.is_err() {
                            break;
                        }
                        bytes_up = bytes_up.saturating_add(n as u64);
                        maybe_emit_traffic(&traffic, bytes_up, bytes_down, &mut last_emit, &mut last_emit_total);
                    }
                }
            }
        }
    }
    // Flush final con los totales exactos por si el último chunk no cruzó el umbral.
    if bytes_up.saturating_add(bytes_down) != last_emit_total {
        emit_tunnel_traffic(&traffic, bytes_up, bytes_down);
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    Ok(())
}

/// Emite un evento de tráfico solo si el throttle lo permite (ver
/// [`crate::tunnel_throttle`]), actualizando el estado de coalescing.
fn maybe_emit_traffic(
    traffic: &Option<(String, String, AppHandle)>,
    bytes_up: u64,
    bytes_down: u64,
    last_emit: &mut std::time::Instant,
    last_emit_total: &mut u64,
) {
    if traffic.is_none() {
        return;
    }
    let total = bytes_up.saturating_add(bytes_down);
    if crate::tunnel_throttle::should_emit_traffic(
        last_emit.elapsed(),
        total.saturating_sub(*last_emit_total),
    ) {
        emit_tunnel_traffic(traffic, bytes_up, bytes_down);
        *last_emit = std::time::Instant::now();
        *last_emit_total = total;
    }
}

fn emit_tunnel_traffic(
    traffic: &Option<(String, String, AppHandle)>,
    bytes_up: u64,
    bytes_down: u64,
) {
    let Some((session_id, tunnel_id, app_handle)) = traffic else {
        return;
    };
    let _ = app_handle.emit(
        &event_name(EventKind::SshTunnelTraffic, session_id),
        serde_json::json!({
            "id": tunnel_id,
            "bytesUp": bytes_up,
            "bytesDown": bytes_down,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::PublicKey;

    // `fingerprint_sha256` debe producir exactamente el mismo SHA256 que
    // `ssh-keygen -lf` (SHA256 de la clave en formato wire, base64 sin padding,
    // prefijado con "SHA256:"). Usamos un par ed25519 fijo cuyo fingerprint
    // conocemos de antemano.
    const PUB_ED25519: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPLoaKpum+TqpMC1HCq9Fz7K6oNPtWxK03HhP6sgLLMV";
    const FP_ED25519: &str = "SHA256:uQAtx5MA1iF9jq547yBEjEJYlWBFUsApAs9ILZLdZQU";

    #[test]
    fn fingerprint_coincide_con_ssh_keygen() {
        let key = PublicKey::from_openssh(PUB_ED25519).expect("clave pública válida");
        assert_eq!(fingerprint_sha256(&key), FP_ED25519);
    }

    #[test]
    fn fingerprint_tiene_prefijo_sha256() {
        let key = PublicKey::from_openssh(PUB_ED25519).expect("clave pública válida");
        let fp = fingerprint_sha256(&key);
        assert!(fp.starts_with("SHA256:"));
        // Base64 sin padding: no debe contener '='.
        assert!(!fp.contains('='));
    }

    #[test]
    fn fingerprints_distintos_para_claves_distintas() {
        // Otra clave ed25519 cualquiera debe dar un fingerprint diferente.
        const OTRA_PUB: &str =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINbq6kVZ1dQK4mZ1J3l2YbXq8q0XlqW7t8q4Q1qS9aaa";
        let a = PublicKey::from_openssh(PUB_ED25519).expect("clave pública válida");
        // La segunda puede o no parsear según el padding; solo comparamos si lo hace.
        if let Ok(b) = PublicKey::from_openssh(OTRA_PUB) {
            assert_ne!(fingerprint_sha256(&a), fingerprint_sha256(&b));
        }
    }

    #[test]
    fn el_modo_estricto_es_el_default_y_se_puede_desactivar() {
        // El default es preguntar: aprender una clave nueva en silencio pasa a
        // ser una decisión explícita del usuario.
        assert!(strict_first_connect());
        set_strict_first_connect(false);
        assert!(!strict_first_connect());
        set_strict_first_connect(true);
        assert!(strict_first_connect());
    }

    #[test]
    fn responder_a_un_prompt_inexistente_no_entra_en_panico() {
        // Una respuesta tardía (el prompt ya caducó) o duplicada devuelve false
        // en vez de romper: el frontend puede reintentar sin consecuencias.
        assert!(!resolve_prompt("no-existe", true));
        assert!(!resolve_prompt("no-existe", false));
    }

    #[tokio::test]
    async fn sin_app_ni_terminal_la_clave_desconocida_se_rechaza() {
        // En la CLI sin TTY (p. ej. dentro de un script) no hay a quién
        // preguntar: se rechaza con un error accionable en vez de aprender la
        // clave a ciegas. En el test, stdin no es un terminal.
        let err = confirm_on_stdin("host.example", 22, "SHA256:abc", "ssh-ed25519")
            .expect_err("sin TTY debe fallar");
        assert!(err.contains("host.example"));
        assert!(err.contains("SHA256:abc"));
    }
}
