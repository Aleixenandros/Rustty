//! Parser **puro** del stream de *control mode* de tmux (F1.1).
//!
//! En modo control el canal deja de transportar bytes de terminal y pasa a ser
//! un protocolo de líneas: notificaciones `%nombre args…` y bloques de
//! respuesta `%begin … %end`/`%error` correlados por número de comando. La
//! salida de cada pane viaja en `%output %<pane> <bytes>`, con `\` y todo byte
//! < ASCII 32 escapados en octal (`\134`, `\015`…) y los bytes ≥ 128 **crudos**
//! — un carácter UTF-8 puede llegar partido entre dos `%output`, así que el
//! payload se conserva como bytes, nunca se valida como String.
//!
//! `feed()` es tolerante a líneas partidas entre lecturas (guarda el resto sin
//! `\n` para la siguiente) y a notificaciones desconocidas (evento `Unknown`,
//! jamás pánico). Los formatos están contrastados con capturas reales de
//! tmux 3.7b (ver tests).

/// Tope del buffer de línea pendiente. Una «línea» de control desmedida sin
/// `\n` señala un stream desincronizado (p. ej. tmux murió y el canal volvió a
/// ser un shell): se vuelca como `Unknown` en vez de crecer sin límite. Mismo
/// presupuesto que la cola del terminal caliente del frontend.
const MAX_PENDING_LINE: usize = 16 * 1024 * 1024;

/// Evento ya parseado del stream de control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    /// Bloque `%begin`…`%end`/`%error` completo. `success` = terminó en `%end`.
    CommandResponse {
        number: u64,
        success: bool,
        output: String,
    },
    /// `%output %<pane> <bytes>` — payload ya desescapado, en crudo.
    Output { pane: u64, bytes: Vec<u8> },
    /// `%extended-output %<pane> <edad> … : <bytes>` (con flow control activo).
    ExtendedOutput { pane: u64, bytes: Vec<u8> },
    /// `%layout-change @<win> <layout> [<layout-visible> [<flags>]]`.
    LayoutChange {
        window: u64,
        layout: String,
        visible_layout: Option<String>,
        flags: Option<String>,
    },
    WindowAdd { window: u64 },
    WindowClose { window: u64 },
    WindowRenamed { window: u64, name: String },
    /// `%window-pane-changed @<win> %<pane>` — cambia la pane activa.
    WindowPaneChanged { window: u64, pane: u64 },
    UnlinkedWindowAdd { window: u64 },
    UnlinkedWindowClose { window: u64 },
    UnlinkedWindowRenamed { window: u64, name: String },
    SessionChanged { session: u64, name: String },
    SessionRenamed { name: String },
    SessionsChanged,
    SessionWindowChanged { session: u64, window: u64 },
    PaneModeChanged { pane: u64 },
    ClientSessionChanged {
        client: String,
        session: u64,
        name: String,
    },
    /// `%subscription-changed <nombre> … : <valor>` (`refresh-client -B`).
    SubscriptionChanged { name: String, value: String },
    /// `%pause %<pane>` / `%continue %<pane>` — flow control (`pause-after`).
    Pause { pane: u64 },
    Continue { pane: u64 },
    /// `%exit [razón]`. Tras esto no se debe volver a escribir en el canal.
    Exit { reason: Option<String> },
    /// Línea que no se entendió. Se conserva para diagnóstico; ignorarla es
    /// decisión del llamador, nunca del parser.
    Unknown { line: String },
}

#[derive(Debug, Default)]
struct PendingBlock {
    number: u64,
    output: String,
}

/// Parser incremental: alimentarlo con los bytes según llegan del canal.
#[derive(Debug, Default)]
pub struct ControlParser {
    buf: Vec<u8>,
    block: Option<PendingBlock>,
}

impl ControlParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Consume bytes del canal y devuelve los eventos completados. Las líneas
    /// sin `\n` final quedan en el buffer para la siguiente llamada.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ControlEvent> {
        let mut buf = std::mem::take(&mut self.buf);
        buf.extend_from_slice(bytes);
        let mut events = Vec::new();
        let mut start = 0;
        while let Some(rel) = buf[start..].iter().position(|&b| b == b'\n') {
            let end = start + rel;
            let mut line = &buf[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if let Some(ev) = self.parse_line(line) {
                events.push(ev);
            }
            start = end + 1;
        }
        buf.drain(..start);
        if buf.len() > MAX_PENDING_LINE {
            events.push(ControlEvent::Unknown {
                line: String::from_utf8_lossy(&buf).into_owned(),
            });
            buf.clear();
        }
        self.buf = buf;
        events
    }

    fn parse_line(&mut self, line: &[u8]) -> Option<ControlEvent> {
        // El DCS de entrada del modo control llega pegado a la primera línea;
        // el ST de despedida es una «línea» propia sin contenido de protocolo.
        let line = line.strip_prefix(b"\x1bP1000p").unwrap_or(line);
        if line == b"\x1b\\" {
            return None;
        }

        // Dentro de un bloque, todo lo que no sea su guarda de cierre es
        // salida del comando (una línea vacía también lo es).
        if let Some(block) = &mut self.block {
            let text = String::from_utf8_lossy(line);
            let closing = if let Some(rest) = text.strip_prefix("%end ") {
                Some((rest, true))
            } else {
                text.strip_prefix("%error ").map(|rest| (rest, false))
            };
            if let Some((rest, success)) = closing {
                let number = guard_number(rest, block.number);
                let output = std::mem::take(&mut block.output);
                self.block = None;
                return Some(ControlEvent::CommandResponse {
                    number,
                    success,
                    output,
                });
            }
            block.output.push_str(&text);
            block.output.push('\n');
            return None;
        }

        if line.is_empty() {
            return None;
        }

        // `%output` y `%extended-output` se parsean a nivel de bytes: el
        // payload puede contener UTF-8 partido que una conversión lossy
        // corrompería.
        if let Some(rest) = line.strip_prefix(b"%output ") {
            if let Some((pane, value)) = split_pane_payload(rest) {
                return Some(ControlEvent::Output {
                    pane,
                    bytes: unescape_octal(value),
                });
            }
        } else if let Some(rest) = line.strip_prefix(b"%extended-output ") {
            if let Some((pane, tail)) = split_pane_payload(rest) {
                // Tras el id vienen campos (edad, flags…) y ` : ` antes del payload.
                if let Some(idx) = find_subsequence(tail, b" : ") {
                    return Some(ControlEvent::ExtendedOutput {
                        pane,
                        bytes: unescape_octal(&tail[idx + 3..]),
                    });
                }
            }
        }

        let text = String::from_utf8_lossy(line).into_owned();
        if let Some(rest) = text.strip_prefix("%begin ") {
            self.block = Some(PendingBlock {
                number: guard_number(rest, 0),
                output: String::new(),
            });
            return None;
        }
        Some(parse_notification(&text).unwrap_or(ControlEvent::Unknown { line: text }))
    }
}

/// Notificaciones de una sola línea (todo lo que no es bloque ni `%output`).
/// `None` = no la entendimos → el llamador la convierte en `Unknown`.
fn parse_notification(text: &str) -> Option<ControlEvent> {
    if text == "%sessions-changed" {
        return Some(ControlEvent::SessionsChanged);
    }
    if text == "%exit" {
        return Some(ControlEvent::Exit { reason: None });
    }
    if let Some(rest) = text.strip_prefix("%exit ") {
        return Some(ControlEvent::Exit {
            reason: Some(rest.to_string()),
        });
    }
    if let Some(rest) = text.strip_prefix("%layout-change ") {
        let mut parts = rest.split_whitespace();
        return Some(ControlEvent::LayoutChange {
            window: id(parts.next()?, '@')?,
            layout: parts.next()?.to_string(),
            visible_layout: parts.next().map(str::to_string),
            flags: parts.next().map(str::to_string),
        });
    }
    if let Some(rest) = text.strip_prefix("%window-add ") {
        return Some(ControlEvent::WindowAdd { window: id(rest, '@')? });
    }
    if let Some(rest) = text.strip_prefix("%window-close ") {
        return Some(ControlEvent::WindowClose { window: id(rest, '@')? });
    }
    if let Some(rest) = text.strip_prefix("%window-renamed ") {
        let (win, name) = rest.split_once(' ')?;
        return Some(ControlEvent::WindowRenamed {
            window: id(win, '@')?,
            name: name.to_string(),
        });
    }
    if let Some(rest) = text.strip_prefix("%window-pane-changed ") {
        let (win, pane) = rest.split_once(' ')?;
        return Some(ControlEvent::WindowPaneChanged {
            window: id(win, '@')?,
            pane: id(pane, '%')?,
        });
    }
    if let Some(rest) = text.strip_prefix("%unlinked-window-add ") {
        return Some(ControlEvent::UnlinkedWindowAdd { window: id(rest, '@')? });
    }
    if let Some(rest) = text.strip_prefix("%unlinked-window-close ") {
        return Some(ControlEvent::UnlinkedWindowClose { window: id(rest, '@')? });
    }
    if let Some(rest) = text.strip_prefix("%unlinked-window-renamed ") {
        let (win, name) = rest.split_once(' ')?;
        return Some(ControlEvent::UnlinkedWindowRenamed {
            window: id(win, '@')?,
            name: name.to_string(),
        });
    }
    if let Some(rest) = text.strip_prefix("%session-changed ") {
        let (session, name) = rest.split_once(' ')?;
        return Some(ControlEvent::SessionChanged {
            session: id(session, '$')?,
            name: name.to_string(),
        });
    }
    if let Some(rest) = text.strip_prefix("%session-renamed ") {
        return Some(ControlEvent::SessionRenamed {
            name: rest.to_string(),
        });
    }
    if let Some(rest) = text.strip_prefix("%session-window-changed ") {
        let (session, win) = rest.split_once(' ')?;
        return Some(ControlEvent::SessionWindowChanged {
            session: id(session, '$')?,
            window: id(win, '@')?,
        });
    }
    if let Some(rest) = text.strip_prefix("%pane-mode-changed ") {
        return Some(ControlEvent::PaneModeChanged { pane: id(rest, '%')? });
    }
    if let Some(rest) = text.strip_prefix("%client-session-changed ") {
        let mut parts = rest.splitn(3, ' ');
        return Some(ControlEvent::ClientSessionChanged {
            client: parts.next()?.to_string(),
            session: id(parts.next()?, '$')?,
            name: parts.next()?.to_string(),
        });
    }
    if let Some(rest) = text.strip_prefix("%subscription-changed ") {
        let (head, value) = rest.split_once(" : ")?;
        return Some(ControlEvent::SubscriptionChanged {
            name: head.split_whitespace().next()?.to_string(),
            value: value.to_string(),
        });
    }
    if let Some(rest) = text.strip_prefix("%pause ") {
        return Some(ControlEvent::Pause { pane: id(rest, '%')? });
    }
    if let Some(rest) = text.strip_prefix("%continue ") {
        return Some(ControlEvent::Continue { pane: id(rest, '%')? });
    }
    None
}

/// `%<n>` / `@<n>` / `$<n>` → n.
fn id(token: &str, sigil: char) -> Option<u64> {
    token.strip_prefix(sigil)?.parse().ok()
}

/// Número de comando de una guarda `%begin`/`%end`/`%error`: el formato es
/// `<timestamp> <número> <flags>`. Si no se puede leer, cae al de reserva
/// (el del `%begin` abierto) para no perder la correlación por una guarda rara.
fn guard_number(rest: &str, fallback: u64) -> u64 {
    rest.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(fallback)
}

/// Separa `%<pane> <payload>` a nivel de bytes.
fn split_pane_payload(rest: &[u8]) -> Option<(u64, &[u8])> {
    let sp = rest.iter().position(|&b| b == b' ')?;
    let pane = id(std::str::from_utf8(&rest[..sp]).ok()?, '%')?;
    Some((pane, &rest[sp + 1..]))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Desescapa el octal de `%output`: `\ooo` (tres dígitos octales) → byte. Un
/// `\` que no encabece tres dígitos octales se conserva literal (tolerancia:
/// tmux nunca lo emite así).
fn unescape_octal(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'\\' && i + 3 < input.len() {
            let d = &input[i + 1..i + 4];
            if d.iter().all(|&c| (b'0'..=b'7').contains(&c)) {
                let val =
                    u32::from(d[0] - b'0') * 64 + u32::from(d[1] - b'0') * 8 + u32::from(d[2] - b'0');
                out.push((val & 0xff) as u8);
                i += 4;
                continue;
            }
        }
        out.push(input[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(chunks: &[&[u8]]) -> Vec<ControlEvent> {
        let mut parser = ControlParser::new();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(parser.feed(chunk));
        }
        events
    }

    /// Captura real de `tmux -C new-session` (tmux 3.7b): bloque vacío inicial,
    /// notificaciones de arranque y un `list-windows` con su respuesta.
    #[test]
    fn captura_real_de_arranque_y_list_windows() {
        let captura = b"%begin 1785510405 280 0\n\
%end 1785510405 280 0\n\
%window-add @0\n\
%sessions-changed\n\
%session-changed $0 rustty_cc_probe\n\
%window-renamed @0 tmux\n\
%begin 1785510405 287 1\n\
0: tmux* (1 panes) [80x24] [layout b25d,80x24,0,0,0] @0 (active)\n\
%end 1785510405 287 1\n\
%window-pane-changed @0 %1\n\
%exit\n";
        let events = feed_all(&[captura]);
        assert_eq!(
            events,
            vec![
                ControlEvent::CommandResponse {
                    number: 280,
                    success: true,
                    output: String::new(),
                },
                ControlEvent::WindowAdd { window: 0 },
                ControlEvent::SessionsChanged,
                ControlEvent::SessionChanged {
                    session: 0,
                    name: "rustty_cc_probe".into(),
                },
                ControlEvent::WindowRenamed {
                    window: 0,
                    name: "tmux".into(),
                },
                ControlEvent::CommandResponse {
                    number: 287,
                    success: true,
                    output: "0: tmux* (1 panes) [80x24] [layout b25d,80x24,0,0,0] @0 (active)\n"
                        .into(),
                },
                ControlEvent::WindowPaneChanged { window: 0, pane: 1 },
                ControlEvent::Exit { reason: None },
            ]
        );
    }

    /// Payload real de `%output` (tmux 3.7b): tab y CR/LF en octal, `\` como
    /// `\134` y el UTF-8 (`ñ€`) en bytes crudos.
    #[test]
    fn output_desescapa_octal_y_conserva_utf8_crudo() {
        let events =
            feed_all(&[b"%output %0 a\\011b\\134z-\xc3\xb1\xe2\x82\xac\\015\\012\n"]);
        assert_eq!(
            events,
            vec![ControlEvent::Output {
                pane: 0,
                bytes: b"a\tb\\z-\xc3\xb1\xe2\x82\xac\r\n".to_vec(),
            }]
        );
    }

    /// Un carácter UTF-8 partido entre dos `%output` debe sobrevivir en bytes:
    /// concatenados reconstruyen la cadena original.
    #[test]
    fn utf8_partido_entre_dos_output_no_se_corrompe() {
        let events = feed_all(&[b"%output %3 antes-\xc3\n", b"%output %3 \xb1-despues\n"]);
        let mut all = Vec::new();
        for ev in events {
            match ev {
                ControlEvent::Output { pane: 3, bytes } => all.extend(bytes),
                other => panic!("evento inesperado: {other:?}"),
            }
        }
        assert_eq!(String::from_utf8(all).unwrap(), "antes-ñ-despues");
    }

    /// Línea partida en trozos arbitrarios entre lecturas (incluso a mitad de
    /// un escape octal): un único evento al llegar el `\n`.
    #[test]
    fn lineas_partidas_entre_feeds_se_recomponen() {
        let events = feed_all(&[b"%outp", b"ut %7 ho\\01", b"1la", b"\n%window-close @2\n"]);
        assert_eq!(
            events,
            vec![
                ControlEvent::Output {
                    pane: 7,
                    bytes: b"ho\tla".to_vec(),
                },
                ControlEvent::WindowClose { window: 2 },
            ]
        );
    }

    #[test]
    fn bloque_error_correlacionado_por_numero() {
        let events = feed_all(&[
            b"%begin 100 42 1\nbad command: nope\n\n%error 101 42 1\n" as &[u8],
        ]);
        assert_eq!(
            events,
            vec![ControlEvent::CommandResponse {
                number: 42,
                success: false,
                output: "bad command: nope\n\n".into(),
            }]
        );
    }

    #[test]
    fn notificaciones_de_layout_ventanas_y_sesiones() {
        let events = feed_all(&[b"%layout-change @1 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} *\n\
%session-window-changed $0 @1\n\
%session-renamed produccion\n\
%pane-mode-changed %5\n\
%unlinked-window-add @9\n\
%client-session-changed /dev/pts/4 $2 backup\n" as &[u8]]);
        assert_eq!(
            events,
            vec![
                ControlEvent::LayoutChange {
                    window: 1,
                    layout: "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}".into(),
                    visible_layout: Some("8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}".into()),
                    flags: Some("*".into()),
                },
                ControlEvent::SessionWindowChanged { session: 0, window: 1 },
                ControlEvent::SessionRenamed {
                    name: "produccion".into(),
                },
                ControlEvent::PaneModeChanged { pane: 5 },
                ControlEvent::UnlinkedWindowAdd { window: 9 },
                ControlEvent::ClientSessionChanged {
                    client: "/dev/pts/4".into(),
                    session: 2,
                    name: "backup".into(),
                },
            ]
        );
    }

    #[test]
    fn extended_output_pause_continue_y_subscription() {
        let events = feed_all(&[b"%extended-output %2 154 : hola\\011mundo\n\
%pause %2\n\
%continue %2\n\
%subscription-changed cwd $0 @1 1 %2 : /home/user/proyecto\n" as &[u8]]);
        assert_eq!(
            events,
            vec![
                ControlEvent::ExtendedOutput {
                    pane: 2,
                    bytes: b"hola\tmundo".to_vec(),
                },
                ControlEvent::Pause { pane: 2 },
                ControlEvent::Continue { pane: 2 },
                ControlEvent::SubscriptionChanged {
                    name: "cwd".into(),
                    value: "/home/user/proyecto".into(),
                },
            ]
        );
    }

    /// El DCS de entrada llega pegado a la primera línea; el ST de salida es
    /// una línea sin contenido de protocolo. CRLF también se tolera.
    #[test]
    fn dcs_st_y_crlf_se_toleran() {
        let events = feed_all(&[
            b"\x1bP1000p%begin 1 2 0\r\n%end 1 2 0\r\n%exit server exited\n\x1b\\\n" as &[u8],
        ]);
        assert_eq!(
            events,
            vec![
                ControlEvent::CommandResponse {
                    number: 2,
                    success: true,
                    output: String::new(),
                },
                ControlEvent::Exit {
                    reason: Some("server exited".into()),
                },
            ]
        );
    }

    /// Lo desconocido o malformado se entrega como `Unknown`, nunca se pierde
    /// en silencio ni rompe el parser para las líneas siguientes.
    #[test]
    fn lo_desconocido_es_unknown_y_no_desincroniza() {
        let events = feed_all(&[
            b"%future-notification foo bar\n%window-add basura\n%window-add @4\n" as &[u8],
        ]);
        assert_eq!(
            events,
            vec![
                ControlEvent::Unknown {
                    line: "%future-notification foo bar".into(),
                },
                ControlEvent::Unknown {
                    line: "%window-add basura".into(),
                },
                ControlEvent::WindowAdd { window: 4 },
            ]
        );
    }

    /// Payload con `\134` (el propio `\`) seguido de dígitos: el desescapado
    /// no debe re-interpretar el resultado.
    #[test]
    fn backslash_escapado_no_se_reinterpreta() {
        let events = feed_all(&[b"%output %1 \\134011\n" as &[u8]]);
        assert_eq!(
            events,
            vec![ControlEvent::Output {
                pane: 1,
                bytes: b"\\011".to_vec(),
            }]
        );
    }
}
