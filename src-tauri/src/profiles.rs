use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::error::AppError;

/// Tipo de autenticación SSH soportado
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    /// Autenticación por contraseña
    Password,
    /// Autenticación por clave pública/privada
    PublicKey,
    /// Autenticación delegada al agente SSH del sistema
    Agent,
}

fn default_conn_type() -> String {
    "ssh".to_string()
}

fn default_true() -> bool {
    true
}

/// Perfil de conexión guardado por el usuario.
/// Soporta SSH y RDP. No almacena contraseñas en texto plano; usa keyring.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    /// UUID único del perfil
    pub id: String,
    /// Nombre descriptivo visible en la UI
    pub name: String,
    /// Hostname o IP del servidor remoto
    pub host: String,
    /// Puerto (SSH: 22, RDP: 3389 por defecto)
    pub port: u16,
    /// Nombre de usuario
    pub username: String,
    /// Tipo de conexión: "ssh" | "rdp"  (default "ssh" para compatibilidad)
    #[serde(default = "default_conn_type")]
    pub connection_type: String,
    /// Dominio Windows (solo RDP)
    pub domain: Option<String>,
    /// Método de autenticación (SSH)
    pub auth_type: AuthType,
    /// Ruta al archivo de clave privada (solo para AuthType::PublicKey)
    pub key_path: Option<String>,
    /// Grupo o etiqueta para organizar conexiones
    pub group: Option<String>,
    /// UUID de la entrada KeePass cuya contraseña se usará en vez del keyring.
    /// Solo aplica cuando `auth_type == Password` y la DB está desbloqueada.
    #[serde(default)]
    pub keepass_entry_uuid: Option<String>,
    /// Si true, inyecta el hook OSC 7 tras conectar para que el panel SFTP
    /// pueda seguir el cwd del terminal. Solo aplica a conexiones SSH.
    #[serde(default = "default_true")]
    pub follow_cwd: bool,
    /// Timestamp ISO 8601 de creación
    pub created_at: String,
    /// Timestamp ISO 8601 de la última modificación. Usado por la
    /// sincronización en la nube para resolver conflictos last-write-wins.
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Gestor de perfiles de conexión.
/// Persiste los perfiles en un archivo JSON en el directorio de datos de la app.
pub struct ProfileManager {
    profiles_path: PathBuf,
}

impl ProfileManager {
    pub fn new(data_dir: PathBuf) -> Self {
        ProfileManager {
            profiles_path: data_dir.join("profiles.json"),
        }
    }

    /// Carga todos los perfiles del disco
    pub fn load_all(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        if !self.profiles_path.exists() {
            return Ok(vec![]);
        }
        let data = fs::read_to_string(&self.profiles_path)?;
        let profiles: Vec<ConnectionProfile> = serde_json::from_str(&data)?;
        Ok(profiles)
    }

    /// Guarda o actualiza un perfil (upsert por id)
    pub fn save(&self, profile: ConnectionProfile) -> Result<(), AppError> {
        let mut profiles = self.load_all()?;
        match profiles.iter().position(|p| p.id == profile.id) {
            Some(idx) => profiles[idx] = profile,
            None => profiles.push(profile),
        }
        self.write_all(&profiles)
    }

    /// Elimina un perfil por su id
    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        let mut profiles = self.load_all()?;
        profiles.retain(|p| p.id != id);
        self.write_all(&profiles)
    }

    fn write_all(&self, profiles: &[ConnectionProfile]) -> Result<(), AppError> {
        if let Some(parent) = self.profiles_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(profiles)?;
        fs::write(&self.profiles_path, data)?;
        Ok(())
    }
}
