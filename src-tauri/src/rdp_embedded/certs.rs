//! TOFU de certificados del servidor RDP para el cliente integrado.
//!
//! Mismo patrón que las host keys SSH (`host_keys`) y los certificados FTPS
//! (`ftps_certs`): la primera vez que se ve el certificado de un `host:puerto`
//! se pide **confirmar su huella**; guardada, se acepta en silencio; si
//! **cambia**, salta el aviso de peligro con la huella anterior y la nueva.
//!
//! La comprobación corre **después** del handshake TLS y **antes** de CredSSP
//! (`connect_finalize`), que es donde viajan las credenciales: con un
//! certificado no confirmado no sale ninguna contraseña del equipo.
//!
//! Las huellas se guardan en `<data_dir>/rdp_known_certs.json`
//! (`host:puerto → SHA-256` en el formato de `ftps_certs`). La primera conexión
//! sigue la política de las host keys SSH (preguntar, por defecto) y un cambio,
//! la de RDP («Preguntar si el certificado de un servidor RDP cambia»), las dos
//! en Preferencias → Seguridad.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::ftps_certs::{decide, fingerprint_sha256_hex, Decision};
use crate::ipc::RDP_CERT_PROMPT;
use crate::locks::MutexExt;

static APP: OnceLock<AppHandle> = OnceLock::new();

static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Serializa las escrituras del JSON entre sesiones simultáneas.
static STORE_LOCK: Mutex<()> = Mutex::new(());

const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

pub fn register_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Entrega la respuesta del usuario. `false` si el `prompt_id` ya no existe.
pub fn resolve_prompt(prompt_id: &str, accept: bool) -> bool {
    let sender = PENDING.lock_recover().remove(prompt_id);
    sender.is_some_and(|tx| tx.send(accept).is_ok())
}

/// Por qué no se aceptó un certificado. El `code` lo interpreta el frontend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertRejected {
    pub code: &'static str,
    pub message: String,
}

// ─── Store ───────────────────────────────────────────────────────────────────

#[must_use]
pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join("rdp_known_certs.json")
}

fn key(host: &str, port: u16) -> String {
    format!("{}:{port}", host.to_ascii_lowercase())
}

fn load(path: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(path: &Path, map: &BTreeMap<String, String>) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(map)
        .map_err(|e| std::io::Error::other(format!("serializar huellas RDP: {e}")))?;
    crate::atomic_file::write(path, &json, false)
}

#[must_use]
pub fn recorded(path: &Path, host: &str, port: u16) -> Option<String> {
    load(path).remove(&key(host, port))
}

pub fn remember(path: &Path, host: &str, port: u16, fingerprint: &str) -> std::io::Result<()> {
    let _guard = STORE_LOCK.lock_recover();
    let mut map = load(path);
    map.insert(key(host, port), fingerprint.to_string());
    save(path, &map)
}

/// Entrada del gestor de certificados.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownCert {
    /// `host:puerto`, la clave con que se borra.
    pub host_port: String,
    pub fingerprint: String,
}

#[must_use]
pub fn list(path: &Path) -> Vec<KnownCert> {
    load(path)
        .into_iter()
        .map(|(host_port, fingerprint)| KnownCert {
            host_port,
            fingerprint,
        })
        .collect()
}

/// Olvida la huella de `host:puerto`. `false` si no estaba.
pub fn forget(path: &Path, host_port: &str) -> std::io::Result<bool> {
    let _guard = STORE_LOCK.lock_recover();
    let mut map = load(path);
    let removed = map.remove(&host_port.to_ascii_lowercase()).is_some();
    if removed {
        save(path, &map)?;
    }
    Ok(removed)
}

// ─── Confirmación ────────────────────────────────────────────────────────────

/// Payload de `rdp-cert-prompt` (espejo de `RdpCertPromptEvent` en events.js).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RdpCertPrompt {
    prompt_id: String,
    host: String,
    port: u16,
    fingerprint: String,
    /// `true` = el certificado de un host conocido ha cambiado: diálogo de peligro.
    changed: bool,
    /// Con `changed`: la huella que había guardada.
    previous: Option<String>,
    /// La conexión va por un salto (el host es el destino real, no el túnel).
    via_jump: bool,
}

async fn ask(
    host: &str,
    port: u16,
    fingerprint: &str,
    previous: Option<&str>,
    via_jump: bool,
) -> bool {
    let Some(app) = APP.get() else {
        return false;
    };
    let prompt_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock_recover().insert(prompt_id.clone(), tx);
    let payload = RdpCertPrompt {
        prompt_id: prompt_id.clone(),
        host: host.to_string(),
        port,
        fingerprint: fingerprint.to_string(),
        changed: previous.is_some(),
        previous: previous.map(str::to_string),
        via_jump,
    };
    if app.emit(RDP_CERT_PROMPT, payload).is_err() {
        PENDING.lock_recover().remove(&prompt_id);
        return false;
    }
    match tokio::time::timeout(PROMPT_TIMEOUT, rx).await {
        Ok(Ok(accepted)) => accepted,
        Ok(Err(_)) => false,
        Err(_) => {
            PENDING.lock_recover().remove(&prompt_id);
            false
        }
    }
}

/// Políticas que aplican.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub strict_first_connect: bool,
    pub prompt_on_change: bool,
}

impl Policy {
    /// La primera conexión, como las host keys SSH; un cambio, según la
    /// preferencia RDP que manda el frontend (`None` = la de SSH).
    #[must_use]
    pub fn current(prompt_on_change: Option<bool>) -> Self {
        Self {
            strict_first_connect: crate::host_keys::strict_first_connect(),
            prompt_on_change: prompt_on_change.unwrap_or_else(crate::host_keys::prompt_on_key_change),
        }
    }
}

/// Comprueba el certificado (DER del certificado hoja) de `host:puerto`.
/// `Ok(())` = se puede seguir con la autenticación.
pub async fn verify(
    store: &Path,
    host: &str,
    port: u16,
    cert_der: &[u8],
    via_jump: bool,
    policy: Policy,
) -> Result<(), CertRejected> {
    let presented = fingerprint_sha256_hex(cert_der);
    let previous = recorded(store, host, port);
    let save_err = |e: std::io::Error| CertRejected {
        code: "cert-store",
        message: format!("No se pudo guardar la huella del certificado: {e}"),
    };
    match decide(previous.as_deref(), &presented) {
        Decision::Trusted => Ok(()),
        Decision::New => {
            let accept =
                !policy.strict_first_connect || ask(host, port, &presented, None, via_jump).await;
            if !accept {
                return Err(CertRejected {
                    code: "cert-rejected",
                    message: format!(
                        "Certificado de {host}:{port} no confirmado (huella {presented})."
                    ),
                });
            }
            remember(store, host, port, &presented).map_err(save_err)
        }
        Decision::Changed => {
            let accept = policy.prompt_on_change
                && ask(host, port, &presented, previous.as_deref(), via_jump).await;
            if !accept {
                return Err(CertRejected {
                    code: "cert-changed",
                    message: format!(
                        "ALERTA: el certificado de {host}:{port} ha cambiado. Huella recibida: {presented}."
                    ),
                });
            }
            remember(store, host, port, &presented).map_err(save_err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("rustty-rdpcert-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = store_path(&dir);
        (dir, path)
    }

    fn policy(strict: bool, prompt: bool) -> Policy {
        Policy {
            strict_first_connect: strict,
            prompt_on_change: prompt,
        }
    }

    #[tokio::test]
    async fn primera_conexion_estricta_sin_ventana_rechaza_sin_guardar() {
        let (dir, path) = temp_store();
        let err = verify(&path, "srv", 3389, b"cert-a", false, policy(true, true))
            .await
            .unwrap_err();
        assert_eq!(err.code, "cert-rejected");
        assert!(recorded(&path, "srv", 3389).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn tofu_automatico_aprende_y_despues_confia() {
        let (dir, path) = temp_store();
        verify(&path, "SRV", 3389, b"cert-a", false, policy(false, true))
            .await
            .unwrap();
        assert_eq!(
            recorded(&path, "srv", 3389),
            Some(fingerprint_sha256_hex(b"cert-a"))
        );
        verify(&path, "srv", 3389, b"cert-a", false, policy(true, true))
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn certificado_cambiado_se_rechaza_y_no_se_sobrescribe() {
        let (dir, path) = temp_store();
        remember(&path, "srv", 3389, &fingerprint_sha256_hex(b"cert-a")).unwrap();
        // Sin ventana no hay nadie que acepte el cambio, aunque la política pregunte.
        for p in [policy(true, true), policy(false, false)] {
            let err = verify(&path, "srv", 3389, b"cert-b", false, p)
                .await
                .unwrap_err();
            assert_eq!(err.code, "cert-changed");
        }
        assert_eq!(
            recorded(&path, "srv", 3389),
            Some(fingerprint_sha256_hex(b"cert-a"))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn gestor_lista_y_olvida() {
        let (dir, path) = temp_store();
        remember(&path, "a", 3389, "AA").unwrap();
        remember(&path, "b", 3390, "BB").unwrap();
        let all = list(&path);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].host_port, "a:3389");
        assert!(forget(&path, "a:3389").unwrap());
        assert!(!forget(&path, "a:3389").unwrap());
        assert_eq!(list(&path).len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
