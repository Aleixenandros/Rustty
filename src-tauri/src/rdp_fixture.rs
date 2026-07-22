//! Servidor RDP de mentira para los tests de integración.
//!
//! Habla lo justo del protocolo para que un cliente real —`xfreerdp`— llegue a
//! **pedir credenciales**, que es donde vivía el fallo que dejó las conexiones
//! RDP rotas en Linux con FreeRDP 3 (v1.59.0): la batería estaba en verde
//! mientras ninguna conexión funcionaba, porque ningún test ejecutaba un cliente
//! contra algo que hablara el protocolo.
//!
//! El diálogo mínimo es:
//!
//! 1. El cliente manda un **X.224 Connection Request** con los protocolos que
//!    acepta.
//! 2. El servidor responde un **Negotiation Response** eligiendo
//!    `PROTOCOL_HYBRID` (NLA), que obliga al cliente a autenticarse.
//! 3. Handshake **TLS** con un certificado autofirmado generado al vuelo.
//! 4. El cliente manda su primer mensaje **CredSSP**. Si dentro viaja `NTLMSSP`
//!    es que consiguió la contraseña: eso es lo que el test comprueba.
//!
//! A partir de ahí el servidor calla: no hace falta implementar CredSSP entero
//! para saber que la credencial llegó.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::Duration;

/// Respuesta de negociación X.224 que selecciona `PROTOCOL_HYBRID`.
/// TPKT (4 bytes) + X.224 Connection Confirm (7) + RDP_NEG_RSP (8) = 19.
const NEG_RESPONSE_HYBRID: [u8; 19] = [
    0x03, 0x00, 0x00, 0x13, // TPKT: versión 3, longitud 19
    0x0E, 0xD0, 0x00, 0x00, 0x12, 0x34, 0x00, // X.224 Connection Confirm
    0x02, 0x00, 0x08, 0x00, // RDP_NEG_RSP, sin flags, longitud 8
    0x02, 0x00, 0x00, 0x00, // selectedProtocol = PROTOCOL_HYBRID (NLA)
];

/// Servidor en marcha. Al soltarlo, su hilo termina en cuanto cierre la conexión
/// en curso; el listener se libera con él.
pub struct FakeRdpServer {
    /// Dirección real donde escucha, con **puerto efímero**: cada ejecución usa
    /// uno distinto, así el TOFU de FreeRDP no ve dos certificados diferentes
    /// para el mismo `host:puerto` y no aborta creyendo que cambió el servidor.
    pub addr: SocketAddr,
    credssp: Receiver<Vec<u8>>,
}

impl FakeRdpServer {
    /// Espera al primer mensaje CredSSP del cliente. `None` si no llegó a
    /// tiempo, que es justo lo que pasaba con el bug: el cliente cancelaba antes
    /// de autenticarse.
    pub fn wait_for_credssp(&self, timeout: Duration) -> Option<Vec<u8>> {
        self.credssp.recv_timeout(timeout).ok()
    }
}

/// Arranca el servidor en un hilo y devuelve su dirección.
pub fn start() -> std::io::Result<FakeRdpServer> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let addr = listener.local_addr()?;
    let config = Arc::new(server_config());
    let (tx, credssp) = mpsc::channel();

    std::thread::spawn(move || {
        let Ok((mut tcp, _)) = listener.accept() else {
            return;
        };
        // 1) X.224 Connection Request. Su contenido no importa: siempre
        //    respondemos NLA, que es el caso que queremos ejercitar.
        let mut buf = [0u8; 1024];
        if tcp.read(&mut buf).is_err() {
            return;
        }
        if tcp.write_all(&NEG_RESPONSE_HYBRID).is_err() {
            return;
        }

        // 2) TLS y primer mensaje CredSSP.
        let Ok(conn) = rustls::ServerConnection::new(config) else {
            return;
        };
        let mut tls = rustls::StreamOwned::new(conn, tcp);
        let mut payload = [0u8; 8192];
        while let Ok(n) = tls.read(&mut payload) {
            if n == 0 {
                break;
            }
            // El cliente manda antes un X.224 de 9 bytes; el que interesa es el
            // primero con contenido CredSSP.
            if n > 16 {
                let _ = tx.send(payload[..n].to_vec());
                break;
            }
        }
    });

    Ok(FakeRdpServer { addr, credssp })
}

/// Configuración TLS con un certificado autofirmado recién emitido.
fn server_config() -> rustls::ServerConfig {
    let cert = rcgen::generate_simple_self_signed(vec!["fakerdp.test".to_string()])
        .expect("emitir el certificado del fixture");
    let chain = vec![cert.cert.der().clone()];
    let key = rustls::pki_types::PrivateKeyDer::try_from(cert.signing_key.serialize_der())
        .expect("clave del fixture");

    // Proveedor explícito: en el árbol conviven `ring` y `aws-lc-rs`, y con dos
    // instalables rustls exige elegir en vez de adivinar.
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("versiones de protocolo por defecto")
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .expect("configurar el certificado del fixture")
}

/// `true` si la carga CredSSP lleva un mensaje NTLM, la señal de que el cliente
/// obtuvo usuario y contraseña y arrancó la autenticación.
pub fn contains_ntlmssp(payload: &[u8]) -> bool {
    payload.windows(7).any(|w| w == b"NTLMSSP")
}
