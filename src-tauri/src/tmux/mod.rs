//! Modo control de tmux (`tmux -CC`) — Fase 1: módulos **puros**, sin E/S.
//!
//! Aquí vive el protocolo, no el transporte: el canal SSH que alimenta estos
//! parsers lo abre `ssh_manager`. `protocol.rs` entiende las líneas,
//! `layout.rs` los layout strings, `client.rs` correla respuestas con
//! comandos y custodia el cierre (tras `%exit`/desync no se escribe más), y
//! `manager.rs` mantiene el modelo pane ↔ sesión lógica / ventana ↔ pestaña.
//! Todo lo de este árbol se prueba con capturas reales de tmux, sin servidor.

pub mod client;
pub mod layout;
pub mod manager;
pub mod protocol;
