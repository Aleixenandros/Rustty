//! TOFU de certificados FTPS.
//!
//! El conector FTPS solo validaba contra las CA raíz de webpki, así que el caso
//! típico —un NAS o servidor interno con certificado **autofirmado**— era
//! imposible de usar. Aquí está la alternativa, con el mismo patrón *Trust On
//! First Use* que las host keys SSH (`host_keys`): la primera vez que se ve el
//! certificado de un host se pide **confirmar su huella**; una vez guardada, se
//! acepta en silencio; si la huella **cambia**, se rechaza la conexión.
//!
//! No es un «ignorar certificado» global: cada huella se guarda por `host:puerto`
//! en `<data_dir>/ftps_known_certs.json`, y un cambio salta como sospechoso.
//!
//! El conector FTP (suppaftp) es **síncrono**, así que la confirmación no puede
//! usar el `oneshot` async de `host_keys`: se emite el evento y se **bloquea** en
//! un canal `std::sync::mpsc` con plazo. El verificador corre dentro del
//! handshake TLS, en el hilo de `spawn_blocking` de la conexión.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use suppaftp::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use suppaftp::rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature};
use suppaftp::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use suppaftp::rustls::{DigitallySignedStruct, Error as TlsError, SignatureScheme};
use tauri::{AppHandle, Emitter};

use crate::ipc::FTPS_CERT_PROMPT;
use crate::locks::MutexExt;

/// `true` = pedir confirmación de una huella nueva (default), igual que el modo
/// estricto de host keys SSH. Opt-in a TOFU automático (aprender en silencio).
static STRICT_FIRST_CONNECT: AtomicBool = AtomicBool::new(true);

/// `AppHandle` para emitir el evento de confirmación. Ausente en tests/CLI, donde
/// no hay ventana: sin él, una huella nueva se rechaza en modo estricto.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Confirmaciones en vuelo: `promptId` → canal por el que llega la respuesta.
/// Canal **síncrono** (`mpsc`), porque quien espera es el verificador TLS en un
/// contexto bloqueante.
static PENDING: LazyLock<Mutex<HashMap<String, std::sync::mpsc::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Plazo para que el usuario conteste. Agotado, se rechaza: preferimos no
/// conectar a aceptar una huella que nadie miró.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Fija la política de primera conexión (la llama el frontend con las prefs).
pub fn set_strict_first_connect(strict: bool) {
    STRICT_FIRST_CONNECT.store(strict, Ordering::Relaxed);
}

#[must_use]
pub fn strict_first_connect() -> bool {
    STRICT_FIRST_CONNECT.load(Ordering::Relaxed)
}

/// Registra el `AppHandle` (en `setup`).
pub fn register_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Entrega la respuesta del usuario a una confirmación en vuelo. Devuelve `false`
/// si el `promptId` ya no existe (plazo agotado o respuesta duplicada).
pub fn resolve_prompt(prompt_id: &str, accept: bool) -> bool {
    let sender = PENDING.lock_recover().remove(prompt_id);
    match sender {
        Some(tx) => tx.send(accept).is_ok(),
        None => false,
    }
}

// ─── Lógica pura ─────────────────────────────────────────────────────────────

/// Huella SHA-256 de un certificado DER, en hex con dos puntos y mayúsculas
/// (`A1:B2:…`), el formato de `openssl x509 -fingerprint -sha256`.
#[must_use]
pub fn fingerprint_sha256_hex(cert_der: &[u8]) -> String {
    let digest = Sha256::digest(cert_der);
    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Qué hacer con una huella presentada, dado lo que había registrado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Coincide con la guardada: aceptar sin molestar.
    Trusted,
    /// No había ninguna para este host: primera conexión.
    New,
    /// Había una **distinta**: sospechoso, rechazar.
    Changed,
}

/// Decide comparando la huella presentada con la registrada (si la hay). La
/// comparación ignora mayúsculas para no depender del formato exacto guardado.
#[must_use]
pub fn decide(recorded: Option<&str>, presented: &str) -> Decision {
    match recorded {
        None => Decision::New,
        Some(r) if r.eq_ignore_ascii_case(presented) => Decision::Trusted,
        Some(_) => Decision::Changed,
    }
}

/// Clave de almacenamiento de un host.
fn store_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

// ─── Store persistente ───────────────────────────────────────────────────────

/// Almacén de huellas conocidas `host:puerto → huella`, respaldado por un JSON.
/// El path se inyecta (el de producción es `<data_dir>/ftps_known_certs.json`),
/// para poder probarlo contra un fichero temporal.
pub struct CertStore {
    path: PathBuf,
}

impl CertStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Nombre del fichero dentro del directorio de datos.
    #[must_use]
    pub fn file_in(data_dir: &std::path::Path) -> PathBuf {
        data_dir.join("ftps_known_certs.json")
    }

    fn load_map(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Huella registrada para un host, si la hay.
    #[must_use]
    pub fn get(&self, host: &str, port: u16) -> Option<String> {
        self.load_map().remove(&store_key(host, port))
    }

    /// Registra (o actualiza) la huella de un host y persiste. Escribe de forma
    /// atómica (temporal + rename) para no dejar el JSON a medias.
    pub fn insert(&self, host: &str, port: u16, fingerprint: &str) -> std::io::Result<()> {
        let mut map = self.load_map();
        map.insert(store_key(host, port), fingerprint.to_string());
        let json = serde_json::to_vec_pretty(&map)
            .map_err(|e| std::io::Error::other(format!("serializar huellas FTPS: {e}")))?;
        crate::atomic_file::write(&self.path, &json, false)
    }
}

// ─── Confirmación (síncrona) ─────────────────────────────────────────────────

/// Payload de `ftps-cert-prompt` (espejo de `FtpsCertPromptEvent` en events.js).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FtpsCertPrompt {
    prompt_id: String,
    host: String,
    port: u16,
    fingerprint: String,
}

/// Pide confirmación de una huella nueva y **espera** la respuesta (bloqueante).
/// `true` = el usuario la acepta. Sin `AppHandle` (tests) devuelve `false`.
fn confirm_new_cert(host: &str, port: u16, fingerprint: &str) -> bool {
    let Some(app) = APP.get() else {
        return false;
    };
    let prompt_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    PENDING.lock_recover().insert(prompt_id.clone(), tx);

    let payload = FtpsCertPrompt {
        prompt_id: prompt_id.clone(),
        host: host.to_string(),
        port,
        fingerprint: fingerprint.to_string(),
    };
    if app.emit(FTPS_CERT_PROMPT, payload).is_err() {
        PENDING.lock_recover().remove(&prompt_id);
        return false;
    }

    match rx.recv_timeout(PROMPT_TIMEOUT) {
        Ok(accepted) => accepted,
        // Plazo agotado o canal cerrado: no confirmado.
        Err(_) => {
            PENDING.lock_recover().remove(&prompt_id);
            false
        }
    }
}

// ─── Verificador rustls ──────────────────────────────────────────────────────

/// Verificador de certificados de servidor con política TOFU. Sustituye a la
/// validación contra CA raíz cuando el usuario conecta por FTPS a un host con
/// certificado propio.
#[derive(Debug)]
pub struct TofuServerCertVerifier {
    host: String,
    port: u16,
    store: PathBuf,
    /// Algoritmos de verificación de firma del proveedor (ring): la comprobación
    /// de la **firma** del handshake sí se hace de verdad; lo que el TOFU relaja
    /// es solo la validación de la **cadena** hasta una CA raíz.
    algs: suppaftp::rustls::crypto::WebPkiSupportedAlgorithms,
}

impl TofuServerCertVerifier {
    #[must_use]
    pub fn new(host: String, port: u16, store: PathBuf) -> Self {
        Self {
            host,
            port,
            store,
            algs: ring::default_provider().signature_verification_algorithms,
        }
    }
}

impl ServerCertVerifier for TofuServerCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let presented = fingerprint_sha256_hex(end_entity);
        let store = CertStore::new(self.store.clone());
        let recorded = store.get(&self.host, self.port);

        match decide(recorded.as_deref(), &presented) {
            Decision::Trusted => Ok(ServerCertVerified::assertion()),
            Decision::Changed => Err(TlsError::General(format!(
                "ALERTA: el certificado FTPS de {}:{} ha cambiado. Huella recibida: {}. \
                 Si reconoces el cambio, borra su entrada en ftps_known_certs.json y vuelve a conectar.",
                self.host, self.port, presented
            ))),
            Decision::New => {
                // Estricto (default): confirmar. Automático: aprender en silencio.
                let accept = if strict_first_connect() {
                    confirm_new_cert(&self.host, self.port, &presented)
                } else {
                    true
                };
                if !accept {
                    return Err(TlsError::General(format!(
                        "Certificado FTPS de {}:{} no confirmado (huella {}). No se ha guardado.",
                        self.host, self.port, presented
                    )));
                }
                store.insert(&self.host, self.port, &presented).map_err(|e| {
                    TlsError::General(format!("No se pudo guardar la huella FTPS: {e}"))
                })?;
                Ok(ServerCertVerified::assertion())
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn huella_es_hex_estable_con_dos_puntos() {
        // SHA-256 de la cadena vacía, conocido.
        let fp = fingerprint_sha256_hex(b"");
        assert!(fp.starts_with("E3:B0:C4:42:98:FC"));
        assert_eq!(fp.split(':').count(), 32); // 32 bytes
        // Determinista.
        assert_eq!(fp, fingerprint_sha256_hex(b""));
        assert_ne!(fp, fingerprint_sha256_hex(b"x"));
    }

    #[test]
    fn decision_tofu() {
        assert_eq!(decide(None, "AA:BB"), Decision::New);
        assert_eq!(decide(Some("AA:BB"), "AA:BB"), Decision::Trusted);
        // La comparación ignora mayúsculas/minúsculas.
        assert_eq!(decide(Some("aa:bb"), "AA:BB"), Decision::Trusted);
        assert_eq!(decide(Some("AA:BB"), "CC:DD"), Decision::Changed);
    }

    #[test]
    fn store_guarda_y_recupera_por_host_y_puerto() {
        let dir = std::env::temp_dir().join(format!("rustty-ftps-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = CertStore::new(CertStore::file_in(&dir));

        assert_eq!(store.get("nas.local", 21), None);
        store.insert("nas.local", 21, "AA:BB:CC").unwrap();
        assert_eq!(store.get("nas.local", 21).as_deref(), Some("AA:BB:CC"));
        // Distinto puerto = otra entrada.
        assert_eq!(store.get("nas.local", 990), None);
        // Sobrescribir actualiza.
        store.insert("nas.local", 21, "DD:EE:FF").unwrap();
        assert_eq!(store.get("nas.local", 21).as_deref(), Some("DD:EE:FF"));
        // Persistió en disco: una instancia nueva lo ve.
        let store2 = CertStore::new(CertStore::file_in(&dir));
        assert_eq!(store2.get("nas.local", 21).as_deref(), Some("DD:EE:FF"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
