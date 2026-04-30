use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use russh::client;
use russh::keys::{known_hosts, ssh_key::PublicKey};
use sha2::{Digest, Sha256};

/// Handler TOFU para russh:
/// - si la host key ya coincide con known_hosts, acepta;
/// - si no hay entrada, la aprende automáticamente;
/// - si hay entrada con el mismo algoritmo pero otra clave, rechaza.
pub struct KnownHostsClient {
    host: String,
    port: u16,
    failure: Arc<Mutex<Option<String>>>,
}

pub fn client(host: String, port: u16) -> (KnownHostsClient, Arc<Mutex<Option<String>>>) {
    let failure = Arc::new(Mutex::new(None));
    (
        KnownHostsClient {
            host,
            port,
            failure: Arc::clone(&failure),
        },
        failure,
    )
}

pub fn take_failure(failure: &Arc<Mutex<Option<String>>>) -> Option<String> {
    failure.lock().ok().and_then(|mut value| value.take())
}

impl KnownHostsClient {
    fn set_failure(&self, message: String) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(message);
        }
    }
}

impl client::Handler for KnownHostsClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        match known_hosts::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                match known_hosts::learn_known_hosts(&self.host, self.port, server_public_key) {
                    Ok(()) => Ok(true),
                    Err(err) => {
                        self.set_failure(format!(
                            "No se pudo guardar la host key de {}:{} en known_hosts: {err}",
                            self.host, self.port
                        ));
                        Ok(false)
                    }
                }
            }
            Err(russh::keys::Error::KeyChanged { line }) => {
                self.set_failure(format!(
                    "ALERTA: la host key de {}:{} ha cambiado (known_hosts línea {}). Fingerprint recibido: {}",
                    self.host,
                    self.port,
                    line,
                    fingerprint_sha256(server_public_key)
                ));
                Ok(false)
            }
            Err(err) => {
                self.set_failure(format!(
                    "No se pudo verificar la host key de {}:{}: {err}",
                    self.host, self.port
                ));
                Ok(false)
            }
        }
    }
}

fn fingerprint_sha256(public_key: &PublicKey) -> String {
    let bytes = public_key.to_bytes().unwrap_or_default();
    let digest = Sha256::digest(bytes);
    format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}
