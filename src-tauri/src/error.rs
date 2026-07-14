use thiserror::Error;

/// Errores centralizados de la aplicación.
/// Implementan Display para poder convertirlos a String
/// y pasarlos al frontend a través de los comandos Tauri.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("Error SSH: {0}")]
    Ssh(String),

    #[error("Error de E/S: {0}")]
    Io(String),

    #[error("Sesión no encontrada: {0}")]
    SessionNotFound(String),

    #[error("Error de serialización: {0}")]
    Serialization(String),

    #[error("Error de autenticación: {0}")]
    Auth(String),

    #[error("Error de sincronización: {0}")]
    Sync(String),

    /// El almacén local (perfiles, credenciales, scripts) existe y parsea, pero
    /// esta build no sabe leerlo: normalmente porque lo escribió una versión más
    /// reciente de Rustty. Es un error deliberado y **no** una corrupción: hay que
    /// parar y decirlo, nunca sobrescribir datos que no entendemos.
    #[error("{0}")]
    Store(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Serialization(e.to_string())
    }
}
