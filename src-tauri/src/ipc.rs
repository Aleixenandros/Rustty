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
    /// `ssh-error-{sessionId}` — error con mensaje.
    SshError,
    /// `ssh-closed-{sessionId}` — sesión SSH cerrada.
    SshClosed,
    /// `ssh-reconnecting-{sessionId}` — intento de reconexión con backoff.
    SshReconnecting,
    /// `ssh-tunnel-traffic-{sessionId}` — tráfico acumulado por túnel.
    SshTunnelTraffic,
    /// `shell-closed-{sessionId}` — consola local cerrada.
    ShellClosed,
    /// `sftp-log-{sessionId}` — etapa de conexión SFTP/FTP.
    SftpLog,
    /// `sftp-progress-{transferId}` — progreso de una transferencia.
    SftpProgress,
    /// `rdp-closed-{sessionId}` — proceso RDP externo terminado.
    RdpClosed,
    /// `vnc-closed-{sessionId}` — visor VNC externo terminado.
    VncClosed,
    /// `telnet-closed-{sessionId}` — cliente Telnet externo terminado.
    TelnetClosed,
    /// `script-progress-{runId}` — avance de un host durante la ejecución de un
    /// script (fase + índice de paso). Sufijo: `runId`.
    ScriptProgress,
    /// `script-output-{runId}` — líneas de salida capturadas de un host (sin
    /// secretos). Sufijo: `runId`.
    ScriptOutput,
    /// `script-host-done-{runId}` — un host terminó el script correctamente.
    /// Sufijo: `runId`.
    ScriptHostDone,
    /// `script-host-error-{runId}` — un host abortó el script con error.
    /// Sufijo: `runId`.
    ScriptHostError,
    /// `script-done-{runId}` — el run completo terminó (agregado ok/error/total).
    /// Sufijo: `runId`.
    ScriptDone,
}

impl EventKind {
    /// Prefijo estable del evento; el nombre completo se forma anteponiéndolo al
    /// sufijo (`sessionId` / `transferId`).
    #[must_use]
    pub const fn prefix(self) -> &'static str {
        match self {
            EventKind::SshLog => "ssh-log-",
            EventKind::SshConnected => "ssh-connected-",
            EventKind::SshError => "ssh-error-",
            EventKind::SshClosed => "ssh-closed-",
            EventKind::SshReconnecting => "ssh-reconnecting-",
            EventKind::SshTunnelTraffic => "ssh-tunnel-traffic-",
            EventKind::ShellClosed => "shell-closed-",
            EventKind::SftpLog => "sftp-log-",
            EventKind::SftpProgress => "sftp-progress-",
            EventKind::RdpClosed => "rdp-closed-",
            EventKind::VncClosed => "vnc-closed-",
            EventKind::TelnetClosed => "telnet-closed-",
            EventKind::ScriptProgress => "script-progress-",
            EventKind::ScriptOutput => "script-output-",
            EventKind::ScriptHostDone => "script-host-done-",
            EventKind::ScriptHostError => "script-host-error-",
            EventKind::ScriptDone => "script-done-",
        }
    }
}

/// Nombre completo de un evento por sesión/transferencia: `prefijo + sufijo`.
///
/// ```ignore
/// let _ = app.emit(&event_name(EventKind::SshConnected, &session_id), &name);
/// ```
#[must_use]
pub fn event_name(kind: EventKind, suffix: &str) -> String {
    format!("{}{suffix}", kind.prefix())
}

/// Evento global (sin sufijo) de acciones de la bandeja del sistema.
///
/// Payload: `{ action: string, ... }` (campos adicionales según la acción).
pub const TRAY_ACTION: &str = "tray-action";

/// Evento global (sin sufijo): el servidor presenta una host key **desconocida**
/// y el modo estricto de primera conexión exige confirmación del usuario.
///
/// Es global y no por sesión porque la política es global (una preferencia) y el
/// handler TOFU (`host_keys`) no conoce el `sessionId`: lo construyen catorce
/// llamadores distintos (SSH, SFTP, scripts, CLI, saltos ProxyJump). La respuesta
/// vuelve por el comando `ssh_hostkey_response` con el `promptId` del payload.
///
/// Payload: `{ promptId, host, port, fingerprint, keyType, viaJump }`.
pub const HOST_KEY_PROMPT: &str = "ssh-hostkey-prompt";

/// Evento global (sin sufijo): un servidor **FTPS** presenta un certificado TLS
/// **desconocido** (típicamente autofirmado de un NAS/servidor interno) y el modo
/// estricto exige confirmar su huella antes de guardarla (TOFU, mismo patrón que
/// las host keys SSH). La respuesta vuelve por el comando `ftps_cert_response`
/// con el `promptId` del payload.
///
/// Payload: `{ promptId, host, port, fingerprint }`.
pub const FTPS_CERT_PROMPT: &str = "ftps-cert-prompt";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_name_concatena_prefijo_y_sufijo() {
        assert_eq!(
            event_name(EventKind::SshConnected, "abc"),
            "ssh-connected-abc"
        );
        assert_eq!(
            event_name(EventKind::SftpProgress, "t-1"),
            "sftp-progress-t-1"
        );
        assert_eq!(
            event_name(EventKind::SshTunnelTraffic, "s9"),
            "ssh-tunnel-traffic-s9"
        );
        assert_eq!(
            event_name(EventKind::ScriptProgress, "run-1"),
            "script-progress-run-1"
        );
        assert_eq!(
            event_name(EventKind::ScriptHostError, "run-1"),
            "script-host-error-run-1"
        );
    }

    #[test]
    fn prefijos_estables_terminan_en_guion() {
        for kind in [
            EventKind::SshLog,
            EventKind::SshConnected,
            EventKind::SshError,
            EventKind::SshClosed,
            EventKind::SshReconnecting,
            EventKind::SshTunnelTraffic,
            EventKind::ShellClosed,
            EventKind::SftpLog,
            EventKind::SftpProgress,
            EventKind::RdpClosed,
            EventKind::VncClosed,
            EventKind::TelnetClosed,
            EventKind::ScriptProgress,
            EventKind::ScriptOutput,
            EventKind::ScriptHostDone,
            EventKind::ScriptHostError,
            EventKind::ScriptDone,
        ] {
            assert!(kind.prefix().ends_with('-'), "{kind:?} sin guion final");
        }
    }
}
