//! Subida a TLS de la conexión RDP.
//!
//! Los servidores RDP usan casi siempre certificados autofirmados, así que la
//! validación contra una CA no sirve: la confianza la da el TOFU de `certs`.
//! Este verificador **no valida la cadena** (eso lo hace el TOFU en cuanto el
//! handshake termina, antes de enviar credenciales), pero **sí** comprueba la
//! firma del handshake con el proveedor `ring`: quien responde tiene la clave
//! privada del certificado que presenta.
//!
//! Proveedor explícito (no el del proceso), sin reanudación de sesión y sin
//! `SSLKEYLOGFILE`.

use std::io;
use std::sync::Arc;

use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{
    self, ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme,
};
use tokio_rustls::TlsConnector;

#[derive(Debug)]
struct DeferToTofu {
    algs: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for DeferToTofu {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        // La decisión de confianza se toma tras el handshake (TOFU), con la
        // huella del certificado hoja y antes de cualquier credencial.
        Ok(ServerCertVerified::assertion())
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

fn client_config() -> io::Result<ClientConfig> {
    let provider = Arc::new(ring::default_provider());
    let algs = provider.signature_verification_algorithms;
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(DeferToTofu { algs }))
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();
    Ok(config)
}

/// Nombre para el SNI. Un host que no sea ni IP ni nombre DNS válido (p. ej.
/// con `_`) no impide conectar: el SNI no interviene en la confianza.
fn sni(host: &str) -> ServerName<'static> {
    ServerName::try_from(host.to_string())
        .unwrap_or_else(|_| ServerName::try_from("rdp.invalid").expect("nombre DNS válido"))
}

/// Resultado de la subida: el flujo cifrado, el DER del certificado hoja (para
/// el TOFU) y la clave pública del servidor (para el enlace de CredSSP).
pub struct Upgraded {
    pub stream: TlsStream<TcpStream>,
    pub cert_der: Vec<u8>,
    pub server_public_key: Vec<u8>,
}

pub async fn upgrade(stream: TcpStream, host: &str) -> io::Result<Upgraded> {
    let connector = TlsConnector::from(Arc::new(client_config()?));
    let mut tls = connector.connect(sni(host), stream).await?;
    tokio::io::AsyncWriteExt::flush(&mut tls).await?;
    let cert_der = tls
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .map(|c| c.as_ref().to_vec())
        .ok_or_else(|| io::Error::other("el servidor no presentó certificado"))?;
    let server_public_key = public_key(&cert_der)?;
    Ok(Upgraded {
        stream: tls,
        cert_der,
        server_public_key,
    })
}

/// `subjectPublicKey` del certificado, que CredSSP liga a la sesión TLS.
fn public_key(cert_der: &[u8]) -> io::Result<Vec<u8>> {
    use x509_cert::der::Decode as _;
    let cert = x509_cert::Certificate::from_der(cert_der).map_err(io::Error::other)?;
    cert.tbs_certificate()
        .subject_public_key_info()
        .subject_public_key
        .as_bytes()
        .map(<[u8]>::to_vec)
        .ok_or_else(|| io::Error::other("clave pública del certificado no alineada"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sni_acepta_ips_y_cae_a_un_nombre_neutro() {
        assert!(matches!(sni("10.0.0.5"), ServerName::IpAddress(_)));
        assert!(matches!(sni("srv.example"), ServerName::DnsName(_)));
        assert!(matches!(sni("bad_name!"), ServerName::DnsName(_)));
    }

    #[test]
    fn configuracion_no_entra_en_panico_con_varios_proveedores() {
        // El árbol tiene `ring` y `aws-lc`: con proveedor explícito no importa.
        assert!(client_config().is_ok());
    }
}
