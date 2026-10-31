//! Servidor SSH **en proceso** (el lado servidor de `russh`) que abre shells y
//! canales `direct-tcpip` y, si se le pide, se comporta como un servidor que
//! **no lee**: anuncia una ventana de CERO bytes al abrir cada canal y nunca la
//! amplía, así que el cliente se queda esperando en su primer `data`, igual
//! que ante un proceso remoto que no consume su stdin con la ventana del
//! servidor ya llena. Además puede volcar una ráfaga de salida por el canal
//! nada más abrirlo: más mensajes que el buffer de 100 por canal del cliente
//! russh. Es la receta exacta del bloqueo que colgaba la conexión entera (un
//! pegado grande con salida simultánea) y permite reproducirlo sin `sshd`, en
//! todas las plataformas y dentro del `cargo test` normal.
//!
//! Con la ventana normal es un servidor sumidero corriente: acepta contraseña,
//! PTY y shell, guarda todo lo que recibe (para comprobar orden y completitud)
//! y vuelca la ráfaga si se le pidió.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key::Algorithm;
use russh::keys::PrivateKey;
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet, Pty};
use tokio::net::TcpListener;

use crate::locks::MutexExt;

/// Contraseña que acepta el servidor (el usuario da igual).
pub const PASSWORD: &str = "clave-de-prueba";

/// Ventana por defecto de un servidor russh: la de un servidor que sí lee.
const NORMAL_WINDOW: u32 = 2 * 1024 * 1024;

/// Cómo se comporta el servidor.
#[derive(Clone, Copy, Debug)]
pub struct ShellServerOptions {
    /// Ventana inicial que anuncia por canal. `0` = nunca lee lo que se le
    /// escribe (el cliente se bloquea en el primer `data`).
    pub window_size: u32,
    /// Ráfaga que vuelca por cada canal recién abierto: `(mensajes, bytes por
    /// mensaje)`. Con más de 100 mensajes desborda el buffer por canal del
    /// cliente si este deja de leer.
    pub burst: Option<(usize, usize)>,
}

impl ShellServerOptions {
    /// Servidor normal que absorbe lo que se le escribe.
    pub fn reads(burst: Option<(usize, usize)>) -> Self {
        Self {
            window_size: NORMAL_WINDOW,
            burst,
        }
    }

    /// Servidor que NO lee: ventana a cero, para siempre.
    pub fn never_reads(burst: Option<(usize, usize)>) -> Self {
        Self {
            window_size: 0,
            burst,
        }
    }

    /// Bytes totales de la ráfaga configurada.
    pub fn burst_len(&self) -> usize {
        self.burst.map_or(0, |(count, size)| count * size)
    }
}

/// Servidor en marcha. Al soltarlo se para.
pub struct ShellServer {
    pub port: u16,
    /// Huella SHA256 de la host key, para fijarla con `expect_fingerprint`
    /// (así el test no toca ningún `known_hosts`).
    pub fingerprint: String,
    received: Arc<Mutex<Vec<u8>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ShellServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl ShellServer {
    /// Arranca en un puerto efímero de localhost y acepta conexiones hasta que
    /// se suelte.
    pub async fn start(opts: ShellServerOptions) -> ShellServer {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("host key");
        let fingerprint = crate::host_keys::fingerprint_sha256(key.public_key());

        let mut config = server::Config::default();
        config.keys.push(key);
        config.methods = MethodSet::from(&[MethodKind::Password][..]);
        config.window_size = opts.window_size;
        config.auth_rejection_time = Duration::from_millis(5);
        config.auth_rejection_time_initial = Some(Duration::ZERO);
        config.inactivity_timeout = Some(Duration::from_secs(60));
        let config = Arc::new(config);

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&received);
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let handler = Handler {
                    opts,
                    received: Arc::clone(&sink),
                };
                let config = Arc::clone(&config);
                tokio::spawn(async move {
                    if let Ok(session) = server::run_stream(config, socket, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        ShellServer {
            port,
            fingerprint,
            received,
            task,
        }
    }

    /// Todo lo que el servidor ha recibido por cualquier canal, en orden.
    pub fn received(&self) -> Vec<u8> {
        self.received.lock_recover().clone()
    }
}

struct Handler {
    opts: ShellServerOptions,
    received: Arc<Mutex<Vec<u8>>>,
}

impl Handler {
    /// Vuelca la ráfaga configurada por `channel`, en su propia tarea (la
    /// sesión sigue atendiendo al cliente mientras tanto). El pequeño retardo
    /// deja que la confirmación de apertura salga antes que los datos.
    fn burst(&self, channel: ChannelId, session: &Session) {
        let Some((count, size)) = self.opts.burst else {
            return;
        };
        let handle = session.handle();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let chunk = vec![b'#'; size];
            for _ in 0..count {
                if handle.data(channel, chunk.clone()).await.is_err() {
                    break;
                }
            }
        });
    }
}

impl server::Handler for Handler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let id = channel.id();
        reply.accept().await;
        self.burst(id, session);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // la firma la dicta russh
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        self.burst(channel, session);
        Ok(())
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.received.lock_recover().extend_from_slice(data);
        Ok(())
    }
}
