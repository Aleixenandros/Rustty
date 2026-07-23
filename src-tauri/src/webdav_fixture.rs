//! Fixture de servidor WebDAV mínimo para los tests de integración (`--ignored`).
//!
//! WebDAV, para lo que usa Rustty, es HTTP de petición-respuesta (`GET`, `PUT`
//! con `If-Match`, `MKCOL`, `PROPFIND`), así que el servidor se escribe a mano y
//! **sin dependencias nuevas**: un `TcpListener` bloqueante en un hilo propio. A
//! cambio de esas ~100 líneas se gana lo que un servidor WebDAV de verdad haría
//! difícil: **programar** la respuesta de cada petición (un `412` en el momento
//! justo) y **registrar** lo que el cliente envió, que es lo que hay que
//! verificar (¿viajó el `If-Match`? ¿hubo `MKCOL` antes del reintento?).
//!
//! Va con hilos y E/S bloqueante a propósito, no con tokio: los tests que lo usan
//! son `#[tokio::test]` (el backend es async) y soltar un runtime anidado dentro
//! de un contexto async entra en pánico.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// Petición tal y como la recibió el servidor, para poder afirmar sobre ella.
#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    /// Cabecera `If-Match` (la escritura condicional que evita pisar un push ajeno).
    pub if_match: Option<String>,
    /// `true` si vino cabecera `Authorization` (basic auth del backend).
    pub authorized: bool,
    pub body: Vec<u8>,
}

/// Respuesta programada que el servidor devolverá a la siguiente petición.
#[derive(Debug, Clone)]
pub struct Canned {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

impl Canned {
    /// `200 OK` con cuerpo y `ETag` (lo que devuelve un GET del estado).
    #[must_use]
    pub fn ok_with_etag(body: &[u8], etag: &str) -> Self {
        Self {
            status: 200,
            etag: Some(etag.to_string()),
            body: body.to_vec(),
        }
    }

    /// Respuesta sin cuerpo con el estado dado (`201`, `404`, `409`, `412`…).
    #[must_use]
    pub fn status(status: u16) -> Self {
        Self {
            status,
            etag: None,
            body: Vec::new(),
        }
    }
}

/// Servidor vivo. Al soltarse detiene el hilo y espera a que termine.
pub struct FakeWebDavServer {
    pub port: u16,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl FakeWebDavServer {
    /// URL del blob de estado, con varios segmentos para que `rsplit_once('/')`
    /// del backend tenga un padre real al que mandar el `MKCOL`.
    #[must_use]
    pub fn state_url(&self) -> String {
        format!("http://127.0.0.1:{}/dav/rustty/estado.bin", self.port)
    }

    /// Peticiones recibidas, en orden.
    #[must_use]
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().map(|r| r.clone()).unwrap_or_default()
    }

    /// Métodos recibidos, en orden: atajo para las aserciones de secuencia.
    #[must_use]
    pub fn methods(&self) -> Vec<String> {
        self.requests().into_iter().map(|r| r.method).collect()
    }
}

impl Drop for FakeWebDavServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // El hilo está bloqueado en `accept`: una conexión de cortesía lo despierta
        // para que vea la bandera y salga.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Arranca el servidor en un puerto libre. Cada petición consume la siguiente
/// respuesta de `script`; agotado el guion, responde `404`.
pub fn start(script: Vec<Canned>) -> std::io::Result<FakeWebDavServer> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();

    let requests = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));

    let thread_requests = Arc::clone(&requests);
    let thread_stop = Arc::clone(&stop);
    let handle = std::thread::spawn(move || {
        let mut script = script.into_iter();
        for incoming in listener.incoming() {
            if thread_stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = incoming else { continue };
            let canned = script.next().unwrap_or_else(|| Canned::status(404));
            let _ = serve_one(&stream, &thread_requests, &canned);
        }
    });

    Ok(FakeWebDavServer {
        port,
        requests,
        stop,
        handle: Some(handle),
    })
}

/// Atiende **una** petición: la parsea, la registra y contesta con la respuesta
/// programada. Cierra la conexión (`Connection: close`) para no tener que
/// gestionar keep-alive.
fn serve_one(
    stream: &TcpStream,
    requests: &Arc<Mutex<Vec<RecordedRequest>>>,
    canned: &Canned,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(()); // conexión de cortesía del Drop
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    let mut content_length = 0usize;
    let mut if_match = None;
    let mut authorized = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break; // fin de cabeceras
        }
        if let Some((name, value)) = line.split_once(':') {
            let value = value.trim();
            match name.to_ascii_lowercase().as_str() {
                "content-length" => content_length = value.parse().unwrap_or(0),
                "if-match" => if_match = Some(value.to_string()),
                "authorization" => authorized = true,
                _ => {}
            }
        }
    }

    // El cuerpo hay que consumirlo entero antes de contestar.
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    if let Ok(mut recorded) = requests.lock() {
        recorded.push(RecordedRequest {
            method,
            path,
            if_match,
            authorized,
            body,
        });
    }

    let mut response = format!(
        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
        canned.status,
        canned.body.len()
    );
    if let Some(etag) = &canned.etag {
        response.push_str(&format!("ETag: {etag}\r\n"));
    }
    response.push_str("\r\n");

    let mut out = response.into_bytes();
    out.extend_from_slice(&canned.body);
    (&*stream).write_all(&out)?;
    (&*stream).flush()
}
