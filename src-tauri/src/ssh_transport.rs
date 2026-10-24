//! Transporte SSH común: abre el `client::Handle` de un perfil, directo o a
//! través de su bastión `ProxyJump` (bastión → canal `direct-tcpip` →
//! handshake del destino sobre ese canal).
//!
//! El salto estaba copiado en cuatro sitios (prueba de conexión y sesión de
//! `ssh_manager`, `scripts/runner.rs` y `cli::connect_handle`) y el panel SFTP
//! ni siquiera lo tenía: conectaba directo a `host:puerto`, así que con un
//! servidor detrás de un bastión el terminal entraba y el panel fallaba (o
//! intentaba salir hacia una IP privada). [`connect_profile_handle`] es el
//! camino único; hoy lo usa el panel SFTP y los otros cuatro pueden migrar a él
//! sin cambiar de comportamiento.
//!
//! Lo que decide quien llama, y por eso entra por parámetro:
//!
//! - La `client::Config`, que vale **para los dos saltos**: el panel SFTP lleva
//!   su ventana grande y el rekey por bytes desactivado, la sesión su keepalive
//!   propio, y los algoritmos heredados del perfil (`preferred`) se negocian
//!   también con el bastión, como hace el terminal.
//! - El verificador de host key de cada salto ([`Hop`]): el destino puede llevar
//!   agent forwarding, X11, túneles remotos o la huella fijada por
//!   `--host-key`; el bastión se verifica contra known_hosts, con las mismas
//!   preguntas (clave desconocida o cambiada) que cualquier otra conexión.
//! - El registro de etapas ([`JumpStage`]), que cada llamador pinta en su log.
//!
//! El bastión se autentica con las credenciales del propio perfil (mismo
//! método, contraseña, clave y passphrase) y con el usuario del spec
//! `[user@]host[:port]`, o el del perfil si no lo trae: lo mismo que hacen los
//! otros cuatro caminos. Separarlas es otra tarea.

use std::sync::{Arc, Mutex};

use russh::client::{self, AuthResult};

use crate::host_keys::{self, KnownHostsClient};
use crate::profiles::ConnectionProfile;
use crate::ssh_manager::{authenticate_handle, parse_jump_spec, russh_connect_addr};

/// Salto de una conexión: el bastión `ProxyJump` o el servidor de destino.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hop {
    Bastion,
    Target,
}

/// Verificador de host key de un salto y la ranura donde deja el motivo de un
/// rechazo: lo que devuelven `host_keys::client` y compañía.
pub(crate) type HostKeyCheck = (KnownHostsClient, Arc<Mutex<Option<String>>>);

/// Etapas del salto por el bastión, para el registro de quien conecta. La
/// conexión directa no pasa por ninguna: el llamador ya anuncia la suya.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JumpStage<'a> {
    /// Conectando al bastión (TCP, handshake y verificación de su host key).
    Connecting { addr: &'a str },
    /// Bastión conectado, con su host key verificada.
    Connected { addr: &'a str },
    /// Autenticando en el bastión con este usuario.
    Authenticating { user: &'a str },
    /// El bastión aceptó la autenticación.
    Authenticated,
    /// Abriendo el canal `direct-tcpip` del bastión hacia el destino.
    OpeningTunnel { target: &'a str },
}

/// Qué falló al abrir la conexión.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectFailure {
    /// Host key rechazada o sin confirmar. El mensaje es el de `host_keys` tal
    /// cual, con su marcador (`hostkey-…:`) al principio: no se le antepone
    /// nada para que `IpcError::classify` lo siga reconociendo.
    HostKey,
    /// No se llegó al servidor o falló el handshake SSH.
    Transport,
    /// El bastión rechazó la autenticación (o no se pudo intentar).
    Auth,
    /// El bastión no abrió el canal `direct-tcpip` hacia el destino.
    Tunnel,
}

/// Error de [`connect_profile_handle`]: en qué salto, qué falló y el mensaje
/// para el usuario.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConnectError {
    pub hop: Hop,
    pub failure: ConnectFailure,
    pub message: String,
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Spec `ProxyJump` del perfil, si tiene uno. Vacío o en blanco equivale a no
/// tenerlo: conexión directa.
pub(crate) fn jump_spec(profile: &ConnectionProfile) -> Option<&str> {
    profile
        .proxy_jump
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Error de conexión de un salto: si el verificador de host key dejó un motivo,
/// es un rechazo de host key y su mensaje manda; si no, fue el transporte.
fn hop_error(hop: Hop, failure: &Arc<Mutex<Option<String>>>, transport: String) -> ConnectError {
    match host_keys::take_failure(failure) {
        Some(reason) => ConnectError {
            hop,
            failure: ConnectFailure::HostKey,
            message: reason,
        },
        None => ConnectError {
            hop,
            failure: ConnectFailure::Transport,
            message: transport,
        },
    }
}

/// Abre la conexión SSH del perfil (sin autenticar el destino): directa, o a
/// través del bastión de `profile.proxy_jump` si lo tiene.
///
/// `host_key_check` construye el verificador de cada salto a partir de su host
/// y puerto. Con bastión se llama dos veces —primero el bastión, después el
/// destino—, así que las preguntas de host key (desconocida o cambiada) salen
/// para cada servidor en su orden. `on_stage` recibe las etapas del salto.
///
/// El handle del bastión no se guarda: el canal `direct-tcpip` que transporta
/// al destino mantiene viva su sesión, y al cerrarse el destino se cierra con
/// él.
pub(crate) async fn connect_profile_handle(
    profile: &ConnectionProfile,
    config: Arc<client::Config>,
    password: Option<&str>,
    passphrase: Option<&str>,
    host_key_check: &dyn Fn(Hop, &str, u16) -> HostKeyCheck,
    on_stage: &dyn Fn(JumpStage<'_>),
) -> Result<client::Handle<KnownHostsClient>, ConnectError> {
    let addr = format!("{}:{}", profile.host, profile.port);
    let Some(spec) = jump_spec(profile) else {
        let (handler, failure) = host_key_check(Hop::Target, &profile.host, profile.port);
        return russh_connect_addr(config, &addr, handler)
            .await
            .map_err(|err| {
                hop_error(
                    Hop::Target,
                    &failure,
                    format!("No se puede conectar a {addr}: {err}"),
                )
            });
    };

    let (b_user, b_host, b_port) = parse_jump_spec(spec, &profile.username);
    let bastion_addr = format!("{b_host}:{b_port}");
    on_stage(JumpStage::Connecting {
        addr: &bastion_addr,
    });
    let (b_handler, b_failure) = host_key_check(Hop::Bastion, &b_host, b_port);
    let mut bastion = russh_connect_addr(config.clone(), &bastion_addr, b_handler)
        .await
        .map_err(|err| {
            hop_error(
                Hop::Bastion,
                &b_failure,
                format!("No se puede conectar al bastión {bastion_addr}: {err}"),
            )
        })?;
    on_stage(JumpStage::Connected {
        addr: &bastion_addr,
    });

    on_stage(JumpStage::Authenticating { user: &b_user });
    let bastion_auth_error = |message: String| ConnectError {
        hop: Hop::Bastion,
        failure: ConnectFailure::Auth,
        message,
    };
    let password = password.map(str::to_string);
    let passphrase = passphrase.map(str::to_string);
    let auth = authenticate_handle(
        &mut bastion,
        &profile.auth_type,
        &b_user,
        &b_host,
        password.as_ref(),
        passphrase.as_ref(),
        profile.key_path.as_deref(),
    )
    .await
    .map_err(|e| bastion_auth_error(format!("Bastión: {e}")))?;
    if let AuthResult::Failure {
        remaining_methods, ..
    } = auth
    {
        return Err(bastion_auth_error(format!(
            "Autenticación contra el bastión fallida. Métodos restantes: {remaining_methods:?}"
        )));
    }
    on_stage(JumpStage::Authenticated);

    on_stage(JumpStage::OpeningTunnel { target: &addr });
    let channel = bastion
        .channel_open_direct_tcpip(
            profile.host.clone(),
            profile.port as u32,
            "127.0.0.1".to_string(),
            0,
        )
        .await
        .map_err(|e| ConnectError {
            hop: Hop::Bastion,
            failure: ConnectFailure::Tunnel,
            message: format!(
                "No se pudo abrir el canal direct-tcpip hacia {addr} a través del bastión: {e}"
            ),
        })?;
    let (handler, failure) = host_key_check(Hop::Target, &profile.host, profile.port);
    client::connect_stream(config, channel.into_stream(), handler)
        .await
        .map_err(|err| {
            hop_error(
                Hop::Target,
                &failure,
                format!("No se puede establecer SSH con {addr} a través del bastión: {err}"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_with_jump(proxy_jump: Option<&str>) -> ConnectionProfile {
        let json = r#"{
            "id": "t",
            "name": "t",
            "host": "10.0.0.5",
            "port": 22,
            "username": "ana",
            "connection_type": "ssh",
            "domain": null,
            "auth_type": "password",
            "key_path": null,
            "group": null,
            "created_at": "2026-05-08T12:00:00Z"
        }"#;
        let mut profile: ConnectionProfile = serde_json::from_str(json).expect("perfil válido");
        profile.proxy_jump = proxy_jump.map(str::to_string);
        profile
    }

    #[test]
    fn jump_spec_vacio_o_en_blanco_es_conexion_directa() {
        assert_eq!(jump_spec(&profile_with_jump(None)), None);
        assert_eq!(jump_spec(&profile_with_jump(Some(""))), None);
        assert_eq!(jump_spec(&profile_with_jump(Some("   "))), None);
        assert_eq!(
            jump_spec(&profile_with_jump(Some("  ops@bastion:2222 "))),
            Some("ops@bastion:2222")
        );
    }

    #[test]
    fn el_motivo_de_host_key_manda_sobre_el_error_de_transporte() {
        // Con motivo: rechazo de host key, y el mensaje va tal cual, con su
        // marcador al principio (la clasificación IPC lo busca ahí).
        let failure = Arc::new(Mutex::new(Some(format!(
            "{}la clave cambió",
            crate::ipc_error::HOSTKEY_CHANGED_MARKER
        ))));
        let err = hop_error(Hop::Bastion, &failure, "TCP caído".to_string());
        assert_eq!(err.hop, Hop::Bastion);
        assert_eq!(err.failure, ConnectFailure::HostKey);
        assert!(err
            .message
            .starts_with(crate::ipc_error::HOSTKEY_CHANGED_MARKER));

        // Sin motivo: fue el transporte.
        let empty = Arc::new(Mutex::new(None));
        let err = hop_error(Hop::Target, &empty, "TCP caído".to_string());
        assert_eq!(err.failure, ConnectFailure::Transport);
        assert_eq!(err.to_string(), "TCP caído");
    }
}
