//! Máquina de estados **pura** del cliente de control de tmux (F1.3).
//!
//! Envuelve al parser (F1.1) y añade lo que el protocolo no da por sí solo:
//! la **correlación** de cada bloque `%begin…%end`/`%error` con el comando
//! que lo provocó (tmux responde en orden, así que la cola es FIFO y el `tag`
//! lo pone este módulo, no el número interno de tmux), los **timeouts** de
//! comandos sin respuesta y el **cierre irreversible** de la sesión de
//! control. Sin E/S ni reloj propio: los bytes y los milisegundos monótonos
//! los aporta el transporte (`ssh_manager`, en la fase 2).
//!
//! La regla de oro (mitigación de la señalización in-band): tras un `%exit`,
//! una desincronización o un timeout, `send_command` **rechaza** escribir —
//! si tmux ya no está al otro lado, lo que se escriba en el canal lo ejecuta
//! el shell.

use super::protocol::{ControlEvent, ControlParser};
use std::collections::VecDeque;

/// Plazo por defecto para que un comando reciba su bloque de respuesta.
pub const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 30_000;

/// Evento ya correlacionado, listo para el consumidor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientEvent {
    /// Respuesta al comando enviado con este `tag` (orden FIFO).
    CommandDone {
        tag: u64,
        success: bool,
        output: String,
    },
    /// Notificación que no responde a ningún comando nuestro. Incluye el
    /// bloque de saludo que tmux emite al arrancar (cola aún vacía).
    Notification(ControlEvent),
    /// La sesión de control terminó. **No volver a escribir en el canal.**
    Shutdown(ShutdownReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShutdownReason {
    /// `%exit` de tmux, con su razón si la dio.
    Exit(Option<String>),
    /// Línea fuera de bloque que no es protocolo: el canal ya no habla
    /// control mode (p. ej. tmux murió y esto es salida del shell).
    Desync { line: String },
    /// El comando con este `tag` agotó su plazo sin respuesta.
    CommandTimeout { tag: u64 },
}

/// Error al intentar enviar un comando.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// La sesión de control está cerrada (exit/desync/timeout).
    Closed,
    /// El comando contiene un salto de línea: en control mode una línea es un
    /// comando, y un `\n` incrustado enviaría un segundo comando fantasma.
    InvalidCommand,
}

#[derive(Debug)]
struct PendingCommand {
    tag: u64,
    sent_at_ms: u64,
}

/// Cliente de control incremental. Crear uno por sesión `tmux -CC`.
#[derive(Debug)]
pub struct ControlClient {
    parser: ControlParser,
    pending: VecDeque<PendingCommand>,
    next_tag: u64,
    timeout_ms: u64,
    closed: bool,
}

impl Default for ControlClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlClient {
    pub fn new() -> Self {
        Self::with_timeout(DEFAULT_COMMAND_TIMEOUT_MS)
    }

    /// `timeout_ms = 0` desactiva los timeouts (útil en depuración).
    pub fn with_timeout(timeout_ms: u64) -> Self {
        ControlClient {
            parser: ControlParser::new(),
            pending: VecDeque::new(),
            next_tag: 0,
            timeout_ms,
            closed: false,
        }
    }

    /// La sesión terminó (exit/desync/timeout): el canal ya no es protocolo.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Comandos aún sin respuesta.
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Encola `command` y devuelve `(tag, bytes)` a escribir en el canal. El
    /// reloj (`now_ms`, monótono) lo aporta el llamador: el módulo es puro.
    pub fn send_command(&mut self, command: &str, now_ms: u64) -> Result<(u64, Vec<u8>), SendError> {
        if self.closed {
            return Err(SendError::Closed);
        }
        if command.contains('\n') || command.contains('\r') {
            return Err(SendError::InvalidCommand);
        }
        let tag = self.next_tag;
        self.next_tag += 1;
        self.pending.push_back(PendingCommand {
            tag,
            sent_at_ms: now_ms,
        });
        Ok((tag, format!("{command}\n").into_bytes()))
    }

    /// Bytes del canal → eventos correlados. Tras un `Shutdown`, el resto del
    /// stream se descarta (ya no es protocolo) y `feed` devuelve vacío.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ClientEvent> {
        if self.closed {
            return Vec::new();
        }
        let mut out = Vec::new();
        for ev in self.parser.feed(bytes) {
            match ev {
                ControlEvent::CommandResponse {
                    number,
                    flags,
                    success,
                    output,
                } => {
                    // El bit 1 de los flags marca los bloques que responden a
                    // comandos de ESTE cliente (verificado en captura real: el
                    // saludo del arranque llega con 0, las respuestas con 1).
                    // Solo esos consumen la cola FIFO; sin la distinción, el
                    // saludo robaría la respuesta del primer comando.
                    let correlated = if flags & 1 == 1 {
                        self.pending.pop_front()
                    } else {
                        None
                    };
                    match correlated {
                        Some(cmd) => out.push(ClientEvent::CommandDone {
                            tag: cmd.tag,
                            success,
                            output,
                        }),
                        None => out.push(ClientEvent::Notification(
                            ControlEvent::CommandResponse {
                                number,
                                flags,
                                success,
                                output,
                            },
                        )),
                    }
                }
                ControlEvent::Exit { reason } => {
                    self.closed = true;
                    out.push(ClientEvent::Shutdown(ShutdownReason::Exit(reason)));
                    break;
                }
                ControlEvent::Unknown { line } if !line.starts_with('%') => {
                    // Fuera de bloque, tmux solo emite líneas `%…`: esto es
                    // otra cosa hablando por el canal. Cerrar antes de tocar
                    // nada — escribir ahora iría a parar a un shell.
                    self.closed = true;
                    out.push(ClientEvent::Shutdown(ShutdownReason::Desync { line }));
                    break;
                }
                other => out.push(ClientEvent::Notification(other)),
            }
        }
        out
    }

    /// Vence el comando más antiguo si agotó su plazo. Llamar desde el timer
    /// del transporte; un vencimiento **cierra** la sesión (un tmux que no
    /// responde ya no es un interlocutor fiable).
    pub fn check_timeouts(&mut self, now_ms: u64) -> Option<ClientEvent> {
        if self.closed || self.timeout_ms == 0 {
            return None;
        }
        let front = self.pending.front()?;
        if now_ms.saturating_sub(front.sent_at_ms) > self.timeout_ms {
            self.closed = true;
            let tag = front.tag;
            return Some(ClientEvent::Shutdown(ShutdownReason::CommandTimeout { tag }));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// El arranque real de `tmux -C` (captura 3.7b): el bloque de saludo llega
    /// con la cola vacía y pasa como notificación, no roba la respuesta del
    /// primer comando del cliente.
    #[test]
    fn el_saludo_inicial_no_roba_la_correlacion() {
        let mut client = ControlClient::new();
        let (tag, bytes) = client.send_command("list-windows", 0).expect("envía");
        assert_eq!(tag, 0);
        assert_eq!(bytes, b"list-windows\n");

        let events = client.feed(
            b"%begin 1785510405 280 0\n%end 1785510405 280 0\n\
%window-add @0\n\
%begin 1785510405 287 1\n0: tmux* (1 panes) [80x24] @0 (active)\n%end 1785510405 287 1\n",
        );
        assert_eq!(
            events,
            vec![
                ClientEvent::Notification(ControlEvent::CommandResponse {
                    number: 280,
                    flags: 0,
                    success: true,
                    output: String::new(),
                }),
                ClientEvent::Notification(ControlEvent::WindowAdd { window: 0 }),
                ClientEvent::CommandDone {
                    tag: 0,
                    success: true,
                    output: "0: tmux* (1 panes) [80x24] @0 (active)\n".into(),
                },
            ]
        );
        assert_eq!(client.pending_count(), 0);
    }

    #[test]
    fn correlacion_fifo_de_varios_comandos_con_exito_y_error() {
        let mut client = ControlClient::new();
        let (t0, _) = client.send_command("split-window -h", 0).unwrap();
        let (t1, _) = client.send_command("no-such-command", 0).unwrap();
        assert_eq!((t0, t1), (0, 1));
        assert_eq!(client.pending_count(), 2);

        let events = client.feed(
            b"%begin 9 5 1\n%end 9 5 1\n%begin 9 6 1\nunknown command\n%error 9 6 1\n",
        );
        assert_eq!(
            events,
            vec![
                ClientEvent::CommandDone {
                    tag: 0,
                    success: true,
                    output: String::new(),
                },
                ClientEvent::CommandDone {
                    tag: 1,
                    success: false,
                    output: "unknown command\n".into(),
                },
            ]
        );
        assert_eq!(client.pending_count(), 0);
    }

    #[test]
    fn exit_cierra_y_prohibe_escribir() {
        let mut client = ControlClient::new();
        let events = client.feed(b"%exit server exited\n%window-add @1\n");
        assert_eq!(
            events,
            vec![ClientEvent::Shutdown(ShutdownReason::Exit(Some(
                "server exited".into()
            )))]
        );
        assert!(client.is_closed());
        // Lo que venga detrás ya no es protocolo: se descarta.
        assert_eq!(client.feed(b"%window-add @2\n"), Vec::new());
        assert_eq!(client.send_command("ls", 0), Err(SendError::Closed));
    }

    #[test]
    fn linea_no_protocolo_fuera_de_bloque_es_desync() {
        let mut client = ControlClient::new();
        let events = client.feed(b"%window-add @0\nbash: fin de la sesion\n");
        assert_eq!(
            events,
            vec![
                ClientEvent::Notification(ControlEvent::WindowAdd { window: 0 }),
                ClientEvent::Shutdown(ShutdownReason::Desync {
                    line: "bash: fin de la sesion".into(),
                }),
            ]
        );
        assert!(client.is_closed());
    }

    /// Una notificación `%…` desconocida (versión futura de tmux) NO es
    /// desincronización: pasa como Unknown y la sesión sigue viva.
    #[test]
    fn notificacion_futura_no_cierra() {
        let mut client = ControlClient::new();
        let events = client.feed(b"%future-thing foo\n");
        assert_eq!(
            events,
            vec![ClientEvent::Notification(ControlEvent::Unknown {
                line: "%future-thing foo".into(),
            })]
        );
        assert!(!client.is_closed());
    }

    #[test]
    fn timeout_vence_al_comando_mas_antiguo_y_cierra() {
        let mut client = ControlClient::with_timeout(1_000);
        assert_eq!(client.check_timeouts(999_999), None, "sin comandos no hay timeout");
        let (tag, _) = client.send_command("ls", 10_000).unwrap();
        assert_eq!(client.check_timeouts(10_500), None, "aún dentro de plazo");
        assert_eq!(
            client.check_timeouts(11_001),
            Some(ClientEvent::Shutdown(ShutdownReason::CommandTimeout { tag })),
        );
        assert!(client.is_closed());
        assert_eq!(client.send_command("ls", 11_002), Err(SendError::Closed));
    }

    #[test]
    fn comando_multilinea_se_rechaza() {
        let mut client = ControlClient::new();
        assert_eq!(
            client.send_command("ls\nkill-server", 0),
            Err(SendError::InvalidCommand)
        );
        assert_eq!(client.pending_count(), 0, "el rechazo no encola nada");
    }
}
