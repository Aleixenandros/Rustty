//! Bombeo de canales SSH sin el interbloqueo de la ventana.
//!
//! **La regla: un canal no se escribe dentro del bucle que lo lee.** russh
//! entrega los mensajes de cada canal por una cola acotada (100 mensajes) y su
//! tarea de sesión *espera* cuando esa cola está llena; es esa misma tarea la
//! que procesa los `WINDOW_ADJUST` del servidor. Si la escritura al canal —que
//! espera ventana— va en el cuerpo de una rama del `select!` que lee el canal,
//! mientras espera nadie lee: con el servidor sin absorber lo escrito (ventana
//! llena) y más de 100 mensajes de bajada en vuelo, la tarea de sesión se
//! bloquea al entregar el siguiente, el ajuste de ventana que liberaría la
//! escritura ya no se procesa y la conexión ENTERA (terminal, SFTP, el resto de
//! túneles) queda colgada para siempre. Y si el servidor cierra el canal
//! mientras la escritura espera, esa espera tampoco acaba: nadie vuelve a abrir
//! la ventana de un canal cerrado.
//!
//! Por eso lectura y escritura van separadas (`Channel::split`) en futuros o
//! tareas independientes, y la espera de ventana solo frena la subida de ESE
//! canal: [`pump_stream`] para los bombeos contra un stream local (túneles
//! `-L`/SOCKS y `-R`, reenvío de agente y X11), [`copy_to_channel`] para la
//! subida del stdin en la CLI, y el `ChannelWriter` de `ssh_manager` para las
//! shells de la interfaz (su entrada llega por mensajes, no de un stream que se
//! pueda frenar, y por eso va por cola).
//!
//! **Y el lector tampoco espera sin plazo ningún otro envío.** Todo lo que los
//! canales mandan a la sesión (datos, EOF, cierre, cambio de tamaño) pasa por
//! una cola común de 10 mensajes, y russh deja de vaciarla —para TODOS los
//! canales de la conexión— mientras algún canal tenga datos esperando ventana
//! dentro de la propia sesión. Eso ocurre aunque el escritor espere ventana
//! antes de mandar: cada `WINDOW_ADJUST` sobrescribe su cuenta local con la de
//! la sesión, que aún no ha descontado lo que sigue en la cola, y el escritor
//! manda de más. Si el servidor ya no va a absorber nada (el comando acabó sin
//! leer su stdin), esos datos no salen nunca y un `eof().await` en el lector no
//! vuelve: por eso el EOF lo manda el propio futuro de subida y el cierre final
//! va con plazo ([`finish_channel`]).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client;
use russh::{ChannelMsg, ChannelWriteHalf};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::locks::MutexExt;
use crate::tunnel_throttle::TunnelTraffic;

/// Lo que se lee de una vez del origen de una subida.
const UPLOAD_CHUNK: usize = 16 * 1024;

/// Plazo de los mensajes finales de un canal (EOF y cierre) cuando ya no
/// queda nada que hacer con él. Si la sesión dejó de vaciar su cola de salida
/// (ver el módulo), esperarlos sería colgarse; pasado el plazo se sigue sin
/// ellos.
const FINISH_GRACE: Duration = Duration::from_millis(250);

/// Por qué paró una subida antes del EOF de su origen.
#[derive(Debug)]
pub(crate) enum CopyError {
    /// No se pudo leer el origen.
    Read(std::io::Error),
    /// No se pudo escribir en el canal (la sesión ya no existe).
    Send(russh::Error),
}

/// Copia `input` al canal hasta su EOF, sin mandar el EOF del canal (eso lo
/// decide el llamador); `on_sent(n)` tras cada trozo escrito.
///
/// Cada escritura espera ventana y esa espera frena la lectura de `input`: el
/// origen se lee al ritmo que el servidor absorbe, sin acumularlo en memoria.
/// Por eso tiene que correr como futuro aparte del que lee el canal, nunca en
/// el cuerpo de una rama de su `select!` (ver el módulo).
pub(crate) async fn copy_to_channel<R>(
    mut input: R,
    write: &ChannelWriteHalf<client::Msg>,
    on_sent: impl Fn(u64),
) -> Result<(), CopyError>
where
    R: AsyncRead + Unpin,
{
    let mut buf = vec![0u8; UPLOAD_CHUNK];
    loop {
        let n = input.read(&mut buf).await.map_err(CopyError::Read)?;
        if n == 0 {
            return Ok(());
        }
        write.data(&buf[..n]).await.map_err(CopyError::Send)?;
        on_sent(n as u64);
    }
}

/// Bombea un canal contra un stream local en los dos sentidos: lo que llega
/// del canal se escribe en `stream` y lo que se lee de `stream` sube por el
/// canal. `on_traffic(subida, bajada)` tras cada trozo.
///
/// Las dos direcciones son futuros INDEPENDIENTES (no una escritura en el
/// cuerpo de una rama del `select!`): si el servidor no absorbe la subida
/// (ventana llena), la espera de `data` ya no impide seguir leyendo el canal,
/// que es lo que mantiene a russh entregando mensajes al resto de canales de
/// la conexión. Termina cuando cualquiera de los dos extremos cierra, y cierra
/// el canal.
pub(crate) async fn pump_stream<S>(
    channel: russh::Channel<client::Msg>,
    stream: S,
    on_traffic: impl Fn(u64, u64),
) where
    S: AsyncRead + AsyncWrite,
{
    let (mut read, write) = channel.split();
    let (local_rx, mut local_tx) = tokio::io::split(stream);
    let up = copy_to_channel(local_rx, &write, |n| on_traffic(n, 0));
    let down = async {
        loop {
            match read.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if local_tx.write_all(&data).await.is_err() {
                        break;
                    }
                    on_traffic(0, data.len() as u64);
                }
                Some(ChannelMsg::Eof)
                | Some(ChannelMsg::Close)
                | Some(ChannelMsg::ExitStatus { .. })
                | Some(ChannelMsg::ExitSignal { .. }) => break,
                Some(_) => {}
                None => break,
            }
        }
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
    finish_channel(&write, true).await;
}

/// Cierra el canal (con EOF delante si `eof`) sin esperar más de
/// [`FINISH_GRACE`]: lo mandado entra en la cola de la sesión y, si esta no la
/// vacía, quien cierra no se queda colgado.
pub(crate) async fn finish_channel(write: &ChannelWriteHalf<client::Msg>, eof: bool) {
    let finish = async {
        if eof {
            let _ = write.eof().await;
        }
        let _ = write.close().await;
    };
    let _ = tokio::time::timeout(FINISH_GRACE, finish).await;
}

/// Bombea una conexión de túnel (`-L`, SOCKS o `-R`): [`pump_stream`] con los
/// eventos de tráfico coalescidos. `traffic` es el acumulado del túnel entero;
/// `on_traffic` recibe sus totales.
pub(crate) async fn pump_tunnel<S>(
    channel: russh::Channel<client::Msg>,
    stream: S,
    traffic: Arc<TunnelTraffic>,
    on_traffic: impl Fn(u64, u64) + Send + Sync + 'static,
) where
    S: AsyncRead + AsyncWrite,
{
    let emitter = TunnelTrafficEmitter::new(traffic, on_traffic);
    pump_stream(channel, stream, |up, down| emitter.add(up, down)).await;
    emitter.flush();
}

/// Coalescing de los eventos de tráfico de UNA conexión de túnel: en vez de
/// emitir por cada chunk (avalancha IPC en transferencias masivas), se emite a
/// lo sumo cada `TRAFFIC_MIN_INTERVAL` o cada `TRAFFIC_MIN_BYTES`, y `flush`
/// manda los totales exactos al terminar. El ritmo lo deciden los bytes de
/// ESTA conexión; el evento lleva el acumulado del túnel. Con interior mutable
/// porque las dos direcciones del bombeo corren como futuros independientes.
struct TunnelTrafficEmitter<F: Fn(u64, u64)> {
    traffic: Arc<TunnelTraffic>,
    on_traffic: F,
    conn_total: AtomicU64,
    last: Mutex<(Instant, u64)>,
}

impl<F: Fn(u64, u64)> TunnelTrafficEmitter<F> {
    fn new(traffic: Arc<TunnelTraffic>, on_traffic: F) -> Self {
        Self {
            traffic,
            on_traffic,
            conn_total: AtomicU64::new(0),
            last: Mutex::new((Instant::now(), 0)),
        }
    }

    fn add(&self, up: u64, down: u64) {
        self.traffic.add(up, down);
        let delta = up.saturating_add(down);
        let total = self
            .conn_total
            .fetch_add(delta, Ordering::Relaxed)
            .saturating_add(delta);
        let mut last = self.last.lock_recover();
        if crate::tunnel_throttle::should_emit_traffic(
            last.0.elapsed(),
            total.saturating_sub(last.1),
        ) {
            self.emit();
            *last = (Instant::now(), total);
        }
    }

    fn emit(&self) {
        let (bytes_up, bytes_down) = self.traffic.totals();
        (self.on_traffic)(bytes_up, bytes_down);
    }

    /// Flush final: la UI ve los totales exactos aunque el último chunk no
    /// cruzara el umbral de emisión.
    fn flush(&self) {
        let total = self.conn_total.load(Ordering::Relaxed);
        if total != self.last.lock_recover().1 {
            self.emit();
        }
    }
}
