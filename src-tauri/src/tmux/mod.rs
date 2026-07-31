//! Modo control de tmux (`tmux -CC`) — Fase 1: módulos **puros**, sin E/S.
//!
//! Aquí vive el protocolo, no el transporte: el canal SSH que alimenta estos
//! parsers lo abre `ssh_manager`, y la máquina de estados del cliente
//! (correlación de respuestas, ciclo de vida DCS/`%exit`) llegará en
//! `client.rs` (F1.3). Todo lo de este árbol se prueba con capturas reales
//! de tmux, sin servidor.

pub mod layout;
pub mod protocol;
