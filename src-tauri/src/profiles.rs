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

fn default_workspace_id() -> String {
    "default".to_string()
}

/// Tipo de túnel SSH persistido en un perfil.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SshTunnelType {
    /// Equivalente a `ssh -L local_port:remote_host:remote_port`.
    Local,
    /// Equivalente a `ssh -R remote_port:local_host:local_port`.
    Remote,
    /// Equivalente a `ssh -D local_port` (SOCKS5 local).
    Dynamic,
}

/// Configuración de redirección de puertos asociada a un perfil.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnelProfile {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub tunnel_type: SshTunnelType,
    #[serde(default)]
    pub bind_host: Option<String>,
    pub local_port: u16,
    #[serde(default)]
    pub remote_host: Option<String>,
    #[serde(default)]
    pub remote_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
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
    /// Notas libres del usuario sobre el perfil (comandos frecuentes,
    /// responsables, rutas, recordatorios). No debe contener secretos.
    #[serde(default)]
    pub notes: Option<String>,
    /// Identificador del perfil-contenedor (workspace) al que pertenece.
    /// Por defecto "default" para no romper perfiles previos a la feature.
    #[serde(default = "default_workspace_id")]
    pub workspace_id: String,
    /// UUID de la entrada KeePass cuya contraseña se usará en vez del keyring.
    /// Solo aplica cuando `auth_type == Password` y la DB está desbloqueada.
    #[serde(default)]
    pub keepass_entry_uuid: Option<String>,
    /// Si true, inyecta el hook OSC 7 tras conectar para que el panel SFTP
    /// pueda seguir el cwd del terminal. Solo aplica a conexiones SSH.
    #[serde(default = "default_true")]
    pub follow_cwd: bool,
    /// Intervalo en segundos para enviar keepalives al servidor SSH.
    /// `None` o `0` deshabilita el keepalive. Útil contra caídas por NAT.
    #[serde(default)]
    pub keep_alive_secs: Option<u32>,
    /// Si true, extiende las listas de algoritmos preferidos con variantes
    /// legacy (aes-cbc, 3des-cbc, dh-group14-sha1, hmac-sha1, ssh-rsa) para
    /// poder conectar con servidores antiguos. Reduce la seguridad.
    #[serde(default)]
    pub allow_legacy_algorithms: bool,
    /// Si true, permite reenviar el agente SSH local hacia la sesión remota.
    #[serde(default)]
    pub agent_forwarding: bool,
    /// Si true, solicita X11 forwarding al servidor. Requiere un X server
    /// local escuchando en `localhost:6000` (DISPLAY=:0).
    #[serde(default)]
    pub x11_forwarding: bool,
    /// Si > 0, intenta reconectar automáticamente al caer la conexión SSH.
    /// El backend reintenta hasta `auto_reconnect` veces con backoff
    /// exponencial (2s, 4s, 8s, …). 0 / None = desactivado.
    #[serde(default)]
    pub auto_reconnect: Option<u32>,
    /// Bastion / jump host (ProxyJump). Formato `[user@]host[:port]`.
    /// Si está presente, primero se conecta al bastion vía SSH, se abre un
    /// canal `direct-tcpip` al host destino y la sesión SSH del target se
    /// realiza sobre ese stream tunelizado. Para autenticar el bastion se
    /// reutilizan las credenciales del perfil (mismo `auth_type`,
    /// `key_path`, `password`, `passphrase`) — la mayoría de despliegues
    /// usan la misma clave en bastion y destino.
    #[serde(default)]
    pub proxy_jump: Option<String>,
    /// Wake On LAN opcional: MAC destino y parámetros UDP.
    #[serde(default)]
    pub mac_address: Option<String>,
    #[serde(default)]
    pub wol_broadcast: Option<String>,
    #[serde(default)]
    pub wol_port: Option<u16>,
    /// Si true, vuelca toda la salida del shell SSH a un fichero de log
    /// dentro de `session_log_dir` (o, si no se indica, en
    /// `<data_dir>/session_logs/`). Útil para auditoría y depuración.
    #[serde(default)]
    pub session_log: bool,
    /// Carpeta personalizada para los logs de sesión. Si está vacía se usa
    /// `<data_dir>/session_logs/<perfil>/<timestamp>.log`.
    #[serde(default)]
    pub session_log_dir: Option<String>,
    /// Túneles SSH guardados para este perfil. Si `auto_start` está activo,
    /// el frontend los levanta al establecer la sesión interactiva.
    #[serde(default)]
    pub ssh_tunnels: Vec<SshTunnelProfile>,
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
        write_private_file(&self.profiles_path, data.as_bytes())?;
        Ok(())
    }
}

#[cfg(unix)]
fn write_private_file(path: &PathBuf, data: &[u8]) -> Result<(), AppError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    let mut permissions = file.metadata()?.permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o600);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private_file(path: &PathBuf, data: &[u8]) -> Result<(), AppError> {
    fs::write(path, data)?;
    Ok(())
}
