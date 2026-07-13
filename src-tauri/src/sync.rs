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
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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
/// Retención por defecto de los tombstones (días). 0 = no podar nunca.
const DEFAULT_TOMBSTONE_RETENTION_DAYS: u32 = 90;
/// Margen tolerado a los `updated_at` del futuro antes de acotarlos (relojes
/// desviados): un item fechado más allá de `now + margen` se recorta para que
/// un equipo con la hora adelantada no gane el LWW «para siempre».
const FUTURE_TIMESTAMP_MARGIN_SECS: i64 = 300;
/// Desvío mínimo entre el reloj local y el `Date` del servidor para avisar.
const CLOCK_SKEW_WARN_SECS: i64 = 300;

// Marcadores estables al inicio de los mensajes de error, para que el frontend
// pueda clasificar sin parsear texto libre (el contrato IPC devuelve
// `Err(String)`). Espejados en `src/sync.js`.
/// Fallo de conectividad (DNS, connect, timeout): estado «offline», no error.
pub const OFFLINE_MARKER: &str = "sync-offline:";
/// El blob remoto no descifra: passphrase incorrecta (p. ej. rotada en otro
/// equipo) o datos corruptos.
pub const BAD_PASSPHRASE_MARKER: &str = "sync-passphrase:";
/// Escritura condicional rechazada (ETag cambió entre el GET y el PUT).
pub const CONFLICT_MARKER: &str = "sync-conflict:";

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
    // Atómica como el resto de ficheros de datos (invariante del proyecto):
    // un corte a mitad no puede dejar un device_id vacío que cambie la
    // identidad del equipo en el siguiente arranque.
    let _ = crate::atomic_file::write(&path, id.as_bytes(), false);
    id
}

// ─── Configuración del sync (en disco como sync_config.json) ─────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncBackendKind {
    #[default]
    None,
    Local,
    Icloud,
    Webdav,
    GoogleDrive,
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
    /// Desde 2026-07 vive en el keyring (`sync:oauth:google_drive:client_secret`)
    /// por coherencia con el resto de credenciales; este campo queda solo como
    /// formato legado que `load_config` migra y deja en blanco.
    #[serde(default)]
    pub client_secret: String,
}

fn google_client_secret_key() -> String {
    format!(
        "sync:oauth:{}:client_secret",
        OAuthProvider::GoogleDrive.key_part()
    )
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
    // Orden: campo legado del fichero (configs aún no migradas) → keyring →
    // secreto embebido en build. `load_config` migra el legado al keyring.
    config
        .google_drive
        .client_secret
        .trim()
        .to_string()
        .into_nonempty()
        .or_else(|| keyring_get_secret(&google_client_secret_key()).ok().flatten())
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
    #[serde(default)]
    pub secrets: bool,
    /// Notas Markdown por conexión (item `note:<id>`). Default `true` para
    /// configuraciones antiguas que no traen el campo.
    #[serde(default = "default_true_field")]
    pub notes: bool,
}

fn default_true_field() -> bool {
    true
}

impl Default for SyncSelective {
    fn default() -> Self {
        Self {
            profiles: true,
            prefs: true,
            themes: true,
            shortcuts: true,
            snippets: true,
            secrets: false,
            notes: true,
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
    /// Si true, el frontend sincroniza al detectar cambios locales (debounce).
    #[serde(default = "default_auto_sync_enabled")]
    pub auto_sync_enabled: bool,
    /// Intervalo del pull periódico en segundos, elegido por el usuario en
    /// Preferencias (0 = desactivado). Reutiliza el antiguo campo legacy: las
    /// configs guardadas por frontends antiguos traen 0 (sin pull periódico) y
    /// las nuevas instalaciones parten de 300 s como default razonable.
    #[serde(default)]
    pub auto_interval_seconds: u64,
    /// Número de snapshots históricos a conservar antes de podar.
    #[serde(default = "default_history_keep")]
    pub history_keep: usize,
    /// Última sincronización completada correctamente en este equipo.
    /// **Legado**: ya no se reescribe en cada ciclo (el frontend lleva el
    /// timestamp vivo en sus prefs); se conserva para leer configs antiguas.
    #[serde(default)]
    pub last_sync_at: Option<DateTime<Utc>>,
    /// Días de retención de los tombstones antes de podarlos del estado
    /// (0 = conservarlos siempre; para equipos que hibernan meses).
    #[serde(default = "default_tombstone_retention_days")]
    pub tombstone_retention_days: u32,
    /// Sincronización final al cerrar la app si quedan cambios sin subir.
    #[serde(default = "default_true_field")]
    pub sync_on_exit: bool,
}

fn default_history_keep() -> usize {
    DEFAULT_HISTORY_KEEP
}

fn default_auto_sync_enabled() -> bool {
    true
}

fn default_tombstone_retention_days() -> u32 {
    DEFAULT_TOMBSTONE_RETENTION_DAYS
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
            auto_sync_enabled: true,
            auto_interval_seconds: 300,
            history_keep: DEFAULT_HISTORY_KEEP,
            last_sync_at: None,
            tombstone_retention_days: DEFAULT_TOMBSTONE_RETENTION_DAYS,
            sync_on_exit: true,
        }
    }
}

// ─── Modelo de estado sincronizado ───────────────────────────────────

/// Un item del estado sincronizado. La clave en el `HashMap` es del estilo
/// `profile:<uuid>`, `pref:theme`, `shortcut:close_tab`, etc. El `data` es
/// la representación opaca del item (lo que el frontend nos haya pasado).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SyncItem {
    pub data: serde_json::Value,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub device_id: String,
}

/// Resultado de un ciclo de sincronización para el frontend: el estado
/// mezclado más los metadatos del ciclo (para toasts/journal).
#[derive(Serialize)]
pub struct SyncRunOutcome {
    pub state: SyncState,
    /// Timestamps futuros acotados al recibir el remoto (relojes desviados).
    pub clamped: usize,
    /// Tombstones podados por antigüedad en este ciclo.
    pub pruned_tombstones: usize,
    /// `true` si el remoto tenía blobs duplicados que se fusionaron (Drive).
    pub deduped: bool,
    /// Desvío reloj local ↔ servidor (segundos, positivo = local adelantado),
    /// solo cuando supera el umbral de aviso.
    pub clock_skew_seconds: Option<i64>,
}

/// Desvío entre el reloj local y el del servidor si supera el umbral de aviso.
pub fn significant_clock_skew(server: DateTime<Utc>, now: DateTime<Utc>) -> Option<i64> {
    let skew = (now - server).num_seconds();
    (skew.abs() >= CLOCK_SKEW_WARN_SECS).then_some(skew)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    /// Igualdad **de contenido**: ignora los `updated_at` de items y
    /// tombstones y el `device_id`. Compara solo qué datos hay y qué claves
    /// están borradas. Sirve para decidir si un push aporta un cambio real al
    /// remoto: un mero refresco de timestamps (mismo contenido) no debe archivar
    /// una versión "restaurable", o se acumularían snapshots idénticos en cada
    /// arranque.
    pub fn content_eq(&self, other: &SyncState) -> bool {
        self.version == other.version
            && self.tombstones.len() == other.tombstones.len()
            && self
                .tombstones
                .keys()
                .all(|k| other.tombstones.contains_key(k))
            && self.items.len() == other.items.len()
            && self.items.iter().all(|(key, item)| {
                other
                    .items
                    .get(key)
                    .is_some_and(|other_item| item.data == other_item.data)
            })
    }

    /// Mezcla `other` (remoto) sobre `self` (local) usando last-write-wins
    /// por item. Devuelve cuántas filas cambiaron (útil para el toast).
    pub fn merge(&mut self, other: SyncState) -> usize {
        let mut changes = 0;

        for (key, remote) in other.items {
            let local_ts = self.items.get(&key).map(|i| i.updated_at);
            let tomb_ts = self.tombstones.get(&key).copied();
            let beats_local = local_ts.is_none_or(|t| remote.updated_at > t);
            let beats_tomb = tomb_ts.is_none_or(|t| remote.updated_at > t);
            if beats_local && beats_tomb {
                self.items.insert(key.clone(), remote);
                self.tombstones.remove(&key);
                changes += 1;
            }
        }

        for (key, ts) in other.tombstones {
            let local_ts = self.items.get(&key).map(|i| i.updated_at);
            let local_tomb_ts = self.tombstones.get(&key).copied();
            let beats_local = local_ts.is_none_or(|t| ts > t);
            let beats_tomb = local_tomb_ts.is_none_or(|t| ts > t);
            if beats_local && beats_tomb {
                self.items.remove(&key);
                self.tombstones.insert(key, ts);
                changes += 1;
            }
        }

        changes
    }

    /// Acota los `updated_at` que vienen del futuro (reloj desviado en otro
    /// equipo) a `now + FUTURE_TIMESTAMP_MARGIN_SECS`. Sin esto, un item
    /// fechado «mañana» es imbatible en el LWW hasta que la realidad lo
    /// alcance. Devuelve cuántos timestamps se recortaron.
    pub fn clamp_future_timestamps(&mut self, now: DateTime<Utc>) -> usize {
        let ceiling = now + chrono::Duration::seconds(FUTURE_TIMESTAMP_MARGIN_SECS);
        let mut clamped = 0;
        for item in self.items.values_mut() {
            if item.updated_at > ceiling {
                item.updated_at = ceiling;
                clamped += 1;
            }
        }
        for ts in self.tombstones.values_mut() {
            if *ts > ceiling {
                *ts = ceiling;
                clamped += 1;
            }
        }
        clamped
    }

    /// Poda los tombstones más antiguos que `retention_days` (0 = nunca).
    /// Crecen para siempre si no: cada perfil/tema/snippet borrado dejaba una
    /// entrada eterna que viajaba cifrada en cada push. Devuelve cuántos cayeron.
    pub fn prune_tombstones(&mut self, now: DateTime<Utc>, retention_days: u32) -> usize {
        if retention_days == 0 {
            return 0;
        }
        let cutoff = now - chrono::Duration::days(i64::from(retention_days));
        let before = self.tombstones.len();
        self.tombstones.retain(|_, ts| *ts >= cutoff);
        before - self.tombstones.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locks::MutexExt;
    use serde_json::json;

    /// El callback OAuth debe sobrevivir a conexiones que no son el callback:
    /// preconexión especulativa del navegador (conecta y calla), favicon y un
    /// callback con `state` ajeno. Con un único `accept()` cualquiera de ellas
    /// consumía la conexión y el flujo fallaba de forma intermitente.
    #[tokio::test]
    async fn oauth_callback_sobrevive_preconexiones_y_state_ajeno() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let pending = OAuthPending {
            provider: OAuthProvider::GoogleDrive,
            verifier: "v".into(),
            state: "estado-bueno".into(),
            redirect_uri: format!("http://{addr}{OAUTH_CALLBACK_PATH}"),
            listener,
        };
        let reader = tokio::spawn(read_oauth_code(pending));

        // 1. Preconexión especulativa: conecta y cierra sin enviar nada.
        drop(tokio::net::TcpStream::connect(addr).await.unwrap());

        let mut buf = [0u8; 512];

        // 2. Petición a otra ruta (favicon): 404 y se sigue esperando.
        let mut fav = tokio::net::TcpStream::connect(addr).await.unwrap();
        fav.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let n = fav.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 404"));

        // 3. Callback con state ajeno: 400 y se sigue esperando.
        let mut bad = tokio::net::TcpStream::connect(addr).await.unwrap();
        bad.write_all(b"GET /oauth/callback?state=otro&code=nope HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let n = bad.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 400"));

        // 4. Callback legítimo: 200 y devuelve el code.
        let mut ok = tokio::net::TcpStream::connect(addr).await.unwrap();
        ok.write_all(b"GET /oauth/callback?state=estado-bueno&code=el-code HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let n = ok.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));

        let code = reader.await.unwrap().unwrap();
        assert_eq!(code, "el-code");
    }

    /// La caché del access token debe servir el token mientras viva (con
    /// margen) y dejar de servirlo al expirar o al limpiarla. Una regresión
    /// aquí reintroduce un refresh por operación (lento) o, peor, sirve
    /// tokens caducados (todas las llamadas a Drive fallarían con 401).
    #[test]
    fn token_cache_respeta_expiracion_y_margen() {
        let now = Instant::now();
        let mut cache = TokenCache::default();
        assert_eq!(cache.get(now), None);

        cache.put("tok".into(), 3600, now);
        assert_eq!(cache.get(now), Some("tok".into()));
        // Aún válido justo antes del margen de seguridad (3600 - 61 s).
        assert_eq!(
            cache.get(now + Duration::from_secs(3600 - 61)),
            Some("tok".into())
        );
        // Dentro del margen (a 59 s de expirar): se considera caducado.
        assert_eq!(cache.get(now + Duration::from_secs(3600 - 59)), None);

        cache.put("tok2".into(), 3600, now);
        cache.clear();
        assert_eq!(cache.get(now), None);
    }

    /// `oauth_begin` debe descartar los flujos pendientes ANTES de hacer bind:
    /// un flujo abandonado retiene el listener del puerto fijo y bloqueaba el
    /// siguiente intento de conexión durante todo el plazo del callback.
    #[tokio::test]
    async fn oauth_begin_descarta_flujos_pendientes_previos() {
        let dir = std::env::temp_dir().join(format!("rustty-sync-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let manager = SyncManager::new(dir.clone());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        manager.pending_oauth.lock_recover().insert(
            "flujo-abandonado".into(),
            OAuthPending {
                provider: OAuthProvider::GoogleDrive,
                verifier: "v".into(),
                state: "s".into(),
                redirect_uri: "http://127.0.0.1:0/oauth/callback".into(),
                listener,
            },
        );

        // Puede fallar (sin client id configurado) o no: en ambos casos el
        // flujo abandonado tiene que haber sido retirado del mapa.
        let _ = manager.oauth_begin(OAuthProvider::GoogleDrive).await;
        assert!(!manager
            .pending_oauth
            .lock()
            .unwrap()
            .contains_key("flujo-abandonado"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sync_item(data: serde_json::Value, device_id: &str) -> SyncItem {
        SyncItem {
            data,
            updated_at: DateTime::parse_from_rfc3339("2026-05-08T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            device_id: device_id.to_string(),
        }
    }

    /// El backup portable cifrado (`age` + scrypt) debe hacer round-trip
    /// exacto y rechazar una passphrase incorrecta. Una regresión aquí
    /// corrompe backups en silencio.
    #[test]
    fn backup_cifrado_round_trip_y_passphrase_incorrecta() {
        let mut st = SyncState::default();
        st.items.insert(
            "prefs:bundle".into(),
            sync_item(json!({"theme": "dark"}), "dev-a"),
        );

        let bytes = pack_state("clave-123", &st).expect("cifra");
        let back = unpack_state("clave-123", &bytes).expect("descifra");
        assert!(st.content_eq(&back));

        assert!(unpack_state("clave-mala", &bytes).is_err());
        // Ciphertext truncado: error, nunca pánico.
        assert!(unpack_state("clave-123", &bytes[..bytes.len() / 2]).is_err());
    }

    #[test]
    fn content_eq_ignora_device_id() {
        let mut a = SyncState::default();
        a.items.insert(
            "prefs:bundle".into(),
            sync_item(json!({"theme": "dark"}), "device-a"),
        );

        let mut b = SyncState::default();
        b.items.insert(
            "prefs:bundle".into(),
            sync_item(json!({"theme": "dark"}), "device-b"),
        );

        assert!(a.content_eq(&b));
    }

    #[test]
    fn content_eq_ignora_los_timestamps() {
        // Mismo dato, distinto updated_at: NO es un cambio de contenido, así que
        // un push no debe archivar una versión nueva.
        let mut a = SyncState::default();
        a.items
            .insert("prefs:bundle".into(), item_en(0, json!({"theme": "dark"})));
        let mut b = SyncState::default();
        b.items.insert(
            "prefs:bundle".into(),
            item_en(999, json!({"theme": "dark"})),
        );

        assert!(a.content_eq(&b));
        assert_ne!(a, b); // la igualdad estricta sí distingue el timestamp
    }

    #[test]
    fn content_eq_detecta_cambios_de_dato() {
        let mut a = SyncState::default();
        a.items
            .insert("prefs:bundle".into(), item_en(0, json!({"theme": "dark"})));
        let mut b = SyncState::default();
        b.items
            .insert("prefs:bundle".into(), item_en(0, json!({"theme": "light"})));

        assert!(!a.content_eq(&b));
    }

    #[test]
    fn content_eq_ignora_timestamp_de_tombstone() {
        let mut a = SyncState::default();
        a.tombstones.insert("profile:x".into(), ts(0));
        let mut b = SyncState::default();
        b.tombstones.insert("profile:x".into(), ts(500));

        assert!(a.content_eq(&b));
    }

    // Construye un SyncItem con un timestamp explícito (segundos desde epoch
    // de 2026-05-08T12:00:00Z) para controlar el orden temporal en los tests
    // de merge / LWW.
    fn item_en(segundos: i64, data: serde_json::Value) -> SyncItem {
        let base = DateTime::parse_from_rfc3339("2026-05-08T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        SyncItem {
            data,
            updated_at: base + chrono::Duration::seconds(segundos),
            device_id: "device-test".to_string(),
        }
    }

    fn ts(segundos: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-05-08T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::Duration::seconds(segundos)
    }

    #[test]
    fn merge_lww_gana_el_item_mas_nuevo() {
        // Local tiene un item viejo; remoto trae el mismo key más nuevo.
        let mut local = SyncState::default();
        local
            .items
            .insert("profile:1".into(), item_en(0, json!({"v": "viejo"})));

        let mut remoto = SyncState::default();
        remoto
            .items
            .insert("profile:1".into(), item_en(10, json!({"v": "nuevo"})));

        let cambios = local.merge(remoto);
        assert_eq!(cambios, 1);
        assert_eq!(local.items["profile:1"].data, json!({"v": "nuevo"}));

        // Caso inverso: remoto trae un item más viejo → no debe pisar al local.
        let mut local2 = SyncState::default();
        local2
            .items
            .insert("profile:1".into(), item_en(10, json!({"v": "nuevo"})));
        let mut remoto2 = SyncState::default();
        remoto2
            .items
            .insert("profile:1".into(), item_en(0, json!({"v": "viejo"})));
        let cambios2 = local2.merge(remoto2);
        assert_eq!(cambios2, 0);
        assert_eq!(local2.items["profile:1"].data, json!({"v": "nuevo"}));
    }

    #[test]
    fn merge_tombstone_mas_nuevo_borra_el_item() {
        // Local tiene un item; remoto trae un tombstone más reciente.
        let mut local = SyncState::default();
        local
            .items
            .insert("profile:1".into(), item_en(0, json!({"v": "vivo"})));

        let mut remoto = SyncState::default();
        remoto.tombstones.insert("profile:1".into(), ts(10));

        let cambios = local.merge(remoto);
        assert_eq!(cambios, 1);
        assert!(!local.items.contains_key("profile:1"));
        assert_eq!(local.tombstones.get("profile:1"), Some(&ts(10)));
    }

    #[test]
    fn merge_item_mas_nuevo_que_tombstone_resucita() {
        // Local tiene un tombstone viejo; remoto trae un item más nuevo.
        // Según la lógica (beats_tomb = item > tombstone), el item resucita
        // y el tombstone se elimina.
        let mut local = SyncState::default();
        local.tombstones.insert("profile:1".into(), ts(0));

        let mut remoto = SyncState::default();
        remoto
            .items
            .insert("profile:1".into(), item_en(10, json!({"v": "renacido"})));

        let cambios = local.merge(remoto);
        assert_eq!(cambios, 1);
        assert_eq!(local.items["profile:1"].data, json!({"v": "renacido"}));
        assert!(!local.tombstones.contains_key("profile:1"));
    }

    #[test]
    fn merge_item_mas_viejo_que_tombstone_no_resucita() {
        // Local tiene un tombstone reciente; remoto trae un item más antiguo:
        // no debe resucitar (el borrado es más reciente que la edición).
        let mut local = SyncState::default();
        local.tombstones.insert("profile:1".into(), ts(10));

        let mut remoto = SyncState::default();
        remoto
            .items
            .insert("profile:1".into(), item_en(0, json!({"v": "zombi"})));

        let cambios = local.merge(remoto);
        assert_eq!(cambios, 0);
        assert!(!local.items.contains_key("profile:1"));
        assert_eq!(local.tombstones.get("profile:1"), Some(&ts(10)));
    }

    /// Un equipo con el reloj adelantado no debe fabricar items imbatibles:
    /// los `updated_at` más allá de `now + margen` se acotan al recibirlos.
    #[test]
    fn clamp_acota_timestamps_futuros() {
        let now = ts(0);
        let ceiling = now + chrono::Duration::seconds(FUTURE_TIMESTAMP_MARGIN_SECS);

        let mut st = SyncState::default();
        st.items
            .insert("profile:ok".into(), item_en(-100, json!({"v": 1})));
        st.items.insert(
            "profile:futuro".into(),
            item_en(FUTURE_TIMESTAMP_MARGIN_SECS + 3_600, json!({"v": 2})),
        );
        st.tombstones
            .insert("theme:futuro".into(), ts(FUTURE_TIMESTAMP_MARGIN_SECS + 999));
        st.tombstones.insert("theme:ok".into(), ts(-5));

        let clamped = st.clamp_future_timestamps(now);
        assert_eq!(clamped, 2);
        assert_eq!(st.items["profile:futuro"].updated_at, ceiling);
        assert_eq!(st.items["profile:ok"].updated_at, ts(-100));
        assert_eq!(st.tombstones["theme:futuro"], ceiling);
        assert_eq!(st.tombstones["theme:ok"], ts(-5));
        // Idempotente: una segunda pasada no recorta nada más.
        assert_eq!(st.clamp_future_timestamps(now), 0);
    }

    /// La poda de tombstones respeta el umbral configurable y el 0 = nunca.
    #[test]
    fn prune_tombstones_respeta_retencion() {
        let now = ts(0);
        let mut st = SyncState::default();
        st.tombstones
            .insert("profile:viejo".into(), now - chrono::Duration::days(120));
        st.tombstones
            .insert("profile:reciente".into(), now - chrono::Duration::days(10));

        // 0 = conservar siempre.
        assert_eq!(st.prune_tombstones(now, 0), 0);
        assert_eq!(st.tombstones.len(), 2);

        assert_eq!(st.prune_tombstones(now, 90), 1);
        assert!(st.tombstones.contains_key("profile:reciente"));
        assert!(!st.tombstones.contains_key("profile:viejo"));
    }

    /// El parser PROPFIND debe sobrevivir a las variantes legítimas del XML:
    /// prefijos de namespace distintos, mayúsculas, CDATA y autocerrados.
    #[test]
    fn propfind_parser_tolera_variantes() {
        // Nextcloud clásico (prefijo d:).
        let nextcloud = r#"<?xml version="1.0"?>
            <d:multistatus xmlns:d="DAV:">
              <d:response><d:href>/remote.php/dav/files/u/Rustty/rustty-sync-history/</d:href></d:response>
              <d:response><d:href>/remote.php/dav/files/u/Rustty/rustty-sync-history/rustty-sync-20260701T101010Z.bin</d:href></d:response>
            </d:multistatus>"#;
        assert_eq!(
            webdav_history_filenames(nextcloud),
            vec!["rustty-sync-20260701T101010Z.bin".to_string()]
        );

        // Prefijo D: en mayúsculas y atributos en la etiqueta (estilo IIS).
        let iis = r#"<D:multistatus xmlns:D="DAV:">
            <D:response><D:HREF xml:lang="en">/dav/rustty-sync-history/rustty-sync-20260702T090000Z.bin</D:HREF></D:response>
        </D:multistatus>"#;
        assert_eq!(
            webdav_history_filenames(iis),
            vec!["rustty-sync-20260702T090000Z.bin".to_string()]
        );

        // Sin prefijo de namespace + CDATA + href autocerrado + nombre URL-encoded.
        let raro = r#"<multistatus>
            <response><href/></response>
            <response><href><![CDATA[/dav/hist/rustty-sync-20260703T080000Z.bin]]></href></response>
            <response><href>/dav/hist/rustty-sync-20260704T070000Z%2Ebin</href></response>
            <response><href>/dav/hist/otro-fichero.txt</href></response>
        </multistatus>"#;
        assert_eq!(
            webdav_history_filenames(raro),
            vec![
                "rustty-sync-20260703T080000Z.bin".to_string(),
                "rustty-sync-20260704T070000Z.bin".to_string(),
            ]
        );

        // Cuerpos degenerados: nunca pánico.
        assert!(webdav_history_filenames("").is_empty());
        assert!(webdav_history_filenames("<no-xml").is_empty());
        assert!(webdav_history_filenames("<href>sin cierre").is_empty());
    }

    /// El primario entre blobs duplicados de Drive es determinista (id menor)
    /// para que todos los equipos converjan al mismo sin coordinarse.
    #[test]
    fn primario_de_duplicados_es_determinista() {
        let (primary, extras) =
            primary_and_duplicates(vec!["zz".into(), "aa".into(), "mm".into()]);
        assert_eq!(primary.as_deref(), Some("aa"));
        assert_eq!(extras, vec!["mm".to_string(), "zz".to_string()]);

        let (primary, extras) = primary_and_duplicates(Vec::new());
        assert!(primary.is_none());
        assert!(extras.is_empty());
    }

    #[test]
    fn estados_transitorios_reintentables() {
        assert!(is_transient_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_transient_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_transient_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!is_transient_status(StatusCode::NOT_FOUND));
        assert!(!is_transient_status(StatusCode::UNAUTHORIZED));
        assert!(!is_transient_status(StatusCode::OK));
        assert!(!is_transient_status(StatusCode::PRECONDITION_FAILED));
    }

    #[test]
    fn merge_es_idempotente() {
        // Mezclar dos veces el mismo remoto no produce cambios la segunda vez.
        let mut local = SyncState::default();
        local
            .items
            .insert("profile:1".into(), item_en(0, json!({"v": "a"})));
        local.tombstones.insert("profile:2".into(), ts(0));

        let mut remoto = SyncState::default();
        remoto
            .items
            .insert("profile:1".into(), item_en(10, json!({"v": "b"})));
        remoto.tombstones.insert("profile:3".into(), ts(5));

        let primera = local.merge(remoto.clone());
        assert!(primera > 0);
        let estado_tras_primera = local.clone();

        let segunda = local.merge(remoto);
        assert_eq!(segunda, 0);
        assert_eq!(local, estado_tras_primera);
    }
}

// ─── Cifrado (age con passphrase) ────────────────────────────────────

pub fn encrypt(passphrase: &str, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    use age::secrecy::SecretString;
    let encryptor =
        age::Encryptor::with_user_passphrase(SecretString::new(passphrase.to_string().into()));
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
    let identity = age::scrypt::Identity::new(SecretString::new(passphrase.to_string().into()));
    // El marcador permite al frontend distinguir «passphrase incorrecta»
    // (p. ej. rotada en otro equipo) de cualquier otro fallo y ofrecer el
    // flujo de actualización en vez de un error rojo genérico.
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| {
            AppError::Sync(format!(
                "{BAD_PASSPHRASE_MARKER} passphrase incorrecta o datos corruptos: {e}"
            ))
        })?;
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
        Ok(value) => {
            #[cfg(target_os = "linux")]
            {
                // The Linux combo backend can read old keyutils-only entries;
                // re-setting persists them into Secret Service as well. Basta
                // UNA vez por clave y arranque: hacerlo en cada lectura
                // reescribía el Secret Service en cada operación de Drive.
                use std::collections::HashSet;
                static REPERSISTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
                let done = REPERSISTED.get_or_init(|| Mutex::new(HashSet::new()));
                let first_read = done
                    .lock()
                    .map(|mut keys| keys.insert(key.to_string()))
                    .unwrap_or(false);
                if first_read {
                    let _ = entry.set_password(&value);
                }
            }
            Ok(Some(value))
        }
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

/// Espera el callback OAuth aceptando conexiones **en bucle** hasta recibir
/// `/oauth/callback` con el `state` correcto o agotar el plazo. Un único
/// `accept()` no basta: la preconexión especulativa del navegador (o la
/// petición del favicon) consumía la conexión y el callback real nunca se
/// atendía, con fallos intermitentes al conectar el backend.
async fn read_oauth_code(pending: OAuthPending) -> Result<String, AppError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        let accept = tokio::time::timeout_at(deadline, pending.listener.accept())
            .await
            .map_err(|_| AppError::Sync("OAuth cancelado: tiempo de espera agotado".into()))?;
        let (mut stream, _) = accept.map_err(|e| AppError::Sync(format!("oauth accept: {e}")))?;

        // Lectura acotada por conexión: una preconexión que nunca envía datos
        // no debe consumir el plazo global del callback.
        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            // Conexión muda o rota: se descarta y se sigue esperando.
            Ok(Err(_)) | Err(_) => continue,
        };
        if n == 0 {
            continue;
        }
        let req = String::from_utf8_lossy(&buf[..n]);
        let first_line = req.lines().next().unwrap_or_default();
        let target = first_line.split_whitespace().nth(1).unwrap_or_default();
        let Some(rest) = target.strip_prefix(OAUTH_CALLBACK_PATH) else {
            // Otra petición del navegador (favicon, sondas): responder y seguir.
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        };
        let query = rest.strip_prefix('?').unwrap_or_default();
        let state = query_param(query, "state").unwrap_or_default();
        let code = query_param(query, "code");
        let error = query_param(query, "error");

        if state != pending.state {
            // `state` ajeno o reutilizado: no es nuestro flujo. Se responde con
            // error y se sigue esperando el callback legítimo hasta el plazo.
            respond_oauth(&mut stream, false).await;
            continue;
        }
        respond_oauth(&mut stream, code.is_some() && error.is_none()).await;
        if let Some(error) = error {
            return Err(AppError::Sync(format!("OAuth error: {error}")));
        }
        match code {
            Some(code) => return Ok(code),
            // Callback con state correcto pero sin `code`: malformado; se
            // sigue esperando por si llega el bueno dentro del plazo.
            None => continue,
        }
    }
}

/// Respuesta mínima en texto plano al navegador que llamó al callback.
async fn respond_oauth(stream: &mut tokio::net::TcpStream, ok: bool) {
    let body = if ok {
        "Rustty ya está conectado. Puedes cerrar esta pestaña."
    } else {
        "No se pudo completar OAuth en Rustty. Vuelve a la app e inténtalo de nuevo."
    };
    let status = if ok { "200 OK" } else { "400 Bad Request" };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    /// Segundos de vida del access token (Google: ~3600).
    expires_in: Option<u64>,
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
    /// Todas las copias del estado remoto (normalmente una). Los backends
    /// donde una carrera de primera sync puede dejar duplicados (Drive)
    /// devuelven todas para que el llamador las fusione; el resto delega en
    /// `read`.
    async fn read_all(&self) -> Result<Vec<Vec<u8>>, AppError> {
        Ok(self.read().await?.into_iter().collect())
    }
    async fn archive_existing(&self, _keep: usize) -> Result<(), AppError> {
        Ok(())
    }
    async fn write(&self, data: &[u8]) -> Result<(), AppError>;
    async fn list_snapshots(&self) -> Result<Vec<SnapshotEntry>, AppError> {
        Ok(Vec::new())
    }
    async fn read_snapshot(&self, _id: &str) -> Result<Option<Vec<u8>>, AppError> {
        Ok(None)
    }
    /// Reescribe un snapshot histórico existente (rotación de passphrase).
    async fn write_snapshot(&self, _id: &str, _data: &[u8]) -> Result<(), AppError> {
        Err(AppError::Sync(
            "Este backend no soporta reescribir snapshots".into(),
        ))
    }
    /// Elimina del remoto el blob de estado y todo el histórico (privacidad:
    /// «Eliminar datos del servidor» al desactivar la sincronización).
    async fn wipe(&self) -> Result<(), AppError>;
    /// Hora del servidor observada en la última lectura (header `Date`), para
    /// avisar de relojes locales muy desviados. `None` si no aplica (local).
    fn observed_server_time(&self) -> Option<DateTime<Utc>> {
        None
    }
}

/// Metadatos de una copia histórica disponible en el backend remoto.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotEntry {
    /// Identificador opaco para el backend (ruta absoluta, file id de Drive,
    /// nombre WebDAV…). El frontend solo lo guarda como `value` del select.
    pub id: String,
    /// Nombre legible para el usuario (timestamp formateado).
    pub label: String,
    /// Timestamp ISO 8601 si el backend lo expone.
    pub modified: Option<String>,
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
        // Fuente única de escritura atómica (temporal único + rename + fsync):
        // el tmp+rename manual anterior no hacía fsync y usaba un nombre
        // temporal fijo (colisión entre dos procesos escribiendo a la vez).
        let path = self.path.clone();
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || crate::atomic_file::write(&path, &data, false))
            .await
            .map_err(|e| AppError::Sync(format!("escribir remoto local: {e}")))?
            .map_err(|e| AppError::Sync(format!("escribir remoto local: {e}")))?;
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

    async fn list_snapshots(&self) -> Result<Vec<SnapshotEntry>, AppError> {
        let Some(parent) = self.path.parent() else {
            return Ok(Vec::new());
        };
        let history = parent.join(HISTORY_DIR);
        let mut dir = match tokio::fs::read_dir(&history).await {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()),
        };
        let mut out = Vec::new();
        while let Some(entry) = dir
            .next_entry()
            .await
            .map_err(|e| AppError::Sync(format!("leer histórico local: {e}")))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("rustty-sync-") || !name.ends_with(".bin") {
                continue;
            }
            let modified = entry
                .metadata()
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| {
                    let dur = t.duration_since(std::time::UNIX_EPOCH).ok()?;
                    Some(DateTime::<Utc>::from_timestamp(dur.as_secs() as i64, 0)?.to_rfc3339())
                });
            out.push(SnapshotEntry {
                id: entry.path().to_string_lossy().into_owned(),
                label: snapshot_label_from_filename(&name),
                modified,
            });
        }
        out.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(out)
    }

    async fn read_snapshot(&self, id: &str) -> Result<Option<Vec<u8>>, AppError> {
        // Validamos que el `id` esté dentro de nuestro HISTORY_DIR para evitar
        // que un valor manipulado lea un fichero arbitrario.
        let target = self.snapshot_path_checked(id)?;
        if !target.exists() {
            return Ok(None);
        }
        let bytes = tokio::fs::read(&target)
            .await
            .map_err(|e| AppError::Sync(format!("leer snapshot local: {e}")))?;
        Ok(Some(bytes))
    }

    async fn write_snapshot(&self, id: &str, data: &[u8]) -> Result<(), AppError> {
        let target = self.snapshot_path_checked(id)?;
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || crate::atomic_file::write(&target, &data, false))
            .await
            .map_err(|e| AppError::Sync(format!("reescribir snapshot local: {e}")))?
            .map_err(|e| AppError::Sync(format!("reescribir snapshot local: {e}")))?;
        Ok(())
    }

    async fn wipe(&self) -> Result<(), AppError> {
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::Sync(format!("borrar remoto local: {e}"))),
        }
        if let Some(parent) = self.path.parent() {
            let history = parent.join(HISTORY_DIR);
            match tokio::fs::remove_dir_all(&history).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(AppError::Sync(format!("borrar histórico local: {e}"))),
            }
        }
        Ok(())
    }
}

impl LocalBackend {
    /// Ruta del snapshot `id` verificando que quede dentro del HISTORY_DIR.
    fn snapshot_path_checked(&self, id: &str) -> Result<PathBuf, AppError> {
        let Some(parent) = self.path.parent() else {
            return Err(AppError::Sync(
                "Snapshot fuera del directorio histórico".into(),
            ));
        };
        let history = parent.join(HISTORY_DIR);
        let target = PathBuf::from(id);
        if target.parent() != Some(history.as_path()) {
            return Err(AppError::Sync(
                "Snapshot fuera del directorio histórico".into(),
            ));
        }
        Ok(target)
    }
}

fn snapshot_label_from_filename(name: &str) -> String {
    // rustty-sync-YYYYMMDDTHHMMSSZ.bin → "YYYY-MM-DD HH:MM:SS UTC"
    let stripped = name
        .strip_prefix("rustty-sync-")
        .and_then(|s| s.strip_suffix(".bin"))
        .unwrap_or(name);
    if stripped.len() == 16 && stripped.as_bytes().get(8) == Some(&b'T') {
        let date = &stripped[..8];
        let time = &stripped[9..15];
        format!(
            "{}-{}-{} {}:{}:{} UTC",
            &date[..4],
            &date[4..6],
            &date[6..8],
            &time[..2],
            &time[2..4],
            &time[4..6],
        )
    } else {
        stripped.to_string()
    }
}

pub struct WebDavBackend {
    pub url: String,
    pub username: String,
    pub password: String,
    /// ETag del último GET del estado: el PUT posterior viaja con `If-Match`
    /// para no pisar en silencio un push ajeno entre nuestro read y write.
    etag: Mutex<Option<String>>,
    /// Hora del servidor (header `Date`) de la última lectura.
    server_time: Mutex<Option<DateTime<Utc>>>,
}

impl WebDavBackend {
    pub fn new(url: String, username: String, password: String) -> Self {
        Self {
            url,
            username,
            password,
            etag: Mutex::new(None),
            server_time: Mutex::new(None),
        }
    }
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
        let client = http_client(20)?;
        let resp = send_with_retry(
            client
                .get(&self.url)
                .basic_auth(&self.username, Some(&self.password)),
            "webdav GET",
        )
        .await?;
        if let (Some(t), Ok(mut slot)) = (response_server_time(&resp), self.server_time.lock()) {
            *slot = Some(t);
        }
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            if let Ok(mut etag) = self.etag.lock() {
                *etag = None;
            }
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "webdav GET status: {}",
                resp.status()
            )));
        }
        // ETag para la escritura condicional posterior de este mismo ciclo.
        let etag_value = resp
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if let Ok(mut etag) = self.etag.lock() {
            *etag = etag_value;
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Sync(format!("webdav body: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn write(&self, data: &[u8]) -> Result<(), AppError> {
        let client = http_client(30)?;
        // Escritura condicional: si otro equipo empujó entre nuestro GET y
        // este PUT, el servidor responde 412 y el llamador re-lee y re-mezcla
        // (sin esto el push ajeno se pisaba en silencio; LWW lo acababa
        // autocorrigiendo, pero el histórico podía archivar un estado pisado).
        // Nota: Drive no soporta PUT condicional de contenido — este guard es
        // exclusivo de WebDAV.
        let etag = self.etag.lock().ok().and_then(|e| e.clone());
        let build_put = |client: &reqwest::Client| {
            let mut put = client
                .put(&self.url)
                .basic_auth(&self.username, Some(&self.password))
                .body(data.to_vec());
            if let Some(tag) = &etag {
                put = put.header(reqwest::header::IF_MATCH, tag);
            }
            put
        };
        let put = send_with_retry(build_put(&client), "webdav PUT").await?;
        if put.status() == StatusCode::PRECONDITION_FAILED {
            return Err(AppError::Sync(format!(
                "{CONFLICT_MARKER} webdav PUT: el estado remoto cambió durante la sincronización"
            )));
        }
        if put.status() == reqwest::StatusCode::CONFLICT {
            // Asegura que el directorio padre exista (Nextcloud crea recursivo,
            // los WebDAV genéricos no — MKCOL best-effort y reintento del PUT).
            if let Some((parent_url, _)) = self.url.rsplit_once('/') {
                let _ = send_with_retry(
                    client
                        .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), parent_url)
                        .basic_auth(&self.username, Some(&self.password)),
                    "webdav MKCOL",
                )
                .await;
                let retry = send_with_retry(build_put(&client), "webdav PUT retry").await?;
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
        let client = http_client(30)?;
        let _ = send_with_retry(
            client
                .request(
                    reqwest::Method::from_bytes(b"MKCOL").unwrap(),
                    format!("{}/{}", base, urlencoding::encode(HISTORY_DIR)),
                )
                .basic_auth(&self.username, Some(&self.password)),
            "webdav histórico MKCOL",
        )
        .await;
        let put = send_with_retry(
            client
                .put(history_url)
                .basic_auth(&self.username, Some(&self.password))
                .body(bytes),
            "webdav histórico PUT",
        )
        .await?;
        if !put.status().is_success() {
            return Err(AppError::Sync(format!(
                "webdav histórico PUT status: {}",
                put.status()
            )));
        }
        prune_webdav_history(&client, base, &self.username, &self.password, keep).await?;
        Ok(())
    }

    async fn list_snapshots(&self) -> Result<Vec<SnapshotEntry>, AppError> {
        let Some((base, _)) = self.url.rsplit_once('/') else {
            return Ok(Vec::new());
        };
        let client = http_client(20)?;
        let history_base = format!("{}/{}", base, urlencoding::encode(HISTORY_DIR));
        let resp = send_with_retry(
            client
                .request(
                    reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
                    &history_base,
                )
                .basic_auth(&self.username, Some(&self.password))
                .header("Depth", "1"),
            "webdav snapshots PROPFIND",
        )
        .await?;
        if !resp.status().is_success() {
            return Ok(Vec::new());
        }
        let body = resp
            .text()
            .await
            .map_err(|e| AppError::Sync(format!("webdav snapshots body: {e}")))?;
        let mut names = webdav_history_filenames(&body);
        names.sort();
        names.reverse();
        Ok(names
            .into_iter()
            .map(|name| SnapshotEntry {
                label: snapshot_label_from_filename(&name),
                modified: None,
                id: name,
            })
            .collect())
    }

    async fn read_snapshot(&self, id: &str) -> Result<Option<Vec<u8>>, AppError> {
        let url = self.snapshot_url_checked(id)?;
        let client = http_client(30)?;
        let resp = send_with_retry(
            client
                .get(&url)
                .basic_auth(&self.username, Some(&self.password)),
            "webdav snapshot GET",
        )
        .await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "webdav snapshot GET status: {}",
                resp.status()
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Sync(format!("webdav snapshot body: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn write_snapshot(&self, id: &str, data: &[u8]) -> Result<(), AppError> {
        let url = self.snapshot_url_checked(id)?;
        let client = http_client(30)?;
        let put = send_with_retry(
            client
                .put(&url)
                .basic_auth(&self.username, Some(&self.password))
                .body(data.to_vec()),
            "webdav snapshot PUT",
        )
        .await?;
        if !put.status().is_success() {
            return Err(AppError::Sync(format!(
                "webdav snapshot PUT status: {}",
                put.status()
            )));
        }
        Ok(())
    }

    async fn wipe(&self) -> Result<(), AppError> {
        let client = http_client(30)?;
        // Blob principal (404 = ya no existe: objetivo cumplido).
        let del = send_with_retry(
            client
                .delete(&self.url)
                .basic_auth(&self.username, Some(&self.password)),
            "webdav DELETE",
        )
        .await?;
        if !del.status().is_success() && del.status() != StatusCode::NOT_FOUND {
            return Err(AppError::Sync(format!(
                "webdav DELETE status: {}",
                del.status()
            )));
        }
        // Histórico completo: DELETE de la colección (recursivo en WebDAV).
        if let Some((base, _)) = self.url.rsplit_once('/') {
            let history = format!("{}/{}", base, urlencoding::encode(HISTORY_DIR));
            let del = send_with_retry(
                client
                    .delete(&history)
                    .basic_auth(&self.username, Some(&self.password)),
                "webdav histórico DELETE",
            )
            .await?;
            if !del.status().is_success() && del.status() != StatusCode::NOT_FOUND {
                return Err(AppError::Sync(format!(
                    "webdav histórico DELETE status: {}",
                    del.status()
                )));
            }
        }
        if let Ok(mut etag) = self.etag.lock() {
            *etag = None;
        }
        Ok(())
    }

    fn observed_server_time(&self) -> Option<DateTime<Utc>> {
        self.server_time.lock().ok().and_then(|t| *t)
    }
}

impl WebDavBackend {
    /// URL del snapshot `id` validando el patrón de nombre esperado.
    fn snapshot_url_checked(&self, id: &str) -> Result<String, AppError> {
        if !id.starts_with("rustty-sync-") || !id.ends_with(".bin") {
            return Err(AppError::Sync("Identificador de snapshot inválido".into()));
        }
        let Some((base, _)) = self.url.rsplit_once('/') else {
            return Err(AppError::Sync("URL WebDAV sin ruta base".into()));
        };
        Ok(format!(
            "{}/{}/{}",
            base,
            urlencoding::encode(HISTORY_DIR),
            urlencoding::encode(id)
        ))
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
    let resp = send_with_retry(
        client
            .request(
                reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
                &history_base,
            )
            .basic_auth(username, Some(password))
            .header("Depth", "1"),
        "webdav histórico PROPFIND",
    )
    .await?;
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
        let _ = send_with_retry(
            client.delete(url).basic_auth(username, Some(password)),
            "webdav histórico DELETE",
        )
        .await;
    }
    Ok(())
}

/// Extrae los nombres de snapshot de un cuerpo PROPFIND.
///
/// Parser tolerante en vez de la búsqueda literal de `href>` anterior, que
/// funcionaba con Nextcloud/ownCloud pero rompía con variantes legítimas del
/// XML: prefijos de namespace distintos de `d:` (`D:`, ninguno, `ns0:`),
/// mayúsculas, atributos en la etiqueta, contenido en CDATA o `<href/>`
/// autocerrado. No pretende ser un parser XML general: solo localizar los
/// elementos `href` (con cualquier prefijo) y quedarse con los nombres que
/// sigan el patrón de snapshot.
fn webdav_history_filenames(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for href in xml_element_texts(body, "href") {
        if let Some(raw_name) = href.trim().rsplit('/').find(|part| !part.is_empty()) {
            let decoded = urlencoding::decode(raw_name)
                .map(|value| value.into_owned())
                .unwrap_or_else(|_| raw_name.to_string());
            if decoded.starts_with("rustty-sync-") && decoded.ends_with(".bin") {
                out.push(decoded);
            }
        }
    }
    out
}

/// Devuelve el texto de cada elemento `<[ns:]local ...>texto</[ns:]local>`
/// del XML, ignorando namespace y mayúsculas. Los autocerrados (`<href/>`)
/// cuentan como vacíos y el contenido `<![CDATA[...]]>` se desenvuelve.
fn xml_element_texts(xml: &str, local_name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        rest = &rest[start + 1..];
        let Some(tag_end) = rest.find('>') else { break };
        let tag = &rest[..tag_end];
        rest = &rest[tag_end + 1..];
        // Descartar cierres, comentarios, declaraciones y CDATA sueltos.
        if tag.starts_with('/') || tag.starts_with('!') || tag.starts_with('?') {
            continue;
        }
        let self_closing = tag.ends_with('/');
        let tag_name = tag
            .trim_end_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("");
        if !xml_name_matches(tag_name, local_name) {
            continue;
        }
        if self_closing {
            out.push(String::new());
            continue;
        }
        // Texto hasta la etiqueta de cierre correspondiente (mismo local name).
        let mut text = String::new();
        let mut cursor = rest;
        while let Some(lt) = cursor.find('<') {
            text.push_str(&cursor[..lt]);
            cursor = &cursor[lt + 1..];
            if let Some(cdata) = cursor.strip_prefix("![CDATA[") {
                let Some(end) = cdata.find("]]>") else { break };
                text.push_str(&cdata[..end]);
                cursor = &cdata[end + 3..];
                continue;
            }
            let Some(close_end) = cursor.find('>') else { break };
            let close_tag = &cursor[..close_end];
            cursor = &cursor[close_end + 1..];
            if let Some(name) = close_tag.strip_prefix('/') {
                if xml_name_matches(name.trim(), local_name) {
                    out.push(text);
                    break;
                }
            }
            // Cualquier otra etiqueta anidada se ignora (href no las tiene).
        }
        rest = cursor;
    }
    out
}

/// Compara el nombre de una etiqueta XML con un local name, ignorando el
/// prefijo de namespace (`d:href`, `D:HREF`, `href` → `href`).
fn xml_name_matches(tag_name: &str, local_name: &str) -> bool {
    let local = tag_name.rsplit(':').next().unwrap_or(tag_name);
    local.eq_ignore_ascii_case(local_name)
}

/// Cliente HTTP compartido de todo el módulo de sync. Construir un
/// `reqwest::Client` por operación tiraba el pool de conexiones (TLS handshake
/// nuevo en cada llamada a Drive/WebDAV); `Client` es un `Arc` por dentro y
/// clonarlo es barato. El timeout fino por petición se ajusta con
/// `RequestBuilder::timeout` donde haga falta.
fn http_client(timeout_secs: u64) -> Result<reqwest::Client, AppError> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let _ = timeout_secs; // el timeout de cliente es global; 30 s cubre todos los usos
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let built = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Sync(format!("http client: {e}")))?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

// ─── Reintentos con backoff y clasificación de errores de red ────────

/// Esperas entre reintentos ante errores transitorios (backoff exponencial).
const HTTP_RETRY_DELAYS_MS: [u64; 2] = [500, 2000];

/// Estados HTTP transitorios que merecen reintento (throttling y 5xx).
fn is_transient_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

/// Fallos de conectividad (DNS/connect/timeout): además de reintentables, el
/// frontend los muestra como estado «sin conexión», no como error rojo.
fn is_connectivity_error(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout()
}

fn net_err(what: &str, e: reqwest::Error) -> AppError {
    if is_connectivity_error(&e) {
        AppError::Sync(format!("{OFFLINE_MARKER} {what}: {e}"))
    } else {
        AppError::Sync(format!("{what}: {e}"))
    }
}

/// Envía la petición reintentando ante errores transitorios (429, 5xx,
/// timeout/connect) con backoff exponencial. Antes, un microcorte de red o un
/// throttling puntual abortaba el `sync_run` entero hasta el siguiente ciclo.
/// El último intento devuelve la respuesta tal cual (el llamador valida el
/// status como siempre). PUT/GET/PROPFIND son idempotentes; el único POST con
/// efectos (crear en Drive) queda cubierto por la deduplicación de blobs.
async fn send_with_retry(
    req: reqwest::RequestBuilder,
    what: &str,
) -> Result<reqwest::Response, AppError> {
    for delay_ms in HTTP_RETRY_DELAYS_MS {
        // Un cuerpo no clonable (stream) no admite reintento: envío único.
        let Some(attempt) = req.try_clone() else { break };
        match attempt.send().await {
            Ok(resp) if !is_transient_status(resp.status()) => return Ok(resp),
            Ok(_transient) => {}
            Err(e) if is_connectivity_error(&e) => {}
            Err(e) => return Err(net_err(what, e)),
        }
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
    req.send().await.map_err(|e| net_err(what, e))
}

/// Hora del servidor según el header `Date` de la respuesta (RFC 2822).
fn response_server_time(resp: &reqwest::Response) -> Option<DateTime<Utc>> {
    let raw = resp.headers().get(reqwest::header::DATE)?.to_str().ok()?;
    DateTime::parse_from_rfc2822(raw)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

// ─── Caché del access token OAuth ────────────────────────────────────
//
// Google devuelve access tokens con ~1 h de vida; refrescarlo en CADA
// operación (read, write, archive, list) convertía un `sync_run` en 3-4
// round-trips extra al token endpoint. Se cachea en memoria de proceso con su
// `expires_in` y un margen de seguridad.

const TOKEN_EXPIRY_MARGIN: Duration = Duration::from_secs(60);

#[derive(Default)]
struct TokenCache {
    token: Option<(String, Instant)>,
}

impl TokenCache {
    /// Devuelve el token si sigue siendo válido en `now` (con margen).
    fn get(&self, now: Instant) -> Option<String> {
        match &self.token {
            Some((token, expiry)) if now + TOKEN_EXPIRY_MARGIN < *expiry => Some(token.clone()),
            _ => None,
        }
    }

    fn put(&mut self, token: String, expires_in_secs: u64, now: Instant) {
        self.token = Some((token, now + Duration::from_secs(expires_in_secs)));
    }

    fn clear(&mut self) {
        self.token = None;
    }
}

fn google_token_cache() -> &'static Mutex<TokenCache> {
    static CACHE: OnceLock<Mutex<TokenCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(TokenCache::default()))
}

/// `file_id` de `rustty-sync.bin` en el appDataFolder de Drive. El id es
/// estable mientras exista el fichero; relistarlo en cada read/write eran 1-2
/// `files.list` de más por ciclo. Se invalida ante 404 y al (des)conectar.
fn google_file_id_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn clear_google_file_id_cache() {
    if let Ok(mut cache) = google_file_id_cache().lock() {
        *cache = None;
    }
}

fn clear_google_caches() {
    if let Ok(mut cache) = google_token_cache().lock() {
        cache.clear();
    }
    clear_google_file_id_cache();
}

async fn refresh_oauth_access_token(
    provider: OAuthProvider,
    config: &SyncConfig,
) -> Result<String, AppError> {
    // Caché en memoria: evita un round-trip al token endpoint por operación.
    if let Ok(cache) = google_token_cache().lock() {
        if let Some(token) = cache.get(Instant::now()) {
            return Ok(token);
        }
    }
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
    let token: TokenResponse = send_with_retry(client.post(token_url).form(&params), "refresh OAuth")
        .await?
        .json()
        .await
        .map_err(|e| AppError::Sync(format!("refresh OAuth json: {e}")))?;
    if let Some(access_token) = token.access_token {
        if let Ok(mut cache) = google_token_cache().lock() {
            cache.put(
                access_token.clone(),
                token.expires_in.unwrap_or(3600),
                Instant::now(),
            );
        }
        Ok(access_token)
    } else if token.error.as_deref() == Some("invalid_grant") {
        // El usuario revocó el acceso (o el refresh token caducó): sin esto,
        // cada sync fallaba para siempre con el error crudo del endpoint.
        // Se limpia el token y se deja el proveedor como desconectado con un
        // mensaje accionable.
        let _ = keyring_delete_secret(&oauth_refresh_key(provider));
        clear_google_caches();
        Err(AppError::Sync(
            "La autorización de Google Drive fue revocada o ha caducado. \
             Vuelve a conectar la cuenta en Preferencias → Copias de seguridad."
                .into(),
        ))
    } else {
        Err(token_error(provider, &token))
    }
}

pub struct GoogleDriveBackend {
    pub config: SyncConfig,
    /// Ids de blobs de estado duplicados detectados al listar (dos equipos
    /// haciendo su primera sync a la vez creaban ambos el fichero). Se
    /// retiran del Drive tras el siguiente `write` correcto.
    duplicates: Mutex<Vec<String>>,
    /// Hora del servidor (header `Date`) de la última llamada a la API.
    server_time: Mutex<Option<DateTime<Utc>>>,
}

/// Primario determinista entre varios blobs de estado: el de id menor. Todos
/// los equipos eligen el mismo sin depender de relojes ni del orden (no
/// garantizado) de `files.list`; el resto son duplicados a fusionar y borrar.
fn primary_and_duplicates(mut ids: Vec<String>) -> (Option<String>, Vec<String>) {
    ids.sort();
    let mut iter = ids.into_iter();
    let primary = iter.next();
    (primary, iter.collect())
}

impl GoogleDriveBackend {
    pub fn new(config: SyncConfig) -> Self {
        Self {
            config,
            duplicates: Mutex::new(Vec::new()),
            server_time: Mutex::new(None),
        }
    }

    async fn access_token(&self) -> Result<String, AppError> {
        refresh_oauth_access_token(OAuthProvider::GoogleDrive, &self.config).await
    }

    fn note_server_time(&self, resp: &reqwest::Response) {
        if let (Some(t), Ok(mut slot)) = (response_server_time(resp), self.server_time.lock()) {
            *slot = Some(t);
        }
    }

    /// Ids de **todos** los `rustty-sync.bin` del appDataFolder (normalmente
    /// uno; más de uno = carrera de primera sync entre equipos).
    async fn list_state_file_ids(
        &self,
        client: &reqwest::Client,
        token: &str,
    ) -> Result<Vec<String>, AppError> {
        let q = format!(
            "name='{}' and 'appDataFolder' in parents and trashed=false",
            STATE_FILENAME
        );
        let resp = send_with_retry(
            client
                .get("https://www.googleapis.com/drive/v3/files")
                .bearer_auth(token)
                .query(&[
                    ("spaces", "appDataFolder"),
                    ("fields", "files(id,name)"),
                    ("q", q.as_str()),
                ]),
            "google files.list",
        )
        .await?;
        self.note_server_time(&resp);
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
            .into_iter()
            .flatten()
            .filter_map(|v| v.get("id").and_then(|id| id.as_str()))
            .map(str::to_string)
            .collect())
    }

    /// Id del blob primario, cacheado. Si el listado revela duplicados, los
    /// registra para retirarlos tras el próximo write.
    async fn file_id(
        &self,
        client: &reqwest::Client,
        token: &str,
    ) -> Result<Option<String>, AppError> {
        if let Ok(cache) = google_file_id_cache().lock() {
            if let Some(id) = cache.as_ref() {
                return Ok(Some(id.clone()));
            }
        }
        let ids = self.list_state_file_ids(client, token).await?;
        let (primary, extras) = primary_and_duplicates(ids);
        if !extras.is_empty() {
            if let Ok(mut dupes) = self.duplicates.lock() {
                dupes.extend(extras);
            }
        }
        if let (Some(id), Ok(mut cache)) = (primary.as_ref(), google_file_id_cache().lock()) {
            *cache = Some(id.clone());
        }
        Ok(primary)
    }

    /// Descarga el contenido de un fichero por id (`None` si ya no existe).
    async fn download_by_id(
        &self,
        client: &reqwest::Client,
        token: &str,
        id: &str,
        what: &str,
    ) -> Result<Option<Vec<u8>>, AppError> {
        let url = format!("https://www.googleapis.com/drive/v3/files/{id}");
        let resp = send_with_retry(
            client.get(url).bearer_auth(token).query(&[("alt", "media")]),
            what,
        )
        .await?;
        self.note_server_time(&resp);
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!("{what} status: {}", resp.status())));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Sync(format!("{what} body: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    /// Crea un fichero nuevo en el appDataFolder y devuelve su id.
    async fn upload_named(
        &self,
        client: &reqwest::Client,
        token: &str,
        name: &str,
        data: &[u8],
    ) -> Result<String, AppError> {
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
        let resp = send_with_retry(
            client
                .post("https://www.googleapis.com/upload/drive/v3/files")
                .bearer_auth(token)
                .query(&[("uploadType", "multipart"), ("fields", "id")])
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/related; boundary={boundary}"),
                )
                .body(body),
            "google create",
        )
        .await?;
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "google create status: {}",
                resp.status()
            )));
        }
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Sync(format!("google create json: {e}")))?;
        value
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| AppError::Sync("google create: respuesta sin id".into()))
    }

    /// Actualiza el contenido de un fichero existente por id.
    /// `Ok(false)` = el id ya no existe (404).
    async fn update_by_id(
        &self,
        client: &reqwest::Client,
        token: &str,
        id: &str,
        data: &[u8],
    ) -> Result<bool, AppError> {
        let url = format!("https://www.googleapis.com/upload/drive/v3/files/{id}");
        let resp = send_with_retry(
            client
                .patch(url)
                .bearer_auth(token)
                .query(&[("uploadType", "media")])
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(data.to_vec()),
            "google update",
        )
        .await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "google update status: {}",
                resp.status()
            )));
        }
        Ok(true)
    }

    async fn delete_by_id(&self, client: &reqwest::Client, token: &str, id: &str) {
        let _ = send_with_retry(
            client
                .delete(format!("https://www.googleapis.com/drive/v3/files/{id}"))
                .bearer_auth(token),
            "google delete",
        )
        .await;
    }

    /// Retira los blobs duplicados registrados (best-effort, tras un write
    /// correcto: su contenido ya está fusionado en el primario).
    async fn cleanup_duplicates(&self, client: &reqwest::Client, token: &str) {
        let extras: Vec<String> = match self.duplicates.lock() {
            Ok(mut dupes) => dupes.drain(..).collect(),
            Err(_) => Vec::new(),
        };
        for id in extras {
            self.delete_by_id(client, token, &id).await;
        }
    }

    async fn history_files(
        &self,
        client: &reqwest::Client,
        token: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        let prefix = format!("{}-rustty-sync-", HISTORY_DIR);
        let q = format!(
            "name contains '{}' and 'appDataFolder' in parents and trashed=false",
            prefix
        );
        let resp = send_with_retry(
            client
                .get("https://www.googleapis.com/drive/v3/files")
                .bearer_auth(token)
                .query(&[
                    ("spaces", "appDataFolder"),
                    ("fields", "files(id,name)"),
                    ("q", q.as_str()),
                ]),
            "google history list",
        )
        .await?;
        if !resp.status().is_success() {
            return Err(AppError::Sync(format!(
                "google history list status: {}",
                resp.status()
            )));
        }
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Sync(format!("google history json: {e}")))?;
        Ok(value
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
            .collect())
    }

    async fn prune_history(
        &self,
        client: &reqwest::Client,
        token: &str,
        keep: usize,
    ) -> Result<(), AppError> {
        let mut files = match self.history_files(client, token).await {
            Ok(files) => files,
            Err(_) => return Ok(()), // poda best-effort, como siempre
        };
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let delete_count = files.len().saturating_sub(keep);
        for (_, id) in files.into_iter().take(delete_count) {
            self.delete_by_id(client, token, &id).await;
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
        let bytes = self
            .download_by_id(&client, &token, &id, "google download")
            .await?;
        if bytes.is_none() {
            // El fichero cacheado ya no existe (borrado desde otro equipo).
            if let Ok(mut cache) = google_file_id_cache().lock() {
                *cache = None;
            }
        }
        Ok(bytes)
    }

    async fn read_all(&self) -> Result<Vec<Vec<u8>>, AppError> {
        let client = http_client(30)?;
        let token = self.access_token().await?;

        // Camino rápido: id cacheado (ciclo normal con un único blob). Los
        // duplicados solo nacen de una carrera de *primera* sync, y el equipo
        // sin caché los detecta al listar; no merece un files.list por ciclo.
        let cached = google_file_id_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.clone());
        if let Some(id) = cached {
            match self
                .download_by_id(&client, &token, &id, "google download")
                .await?
            {
                Some(bytes) => return Ok(vec![bytes]),
                None => {
                    if let Ok(mut cache) = google_file_id_cache().lock() {
                        *cache = None;
                    }
                }
            }
        }

        let ids = self.list_state_file_ids(&client, &token).await?;
        let (primary, extras) = primary_and_duplicates(ids);
        if !extras.is_empty() {
            if let Ok(mut dupes) = self.duplicates.lock() {
                dupes.extend(extras.iter().cloned());
            }
        }
        let Some(primary) = primary else {
            return Ok(Vec::new());
        };
        if let Ok(mut cache) = google_file_id_cache().lock() {
            *cache = Some(primary.clone());
        }
        let mut blobs = Vec::new();
        for id in std::iter::once(&primary).chain(extras.iter()) {
            if let Some(bytes) = self
                .download_by_id(&client, &token, id, "google download")
                .await?
            {
                blobs.push(bytes);
            }
        }
        Ok(blobs)
    }

    async fn write(&self, data: &[u8]) -> Result<(), AppError> {
        let client = http_client(30)?;
        let token = self.access_token().await?;
        if let Some(id) = self.file_id(&client, &token).await? {
            if self.update_by_id(&client, &token, &id, data).await? {
                self.cleanup_duplicates(&client, &token).await;
                return Ok(());
            }
            // id cacheado obsoleto: invalidar y crear el fichero de cero.
            if let Ok(mut cache) = google_file_id_cache().lock() {
                *cache = None;
            }
        }

        let created = self
            .upload_named(&client, &token, STATE_FILENAME, data)
            .await?;
        // Detección de carrera: si otro equipo creó su blob a la vez, tras
        // nuestro create hay más de un fichero. Todos los equipos eligen el
        // mismo primario determinista (id menor); quien no lo creó vuelca su
        // estado en él y borra el suyo. El equipo del blob retirado no pierde
        // nada de forma permanente: reconstruye su estado desde los datos
        // locales y lo re-empuja en su siguiente ciclo.
        let ids = self.list_state_file_ids(&client, &token).await?;
        let (primary, extras) = primary_and_duplicates(ids);
        match primary {
            Some(primary) if primary != created => {
                if self.update_by_id(&client, &token, &primary, data).await? {
                    self.delete_by_id(&client, &token, &created).await;
                }
                if let Ok(mut cache) = google_file_id_cache().lock() {
                    *cache = Some(primary);
                }
            }
            Some(primary) => {
                for extra in extras {
                    self.delete_by_id(&client, &token, &extra).await;
                }
                if let Ok(mut cache) = google_file_id_cache().lock() {
                    *cache = Some(primary);
                }
            }
            None => {}
        }
        self.cleanup_duplicates(&client, &token).await;
        Ok(())
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

    async fn list_snapshots(&self) -> Result<Vec<SnapshotEntry>, AppError> {
        let client = http_client(20)?;
        let token = self.access_token().await?;
        let prefix = format!("{}-rustty-sync-", HISTORY_DIR);
        let q = format!(
            "name contains '{}' and 'appDataFolder' in parents and trashed=false",
            prefix
        );
        let resp = send_with_retry(
            client
                .get("https://www.googleapis.com/drive/v3/files")
                .bearer_auth(&token)
                .query(&[
                    ("spaces", "appDataFolder"),
                    ("fields", "files(id,name,modifiedTime)"),
                    ("q", q.as_str()),
                    ("pageSize", "200"),
                ]),
            "google snapshots list",
        )
        .await?;
        if !resp.status().is_success() {
            return Ok(Vec::new());
        }
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Sync(format!("google snapshots json: {e}")))?;
        let mut out: Vec<SnapshotEntry> = value
            .get("files")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|file| {
                let name = file.get("name")?.as_str()?.to_string();
                let id = file.get("id")?.as_str()?.to_string();
                let modified = file
                    .get("modifiedTime")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let label_src = name
                    .strip_prefix(&format!("{}-", HISTORY_DIR))
                    .unwrap_or(&name)
                    .to_string();
                Some(SnapshotEntry {
                    id,
                    label: snapshot_label_from_filename(&label_src),
                    modified,
                })
            })
            .collect();
        out.sort_by(|a, b| b.label.cmp(&a.label));
        Ok(out)
    }

    async fn read_snapshot(&self, id: &str) -> Result<Option<Vec<u8>>, AppError> {
        if id.is_empty() || id.contains('/') {
            return Err(AppError::Sync("Identificador de snapshot inválido".into()));
        }
        let client = http_client(30)?;
        let token = self.access_token().await?;
        self.download_by_id(&client, &token, id, "google snapshot download")
            .await
    }

    async fn write_snapshot(&self, id: &str, data: &[u8]) -> Result<(), AppError> {
        if id.is_empty() || id.contains('/') {
            return Err(AppError::Sync("Identificador de snapshot inválido".into()));
        }
        let client = http_client(30)?;
        let token = self.access_token().await?;
        if !self.update_by_id(&client, &token, id, data).await? {
            return Err(AppError::Sync("Snapshot no encontrado".into()));
        }
        Ok(())
    }

    async fn wipe(&self) -> Result<(), AppError> {
        let client = http_client(30)?;
        let token = self.access_token().await?;
        // Todos los blobs de estado (incluidos posibles duplicados) y todo el
        // histórico. Best-effort fichero a fichero; el appDataFolder en sí lo
        // gestiona Google.
        for id in self.list_state_file_ids(&client, &token).await? {
            self.delete_by_id(&client, &token, &id).await;
        }
        for (_, id) in self.history_files(&client, &token).await? {
            self.delete_by_id(&client, &token, &id).await;
        }
        clear_google_file_id_cache();
        Ok(())
    }

    fn observed_server_time(&self) -> Option<DateTime<Utc>> {
        self.server_time.lock().ok().and_then(|t| *t)
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
        let mut config: SyncConfig = std::fs::read_to_string(self.config_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // Migración única: el client_secret de Drive vivía en claro en
        // sync_config.json; ahora va al keyring como el resto de credenciales.
        // Tras migrar, el campo queda en blanco y esta rama no vuelve a entrar.
        if !config.google_drive.client_secret.trim().is_empty()
            && keyring_set_secret(
                &google_client_secret_key(),
                config.google_drive.client_secret.trim(),
            )
            .is_ok()
        {
            config.google_drive.client_secret.clear();
            let _ = self.save_config(&config);
        }
        config
    }

    pub fn save_config(&self, config: &SyncConfig) -> Result<(), AppError> {
        // El client_secret nunca se persiste en claro: si llega relleno (el
        // formulario o una config antigua), va al keyring y el fichero queda
        // con el campo vacío.
        let mut config = config.clone();
        let incoming_secret = config.google_drive.client_secret.trim().to_string();
        if !incoming_secret.is_empty() {
            keyring_set_secret(&google_client_secret_key(), &incoming_secret)?;
            config.google_drive.client_secret.clear();
        }
        let s = serde_json::to_string_pretty(&config)
            .map_err(|e| AppError::Sync(format!("serialize config: {e}")))?;
        // Escritura atómica: un corte a mitad no puede dejar el fichero vacío.
        crate::atomic_file::write(&self.config_path(), s.as_bytes(), false)
            .map_err(|e| AppError::Sync(format!("write config: {e}")))?;
        Ok(())
    }

    /// Elimina la caché local del último merge (`sync_state.json`): contiene
    /// todos los hosts/usuarios sincronizados y no debe sobrevivir a una
    /// desactivación de la sincronización ni a un borrado de datos remotos.
    pub fn clear_local_state(&self) -> Result<(), AppError> {
        match std::fs::remove_file(self.local_state_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Sync(format!("borrar caché local: {e}"))),
        }
    }

    /// ¿Existe ya la caché local de un merge anterior? (`false` = este equipo
    /// nunca completó una sincronización: candidato a la vista previa).
    pub fn local_state_exists(&self) -> bool {
        self.local_state_path().exists()
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
        // Caché del merge con todos los perfiles sincronizados (hosts, usuarios,
        // bastiones): escritura atómica y privada (0600 en Unix), igual que
        // `profiles.json`, para no dejarla truncada ni legible por otros usuarios.
        crate::atomic_file::write(&self.local_state_path(), s.as_bytes(), true)
            .map_err(|e| AppError::Sync(format!("write state: {e}")))?;
        Ok(())
    }

    pub fn oauth_connected(&self, provider: OAuthProvider) -> Result<bool, AppError> {
        Ok(keyring_get_secret(&oauth_refresh_key(provider))?.is_some())
    }

    pub fn oauth_disconnect(&self, provider: OAuthProvider) -> Result<(), AppError> {
        clear_google_caches();
        keyring_delete_secret(&oauth_refresh_key(provider))
    }

    pub async fn oauth_begin(&self, provider: OAuthProvider) -> Result<OAuthStartResult, AppError> {
        // Descarta cualquier flujo anterior abandonado ANTES de hacer bind: cada
        // `OAuthPending` retiene su `TcpListener` en el puerto fijo 53682, así
        // que un flujo a medias (navegador cerrado sin autorizar) bloqueaba el
        // siguiente intento con «No se pudo abrir el callback OAuth local»
        // durante los 180 s del plazo.
        if let Ok(mut pending) = self.pending_oauth.lock() {
            pending.clear();
        }
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
        // Cuenta (re)conectada: invalida token/file_id de la sesión anterior.
        clear_google_caches();
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
                Ok(Box::new(WebDavBackend::new(
                    url,
                    config.webdav.username.clone(),
                    password.to_string(),
                )))
            }
            SyncBackendKind::GoogleDrive => Ok(Box::new(GoogleDriveBackend::new(config.clone()))),
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
