//! Puente **puro** entre el stream de control de tmux y el mundo exterior
//! (Fase 2 del modo control). Une `client` (correlación) + `manager` (modelo)
//! y digiere los `ModelUpdate` a salidas listas para el transporte: bytes de
//! terminal por sesión lógica, payloads serializables para los eventos
//! `tmux-*` del contrato IPC y comandos ya compuestos (con su saneado) para
//! escribir en el canal.
//!
//! Sin E/S, sin reloj, sin Tauri: `ssh_manager` le da bytes y milisegundos
//! monótonos y escribe lo que este módulo devuelve. Así el wiring completo se
//! prueba contra un tmux real por un canal exec, sin `AppHandle`.

use serde::Serialize;

use super::client::{ControlClient, SendError, ShutdownReason};
use super::layout::{LayoutCell, LayoutKind, SplitDir};
use super::manager::{ModelUpdate, PaneBinding, TmuxManager};

// ─── Payloads serializables del contrato de eventos (espejo de events.js) ────

/// Vínculo pane ↔ sesión lógica, como viaja en los eventos (`TmuxPaneBinding`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneRef {
    pub pane: u64,
    pub logical_id: String,
}

impl From<PaneBinding> for PaneRef {
    fn from(b: PaneBinding) -> Self {
        PaneRef { pane: b.pane, logical_id: b.logical_id }
    }
}

/// Nodo del layout serializado para el frontend. `dir` usa la convención
/// flex-CSS de `modules/panes/tree.js`: `"row"` = lado a lado (`{}` de tmux),
/// `"column"` = apiladas (`[]`). Geometría en celdas de terminal: la UI acata
/// estos tamaños, no negocia.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutNode {
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<LayoutNode>>,
}

impl From<&LayoutCell> for LayoutNode {
    fn from(cell: &LayoutCell) -> Self {
        match &cell.kind {
            LayoutKind::Leaf { pane } => LayoutNode {
                width: cell.width,
                height: cell.height,
                x: cell.x,
                y: cell.y,
                pane: Some(*pane),
                dir: None,
                children: None,
            },
            LayoutKind::Split { dir, children } => LayoutNode {
                width: cell.width,
                height: cell.height,
                x: cell.x,
                y: cell.y,
                pane: None,
                dir: Some(match dir {
                    SplitDir::LeftRight => "row",
                    SplitDir::TopBottom => "column",
                }),
                children: Some(children.iter().map(LayoutNode::from).collect()),
            },
        }
    }
}

/// Payload de `tmux-layout-{sessionId}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxLayoutPayload {
    pub window: u64,
    pub layout: LayoutNode,
    pub added: Vec<PaneRef>,
    pub removed: Vec<PaneRef>,
}

/// Payload de `tmux-window-added-{sessionId}` (upsert: alta o renombrado) y
/// de `tmux-window-closed-{sessionId}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWindowPayload {
    pub window: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Payload de `tmux-pane-closed-{sessionId}`. Señal ÚNICA de «cierra la
/// sesión lógica de esta pane» (el layout solo trae geometría).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneClosedPayload {
    pub pane: PaneRef,
}

/// Payload de `tmux-exit-{sessionId}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxExitPayload {
    pub reason: Option<String>,
}

// ─── Salidas del puente ──────────────────────────────────────────────────────

/// Lo que el transporte tiene que hacer con cada digestión. El puente nunca
/// descarta en silencio: lo que no entiende sale como `Warning`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeOut {
    /// Bytes de terminal para la sesión lógica de una pane (→ su Channel).
    PaneOutput { pane: PaneRef, bytes: Vec<u8> },
    /// Layout nuevo de una ventana (→ evento `tmux-layout`).
    Layout(TmuxLayoutPayload),
    /// Alta o renombrado de ventana (→ `tmux-window-added`, semántica upsert).
    WindowUpsert(TmuxWindowPayload),
    /// Cierre de ventana (→ `tmux-window-closed`).
    WindowClosed(TmuxWindowPayload),
    /// Una pane terminó (→ `tmux-pane-closed`); su sesión lógica se cierra.
    PaneClosed(TmuxPaneClosedPayload),
    /// Respuesta correlada a un comando enviado con `command()`.
    CommandDone { tag: u64, success: bool, output: String },
    /// La sesión de control terminó (→ `tmux-exit`). No escribir más.
    Ended(TmuxExitPayload),
    /// Algo ilegible o inesperado; va al log de conexión, nunca al limbo.
    Warning { message: String },
}

// ─── El puente ───────────────────────────────────────────────────────────────

/// Estado del modo control de UNA conexión: cliente correlador + modelo.
#[derive(Debug)]
pub struct ControlBridge {
    client: ControlClient,
    manager: TmuxManager,
}

impl ControlBridge {
    /// `prefix` = sessionId de la conexión SSH: los ids lógicos de pane salen
    /// como `{prefix}-p{pane}` (deterministas, sobreviven a `break-pane`).
    pub fn new(prefix: impl Into<String>) -> Self {
        ControlBridge {
            client: ControlClient::new(),
            manager: TmuxManager::new(prefix),
        }
    }

    /// Tras `%exit`, desync o timeout ya no se puede (ni debe) escribir.
    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// Id lógico determinista de una pane (para el fixture y el frontend).
    pub fn logical_id_for(&self, pane: u64) -> String {
        self.manager.logical_id_for(pane)
    }

    /// Bytes recibidos del canal → salidas digeridas.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<BridgeOut> {
        let events = self.client.feed(bytes);
        let mut out = Vec::new();
        for event in events {
            for update in self.manager.apply(event) {
                digest(update, &mut out);
            }
        }
        out
    }

    /// Compone el envío de un comando: devuelve `(tag, bytes_a_escribir)`.
    /// El transporte escribe los bytes; la respuesta llegará como
    /// `BridgeOut::CommandDone` con ese tag.
    pub fn command(&mut self, command: &str, now_ms: u64) -> Result<(u64, Vec<u8>), SendError> {
        self.client.send_command(command, now_ms)
    }

    /// Vencimiento de comandos pendientes (llamar desde el timer del worker).
    pub fn check_timeouts(&mut self, now_ms: u64) -> Vec<BridgeOut> {
        let mut out = Vec::new();
        if let Some(event) = self.client.check_timeouts(now_ms) {
            for update in self.manager.apply(event) {
                digest(update, &mut out);
            }
        }
        out
    }
}

/// `ModelUpdate` → `BridgeOut`s. Las updates de foco y suscripción se ignoran
/// a propósito en esta fase (la UI manda su propio foco); el flow control por
/// pane (`%pause`) queda para cuando se active `pause-after` (F3.3).
fn digest(update: ModelUpdate, out: &mut Vec<BridgeOut>) {
    match update {
        ModelUpdate::Output { pane, bytes } => {
            out.push(BridgeOut::PaneOutput { pane: pane.into(), bytes });
        }
        ModelUpdate::LayoutChanged { window, layout, added, removed } => {
            for binding in &removed {
                out.push(BridgeOut::PaneClosed(TmuxPaneClosedPayload {
                    pane: binding.clone().into(),
                }));
            }
            out.push(BridgeOut::Layout(TmuxLayoutPayload {
                window,
                layout: LayoutNode::from(&layout),
                added: added.into_iter().map(PaneRef::from).collect(),
                removed: removed.into_iter().map(PaneRef::from).collect(),
            }));
        }
        ModelUpdate::WindowAdded { window } => {
            out.push(BridgeOut::WindowUpsert(TmuxWindowPayload { window, name: None }));
        }
        ModelUpdate::WindowRenamed { window, name } => {
            out.push(BridgeOut::WindowUpsert(TmuxWindowPayload { window, name: Some(name) }));
        }
        ModelUpdate::WindowClosed { window, removed_panes } => {
            for binding in removed_panes {
                out.push(BridgeOut::PaneClosed(TmuxPaneClosedPayload { pane: binding.into() }));
            }
            out.push(BridgeOut::WindowClosed(TmuxWindowPayload { window, name: None }));
        }
        ModelUpdate::CommandDone { tag, success, output } => {
            out.push(BridgeOut::CommandDone { tag, success, output });
        }
        ModelUpdate::Ended { reason } => {
            out.push(BridgeOut::Ended(TmuxExitPayload { reason: exit_reason(reason) }));
        }
        ModelUpdate::Warning { message } => {
            out.push(BridgeOut::Warning { message });
        }
        // Foco (la UI no lo sigue: manda el suyo), suscripciones de formato y
        // pausa por pane (sin pause-after activo tmux no las emite).
        ModelUpdate::SessionChanged { .. }
        | ModelUpdate::ActiveWindowChanged { .. }
        | ModelUpdate::ActivePaneChanged { .. }
        | ModelUpdate::FlowPaused { .. }
        | ModelUpdate::Subscription { .. } => {}
    }
}

fn exit_reason(reason: ShutdownReason) -> Option<String> {
    match reason {
        ShutdownReason::Exit(reason) => reason,
        ShutdownReason::Desync { line } => Some(format!("desincronización: {line}")),
        ShutdownReason::CommandTimeout { tag } => {
            Some(format!("el comando #{tag} agotó su plazo"))
        }
    }
}

// ─── Composición de comandos tmux (saneada) ──────────────────────────────────
//
// INVARIANTE del modo control: en el canal NUNCA se escriben bytes crudos de
// teclado — todo viaja como comandos de una línea. Los ids de pane/ventana son
// numéricos (imposible inyectar); el único texto libre (renombrar ventana) va
// entre comillas simples con el único escape que tmux entiende para ellas.

/// Entrada de teclado como `send-keys` hexadecimal: agnóstico del contenido
/// (UTF-8 parcial, secuencias de escape, NUL…), sin problemas de quoting.
pub fn cmd_send_keys(pane: u64, data: &[u8]) -> String {
    let mut cmd = format!("send-keys -H -t %{pane}");
    for byte in data {
        cmd.push_str(&format!(" 0x{byte:02x}"));
    }
    cmd
}

/// Divide una pane. `horizontal = true` → lado a lado (`split-window -h`).
pub fn cmd_split_pane(pane: u64, horizontal: bool) -> String {
    let flag = if horizontal { "-h" } else { "-v" };
    format!("split-window {flag} -t %{pane}")
}

pub fn cmd_kill_pane(pane: u64) -> String {
    format!("kill-pane -t %{pane}")
}

pub fn cmd_new_window() -> String {
    "new-window".to_string()
}

pub fn cmd_kill_window(window: u64) -> String {
    format!("kill-window -t @{window}")
}

/// Renombra una ventana. El nombre va entre comillas simples; una comilla
/// simple dentro se escribe `'\''` (cerrar, comilla escapada, reabrir), el
/// único escape que el parser de tmux acepta para ese caso. Los saltos de
/// línea se retiran: `ControlClient` los rechazaría (comando fantasma).
pub fn cmd_rename_window(window: u64, name: &str) -> String {
    let clean: String = name.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    let escaped = clean.replace('\'', "'\\''");
    format!("rename-window -t @{window} '{escaped}'")
}

/// Redimensiona una pane a un tamaño absoluto en celdas.
pub fn cmd_resize_pane(pane: u64, cols: u32, rows: u32) -> String {
    format!("resize-pane -t %{pane} -x {cols} -y {rows}")
}

/// Tamaño del cliente de control (F4.3): tmux nunca hará una ventana mayor
/// que su cliente más pequeño, así que hay que declararle el nuestro.
pub fn cmd_set_client_size(cols: u32, rows: u32) -> String {
    format!("refresh-client -C {cols}x{rows}")
}

/// Scrollback de una pane para el reenganche (F5.1): `-p` a stdout del
/// comando, `-e` conserva colores, `-J` une las líneas envueltas, `-S -N`
/// arranca N líneas atrás.
pub fn cmd_capture_pane(pane: u64, lines: u32) -> String {
    format!("capture-pane -p -e -J -t %{pane} -S -{lines}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Arranque real (tmux 3.7b): saludo (flags 0) + sesión + ventana +
    /// layout de una pane. Mismo patrón de bytes que client.rs y manager.rs.
    const BOOT: &[u8] = b"%begin 1 0 0\n%end 1 0 0\n%session-changed $0 rustty\n%window-add @0\n%layout-change @0 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *\n";

    #[test]
    fn el_arranque_produce_ventana_y_layout_con_ids_deterministas() {
        let mut bridge = ControlBridge::new("ssh-abc");
        let out = bridge.feed(BOOT);
        assert!(out.contains(&BridgeOut::WindowUpsert(TmuxWindowPayload {
            window: 0,
            name: None
        })));
        let layout = out.iter().find_map(|o| match o {
            BridgeOut::Layout(l) => Some(l),
            _ => None,
        });
        let layout = layout.expect("falta el layout");
        assert_eq!(layout.window, 0);
        assert_eq!(layout.layout.pane, Some(0));
        assert_eq!(layout.added, vec![PaneRef { pane: 0, logical_id: "ssh-abc-p0".into() }]);
        assert!(!bridge.is_closed());
    }

    #[test]
    fn la_salida_de_una_pane_llega_con_su_id_logico() {
        let mut bridge = ControlBridge::new("s");
        bridge.feed(BOOT);
        let out = bridge.feed(b"%output %0 hola\\015\\012\n");
        assert_eq!(
            out,
            vec![BridgeOut::PaneOutput {
                pane: PaneRef { pane: 0, logical_id: "s-p0".into() },
                bytes: b"hola\r\n".to_vec(),
            }]
        );
    }

    #[test]
    fn cerrar_ventana_emite_pane_closed_antes_que_window_closed() {
        let mut bridge = ControlBridge::new("s");
        bridge.feed(BOOT);
        let out = bridge.feed(b"%window-close @0\n");
        assert_eq!(
            out,
            vec![
                BridgeOut::PaneClosed(TmuxPaneClosedPayload {
                    pane: PaneRef { pane: 0, logical_id: "s-p0".into() },
                }),
                BridgeOut::WindowClosed(TmuxWindowPayload { window: 0, name: None }),
            ]
        );
    }

    #[test]
    fn un_comando_se_correla_y_exit_cierra_el_puente() {
        let mut bridge = ControlBridge::new("s");
        bridge.feed(BOOT);
        let (tag, bytes) = bridge.command("list-windows", 0).expect("comando");
        assert_eq!(bytes, b"list-windows\n");
        let out = bridge.feed(b"%begin 7 2 1\n@0 ventana\n%end 7 2 1\n%exit\n");
        assert!(out.contains(&BridgeOut::CommandDone {
            tag,
            success: true,
            output: "@0 ventana\n".into()
        }));
        assert!(out.iter().any(|o| matches!(o, BridgeOut::Ended(_))));
        assert!(bridge.is_closed());
        assert_eq!(bridge.command("ls", 0), Err(SendError::Closed));
    }

    #[test]
    fn el_layout_serializado_usa_la_convencion_de_tree_js() {
        // 40x24 y 39x24 lado a lado: `{}` de tmux → dir "row".
        let mut bridge = ControlBridge::new("s");
        bridge.feed(BOOT);
        let out =
            bridge.feed(b"%layout-change @0 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} x *\n");
        let layout = out
            .iter()
            .find_map(|o| match o {
                BridgeOut::Layout(l) => Some(l),
                _ => None,
            })
            .expect("layout");
        assert_eq!(layout.layout.dir, Some("row"));
        let children = layout.layout.children.as_ref().expect("hijos");
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].pane, Some(0));
        assert_eq!(children[1].pane, Some(1));
        // El JSON final va en camelCase y sin campos ausentes.
        let json = serde_json::to_value(layout).expect("serializable");
        assert_eq!(json["layout"]["dir"], "row");
        assert!(json["layout"]["children"][0].get("dir").is_none());
    }

    #[test]
    fn los_comandos_compuestos_sanean_lo_que_toca() {
        assert_eq!(cmd_send_keys(3, b"ls\r"), "send-keys -H -t %3 0x6c 0x73 0x0d");
        assert_eq!(cmd_split_pane(1, true), "split-window -h -t %1");
        assert_eq!(cmd_split_pane(1, false), "split-window -v -t %1");
        assert_eq!(
            cmd_rename_window(2, "logs de l'app\nmala"),
            "rename-window -t @2 'logs de l'\\''appmala'"
        );
        assert_eq!(cmd_set_client_size(120, 40), "refresh-client -C 120x40");
        assert_eq!(cmd_capture_pane(5, 2000), "capture-pane -p -e -J -t %5 -S -2000");
    }

    #[test]
    fn un_timeout_termina_la_sesion_de_control() {
        let mut bridge = ControlBridge::new("s");
        bridge.feed(BOOT);
        bridge.command("ls", 1_000).expect("comando");
        // Antes del plazo (30 s por defecto): nada que reportar, puente vivo.
        assert!(bridge.check_timeouts(10_000).is_empty());
        assert!(!bridge.is_closed());
        // Vencido el plazo: Ended con el motivo y puente cerrado para siempre.
        let out = bridge.check_timeouts(40_000);
        assert!(out.iter().any(|o| matches!(o, BridgeOut::Ended(_))));
        assert!(bridge.is_closed());
    }
}
