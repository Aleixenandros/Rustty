//! Modelo **puro** de la sesión de control (F1.4, `TmuxManager`).
//!
//! Mantiene el mapa pane ↔ **sesión lógica** del frontend y ventana ↔ pestaña:
//! consume los `ClientEvent` del cliente (F1.3) y devuelve `ModelUpdate`s ya
//! digeridos para la capa de wiring (fase 2). La decisión de diseño clave del
//! plan vive aquí: **cada pane de tmux es una sesión lógica** con un id
//! sintético — y ese id es **determinista** (`{prefijo}-p{pane}`), no un uuid:
//! si una pane sale de una ventana y aparece en otra (`break-pane`), el
//! binding sobrevive al par quitar/añadir sin perder la sesión del frontend.
//!
//! Sin E/S: los layouts llegan como string (`%layout-change`) y se parsean con
//! `layout.rs`; un layout corrupto produce `Warning`, nunca pánico ni descarte
//! mudo.

use super::client::{ClientEvent, ShutdownReason};
use super::layout::{parse_layout, LayoutCell};
use super::protocol::ControlEvent;
use std::collections::BTreeMap;

/// Estado de una ventana de tmux (una pestaña del frontend).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowState {
    pub name: String,
    pub layout: Option<LayoutCell>,
    pub active_pane: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PaneState {
    /// `None` = pane vista (p. ej. por `%output`) antes de conocer su ventana.
    window: Option<u64>,
    logical_id: String,
}

/// Pane + su sesión lógica del frontend, tal y como viaja en los updates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneBinding {
    pub pane: u64,
    pub logical_id: String,
}

/// Cambio ya digerido del modelo, listo para traducir a eventos IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelUpdate {
    SessionChanged { session: u64, name: String },
    WindowAdded { window: u64 },
    WindowRenamed { window: u64, name: String },
    /// La ventana se cerró; sus panes mueren con ella.
    WindowClosed {
        window: u64,
        removed_panes: Vec<PaneBinding>,
    },
    /// Ventana activa de la sesión (foco de pestaña).
    ActiveWindowChanged { window: u64 },
    /// Layout nuevo de una ventana. `added` = panes nuevas EN esta ventana
    /// (recién creadas o adoptadas); `removed` = ya no están en esta ventana
    /// (cerradas, o a punto de reaparecer en otra si fue un `break-pane` —
    /// el id lógico determinista hace ese par quitar/añadir inocuo).
    LayoutChanged {
        window: u64,
        layout: LayoutCell,
        added: Vec<PaneBinding>,
        removed: Vec<PaneBinding>,
    },
    /// Pane activa dentro de una ventana (foco de split).
    ActivePaneChanged { window: u64, pane: u64 },
    /// Bytes de terminal para la sesión lógica de esta pane.
    Output { pane: PaneBinding, bytes: Vec<u8> },
    /// Flow control por pane (`%pause`/`%continue`, F3.3).
    FlowPaused { pane: PaneBinding, paused: bool },
    /// Valor de una suscripción de formato (`refresh-client -B`), p. ej. cwd.
    Subscription { name: String, value: String },
    /// Respuesta correlada a un comando nuestro (passthrough del cliente).
    CommandDone {
        tag: u64,
        success: bool,
        output: String,
    },
    /// La sesión de control terminó: cerrar todas las sesiones lógicas.
    Ended { reason: ShutdownReason },
    /// Algo raro pero no fatal (layout corrupto, notificación desconocida):
    /// para el log de diagnóstico, nunca se descarta en silencio.
    Warning { message: String },
}

/// Modelo de una sesión `tmux -CC`. Crear uno por sesión de control.
#[derive(Debug)]
pub struct TmuxManager {
    /// Prefijo de los ids lógicos (p. ej. el sessionId de la conexión SSH).
    prefix: String,
    session: Option<(u64, String)>,
    windows: BTreeMap<u64, WindowState>,
    panes: BTreeMap<u64, PaneState>,
}

impl TmuxManager {
    pub fn new(prefix: impl Into<String>) -> Self {
        TmuxManager {
            prefix: prefix.into(),
            session: None,
            windows: BTreeMap::new(),
            panes: BTreeMap::new(),
        }
    }

    /// Id de la sesión lógica de una pane. Determinista a propósito (ver doc
    /// del módulo).
    pub fn logical_id_for(&self, pane: u64) -> String {
        format!("{}-p{pane}", self.prefix)
    }

    /// Sesión lógica de una pane ya vista, si existe.
    pub fn logical_id(&self, pane: u64) -> Option<&str> {
        self.panes.get(&pane).map(|p| p.logical_id.as_str())
    }

    /// Pane de una sesión lógica (para enrutar la entrada: `send-keys`).
    pub fn pane_by_logical(&self, logical_id: &str) -> Option<u64> {
        self.panes
            .iter()
            .find(|(_, p)| p.logical_id == logical_id)
            .map(|(id, _)| *id)
    }

    /// Sesión tmux actual (`$id`, nombre), si ya se anunció.
    pub fn session(&self) -> Option<(u64, &str)> {
        self.session.as_ref().map(|(id, name)| (*id, name.as_str()))
    }

    /// Ventanas conocidas en orden de id.
    pub fn windows(&self) -> impl Iterator<Item = (u64, &WindowState)> {
        self.windows.iter().map(|(id, w)| (*id, w))
    }

    fn binding(&mut self, pane: u64) -> PaneBinding {
        let logical_id = self.logical_id_for(pane);
        self.panes.entry(pane).or_insert_with(|| PaneState {
            window: None,
            logical_id: logical_id.clone(),
        });
        PaneBinding {
            pane,
            logical_id,
        }
    }

    /// Consume un evento del cliente y devuelve los cambios del modelo.
    pub fn apply(&mut self, event: ClientEvent) -> Vec<ModelUpdate> {
        match event {
            ClientEvent::CommandDone {
                tag,
                success,
                output,
            } => vec![ModelUpdate::CommandDone {
                tag,
                success,
                output,
            }],
            ClientEvent::Shutdown(reason) => vec![ModelUpdate::Ended { reason }],
            ClientEvent::Notification(ev) => self.apply_notification(ev),
        }
    }

    fn apply_notification(&mut self, ev: ControlEvent) -> Vec<ModelUpdate> {
        match ev {
            ControlEvent::Output { pane, bytes }
            | ControlEvent::ExtendedOutput { pane, bytes } => {
                let binding = self.binding(pane);
                vec![ModelUpdate::Output { pane: binding, bytes }]
            }
            ControlEvent::LayoutChange { window, layout, .. } => {
                self.apply_layout(window, &layout)
            }
            ControlEvent::WindowAdd { window } => {
                self.windows.entry(window).or_insert_with(|| WindowState {
                    name: String::new(),
                    layout: None,
                    active_pane: None,
                });
                vec![ModelUpdate::WindowAdded { window }]
            }
            ControlEvent::WindowRenamed { window, name } => {
                let w = self.windows.entry(window).or_insert_with(|| WindowState {
                    name: String::new(),
                    layout: None,
                    active_pane: None,
                });
                w.name = name.clone();
                vec![ModelUpdate::WindowRenamed { window, name }]
            }
            ControlEvent::WindowClose { window } => {
                self.windows.remove(&window);
                let removed: Vec<u64> = self
                    .panes
                    .iter()
                    .filter(|(_, p)| p.window == Some(window))
                    .map(|(id, _)| *id)
                    .collect();
                let removed_panes = removed
                    .into_iter()
                    .map(|id| {
                        let state = self.panes.remove(&id).expect("pane recién listada");
                        PaneBinding {
                            pane: id,
                            logical_id: state.logical_id,
                        }
                    })
                    .collect();
                vec![ModelUpdate::WindowClosed {
                    window,
                    removed_panes,
                }]
            }
            ControlEvent::WindowPaneChanged { window, pane } => {
                // Registra la pane pero NO le adjudica ventana: la membresía
                // la dicta el `%layout-change`, cuyo `added` es la señal única
                // de «crea la sesión lógica». Si se adjudicara aquí (el
                // %window-pane-changed llega ANTES que el layout en el
                // arranque real), la pane jamás aparecería en `added` — lo
                // cazó el test de integración contra tmux 3.7b.
                self.binding(pane);
                if let Some(w) = self.windows.get_mut(&window) {
                    w.active_pane = Some(pane);
                }
                vec![ModelUpdate::ActivePaneChanged { window, pane }]
            }
            ControlEvent::SessionChanged { session, name } => {
                self.session = Some((session, name.clone()));
                vec![ModelUpdate::SessionChanged { session, name }]
            }
            ControlEvent::SessionRenamed { name } => match &mut self.session {
                Some((id, current)) => {
                    *current = name.clone();
                    let session = *id;
                    vec![ModelUpdate::SessionChanged { session, name }]
                }
                None => vec![ModelUpdate::Warning {
                    message: format!("session-renamed sin sesión anunciada: {name}"),
                }],
            },
            ControlEvent::SessionWindowChanged { window, .. } => {
                vec![ModelUpdate::ActiveWindowChanged { window }]
            }
            ControlEvent::SubscriptionChanged { name, value } => {
                vec![ModelUpdate::Subscription { name, value }]
            }
            ControlEvent::Pause { pane } => {
                let binding = self.binding(pane);
                vec![ModelUpdate::FlowPaused { pane: binding, paused: true }]
            }
            ControlEvent::Continue { pane } => {
                let binding = self.binding(pane);
                vec![ModelUpdate::FlowPaused { pane: binding, paused: false }]
            }
            ControlEvent::Unknown { line } => vec![ModelUpdate::Warning {
                message: format!("notificación no reconocida: {line}"),
            }],
            // Ventanas de otras sesiones no enlazadas y el resto de
            // notificaciones informativas: no afectan a nuestro modelo.
            ControlEvent::UnlinkedWindowAdd { .. }
            | ControlEvent::UnlinkedWindowClose { .. }
            | ControlEvent::UnlinkedWindowRenamed { .. }
            | ControlEvent::SessionsChanged
            | ControlEvent::ClientSessionChanged { .. }
            | ControlEvent::PaneModeChanged { .. }
            | ControlEvent::CommandResponse { .. } => Vec::new(),
            // `%exit` llega como `Shutdown` del cliente; si apareciera aquí,
            // se trata igual.
            ControlEvent::Exit { reason } => vec![ModelUpdate::Ended {
                reason: ShutdownReason::Exit(reason),
            }],
        }
    }

    fn apply_layout(&mut self, window: u64, layout_str: &str) -> Vec<ModelUpdate> {
        let cell = match parse_layout(layout_str) {
            Ok(cell) => cell,
            Err(e) => {
                return vec![ModelUpdate::Warning {
                    message: format!("layout de @{window} ilegible: {e}"),
                }]
            }
        };
        let new_ids = cell.pane_ids();

        // Añadidas: nuevas en ESTA ventana (recién creadas o adoptadas de
        // «sin ventana» / de otra ventana tras un break-pane).
        let mut added = Vec::new();
        for id in &new_ids {
            let logical_id = self.logical_id_for(*id);
            let state = self.panes.entry(*id).or_insert_with(|| PaneState {
                window: None,
                logical_id: logical_id.clone(),
            });
            if state.window != Some(window) {
                state.window = Some(window);
                added.push(PaneBinding {
                    pane: *id,
                    logical_id,
                });
            }
        }

        // Quitadas: estaban en esta ventana y ya no aparecen en su layout.
        let gone: Vec<u64> = self
            .panes
            .iter()
            .filter(|(id, p)| p.window == Some(window) && !new_ids.contains(id))
            .map(|(id, _)| *id)
            .collect();
        let removed = gone
            .into_iter()
            .map(|id| {
                let state = self.panes.remove(&id).expect("pane recién listada");
                PaneBinding {
                    pane: id,
                    logical_id: state.logical_id,
                }
            })
            .collect();

        let w = self.windows.entry(window).or_insert_with(|| WindowState {
            name: String::new(),
            layout: None,
            active_pane: None,
        });
        w.layout = Some(cell.clone());

        vec![ModelUpdate::LayoutChanged {
            window,
            layout: cell,
            added,
            removed,
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmux::client::ControlClient;

    /// Alimenta bytes crudos del canal al cliente y vuelca sus eventos en el
    /// manager: el mismo pipeline que usará el wiring.
    fn pump(client: &mut ControlClient, manager: &mut TmuxManager, bytes: &[u8]) -> Vec<ModelUpdate> {
        client
            .feed(bytes)
            .into_iter()
            .flat_map(|ev| manager.apply(ev))
            .collect()
    }

    /// Arranque real de `tmux -C` (captura 3.7b) de punta a punta:
    /// bytes → cliente → manager.
    #[test]
    fn arranque_real_construye_el_modelo() {
        let mut client = ControlClient::new();
        let mut manager = TmuxManager::new("ssh-abc");
        let updates = pump(
            &mut client,
            &mut manager,
            b"%begin 1785510405 280 0\n%end 1785510405 280 0\n\
%window-add @0\n\
%sessions-changed\n\
%session-changed $0 rustty_cc_probe\n\
%window-renamed @0 tmux\n\
%window-pane-changed @0 %1\n",
        );
        assert_eq!(
            updates,
            vec![
                ModelUpdate::WindowAdded { window: 0 },
                ModelUpdate::SessionChanged {
                    session: 0,
                    name: "rustty_cc_probe".into(),
                },
                ModelUpdate::WindowRenamed {
                    window: 0,
                    name: "tmux".into(),
                },
                ModelUpdate::ActivePaneChanged { window: 0, pane: 1 },
            ]
        );
        assert_eq!(manager.session(), Some((0, "rustty_cc_probe")));
        assert_eq!(manager.logical_id(1), Some("ssh-abc-p1"));
        assert_eq!(manager.pane_by_logical("ssh-abc-p1"), Some(1));
    }

    #[test]
    fn layout_da_de_alta_las_panes_con_ids_deterministas() {
        let mut manager = TmuxManager::new("s");
        let updates = manager.apply(ClientEvent::Notification(ControlEvent::LayoutChange {
            window: 1,
            layout: "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}".into(),
            visible_layout: None,
            flags: None,
        }));
        let ModelUpdate::LayoutChanged { window, added, removed, .. } = &updates[0] else {
            panic!("esperaba LayoutChanged: {updates:?}");
        };
        assert_eq!(*window, 1);
        assert_eq!(removed, &Vec::new());
        assert_eq!(
            added,
            &vec![
                PaneBinding { pane: 0, logical_id: "s-p0".into() },
                PaneBinding { pane: 1, logical_id: "s-p1".into() },
            ]
        );
    }

    /// Un split añade SOLO la pane nueva; cerrarla la quita y conserva el
    /// resto (los layouts son capturas reales de tmux 3.7b).
    #[test]
    fn split_y_cierre_hacen_el_diff_minimo() {
        let mut manager = TmuxManager::new("s");
        manager.apply(ClientEvent::Notification(ControlEvent::LayoutChange {
            window: 0,
            layout: "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}".into(),
            visible_layout: None,
            flags: None,
        }));
        // split-window -v sobre la pane derecha → aparece %2.
        let updates = manager.apply(ClientEvent::Notification(ControlEvent::LayoutChange {
            window: 0,
            layout: "d67e,80x24,0,0{40x24,0,0,0,39x24,41,0[39x12,41,0,1,39x11,41,13,2]}".into(),
            visible_layout: None,
            flags: None,
        }));
        let ModelUpdate::LayoutChanged { added, removed, .. } = &updates[0] else {
            panic!("esperaba LayoutChanged");
        };
        assert_eq!(added, &vec![PaneBinding { pane: 2, logical_id: "s-p2".into() }]);
        assert!(removed.is_empty());

        // kill-pane de %2 → vuelve el layout de dos panes.
        let updates = manager.apply(ClientEvent::Notification(ControlEvent::LayoutChange {
            window: 0,
            layout: "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}".into(),
            visible_layout: None,
            flags: None,
        }));
        let ModelUpdate::LayoutChanged { added, removed, .. } = &updates[0] else {
            panic!("esperaba LayoutChanged");
        };
        assert!(added.is_empty());
        assert_eq!(removed, &vec![PaneBinding { pane: 2, logical_id: "s-p2".into() }]);
        assert_eq!(manager.logical_id(2), None);
    }

    /// `%output` de una pane aún sin ventana la registra (id determinista) y
    /// el primer layout la adopta sin cambiar su sesión lógica.
    #[test]
    fn output_temprano_registra_y_el_layout_adopta() {
        let mut manager = TmuxManager::new("s");
        let updates = manager.apply(ClientEvent::Notification(ControlEvent::Output {
            pane: 0,
            bytes: b"hola".to_vec(),
        }));
        assert_eq!(
            updates,
            vec![ModelUpdate::Output {
                pane: PaneBinding { pane: 0, logical_id: "s-p0".into() },
                bytes: b"hola".to_vec(),
            }]
        );
        let updates = manager.apply(ClientEvent::Notification(ControlEvent::LayoutChange {
            window: 0,
            layout: "b25d,80x24,0,0,0".into(),
            visible_layout: None,
            flags: None,
        }));
        let ModelUpdate::LayoutChanged { added, .. } = &updates[0] else {
            panic!("esperaba LayoutChanged");
        };
        // La adopción conserva el id lógico ya usado por el output temprano.
        assert_eq!(added, &vec![PaneBinding { pane: 0, logical_id: "s-p0".into() }]);
    }

    #[test]
    fn cerrar_ventana_retira_sus_panes() {
        let mut manager = TmuxManager::new("s");
        manager.apply(ClientEvent::Notification(ControlEvent::LayoutChange {
            window: 3,
            layout: "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}".into(),
            visible_layout: None,
            flags: None,
        }));
        let updates = manager.apply(ClientEvent::Notification(ControlEvent::WindowClose {
            window: 3,
        }));
        assert_eq!(
            updates,
            vec![ModelUpdate::WindowClosed {
                window: 3,
                removed_panes: vec![
                    PaneBinding { pane: 0, logical_id: "s-p0".into() },
                    PaneBinding { pane: 1, logical_id: "s-p1".into() },
                ],
            }]
        );
        assert_eq!(manager.windows().count(), 0);
    }

    #[test]
    fn layout_corrupto_es_warning_no_panico() {
        let mut manager = TmuxManager::new("s");
        let updates = manager.apply(ClientEvent::Notification(ControlEvent::LayoutChange {
            window: 0,
            layout: "0000,80x24,0,0,0".into(),
            visible_layout: None,
            flags: None,
        }));
        assert!(
            matches!(&updates[0], ModelUpdate::Warning { message } if message.contains("@0")),
            "{updates:?}"
        );
    }

    #[test]
    fn shutdown_y_command_done_pasan_digeridos() {
        let mut manager = TmuxManager::new("s");
        assert_eq!(
            manager.apply(ClientEvent::CommandDone {
                tag: 4,
                success: true,
                output: "x\n".into(),
            }),
            vec![ModelUpdate::CommandDone {
                tag: 4,
                success: true,
                output: "x\n".into(),
            }]
        );
        assert_eq!(
            manager.apply(ClientEvent::Shutdown(ShutdownReason::Exit(None))),
            vec![ModelUpdate::Ended {
                reason: ShutdownReason::Exit(None),
            }]
        );
    }
}
