//! Errores **estructurados** de la frontera IPC.
//!
//! Hasta ahora todo comando devolvía `Result<T, String>`: el frontend recibía
//! una frase en el idioma del backend y, para reaccionar de forma distinta a
//! «contraseña incorrecta» y «el servidor no responde», no le quedaba más que
//! buscar subcadenas. Eso es frágil por los dos lados —una frase se reescribe
//! sin querer y el `if` deja de disparar, sin que el compilador diga nada—.
//!
//! `IpcError` añade un **discriminante estable** (`kind`) junto al mensaje.
//! Reglas del contrato:
//!
//! 1. El `kind` es la parte estable; el `message` es humano y puede cambiar.
//! 2. La clasificación se hace **aquí**, una vez, a partir de la variante de
//!    [`AppError`] y de los marcadores internos que ya usan `sync.rs` y
//!    `host_keys.rs`. Ningún consumidor vuelve a inspeccionar el texto.
//! 3. Los marcadores internos (`hostkey-changed:`…) se **retiran** del mensaje
//!    al clasificar: son para el código, no para el usuario. Los de sync se
//!    conservan porque `src/sync.js` los sigue leyendo (contrato espejado).
//! 4. La lista de `kind` está espejada en `src/modules/ipc/errors.js`, con un
//!    test de paridad a cada lado: **añadir uno obliga a tocar los dos**.

use crate::error::AppError;
use serde::Serialize;

/// Marcador interno: la host key es desconocida y se rechazó la conexión.
pub const HOSTKEY_UNKNOWN_MARKER: &str = "hostkey-unknown:";
/// Marcador interno: la host key registrada **cambió** y se rechazó.
pub const HOSTKEY_CHANGED_MARKER: &str = "hostkey-changed:";

/// Discriminante estable de un fallo en la frontera IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IpcErrorKind {
    /// Credenciales rechazadas por el servidor (usuario, clave, MFA).
    AuthFailed,
    /// Host key desconocida y no confirmada: no se conectó.
    HostKeyUnknown,
    /// La host key registrada cambió y se rechazó. Puede ser un ataque.
    HostKeyMismatch,
    /// No hay ruta hasta el servidor (rechazo TCP, red caída, DNS).
    NetworkUnreachable,
    /// Se agotó el plazo esperando al servidor.
    Timeout,
    /// El sistema operativo denegó la operación (permisos, fichero, keyring).
    PermissionDenied,
    /// El estado remoto cambió durante la sincronización (412 de If-Match).
    Conflict,
    /// La passphrase de sincronización no descifra el blob remoto.
    BadPassphrase,
    /// Sin conectividad con el backend de sincronización.
    Offline,
    /// El recurso pedido no existe (perfil, sesión, fichero).
    NotFound,
    /// El otro extremo no habla lo que esperábamos (protocolo, formato).
    Protocol,
    /// Cualquier otra cosa. El frontend cae al mensaje.
    Internal,
}

/// Error de la frontera IPC: discriminante estable + mensaje humano.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IpcError {
    pub kind: IpcErrorKind,
    pub message: String,
}

impl IpcError {
    pub fn new(kind: IpcErrorKind, message: impl Into<String>) -> Self {
        IpcError {
            kind,
            message: message.into(),
        }
    }

    /// Clasifica un mensaje ya formateado. Se usa cuando el origen del fallo
    /// perdió el tipo por el camino (`map_err(|e| e.to_string())`).
    pub fn classify(message: impl Into<String>) -> Self {
        let message = message.into();
        if let Some(rest) = message.strip_prefix(HOSTKEY_CHANGED_MARKER) {
            return IpcError::new(IpcErrorKind::HostKeyMismatch, rest.trim_start());
        }
        if let Some(rest) = message.strip_prefix(HOSTKEY_UNKNOWN_MARKER) {
            return IpcError::new(IpcErrorKind::HostKeyUnknown, rest.trim_start());
        }
        // Los marcadores de sync SÍ se conservan en el mensaje: `src/sync.js`
        // los sigue leyendo y retirarlos rompería su clasificación.
        if message.contains(crate::sync::CONFLICT_MARKER) {
            return IpcError::new(IpcErrorKind::Conflict, message);
        }
        if message.contains(crate::sync::BAD_PASSPHRASE_MARKER) {
            return IpcError::new(IpcErrorKind::BadPassphrase, message);
        }
        if message.contains(crate::sync::OFFLINE_MARKER) {
            return IpcError::new(IpcErrorKind::Offline, message);
        }
        IpcError::new(IpcErrorKind::Internal, message)
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<AppError> for IpcError {
    fn from(err: AppError) -> Self {
        // La variante manda; dentro de ella, el marcador afina. Un `AppError`
        // que no aporta más que texto pasa por `classify`, que es donde vive
        // todo el conocimiento sobre marcadores.
        match err {
            AppError::Auth(msg) => match IpcError::classify(msg) {
                // Un fallo de host key llega como Auth desde `ssh_manager`:
                // conserva su clasificación fina en vez de degradarla.
                classified if classified.kind != IpcErrorKind::Internal => classified,
                classified => IpcError::new(IpcErrorKind::AuthFailed, classified.message),
            },
            AppError::SessionNotFound(msg) => IpcError::new(
                IpcErrorKind::NotFound,
                format!("Sesión no encontrada: {msg}"),
            ),
            AppError::Serialization(msg) => IpcError::new(
                IpcErrorKind::Protocol,
                format!("Error de serialización: {msg}"),
            ),
            AppError::Store(msg) => IpcError::new(IpcErrorKind::Protocol, msg),
            AppError::Io(msg) => {
                let kind = if msg.contains("permission denied")
                    || msg.contains("Permission denied")
                    || msg.contains("Acceso denegado")
                {
                    IpcErrorKind::PermissionDenied
                } else if msg.contains("timed out") || msg.contains("timeout") {
                    IpcErrorKind::Timeout
                } else if msg.contains("refused")
                    || msg.contains("unreachable")
                    || msg.contains("No such host")
                    || msg.contains("failed to lookup address")
                {
                    IpcErrorKind::NetworkUnreachable
                } else {
                    IpcErrorKind::Internal
                };
                IpcError::new(kind, format!("Error de E/S: {msg}"))
            }
            other => IpcError::classify(other.to_string()),
        }
    }
}

impl From<String> for IpcError {
    fn from(message: String) -> Self {
        IpcError::classify(message)
    }
}

impl From<&str> for IpcError {
    fn from(message: &str) -> Self {
        IpcError::classify(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn los_marcadores_de_host_key_clasifican_y_desaparecen_del_mensaje() {
        let err = IpcError::classify(format!("{HOSTKEY_CHANGED_MARKER} ALERTA: la clave cambió"));
        assert_eq!(err.kind, IpcErrorKind::HostKeyMismatch);
        assert_eq!(err.message, "ALERTA: la clave cambió");
        assert!(!err.message.contains("hostkey-"), "el marcador es interno");

        let err = IpcError::classify(format!("{HOSTKEY_UNKNOWN_MARKER} clave sin confirmar"));
        assert_eq!(err.kind, IpcErrorKind::HostKeyUnknown);
        assert_eq!(err.message, "clave sin confirmar");
    }

    #[test]
    fn los_marcadores_de_sync_clasifican_pero_se_conservan() {
        // `src/sync.js` los sigue leyendo del texto: retirarlos rompería su
        // clasificación (estado offline silencioso, passphrase incorrecta).
        for (marker, kind) in [
            (crate::sync::OFFLINE_MARKER, IpcErrorKind::Offline),
            (crate::sync::BAD_PASSPHRASE_MARKER, IpcErrorKind::BadPassphrase),
            (crate::sync::CONFLICT_MARKER, IpcErrorKind::Conflict),
        ] {
            let err = IpcError::classify(format!("{marker} detalle"));
            assert_eq!(err.kind, kind, "marcador {marker}");
            assert!(err.message.contains(marker), "marcador {marker} conservado");
        }
    }

    #[test]
    fn una_autenticacion_fallida_se_distingue_de_una_host_key() {
        let auth = IpcError::from(AppError::Auth("Autenticación fallida".into()));
        assert_eq!(auth.kind, IpcErrorKind::AuthFailed);

        // El fallo de host key viaja dentro de un AppError::Auth: no debe
        // degradarse a «credenciales incorrectas», que llevaría al usuario a
        // reescribir su contraseña ante lo que puede ser un ataque.
        let hostkey = IpcError::from(AppError::Auth(format!(
            "{HOSTKEY_CHANGED_MARKER} la clave de srv:22 cambió"
        )));
        assert_eq!(hostkey.kind, IpcErrorKind::HostKeyMismatch);
        assert!(!hostkey.message.starts_with(HOSTKEY_CHANGED_MARKER));
    }

    #[test]
    fn los_errores_de_e_s_se_afinan_por_su_causa() {
        let cases = [
            ("Connection refused (os error 111)", IpcErrorKind::NetworkUnreachable),
            ("failed to lookup address information", IpcErrorKind::NetworkUnreachable),
            ("operation timed out", IpcErrorKind::Timeout),
            ("Permission denied (os error 13)", IpcErrorKind::PermissionDenied),
            ("disco lleno", IpcErrorKind::Internal),
        ];
        for (msg, expected) in cases {
            assert_eq!(IpcError::from(AppError::Io(msg.into())).kind, expected, "{msg}");
        }
    }

    #[test]
    fn el_json_lleva_kind_en_camel_case_y_el_mensaje() {
        let json = serde_json::to_string(&IpcError::new(
            IpcErrorKind::HostKeyMismatch,
            "la clave cambió",
        ))
        .expect("serializa");
        assert_eq!(json, r#"{"kind":"hostKeyMismatch","message":"la clave cambió"}"#);
    }

    #[test]
    fn display_devuelve_solo_el_mensaje() {
        // Los `format!("{e}")` que ya existen no deben empezar a imprimir
        // estructura: lo que el usuario ve sigue siendo la frase.
        let err = IpcError::new(IpcErrorKind::Timeout, "el servidor no responde");
        assert_eq!(err.to_string(), "el servidor no responde");
    }

    #[test]
    fn un_error_sin_pistas_cae_a_internal() {
        let err = IpcError::classify("algo raro pasó");
        assert_eq!(err.kind, IpcErrorKind::Internal);
        assert_eq!(err.message, "algo raro pasó");
    }
}
