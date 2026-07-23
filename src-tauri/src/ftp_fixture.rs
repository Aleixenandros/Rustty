//! Fixture de servidor FTP efímero para los tests de integración (`--ignored`).
//!
//! Levanta un `libunftp` **real** sobre un directorio temporal, en un puerto
//! libre, corriendo en su propio runtime tokio de fondo. El cliente `suppaftp`
//! del backend (que es **síncrono**) conecta contra él por el camino real, así
//! que estos tests son `#[test]` normales, no `#[tokio::test]`.
//!
//! Es dev-only: `libunftp`/`unftp-sbe-fs` son `dev-dependencies` y este módulo
//! se compila solo bajo `cfg(test)`. No entra en el binario de release.

use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Servidor FTP de pruebas vivo. Al soltarse (`Drop`) se apaga el runtime —lo
/// que cancela el bucle de `listen`— y se borra el directorio temporal.
pub struct FakeFtpServer {
    pub port: u16,
    pub root: PathBuf,
    // El runtime mantiene viva la tarea del servidor; soltarlo la cancela. Va el
    // último para que se suelte antes de borrar `root`.
    runtime: Option<tokio::runtime::Runtime>,
}

impl Drop for FakeFtpServer {
    fn drop(&mut self) {
        // Apagar el runtime sin bloquear indefinidamente el hilo del test.
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_timeout(Duration::from_secs(1));
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Arranca un servidor FTP **plano** anónimo con la raíz en un directorio
/// temporal propio.
pub fn start() -> std::io::Result<FakeFtpServer> {
    start_inner(false)
}

/// Arranca un servidor **FTPS** (TLS explícito) con un certificado autofirmado
/// emitido al vuelo por `rcgen` —ninguna clave privada guardada en el repo—,
/// para ejercitar el TOFU de certificados del cliente contra un servidor real.
pub fn start_ftps() -> std::io::Result<FakeFtpServer> {
    start_inner(true)
}

/// Levanta el servidor (plano o FTPS) en su runtime de fondo y espera a que el
/// puerto de control acepte conexión antes de devolver.
fn start_inner(ftps: bool) -> std::io::Result<FakeFtpServer> {
    let root = std::env::temp_dir().join(format!("rustty-ftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root)?;
    let port = free_port()?;

    // Certificado autofirmado (solo FTPS): SAN 127.0.0.1. El cliente lo verifica
    // por huella (TOFU), no por cadena, así que basta con que sea válido en
    // formato. Se emite al vuelo y se escribe en el tempdir del fixture.
    let tls = if ftps {
        let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_string()])
            .map_err(|e| std::io::Error::other(format!("generar certificado FTPS: {e}")))?;
        let cert_path = root.join("cert.pem");
        let key_path = root.join("key.pem");
        std::fs::write(&cert_path, cert.cert.pem())?;
        std::fs::write(&key_path, cert.signing_key.serialize_pem())?;
        Some((cert_path, key_path))
    } else {
        None
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;

    let root_for_server = root.clone();
    let bind = format!("127.0.0.1:{port}");
    runtime.spawn(async move {
        let mut builder = libunftp::ServerBuilder::new(Box::new(move || {
            unftp_sbe_fs::Filesystem::new(root_for_server.clone())
                .expect("crear backend de ficheros del fixture FTP")
        }))
        .greeting("Rustty test FTP");
        if let Some((cert_path, key_path)) = tls {
            builder = builder.ftps(cert_path, key_path);
        }
        let server = builder.build().expect("construir el servidor FTP del fixture");
        // `listen` corre hasta que se cancela la tarea (al soltar el runtime).
        let _ = server.listen(bind).await;
    });

    if !wait_until_listening(port, Duration::from_secs(5)) {
        return Err(std::io::Error::other("el servidor FTP no llegó a escuchar a tiempo"));
    }

    Ok(FakeFtpServer {
        port,
        root,
        runtime: Some(runtime),
    })
}

/// Pide un puerto efímero libre soltando el listener acto seguido, para que el
/// servidor FTP lo tome. La ventana de carrera es teórica en localhost.
fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// Sondea el puerto de control hasta que acepta una conexión TCP o se agota el
/// plazo.
fn wait_until_listening(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}
