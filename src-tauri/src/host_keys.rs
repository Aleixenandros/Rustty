use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use russh::client;
use russh::keys::{known_hosts, ssh_key::PublicKey};
use russh::{Channel, ChannelMsg};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
        match known_hosts::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                match known_hosts::learn_known_hosts(&self.host, self.port, server_public_key) {
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
            Err(russh::keys::Error::KeyChanged { line }) => {
                self.set_failure(format!(
                    "ALERTA: la host key de {}:{} ha cambiado (known_hosts línea {}). Fingerprint recibido: {}",
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

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<russh::client::Msg>,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if !self.agent_forwarding {
            return Ok(());
        }
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
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if !self.x11_forwarding {
            return Ok(());
        }
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
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.remote_forwards.lock().ok().and_then(|map| {
            map.get(&(connected_address.to_string(), connected_port))
                .cloned()
                .or_else(|| map.get(&("0.0.0.0".to_string(), connected_port)).cloned())
                .or_else(|| map.get(&("".to_string(), connected_port)).cloned())
        });
        let Some(target) = target else {
            let _ = channel.close().await;
            return Ok(());
        };
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

fn fingerprint_sha256(public_key: &PublicKey) -> String {
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
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if local_tx.write_all(&data).await.is_err() {
                            break;
                        }
                        bytes_down = bytes_down.saturating_add(data.len() as u64);
                        emit_tunnel_traffic(&traffic, bytes_up, bytes_down);
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
                        emit_tunnel_traffic(&traffic, bytes_up, bytes_down);
                    }
                }
            }
        }
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    Ok(())
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
        &format!("ssh-tunnel-traffic-{session_id}"),
        serde_json::json!({
            "id": tunnel_id,
            "bytesUp": bytes_up,
            "bytesDown": bytes_down,
        }),
    );
}
