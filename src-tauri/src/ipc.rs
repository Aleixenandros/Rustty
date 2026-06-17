//! Contrato de nombres de eventos IPC (backend ⇄ frontend).
//!
//! Fuente única de verdad para los nombres de los eventos Tauri que el backend
//! emite hacia el frontend. Casi todos los eventos van dirigidos a una sesión o
//! transferencia concreta y su nombre es `prefijo + sufijo`, donde el sufijo es
//! el `sessionId` / `transferId`. Centralizar el prefijo aquí evita los strings
//! mágicos repartidos por `ssh_manager`, `sftp_manager`, etc. y mantiene el
//! contrato alineado con `src/modules/ipc/events.js` (mismo catálogo).

/// Familia de eventos dirigidos a una sesión o transferencia (`prefijo + sufijo`).
///
/// El sufijo es el identificador de sesión (`sessionId`) o de transferencia
/// (`transferId`) según el evento. Para construir el nombre completo se usa
/// [`event_name`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    /// `ssh-log-{sessionId}` — etapa de diagnóstico de la conexión SSH.
    SshLog,
    /// `ssh-connected-{sessionId}` — autenticación SSH correcta.
    SshConnected,
    /// `ssh-data-{sessionId}` — bytes recibidos del servidor (caliente).
    SshData,
    /// `ssh-error-{sessionId}` — error con mensaje.
    SshError,
    /// `ssh-closed-{sessionId}` — sesión SSH cerrada.
    SshClosed,
    /// `ssh-reconnecting-{sessionId}` — intento de reconexión con backoff.
    SshReconnecting,
    /// `ssh-tunnel-traffic-{sessionId}` — tráfico acumulado por túnel.
    SshTunnelTraffic,
    /// `shell-data-{sessionId}` — bytes de la consola local (caliente).
    ShellData,
    /// `shell-closed-{sessionId}` — consola local cerrada.
    ShellClosed,
    /// `sftp-log-{sessionId}` — etapa de conexión SFTP/FTP.
    SftpLog,
    /// `sftp-progress-{transferId}` — progreso de una transferencia.
    SftpProgress,
    /// `rdp-closed-{sessionId}` — proceso RDP externo terminado.
    RdpClosed,
}

impl EventKind {
    /// Prefijo estable del evento; el nombre completo se forma anteponiéndolo al
    /// sufijo (`sessionId` / `transferId`).
    #[must_use]
    pub const fn prefix(self) -> &'static str {
        match self {
            EventKind::SshLog => "ssh-log-",
            EventKind::SshConnected => "ssh-connected-",
            EventKind::SshData => "ssh-data-",
            EventKind::SshError => "ssh-error-",
            EventKind::SshClosed => "ssh-closed-",
            EventKind::SshReconnecting => "ssh-reconnecting-",
            EventKind::SshTunnelTraffic => "ssh-tunnel-traffic-",
            EventKind::ShellData => "shell-data-",
            EventKind::ShellClosed => "shell-closed-",
            EventKind::SftpLog => "sftp-log-",
            EventKind::SftpProgress => "sftp-progress-",
            EventKind::RdpClosed => "rdp-closed-",
        }
    }
}

/// Nombre completo de un evento por sesión/transferencia: `prefijo + sufijo`.
///
/// ```ignore
/// let _ = app.emit(&event_name(EventKind::SshData, &session_id), bytes);
/// ```
#[must_use]
pub fn event_name(kind: EventKind, suffix: &str) -> String {
    format!("{}{suffix}", kind.prefix())
}

/// Evento global (sin sufijo) de acciones de la bandeja del sistema.
///
/// Payload: `{ action: string, ... }` (campos adicionales según la acción).
pub const TRAY_ACTION: &str = "tray-action";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_name_concatena_prefijo_y_sufijo() {
        assert_eq!(event_name(EventKind::SshData, "abc"), "ssh-data-abc");
        assert_eq!(
            event_name(EventKind::SftpProgress, "t-1"),
            "sftp-progress-t-1"
        );
        assert_eq!(
            event_name(EventKind::SshTunnelTraffic, "s9"),
            "ssh-tunnel-traffic-s9"
        );
    }

    #[test]
    fn prefijos_estables_terminan_en_guion() {
        for kind in [
            EventKind::SshLog,
            EventKind::SshConnected,
            EventKind::SshData,
            EventKind::SshError,
            EventKind::SshClosed,
            EventKind::SshReconnecting,
            EventKind::SshTunnelTraffic,
            EventKind::ShellData,
            EventKind::ShellClosed,
            EventKind::SftpLog,
            EventKind::SftpProgress,
            EventKind::RdpClosed,
        ] {
            assert!(kind.prefix().ends_with('-'), "{kind:?} sin guion final");
        }
    }
}
