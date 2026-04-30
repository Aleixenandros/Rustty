// ═══════════════════════════════════════════════════════════════════
//  Sincronización en la nube — Rustty
//
//  Diseño:
//   - End-to-end encryption con `age` (passphrase → scrypt → ChaCha20-Poly1305).
//     El servidor solo ve blobs opacos.
//   - Backends intercambiables (`SyncBackend` trait): carpeta local/NAS
//     y WebDAV (Nextcloud/ownCloud/cualquier server WebDAV).
//   - Estado serializado como JSON con items por colección + tombstones.
//     Resolución de conflictos last-write-wins por item (`updated_at`).
//   - Selectivo: el usuario elige qué colecciones sincroniza
//     (perfiles / prefs / temas / atajos / snippets).
//   - Dispositivo: cada equipo genera un `device_id` (UUID v4) que se
//     persiste en el data dir.
//   - Export/import de fichero cifrado (`.rustty-sync.bin`) para copia
//     manual entre equipos sin servidor.
//   - **Nunca** se sincroniza el keyring del SO (queda explícito).
// ═══════════════════════════════════════════════════════════════════

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::error::AppError;

const STATE_FILENAME: &str = "rustty-sync.bin";
const HISTORY_DIR: &str = "rustty-sync-history";
const DEFAULT_HISTORY_KEEP: usize = 30;
const STATE_VERSION: u32 = 1;

// ─── Identidad del dispositivo ───────────────────────────────────────

fn device_id_path(data_dir: &Path) -> PathBuf {
    data_dir.join("device_id")
}

/// Devuelve el `device_id` persistido en el data dir; lo crea si no existe.
pub fn get_or_create_device_id(data_dir: &Path) -> String {
    let path = device_id_path(data_dir);
    if let Ok(s) = std::fs::read_to_string(&path) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let id = Uuid::new_v4().to_string();
    let _ = std::fs::write(&path, &id);
    id
}

// ─── Configuración del sync (en disco como sync_config.json) ─────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SyncBackendKind {
    None,
    Local,
    Icloud,
    Webdav,
    GoogleDrive,
}

impl Default for SyncBackendKind {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LocalConfig {
    pub folder: String,
}

fn default_icloud_folder() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::Sync("No se pudo resolver el directorio home".into()))?;
    Ok(home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs")
        .join("Rustty"))
}

pub fn resolve_sync_folder(config: &SyncConfig) -> Result<Option<PathBuf>, AppError> {
    match config.backend {
        SyncBackendKind::Local => {
            if config.local.folder.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(PathBuf::from(config.local.folder.trim())))
            }
        }
        SyncBackendKind::Icloud => Ok(Some(default_icloud_folder()?)),
        _ => Ok(None),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    // La contraseña va al keyring, no al fichero.
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct GoogleDriveConfig {
    pub client_id: String,
    /// Google marca estos secretos como "installed app"; no protegen nada en
    /// un binario distribuido, pero algunos proyectos antiguos aún lo exigen.
    #[serde(default)]
    pub client_secret: String,
}

fn configured_google_client_id(config: &SyncConfig) -> Option<String> {
    config
        .google_drive
        .client_id
        .trim()
        .to_string()
        .into_nonempty()
        .or_else(|| option_env!("RUSTTY_GOOGLE_DRIVE_CLIENT_ID").map(str::to_string))
}

fn configured_google_client_secret(config: &SyncConfig) -> Option<String> {
    config
        .google_drive
        .client_secret
        .trim()
        .to_string()
        .into_nonempty()
        .or_else(|| option_env!("RUSTTY_GOOGLE_DRIVE_CLIENT_SECRET").map(str::to_string))
}

trait NonEmptyString {
    fn into_nonempty(self) -> Option<String>;
}

impl NonEmptyString for String {
    fn into_nonempty(self) -> Option<String> {
        if self.is_empty() {
            None
        } else {
            Some(self)
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncSelective {
    pub profiles: bool,
    pub prefs: bool,
    pub themes: bool,
    pub shortcuts: bool,
    pub snippets: bool,
}

impl Default for SyncSelective {
    fn default() -> Self {
        Self {
            profiles: true,
            prefs: true,
            themes: true,
            shortcuts: true,
            snippets: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncConfig {
    pub enabled: bool,
    #[serde(default)]
    pub backend: SyncBackendKind,
    #[serde(default)]
    pub local: LocalConfig,
    #[serde(default)]
    pub webdav: WebDavConfig,
    #[serde(default)]
    pub google_drive: GoogleDriveConfig,
    #[serde(default)]
    pub selective: SyncSelective,
    /// Si true, el frontend sincroniza al detectar cambios y cada 5 minutos.
    #[serde(default)]
    pub auto_sync_enabled: bool,
    /// Campo legacy: 0 = manual; >0 = intervalo antiguo en segundos.
    #[serde(default)]
    pub auto_interval_seconds: u64,
    /// Número de snapshots históricos a conservar antes de podar.
    #[serde(default = "default_history_keep")]
    pub history_keep: usize,
    /// Última sincronización completada correctamente en este equipo.
    #[serde(default)]
    pub last_sync_at: Option<DateTime<Utc>>,
}

fn default_history_keep() -> usize {
    DEFAULT_HISTORY_KEEP
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            backend: SyncBackendKind::None,
            local: LocalConfig::default(),
            webdav: WebDavConfig::default(),
            google_drive: GoogleDriveConfig::default(),
            selective: SyncSelective::default(),
            auto_sync_enabled: false,
            auto_interval_seconds: 0,
            history_keep: DEFAULT_HISTORY_KEEP,
            last_sync_at: None,
        }
    }
}

// ─── Modelo de estado sincronizado ───────────────────────────────────

/// Un item del estado sincronizado. La clave en el `HashMap` es del estilo
/// `profile:<uuid>`, `pref:theme`, `shortcut:close_tab`, etc. El `data` es
/// la representación opaca del item (lo que el frontend nos haya pasado).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncItem {
    pub data: serde_json::Value,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub device_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncState {
    pub version: u32,
    pub items: HashMap<String, SyncItem>,
    /// Tombstones: claves borradas con timestamp de borrado.
    /// Permiten que un dispositivo offline no resucite un perfil ya eliminado.
    #[serde(default)]
    pub tombstones: HashMap<String, DateTime<Utc>>,
}

impl Default for SyncState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            items: HashMap::new(),
            tombstones: HashMap::new(),
        }
    }
}

impl SyncState {
    /// Mezcla `other` (remoto) sobre `self` (local) usando last-write-wins
    /// por item. Devuelve cuántas filas cambiaron (útil para el toast).
    pub fn merge(&mut self, other: SyncState) -> usize {
        let mut changes = 0;

        for (key, remote) in other.items {
            let local_ts = self.items.get(&key).map(|i| i.updated_at);
            let tomb_ts = self.tombstones.get(&key).copied();
            let beats_local = local_ts.map_or(true, |t| remote.updated_at > t);
            let beats_tomb = tomb_ts.map_or(true, |t| remote.updated_at > t);
            if beats_local && beats_tomb {
                self.items.insert(key.clone(), remote);
                self.tombstones.remove(&key);
                changes += 1;
            }
        }

        for (key, ts) in other.tombstones {
            let local_ts = self.items.get(&key).map(|i| i.updated_at);
            let local_tomb_ts = self.tombstones.get(&key).copied();
            let beats_local = local_ts.map_or(true, |t| ts > t);
            let beats_tomb = local_tomb_ts.map_or(true, |t| ts > t);
            if beats_local && beats_tomb {
                self.items.remove(&key);
                self.tombstones.insert(key, ts);
                changes += 1;
            }
        }

        changes
    }
}

// ─── Cifrado (age con passphrase) ────────────────────────────────────

pub fn encrypt(passphrase: &str, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    use age::secrecy::SecretString;
    let encryptor = age::Encryptor::with_user_passphrase(SecretString::new(passphrase.to_string()));
    let mut out = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut out)
        .map_err(|e| AppError::Sync(format!("wrap_output: {e}")))?;
    writer
        .write_all(plaintext)
        .map_err(|e| AppError::Sync(format!("write encrypted: {e}")))?;
    writer
        .finish()
        .map_err(|e| AppError::Sync(format!("finish encryptor: {e}")))?;
    Ok(out)
}

pub fn decrypt(passphrase: &str, ciphertext: &[u8]) -> Result<Vec<u8>, AppError> {
    use age::secrecy::SecretString;
    let decryptor =
        age::Decryptor::new(ciphertext).map_err(|e| AppError::Sync(format!("decryptor: {e}")))?;
    let decryptor = match decryptor {
        age::Decryptor::Passphrase(d) => d,
        age::Decryptor::Recipients(_) => {
            return Err(AppError::Sync("El blob no es passphrase-encrypted".into()));
        }
    };
    let mut reader = decryptor
        .decrypt(&SecretString::new(passphrase.to_string()), None)
        .map_err(|e| AppError::Sync(format!("decrypt (¿passphrase incorrecta?): {e}")))?;
    let mut plain = Vec::new();
    reader
        .read_to_end(&mut plain)
        .map_err(|e| AppError::Sync(format!("read decrypted: {e}")))?;
    Ok(plain)
}

// ─── OAuth 2.0 + PKCE ────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "rustty";
const OAUTH_CALLBACK_PATH: &str = "/oauth/callback";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum OAuthProvider {
    GoogleDrive,
}

impl OAuthProvider {
    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "google_drive" | "googledrive" | "google" => Ok(Self::GoogleDrive),
            other => Err(AppError::Sync(format!(
                "Proveedor OAuth no soportado: {other}"
            ))),
        }
    }

    fn key_part(self) -> &'static str {
        match self {
            Self::GoogleDrive => "google_drive",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OAuthStartResult {
    pub flow_id: String,
    pub auth_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OAuthFinishResult {
    pub provider: String,
    pub connected: bool,
}

struct OAuthPending {
    provider: OAuthProvider,
    verifier: String,
    state: String,
    redirect_uri: String,
    listener: TcpListener,
}

fn oauth_refresh_key(provider: OAuthProvider) -> String {
    format!("sync:oauth:{}:refresh_token", provider.key_part())
}

fn keyring_set_secret(key: &str, value: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| AppError::Sync(format!("keyring entry: {e}")))?;
    entry
        .set_password(value)
        .map_err(|e| AppError::Sync(format!("keyring set: {e}")))
}

fn keyring_get_secret(key: &str) -> Result<Option<String>, AppError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| AppError::Sync(format!("keyring entry: {e}")))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Sync(format!("keyring get: {e}"))),
    }
}

fn keyring_delete_secret(key: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| AppError::Sync(format!("keyring entry: {e}")))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Sync(format!("keyring delete: {e}"))),
    }
}

fn pkce_pair() -> (String, String) {
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn append_param(url: &mut String, key: &str, value: &str) {
    if url.contains('?') {
        url.push('&');
    } else {
        url.push('?');
    }
    url.push_str(key);
    url.push('=');
    url.push_str(&urlencoding::encode(value));
}

fn query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == name {
            return urlencoding::decode(value).ok().map(|v| v.into_owned());
        }
    }
    None
}

async fn read_oauth_code(pending: OAuthPending) -> Result<String, AppError> {
    let accept = tokio::time::timeout(Duration::from_secs(180), pending.listener.accept())
        .await
        .map_err(|_| AppError::Sync("OAuth cancelado: tiempo de espera agotado".into()))?;
    let (mut stream, _) = accept.map_err(|e| AppError::Sync(format!("oauth accept: {e}")))?;
    let mut buf = vec![0u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| AppError::Sync(format!("oauth read: {e}")))?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first_line = req.lines().next().unwrap_or_default();
    let target = first_line.split_whitespace().nth(1).unwrap_or_default();
    let query = target
        .strip_prefix(OAUTH_CALLBACK_PATH)
        .and_then(|rest| rest.strip_prefix('?'))
        .unwrap_or_default();
    let state = query_param(query, "state").unwrap_or_default();
    let code = query_param(query, "code");
    let error = query_param(query, "error");
    let ok = state == pending.state && code.is_some() && error.is_none();
    let body = if ok {
        "Rustty ya está conectado. Puedes cerrar esta pestaña."
    } else {
        "No se pudo completar OAuth en Rustty. Vuelve a la app e inténtalo de nuevo."
    };
    let status = if ok { "200 OK" } else { "400 Bad Request" };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    if state != pending.state {
        return Err(AppError::Sync("OAuth state inválido".into()));
    }
    if let Some(error) = error {
        return Err(AppError::Sync(format!("OAuth error: {error}")));
    }
    code.ok_or_else(|| AppError::Sync("OAuth sin code".into()))
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn token_error(provider: OAuthProvider, token: &TokenResponse) -> AppError {
    let msg = token
        .error_description
        .clone()
        .or_else(|| token.error.clone())
        .unwrap_or_else(|| "respuesta OAuth sin access_token".into());
    AppError::Sync(format!("{} OAuth: {msg}", provider.key_part()))
}

fn token_missing_refresh_error(provider: OAuthProvider, token: &TokenResponse) -> AppError {
    let msg = token
        .error_description
        .clone()
        .or_else(|| token.error.clone())
        .unwrap_or_else(|| "respuesta OAuth sin refresh_token".into());
    AppError::Sync(format!("{} OAuth: {msg}", provider.key_part()))
}

// ─── Backends ────────────────────────────────────────────────────────

#[async_trait]
pub trait SyncBackend: Send + Sync {
    /// Devuelve `Ok(None)` si el remoto aún no tiene el fichero (primera sync).
    async fn read(&self) -> Result<Option<Vec<u8>>, AppError>;
    async fn archive_existing(&self, _keep: usize) -> Result<(), AppError> {
        Ok(())
    }
    async fn write(&self, data: &[u8]) -> Result<(), AppError>;
}

pub struct LocalBackend {
    pub path: PathBuf,
}

#[async_trait]
impl SyncBackend for LocalBackend {
    async fn read(&self) -> Result<Option<Vec<u8>>, AppError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = tokio::fs::read(&self.path)
            .await
            .map_err(|e| AppError::Sync(format!("leer remoto local: {e}")))?;
        Ok(Some(bytes))
    }
    async fn write(&self, data: &[u8]) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::Sync(format!("crear directorio remoto local: {e}")))?;
        }
        // Escritura atómica: tmp + rename
        let tmp = self.path.with_extension("bin.tmp");
        tokio::fs::write(&tmp, data)
            .await
            .map_err(|e| AppError::Sync(format!("escribir remoto local: {e}")))?;
        tokio::fs::rename(&tmp, &self.path)
            .await
            .map_err(|e| AppError::Sync(format!("rename remoto local: {e}")))?;
        Ok(())
    }

    async fn archive_existing(&self, keep: usize) -> Result<(), AppError> {
        if !self.path.exists() {
            return Ok(());
        }
        let Some(parent) = self.path.parent() else {
            return Ok(());
        };
        let history = parent.join(HISTORY_DIR);
        tokio::fs::create_dir_all(&history)
            .await
            .map_err(|e| AppError::Sync(format!("crear histórico local: {e}")))?;
        let archive = history.join(history_filename());
        tokio::fs::copy(&self.path, &archive)
            .await
            .map_err(|e| AppError::Sync(format!("archivar remoto local: {e}")))?;
        prune_local_history(&history, keep).await?;
        Ok(())
    }
}

pub struct WebDavBackend {
    pub url: String,
    pub username: String,
    pub password: String,
}

fn history_filename() -> String {
    format!("rustty-sync-{}.bin", Utc::now().format("%Y%m%dT%H%M%SZ"))
}

async fn prune_local_history(path: &Path, keep: usize) -> Result<(), AppError> {
    let mut entries = Vec::new();
    let mut dir = match tokio::fs::read_dir(path).await {
        Ok(dir) => dir,
        Err(_) => return Ok(()),
    };
    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| AppError::Sync(format!("leer histórico local: {e}")))?
    {
        let metadata = entry
            .metadata()
            .await
            .map_err(|e| AppError::Sync(format!("metadata histórico local: {e}")))?;
        if metadata.is_file() {
            let modified = metadata.modified().ok();
            entries.push((entry.path(), modified));
        }
    }
    entries.sort_by_key(|(_, modified)| *modified);
    let delete_count = entries.len().saturating_sub(keep);
    for (path, _) in entries.into_iter().take(delete_count) {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(())
}

#[async_trait]
impl SyncBackend for WebDavBackend {
    async fn read(&self) -> Result<Option<Vec<u8>>, AppError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| AppError::Sync(format!("webdav client: {e}")))?;
        let resp = client
            .get(&self.url)
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .await
            .map_err(|e| AppError::Sync(format!("webdav GET: {e}")))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "webdav GET status: {}",
                resp.status()
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Sync(format!("webdav body: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn write(&self, data: &[u8]) -> Result<(), AppError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| AppError::Sync(format!("webdav client: {e}")))?;
        // Asegura que el directorio padre exista (Nextcloud crea recursivo,
        // los WebDAV genéricos no — usamos MKCOL best-effort si falla con 409).
        let put = client
            .put(&self.url)
            .basic_auth(&self.username, Some(&self.password))
            .body(data.to_vec())
            .send()
            .await
            .map_err(|e| AppError::Sync(format!("webdav PUT: {e}")))?;
        if put.status() == reqwest::StatusCode::CONFLICT {
            // Intenta crear la colección padre y reintenta el PUT
            if let Some((parent_url, _)) = self.url.rsplit_once('/') {
                let _ = client
                    .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), parent_url)
                    .basic_auth(&self.username, Some(&self.password))
                    .send()
                    .await;
                let retry = client
                    .put(&self.url)
                    .basic_auth(&self.username, Some(&self.password))
                    .body(data.to_vec())
                    .send()
                    .await
                    .map_err(|e| AppError::Sync(format!("webdav PUT retry: {e}")))?;
                if !retry.status().is_success() {
                    return Err(AppError::Sync(format!(
                        "webdav PUT (tras MKCOL) status: {}",
                        retry.status()
                    )));
                }
                return Ok(());
            }
        }
        if !put.status().is_success() {
            return Err(AppError::Sync(format!(
                "webdav PUT status: {}",
                put.status()
            )));
        }
        Ok(())
    }

    async fn archive_existing(&self, keep: usize) -> Result<(), AppError> {
        let Some(bytes) = self.read().await? else {
            return Ok(());
        };
        let Some((base, _)) = self.url.rsplit_once('/') else {
            return Ok(());
        };
        let history_url = format!(
            "{}/{}/{}",
            base,
            urlencoding::encode(HISTORY_DIR),
            urlencoding::encode(&history_filename())
        );
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| AppError::Sync(format!("webdav client: {e}")))?;
        let _ = client
            .request(
                reqwest::Method::from_bytes(b"MKCOL").unwrap(),
                format!("{}/{}", base, urlencoding::encode(HISTORY_DIR)),
            )
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .await;
        let put = client
            .put(history_url)
            .basic_auth(&self.username, Some(&self.password))
            .body(bytes)
            .send()
            .await
            .map_err(|e| AppError::Sync(format!("webdav histórico PUT: {e}")))?;
        if !put.status().is_success() {
            return Err(AppError::Sync(format!(
                "webdav histórico PUT status: {}",
                put.status()
            )));
        }
        prune_webdav_history(&client, base, &self.username, &self.password, keep).await?;
        Ok(())
    }
}

async fn prune_webdav_history(
    client: &reqwest::Client,
    base: &str,
    username: &str,
    password: &str,
    keep: usize,
) -> Result<(), AppError> {
    let history_base = format!("{}/{}", base, urlencoding::encode(HISTORY_DIR));
    let resp = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            &history_base,
        )
        .basic_auth(username, Some(password))
        .header("Depth", "1")
        .send()
        .await
        .map_err(|e| AppError::Sync(format!("webdav histórico PROPFIND: {e}")))?;
    if !resp.status().is_success() {
        return Ok(());
    }
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Sync(format!("webdav histórico body: {e}")))?;
    let mut names = webdav_history_filenames(&body);
    names.sort();
    let delete_count = names.len().saturating_sub(keep);
    for name in names.into_iter().take(delete_count) {
        let url = format!("{}/{}", history_base, urlencoding::encode(&name));
        let _ = client
            .delete(url)
            .basic_auth(username, Some(password))
            .send()
            .await;
    }
    Ok(())
}

fn webdav_history_filenames(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("<") {
        rest = &rest[start..];
        let Some(tag_end) = rest.find(">") else { break };
        let tag = &rest[..=tag_end];
        if !tag.ends_with("href>") {
            rest = &rest[tag_end + 1..];
            continue;
        }
        let Some(end) = rest[tag_end + 1..].find("</") else {
            rest = &rest[tag_end + 1..];
            continue;
        };
        let href = &rest[tag_end + 1..tag_end + 1 + end];
        if let Some(raw_name) = href.rsplit('/').find(|part| !part.is_empty()) {
            let decoded = urlencoding::decode(raw_name)
                .map(|value| value.into_owned())
                .unwrap_or_else(|_| raw_name.to_string());
            if decoded.starts_with("rustty-sync-") && decoded.ends_with(".bin") {
                out.push(decoded);
            }
        }
        rest = &rest[tag_end + 1 + end + 2..];
    }
    out
}

fn http_client(timeout_secs: u64) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| AppError::Sync(format!("http client: {e}")))
}

async fn refresh_oauth_access_token(
    provider: OAuthProvider,
    config: &SyncConfig,
) -> Result<String, AppError> {
    let refresh_token = keyring_get_secret(&oauth_refresh_key(provider))?
        .ok_or_else(|| AppError::Sync("Proveedor cloud no conectado".into()))?;
    let client = http_client(20)?;
    let mut params = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token),
    ];
    let token_url = match provider {
        OAuthProvider::GoogleDrive => {
            let client_id = configured_google_client_id(config)
                .ok_or_else(|| AppError::Sync("Client ID de Google Drive no configurado".into()))?;
            params.push(("client_id".to_string(), client_id));
            let client_secret = configured_google_client_secret(config);
            if let Some(secret) = client_secret {
                params.push(("client_secret".to_string(), secret));
            }
            "https://oauth2.googleapis.com/token".to_string()
        }
    };
    let token: TokenResponse = client
        .post(token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::Sync(format!("refresh OAuth: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Sync(format!("refresh OAuth json: {e}")))?;
    if let Some(access_token) = token.access_token {
        Ok(access_token)
    } else {
        Err(token_error(provider, &token))
    }
}

pub struct GoogleDriveBackend {
    pub config: SyncConfig,
}

impl GoogleDriveBackend {
    async fn access_token(&self) -> Result<String, AppError> {
        refresh_oauth_access_token(OAuthProvider::GoogleDrive, &self.config).await
    }

    async fn file_id(
        &self,
        client: &reqwest::Client,
        token: &str,
    ) -> Result<Option<String>, AppError> {
        let q = format!(
            "name='{}' and 'appDataFolder' in parents and trashed=false",
            STATE_FILENAME
        );
        let resp = client
            .get("https://www.googleapis.com/drive/v3/files")
            .bearer_auth(token)
            .query(&[
                ("spaces", "appDataFolder"),
                ("fields", "files(id,name)"),
                ("q", q.as_str()),
            ])
            .send()
            .await
            .map_err(|e| AppError::Sync(format!("google files.list: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "google files.list status: {}",
                resp.status()
            )));
        }
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Sync(format!("google files.list json: {e}")))?;
        Ok(value
            .get("files")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    }

    async fn upload_named(
        &self,
        client: &reqwest::Client,
        token: &str,
        name: &str,
        data: &[u8],
    ) -> Result<(), AppError> {
        let boundary = format!("rustty-{}", Uuid::new_v4().simple());
        let metadata = serde_json::json!({
            "name": name,
            "parents": ["appDataFolder"],
        });
        let mut body = Vec::new();
        write!(
            body,
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n",
            metadata
        )
        .map_err(|e| AppError::Sync(format!("google multipart: {e}")))?;
        body.extend_from_slice(data);
        write!(body, "\r\n--{boundary}--\r\n")
            .map_err(|e| AppError::Sync(format!("google multipart finish: {e}")))?;
        let resp = client
            .post("https://www.googleapis.com/upload/drive/v3/files")
            .bearer_auth(token)
            .query(&[("uploadType", "multipart")])
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/related; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| AppError::Sync(format!("google create: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "google create status: {}",
                resp.status()
            )));
        }
        Ok(())
    }

    async fn prune_history(
        &self,
        client: &reqwest::Client,
        token: &str,
        keep: usize,
    ) -> Result<(), AppError> {
        let prefix = format!("{}-rustty-sync-", HISTORY_DIR);
        let q = format!(
            "name contains '{}' and 'appDataFolder' in parents and trashed=false",
            prefix
        );
        let resp = client
            .get("https://www.googleapis.com/drive/v3/files")
            .bearer_auth(token)
            .query(&[
                ("spaces", "appDataFolder"),
                ("fields", "files(id,name)"),
                ("q", q.as_str()),
            ])
            .send()
            .await
            .map_err(|e| AppError::Sync(format!("google history list: {e}")))?;
        if !resp.status().is_success() {
            return Ok(());
        }
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Sync(format!("google history json: {e}")))?;
        let mut files: Vec<(String, String)> = value
            .get("files")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|file| {
                Some((
                    file.get("name")?.as_str()?.to_string(),
                    file.get("id")?.as_str()?.to_string(),
                ))
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let delete_count = files.len().saturating_sub(keep);
        for (_, id) in files.into_iter().take(delete_count) {
            let _ = client
                .delete(format!("https://www.googleapis.com/drive/v3/files/{id}"))
                .bearer_auth(token)
                .send()
                .await;
        }
        Ok(())
    }
}

#[async_trait]
impl SyncBackend for GoogleDriveBackend {
    async fn read(&self) -> Result<Option<Vec<u8>>, AppError> {
        let client = http_client(30)?;
        let token = self.access_token().await?;
        let Some(id) = self.file_id(&client, &token).await? else {
            return Ok(None);
        };
        let url = format!("https://www.googleapis.com/drive/v3/files/{id}");
        let resp = client
            .get(url)
            .bearer_auth(&token)
            .query(&[("alt", "media")])
            .send()
            .await
            .map_err(|e| AppError::Sync(format!("google download: {e}")))?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "google download status: {}",
                resp.status()
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Sync(format!("google download body: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn write(&self, data: &[u8]) -> Result<(), AppError> {
        let client = http_client(30)?;
        let token = self.access_token().await?;
        if let Some(id) = self.file_id(&client, &token).await? {
            let url = format!("https://www.googleapis.com/upload/drive/v3/files/{id}");
            let resp = client
                .patch(url)
                .bearer_auth(&token)
                .query(&[("uploadType", "media")])
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(data.to_vec())
                .send()
                .await
                .map_err(|e| AppError::Sync(format!("google update: {e}")))?;
            if !resp.status().is_success() {
                return Err(AppError::Sync(format!(
                    "google update status: {}",
                    resp.status()
                )));
            }
            return Ok(());
        }

        self.upload_named(&client, &token, STATE_FILENAME, data)
            .await
    }

    async fn archive_existing(&self, keep: usize) -> Result<(), AppError> {
        let Some(bytes) = self.read().await? else {
            return Ok(());
        };
        let client = http_client(30)?;
        let token = self.access_token().await?;
        self.upload_named(
            &client,
            &token,
            &format!("{}-{}", HISTORY_DIR, history_filename()),
            &bytes,
        )
        .await?;
        self.prune_history(&client, &token, keep).await
    }
}

// ─── Manager ─────────────────────────────────────────────────────────

pub struct SyncManager {
    pub data_dir: PathBuf,
    pending_oauth: Mutex<HashMap<String, OAuthPending>>,
}

impl SyncManager {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            pending_oauth: Mutex::new(HashMap::new()),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.data_dir.join("sync_config.json")
    }

    fn local_state_path(&self) -> PathBuf {
        self.data_dir.join("sync_state.json")
    }

    pub fn load_config(&self) -> SyncConfig {
        std::fs::read_to_string(self.config_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_config(&self, config: &SyncConfig) -> Result<(), AppError> {
        let s = serde_json::to_string_pretty(config)
            .map_err(|e| AppError::Sync(format!("serialize config: {e}")))?;
        std::fs::write(self.config_path(), s)
            .map_err(|e| AppError::Sync(format!("write config: {e}")))?;
        Ok(())
    }

    /// Carga el último estado sincronizado conocido (cache local).
    #[allow(dead_code)]
    pub fn load_local_state(&self) -> SyncState {
        std::fs::read_to_string(self.local_state_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_local_state(&self, state: &SyncState) -> Result<(), AppError> {
        let s = serde_json::to_string(state)
            .map_err(|e| AppError::Sync(format!("serialize state: {e}")))?;
        std::fs::write(self.local_state_path(), s)
            .map_err(|e| AppError::Sync(format!("write state: {e}")))?;
        Ok(())
    }

    pub fn oauth_connected(&self, provider: OAuthProvider) -> Result<bool, AppError> {
        Ok(keyring_get_secret(&oauth_refresh_key(provider))?.is_some())
    }

    pub fn oauth_disconnect(&self, provider: OAuthProvider) -> Result<(), AppError> {
        keyring_delete_secret(&oauth_refresh_key(provider))
    }

    pub async fn oauth_begin(&self, provider: OAuthProvider) -> Result<OAuthStartResult, AppError> {
        let config = self.load_config();
        let client_id = match provider {
            OAuthProvider::GoogleDrive => configured_google_client_id(&config),
        }
        .ok_or_else(|| AppError::Sync("Client ID OAuth no configurado".into()))?;

        let listener = TcpListener::bind("127.0.0.1:53682").await.map_err(|e| {
            AppError::Sync(format!("No se pudo abrir el callback OAuth local: {e}"))
        })?;
        let redirect_uri = format!("http://127.0.0.1:53682{OAUTH_CALLBACK_PATH}");
        let flow_id = Uuid::new_v4().to_string();
        let state = Uuid::new_v4().to_string();
        let (verifier, challenge) = pkce_pair();

        let mut auth_url = match provider {
            OAuthProvider::GoogleDrive => {
                "https://accounts.google.com/o/oauth2/v2/auth".to_string()
            }
        };
        append_param(&mut auth_url, "response_type", "code");
        append_param(&mut auth_url, "client_id", &client_id);
        append_param(&mut auth_url, "redirect_uri", &redirect_uri);
        append_param(&mut auth_url, "state", &state);
        append_param(&mut auth_url, "code_challenge", &challenge);
        append_param(&mut auth_url, "code_challenge_method", "S256");
        match provider {
            OAuthProvider::GoogleDrive => {
                append_param(
                    &mut auth_url,
                    "scope",
                    "https://www.googleapis.com/auth/drive.appdata",
                );
                append_param(&mut auth_url, "access_type", "offline");
                append_param(&mut auth_url, "prompt", "consent");
            }
        }

        let pending = OAuthPending {
            provider,
            verifier,
            state,
            redirect_uri,
            listener,
        };
        self.pending_oauth
            .lock()
            .map_err(|_| AppError::Sync("OAuth lock poisoned".into()))?
            .insert(flow_id.clone(), pending);
        Ok(OAuthStartResult { flow_id, auth_url })
    }

    pub async fn oauth_complete(&self, flow_id: &str) -> Result<OAuthFinishResult, AppError> {
        let pending = self
            .pending_oauth
            .lock()
            .map_err(|_| AppError::Sync("OAuth lock poisoned".into()))?
            .remove(flow_id)
            .ok_or_else(|| AppError::Sync("Flujo OAuth no encontrado".into()))?;
        let provider = pending.provider;
        let verifier = pending.verifier.clone();
        let redirect_uri = pending.redirect_uri.clone();
        let code = read_oauth_code(pending).await?;
        let config = self.load_config();
        let client = http_client(20)?;
        let mut params = vec![
            ("grant_type".to_string(), "authorization_code".to_string()),
            ("code".to_string(), code),
            ("redirect_uri".to_string(), redirect_uri),
            ("code_verifier".to_string(), verifier),
        ];
        let token_url = match provider {
            OAuthProvider::GoogleDrive => {
                let client_id = configured_google_client_id(&config).ok_or_else(|| {
                    AppError::Sync("Client ID de Google Drive no configurado".into())
                })?;
                params.push(("client_id".to_string(), client_id));
                let client_secret = configured_google_client_secret(&config);
                if let Some(secret) = client_secret {
                    params.push(("client_secret".to_string(), secret));
                }
                "https://oauth2.googleapis.com/token".to_string()
            }
        };
        let token: TokenResponse = client
            .post(token_url)
            .form(&params)
            .send()
            .await
            .map_err(|e| AppError::Sync(format!("oauth token: {e}")))?
            .json()
            .await
            .map_err(|e| AppError::Sync(format!("oauth token json: {e}")))?;
        let refresh_token = if let Some(refresh_token) = token.refresh_token {
            refresh_token
        } else {
            return Err(token_missing_refresh_error(provider, &token));
        };
        keyring_set_secret(&oauth_refresh_key(provider), &refresh_token)?;
        Ok(OAuthFinishResult {
            provider: provider.key_part().to_string(),
            connected: true,
        })
    }

    pub fn backend(
        &self,
        config: &SyncConfig,
        password: &str,
    ) -> Result<Box<dyn SyncBackend>, AppError> {
        match config.backend {
            SyncBackendKind::Local => {
                if config.local.folder.is_empty() {
                    return Err(AppError::Sync(
                        "Carpeta local de sincronización no configurada".into(),
                    ));
                }
                let folder = PathBuf::from(&config.local.folder);
                Ok(Box::new(LocalBackend {
                    path: folder.join(STATE_FILENAME),
                }))
            }
            SyncBackendKind::Icloud => {
                let folder = default_icloud_folder()?;
                Ok(Box::new(LocalBackend {
                    path: folder.join(STATE_FILENAME),
                }))
            }
            SyncBackendKind::Webdav => {
                if config.webdav.url.is_empty() {
                    return Err(AppError::Sync("URL WebDAV no configurada".into()));
                }
                let base = config.webdav.url.trim_end_matches('/');
                let url = format!("{}/{}", base, urlencoding::encode(STATE_FILENAME));
                Ok(Box::new(WebDavBackend {
                    url,
                    username: config.webdav.username.clone(),
                    password: password.to_string(),
                }))
            }
            SyncBackendKind::GoogleDrive => Ok(Box::new(GoogleDriveBackend {
                config: config.clone(),
            })),
            SyncBackendKind::None => Err(AppError::Sync("No hay backend seleccionado".into())),
        }
    }
}

// ─── Helpers de serialización del estado cifrado ────────────────────

/// Serializa, cifra con passphrase, devuelve los bytes listos para escribir.
pub fn pack_state(passphrase: &str, state: &SyncState) -> Result<Vec<u8>, AppError> {
    let json =
        serde_json::to_vec(state).map_err(|e| AppError::Sync(format!("serialize state: {e}")))?;
    encrypt(passphrase, &json)
}

/// Descifra y deserializa.
pub fn unpack_state(passphrase: &str, ciphertext: &[u8]) -> Result<SyncState, AppError> {
    let plain = decrypt(passphrase, ciphertext)?;
    let state: SyncState = serde_json::from_slice(&plain)
        .map_err(|e| AppError::Sync(format!("deserialize state: {e}")))?;
    Ok(state)
}
