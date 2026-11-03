//! Operaciones del bucle raíz de una sesión SSH que esperan al servidor.
//!
//! **La regla: el bucle raíz de `ssh_manager::run_session` no espera ninguna
//! llamada del `Handle` de russh.** Todo lo que el `Handle` manda a la sesión
//! (keepalive, abrir un canal, pedir o cancelar un `tcpip-forward`) entra por
//! una cola acotada que russh deja de vaciar —para la conexión entera— mientras
//! algún canal tenga datos esperando ventana (ver `crate::channel_pump`), y que
//! con Eugeny/russh#806 (el otro extremo cierra un canal con datos pendientes)
//! no vuelve a vaciar nunca. Un `.await` de esos dentro del `select!` raíz
//! paraba el bucle: dejaba de leer el canal raíz y, pasados 100 mensajes, la
//! tarea de sesión de russh se bloqueaba al entregar el siguiente; terminal,
//! pestañas hijas y túneles quedaban congelados. Y aun sin atasco, cada ida y
//! vuelta (abrir el canal de una muestra del monitor, un túnel remoto, una
//! pestaña nueva) congelaba el terminal lo que tardara el servidor.
//!
//! Por eso el bucle entrega cada operación a [`SessionOps`], que la lanza en
//! su propia tarea y vuelve en el acto: sus métodos **no son `async`**, así
//! que no hay forma de esperar desde ellos. Lo que el bucle necesita de vuelta
//! (una muestra de métricas, un canal de shell abierto, el puerto concedido
//! por el servidor) llega por [`SessionOps::next`], una rama más del
//! `select!`; lo que solo contesta a un `oneshot` (el `kill`, el cierre de un
//! túnel remoto) lo contesta la propia tarea.
//!
//! Cada espera lleva plazo ([`OpLimits`]), y el keepalive y las muestras del
//! monitor van de una en una (si la anterior sigue en vuelo, el tic se salta):
//! una conexión atascada no acumula tareas. Al soltar [`SessionOps`] se
//! abortan todas: ninguna sobrevive a la sesión reteniendo su handle.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::ChannelMsg;
use tauri::ipc::{Channel, Response};
use tokio::sync::oneshot;
use tokio::task::{AbortHandle, JoinSet};

use crate::host_keys::KnownHostsClient;

/// Handle de la conexión compartido con las tareas de [`SessionOps`]. Sus
/// métodos toman `&self`; el `&mut` solo hace falta para autenticar, antes
/// del bucle.
pub(crate) type SharedHandle = Arc<client::Handle<KnownHostsClient>>;

/// Plazos de las operaciones. Ninguno cambia un valor que el usuario vea: son
/// el techo de esperas que antes no lo tenían (o el que ya tenían, como la
/// lectura de una muestra del monitor).
#[derive(Clone, Copy, Debug)]
pub(crate) struct OpLimits {
    /// Encolar un `keepalive@openssh.com`. En una conexión sana es inmediato.
    pub keepalive: Duration,
    /// Abrir un canal `exec` y lanzar su comando (métricas, `kill`).
    pub exec_open: Duration,
    /// Leer la salida de ese `exec`. Si el servidor tarda más (muy cargado,
    /// red mala), la muestra se descarta y la siguiente lo reintenta.
    pub exec_read: Duration,
    /// Abrir una pestaña nueva sobre la conexión: canal, entorno, PTY y shell.
    /// Generoso: un `sshd` con PAM lento tarda en contestar al shell.
    pub shell_open: Duration,
    /// Respuesta del servidor a un `tcpip-forward` o a su cancelación.
    pub remote_forward: Duration,
}

impl OpLimits {
    pub(crate) const DEFAULT: OpLimits = OpLimits {
        keepalive: Duration::from_secs(30),
        exec_open: Duration::from_secs(15),
        exec_read: Duration::from_secs(10),
        shell_open: Duration::from_secs(60),
        remote_forward: Duration::from_secs(15),
    };
}

/// Cómo acabó un keepalive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeepaliveOutcome {
    /// Entró en la cola de la sesión.
    Sent,
    /// La sesión ya no existe: el lector del canal raíz lo verá enseguida.
    SessionGone,
    /// No cupo en el plazo: la conexión no está enviando.
    TimedOut,
}

/// Respuesta del servidor a un `tcpip-forward`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ForwardResult {
    /// Concedido; el puerto que devolvió el servidor (`0` = el pedido).
    Granted(u32),
    /// Rechazado, o cayó la sesión.
    Denied(String),
    /// Sin respuesta en el plazo.
    TimedOut,
}

/// Qué hacer con un túnel remoto cuando llega la respuesta a su forward.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ForwardStep {
    /// Concedido y aún querido: el túnel queda abierto en `port`.
    Register { port: u32 },
    /// No queda túnel: quien lo abrió recibe `error` y, con `cancel_port`, se
    /// cancela en el servidor lo que pudo quedar concedido.
    Abandon {
        cancel_port: Option<u32>,
        error: String,
    },
}

/// Decide el desenlace de un túnel remoto pedido en el puerto `requested`.
/// `cancelled`: lo cerraron (el usuario o su pestaña) mientras se abría.
///
/// Un forward concedido pero ya no querido se cancela en el servidor; uno sin
/// respuesta en plazo también, por si el servidor lo concede más tarde (la
/// cancelación va detrás en la misma conexión y el servidor las atiende en
/// orden), y así no queda un puerto remoto ocupado sin nadie que lo atienda.
pub(crate) fn forward_step(requested: u32, result: ForwardResult, cancelled: bool) -> ForwardStep {
    match result {
        ForwardResult::Granted(port) => {
            let port = if port == 0 { requested } else { port };
            if cancelled {
                ForwardStep::Abandon {
                    cancel_port: Some(port),
                    error: "El túnel se cerró antes de terminar de abrirse".to_string(),
                }
            } else {
                ForwardStep::Register { port }
            }
        }
        ForwardResult::Denied(err) => ForwardStep::Abandon {
            cancel_port: None,
            error: format!("El servidor rechazó el túnel remoto: {err}"),
        },
        ForwardResult::TimedOut => ForwardStep::Abandon {
            cancel_port: Some(requested),
            error: "El servidor no contestó a tiempo al túnel remoto".to_string(),
        },
    }
}

/// Lo que una operación devuelve al bucle raíz.
pub(crate) enum OpDone {
    Keepalive(KeepaliveOutcome),
    /// Salida de una muestra del monitor. `generation` es la del monitor al
    /// lanzarla: si cambió (se apagó o cambió el intervalo), se descarta.
    MetricsSample { generation: u64, text: String },
    /// Pestaña nueva: el canal ya tiene PTY y shell (o el error). El bucle la
    /// registra, anuncia `ssh-connected` y contesta al invoke, en ese orden.
    ShellOpened {
        shell_id: String,
        on_data: Channel<Response>,
        reply: oneshot::Sender<Result<(), String>>,
        result: Result<russh::Channel<client::Msg>, String>,
    },
    /// Respuesta del servidor al forward de un túnel remoto.
    RemoteForward { tunnel_id: String, result: ForwardResult },
    /// Nada que hacer en el bucle (la tarea ya contestó o no había a quién).
    Idle,
}

/// Una pestaña nueva a abrir sobre la conexión (ver [`SessionOps::open_shell`]).
pub(crate) struct ShellRequest {
    pub shell_id: String,
    pub on_data: Channel<Response>,
    pub cols: u32,
    pub rows: u32,
    /// Variables del perfil (compartidas por todas las pestañas nuevas).
    pub env: Arc<Vec<(String, String)>>,
    pub term: &'static str,
    pub reply: oneshot::Sender<Result<(), String>>,
}

/// Operaciones en vuelo de UNA sesión (una iteración de `run_session`).
pub(crate) struct SessionOps {
    tasks: JoinSet<OpDone>,
    keepalive: Option<AbortHandle>,
    metrics: Option<AbortHandle>,
    metrics_generation: u64,
    limits: OpLimits,
}

fn in_flight(slot: &Option<AbortHandle>) -> bool {
    slot.as_ref().is_some_and(|task| !task.is_finished())
}

impl SessionOps {
    pub(crate) fn new(limits: OpLimits) -> Self {
        Self {
            tasks: JoinSet::new(),
            keepalive: None,
            metrics: None,
            metrics_generation: 0,
            limits,
        }
    }

    /// Sin operaciones en vuelo ni resultados por recoger: la rama de
    /// [`Self::next`] del `select!` se apaga con esto.
    pub(crate) fn is_idle(&self) -> bool {
        self.tasks.is_empty()
    }

    /// Siguiente resultado. Las abortadas no entregan nada. Cancelable: se
    /// puede usar como rama de un `select!`.
    pub(crate) async fn next(&mut self) -> Option<OpDone> {
        while let Some(joined) = self.tasks.join_next().await {
            if let Ok(done) = joined {
                return Some(done);
            }
        }
        None
    }

    /// Lanza un futuro que no devuelve nada al bucle (p. ej. abrir el canal de
    /// una conexión de túnel y arrancar su bombeo). Debe acotar sus esperas.
    pub(crate) fn spawn<F>(&mut self, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.tasks.spawn(async move {
            task.await;
            OpDone::Idle
        });
    }

    /// Manda un `keepalive@openssh.com` sin pedir respuesta, como hacía el
    /// bucle. `false` = el anterior sigue sin salir y este tic se salta.
    pub(crate) fn keepalive(&mut self, handle: &SharedHandle) -> bool {
        if in_flight(&self.keepalive) {
            return false;
        }
        let handle = handle.clone();
        let limit = self.limits.keepalive;
        self.keepalive = Some(self.tasks.spawn(async move {
            let outcome = match tokio::time::timeout(limit, handle.send_keepalive(false)).await {
                Ok(Ok(())) => KeepaliveOutcome::Sent,
                Ok(Err(_)) => KeepaliveOutcome::SessionGone,
                Err(_) => KeepaliveOutcome::TimedOut,
            };
            OpDone::Keepalive(outcome)
        }));
        true
    }

    /// Generación actual del monitor (ver [`OpDone::MetricsSample`]).
    pub(crate) fn metrics_generation(&self) -> u64 {
        self.metrics_generation
    }

    /// Lanza una muestra del monitor: canal `exec` con `command`, lectura de
    /// su salida y cierre. Una muestra lenta o fallida se salta en silencio.
    /// `false` = la anterior sigue en vuelo y este tic se salta (dos muestras
    /// a la vez darían deltas cruzados).
    pub(crate) fn metrics_sample(&mut self, handle: &SharedHandle, command: String) -> bool {
        if in_flight(&self.metrics) {
            return false;
        }
        let handle = handle.clone();
        let limits = self.limits;
        let generation = self.metrics_generation;
        self.metrics = Some(self.tasks.spawn(async move {
            let Some(channel) = open_exec(&handle, &command, limits.exec_open).await.ok() else {
                return OpDone::Idle;
            };
            match read_sample(channel, limits.exec_read).await {
                Some(text) => OpDone::MetricsSample { generation, text },
                None => OpDone::Idle,
            }
        }));
        true
    }

    /// El monitor se apagó o cambió de intervalo: aborta la muestra en vuelo y
    /// deja sin efecto cualquiera ya terminada que el bucle no haya recogido.
    pub(crate) fn reset_metrics(&mut self) {
        if let Some(task) = self.metrics.take() {
            task.abort();
        }
        self.metrics_generation = self.metrics_generation.wrapping_add(1);
    }

    /// `command` (un `kill` ya compuesto) por un `exec` aparte; su veredicto
    /// vuelve por `reply`.
    pub(crate) fn kill(
        &mut self,
        handle: &SharedHandle,
        command: String,
        reply: oneshot::Sender<Result<(), String>>,
    ) {
        let handle = handle.clone();
        let limits = self.limits;
        self.tasks.spawn(async move {
            let result = match open_exec(&handle, &command, limits.exec_open).await {
                Ok(channel) => read_kill_outcome(channel, limits.exec_read).await,
                Err(err) => Err(err),
            };
            let _ = reply.send(result);
            OpDone::Idle
        });
    }

    /// Abre una pestaña nueva sobre la conexión (canal, entorno, PTY y shell).
    pub(crate) fn open_shell(&mut self, handle: &SharedHandle, req: ShellRequest) {
        let handle = handle.clone();
        let limit = self.limits.shell_open;
        self.tasks.spawn(async move {
            let ShellRequest {
                shell_id,
                on_data,
                cols,
                rows,
                env,
                term,
                reply,
            } = req;
            let open = crate::ssh_manager::open_extra_shell_channel(&handle, (cols, rows), &env, term);
            let result = tokio::time::timeout(limit, open)
                .await
                .unwrap_or_else(|_| Err("El servidor no abrió la shell a tiempo".to_string()));
            OpDone::ShellOpened {
                shell_id,
                on_data,
                reply,
                result,
            }
        });
    }

    /// Pide al servidor el forward de un túnel remoto; la respuesta vuelve
    /// como [`OpDone::RemoteForward`].
    pub(crate) fn remote_forward(
        &mut self,
        handle: &SharedHandle,
        tunnel_id: String,
        bind_host: String,
        port: u32,
    ) {
        let handle = handle.clone();
        let limit = self.limits.remote_forward;
        self.tasks.spawn(async move {
            let result = match tokio::time::timeout(limit, handle.tcpip_forward(bind_host, port)).await
            {
                Ok(Ok(port)) => ForwardResult::Granted(port),
                Ok(Err(err)) => ForwardResult::Denied(err.to_string()),
                Err(_) => ForwardResult::TimedOut,
            };
            OpDone::RemoteForward { tunnel_id, result }
        });
    }

    /// Cancela un forward remoto y, al acabar (o agotarse el plazo), contesta
    /// `Ok` a `replies`: un `stop_tunnel` vuelve cuando el servidor ya soltó
    /// el puerto, y un túnel reabierto justo después no choca con el viejo.
    pub(crate) fn cancel_remote_forward(
        &mut self,
        handle: &SharedHandle,
        bind_host: String,
        port: u32,
        replies: Vec<oneshot::Sender<Result<(), String>>>,
    ) {
        let handle = handle.clone();
        let limit = self.limits.remote_forward;
        self.tasks.spawn(async move {
            let _ = tokio::time::timeout(limit, handle.cancel_tcpip_forward(bind_host, port)).await;
            for reply in replies {
                let _ = reply.send(Ok(()));
            }
            OpDone::Idle
        });
    }
}

/// Abre un canal `exec` y lanza `command`, todo dentro de `limit`.
async fn open_exec(
    handle: &client::Handle<KnownHostsClient>,
    command: &str,
    limit: Duration,
) -> Result<russh::Channel<client::Msg>, String> {
    let open = async {
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("No se pudo abrir el canal: {e}"))?;
        channel
            .exec(false, command)
            .await
            .map_err(|_| "No se pudo lanzar el comando remoto".to_string())?;
        Ok(channel)
    };
    tokio::time::timeout(limit, open)
        .await
        .unwrap_or_else(|_| Err("No se pudo abrir el canal: plazo agotado".to_string()))
}

/// Lee la salida de una muestra del monitor hasta su fin. `None` si no acabó
/// en `limit`: esa muestra se salta.
async fn read_sample(mut channel: russh::Channel<client::Msg>, limit: Duration) -> Option<String> {
    let mut buf = Vec::new();
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => buf.extend_from_slice(data),
                ChannelMsg::Eof
                | ChannelMsg::Close
                | ChannelMsg::ExitStatus { .. }
                | ChannelMsg::ExitSignal { .. } => break,
                _ => {}
            }
        }
    };
    tokio::time::timeout(limit, read).await.ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Desenlace de un `kill` remoto ya lanzado: estado de salida 0 → `Ok`;
/// cualquier otro estado o el plazo agotado → `Err` con lo que el remoto haya
/// impreso (p. ej. «Operation not permitted» o «No such process»).
async fn read_kill_outcome(
    mut channel: russh::Channel<client::Msg>,
    limit: Duration,
) -> Result<(), String> {
    let mut out = Vec::new();
    let mut status: Option<u32> = None;
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => out.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => out.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitSignal { .. } => break,
                _ => {}
            }
        }
    };
    if tokio::time::timeout(limit, read).await.is_err() {
        return Err("El servidor no respondió al kill a tiempo".to_string());
    }
    match status {
        Some(0) => Ok(()),
        other => {
            let text = String::from_utf8_lossy(&out).trim().to_string();
            if text.is_empty() {
                Err(format!(
                    "kill terminó con estado {}",
                    other.map_or_else(|| "desconocido".to_string(), |s| s.to_string())
                ))
            } else {
                Err(text)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_forward_concedido_y_querido_se_registra_en_el_puerto_que_da_el_servidor() {
        assert_eq!(
            forward_step(8080, ForwardResult::Granted(8080), false),
            ForwardStep::Register { port: 8080 }
        );
        // `0` = el servidor no eligió otro: vale el pedido.
        assert_eq!(
            forward_step(8080, ForwardResult::Granted(0), false),
            ForwardStep::Register { port: 8080 }
        );
        assert_eq!(
            forward_step(8080, ForwardResult::Granted(41000), false),
            ForwardStep::Register { port: 41000 }
        );
    }

    #[test]
    fn un_forward_cerrado_mientras_se_abria_se_cancela_en_el_servidor() {
        let ForwardStep::Abandon { cancel_port, .. } =
            forward_step(8080, ForwardResult::Granted(41000), true)
        else {
            panic!("un túnel cerrado no puede quedar abierto");
        };
        assert_eq!(cancel_port, Some(41000));
        let ForwardStep::Abandon { cancel_port, .. } =
            forward_step(8080, ForwardResult::Granted(0), true)
        else {
            panic!("un túnel cerrado no puede quedar abierto");
        };
        assert_eq!(cancel_port, Some(8080));
    }

    #[test]
    fn un_forward_rechazado_no_cancela_nada_y_explica_el_motivo() {
        for cancelled in [false, true] {
            let step = forward_step(8080, ForwardResult::Denied("denegado".into()), cancelled);
            let ForwardStep::Abandon { cancel_port, error } = step else {
                panic!("un forward rechazado no abre túnel");
            };
            assert_eq!(cancel_port, None);
            assert!(error.contains("denegado"), "{error}");
        }
    }

    #[test]
    fn un_forward_sin_respuesta_se_da_por_fallido_y_se_cancela_por_si_llega_tarde() {
        for cancelled in [false, true] {
            let ForwardStep::Abandon { cancel_port, error } =
                forward_step(8080, ForwardResult::TimedOut, cancelled)
            else {
                panic!("sin respuesta no hay túnel");
            };
            assert_eq!(cancel_port, Some(8080));
            assert!(error.contains("a tiempo"), "{error}");
        }
    }

    /// Plazos cortos para que los tests no esperen los de verdad.
    const TEST_LIMITS: OpLimits = OpLimits {
        keepalive: Duration::from_millis(400),
        exec_open: Duration::from_millis(400),
        exec_read: Duration::from_millis(400),
        shell_open: Duration::from_millis(400),
        remote_forward: Duration::from_millis(400),
    };

    /// Conexión cuya cola de salida está llena y russh no vacía, pero que
    /// **sigue recibiendo**: es el estado en que la deja Eugeny/russh#806 (o
    /// cualquier canal con datos esperando ventana). El servidor no lee
    /// (ventana cero) y un `Handle::data` deja datos pendientes en la sesión;
    /// desde ahí russh no toma nada más de la cola y se le encolan envíos
    /// hasta que no cabe ninguno. La shell se abre antes y su servidor le
    /// manda la ráfaga con retraso, ya con la conexión atascada.
    async fn stalled_but_receiving(
        opts: crate::shell_fixture::ShellServerOptions,
    ) -> (impl Sized, SharedHandle, russh::Channel<client::Msg>) {
        use crate::shell_fixture::ShellServer;
        let server = ShellServer::start(opts).await;
        let handle: SharedHandle = Arc::new(server.connect().await);
        let opened = std::time::Instant::now();
        let shell = handle.channel_open_session().await.expect("abrir canal");
        shell
            .request_pty(true, "xterm", 80, 24, 0, 0, &[])
            .await
            .expect("pty");
        shell.request_shell(true).await.expect("shell");

        let stalled = handle
            .channel_open_direct_tcpip("127.0.0.1", 80, "127.0.0.1", 40000)
            .await
            .expect("direct-tcpip");
        let id = stalled.id();
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let filler = {
            let handle = handle.clone();
            let counter = counter.clone();
            tokio::spawn(async move {
                while handle.data(id, vec![b'x'; 1024]).await.is_ok() {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            })
        };
        let llena = async {
            let mut last = u32::MAX;
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let now = counter.load(std::sync::atomic::Ordering::SeqCst);
                if now == last {
                    break;
                }
                last = now;
            }
        };
        tokio::time::timeout(Duration::from_secs(10), llena)
            .await
            .expect("la cola de salida no llegó a llenarse");
        // La prueba de verdad: con la cola llena, un envío del handle no sale.
        assert!(
            tokio::time::timeout(Duration::from_millis(200), handle.send_keepalive(false))
                .await
                .is_err(),
            "la conexión debía estar atascada"
        );
        // Y lo estaba antes de que el servidor empezara a mandar la ráfaga.
        assert!(
            opts.burst.is_none() || opened.elapsed() < opts.burst_delay,
            "la ráfaga de la shell no debía llegar antes del atasco"
        );
        ((server, stalled, filler), handle, shell)
    }

    /// **Regresión del bucle raíz congelado.** Con la conexión atascada (cola
    /// de salida que russh no vacía, pero recibiendo), se lanzan a la vez un
    /// keepalive, una muestra del monitor, un `kill`, un túnel remoto, su
    /// cancelación y una pestaña nueva —todo lo que el bucle raíz esperaba
    /// dentro de su `select!`—. Un bucle con la misma forma que el de
    /// `run_session` sigue leyendo la shell mientras tanto: la salida que el
    /// servidor manda con todo eso en vuelo llega entera. Y cada operación
    /// acaba en su plazo, sin dejar nada colgado.
    #[tokio::test]
    async fn con_la_conexion_atascada_el_bucle_sigue_leyendo_y_cada_operacion_vence_en_su_plazo() {
        use crate::shell_fixture::ShellServerOptions;
        let opts =
            ShellServerOptions::never_reads(Some((60, 1024))).with_burst_delay(Duration::from_secs(4));
        let (_keep, handle, mut shell) = stalled_but_receiving(opts).await;

        let mut ops = SessionOps::new(TEST_LIMITS);
        assert!(ops.keepalive(&handle));
        assert!(!ops.keepalive(&handle), "un keepalive en vuelo: el tic se salta");
        assert!(ops.metrics_sample(&handle, "cat /proc/stat".to_string()));
        assert!(!ops.metrics_sample(&handle, "cat /proc/stat".to_string()));
        let (kill_tx, kill_rx) = oneshot::channel();
        ops.kill(&handle, "kill -TERM 1234".to_string(), kill_tx);
        ops.remote_forward(&handle, "t1".to_string(), "127.0.0.1".to_string(), 8080);
        let (stop_tx, stop_rx) = oneshot::channel();
        ops.cancel_remote_forward(&handle, "127.0.0.1".to_string(), 8081, vec![stop_tx]);
        let on_data: Channel<Response> = Channel::new(|_| Ok(()));
        let (shell_tx, _shell_rx) = oneshot::channel();
        ops.open_shell(
            &handle,
            ShellRequest {
                shell_id: "hija".to_string(),
                on_data,
                cols: 80,
                rows: 24,
                env: Arc::new(Vec::new()),
                term: "xterm",
                reply: shell_tx,
            },
        );

        let mut got = 0usize;
        let mut keepalive = None;
        let mut forward = None;
        let mut shell_opened = None;
        let bucle = async {
            loop {
                tokio::select! {
                    msg = shell.wait() => match msg {
                        Some(ChannelMsg::Data { data }) => got += data.len(),
                        Some(_) => {}
                        None => break,
                    },
                    Some(done) = ops.next(), if !ops.is_idle() => match done {
                        OpDone::Keepalive(outcome) => keepalive = Some(outcome),
                        OpDone::RemoteForward { tunnel_id, result } => {
                            forward = Some((tunnel_id, result));
                        }
                        OpDone::ShellOpened { result, .. } => shell_opened = Some(result.is_ok()),
                        OpDone::MetricsSample { .. } => panic!("no puede haber muestra"),
                        OpDone::Idle => {}
                    },
                }
                if got >= opts.burst_len() && ops.is_idle() {
                    break;
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(15), bucle)
            .await
            .unwrap_or_else(|_| panic!("el bucle se atascó: {got} de {} bytes", opts.burst_len()));

        assert_eq!(got, opts.burst_len(), "la salida de la shell llega entera");
        assert_eq!(keepalive, Some(KeepaliveOutcome::TimedOut));
        assert_eq!(forward, Some(("t1".to_string(), ForwardResult::TimedOut)));
        assert_eq!(shell_opened, Some(false));
        assert!(kill_rx.await.expect("el kill contesta").is_err());
        assert_eq!(stop_rx.await.expect("el cierre contesta"), Ok(()));
        // Vencido el anterior, el siguiente tic vuelve a intentarlo.
        assert!(ops.keepalive(&handle));
    }

    /// Al soltar las operaciones (fin de la sesión) se abortan las que siguen
    /// en vuelo y sueltan su handle: la sesión no queda retenida por ellas.
    #[tokio::test]
    async fn soltar_las_operaciones_suelta_el_handle() {
        use crate::shell_fixture::ShellServerOptions;
        let (_keep, handle, _shell) =
            stalled_but_receiving(ShellServerOptions::never_reads(None)).await;
        let mut ops = SessionOps::new(OpLimits::DEFAULT);
        ops.keepalive(&handle);
        ops.remote_forward(&handle, "t1".to_string(), "127.0.0.1".to_string(), 8080);
        tokio::task::yield_now().await;
        assert!(Arc::strong_count(&handle) > 1);
        drop(ops);
        let suelto = async {
            // El filler del fixture conserva su propio clon.
            while Arc::strong_count(&handle) > 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), suelto)
            .await
            .expect("las tareas abortadas debían soltar el handle");
    }

    /// Con una conexión sana, el monitor devuelve su muestra con la
    /// generación con que se lanzó; tras un `reset_metrics` esa generación ya
    /// no es la actual (el bucle la descarta).
    #[tokio::test]
    async fn una_muestra_lleva_su_generacion_y_un_reinicio_la_invalida() {
        use crate::shell_fixture::{ShellServer, ShellServerOptions};
        let opts = ShellServerOptions::reads(Some((3, 16))).then_exit(0);
        let server = ShellServer::start(opts).await;
        let handle: SharedHandle = Arc::new(server.connect().await);
        let mut ops = SessionOps::new(OpLimits::DEFAULT);
        let generation = ops.metrics_generation();
        assert!(ops.metrics_sample(&handle, "cat /proc/stat".to_string()));
        let done = tokio::time::timeout(Duration::from_secs(10), ops.next())
            .await
            .expect("la muestra acaba");
        let Some(OpDone::MetricsSample { generation: g, text }) = done else {
            panic!("se esperaba una muestra");
        };
        assert_eq!(g, generation);
        assert_eq!(text.len(), opts.burst_len());
        ops.reset_metrics();
        assert_ne!(ops.metrics_generation(), g);
        // Y el keepalive sale enseguida.
        assert!(ops.keepalive(&handle));
        let done = tokio::time::timeout(Duration::from_secs(5), ops.next())
            .await
            .expect("el keepalive acaba");
        assert!(matches!(done, Some(OpDone::Keepalive(KeepaliveOutcome::Sent))));
    }
}
