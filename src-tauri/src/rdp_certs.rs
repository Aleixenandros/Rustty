//! Almacén TOFU de certificados del cliente RDP externo (FreeRDP).
//!
//! El TOFU de RDP no lo hace Rustty: lo hace `xfreerdp`, al que lanzamos con
//! `/cert:tofu` (ver `rdp_manager`). El cliente recuerda el certificado de cada
//! `host:puerto` y, si cambia, **aborta** sin preguntar nada —no hay terminal
//! donde preguntar—. Hasta ahora eso dejaba la conexión muerta con un aviso que
//! mandaba al usuario a borrar un fichero a mano; aquí está lo que hace falta
//! para ofrecerle lo mismo que en SSH: enseñar las dos huellas y, si acepta el
//! cambio, olvidar el certificado recordado y reconectar.
//!
//! Dónde vive lo recordado depende de la versión del cliente:
//!
//! * **FreeRDP 3**: un PEM por host en `<config>/freerdp/server/<host>_<puerto>.pem`
//!   (el formato `%s_%hu.pem` de `freerdp_certificate_store_get_cert_path`).
//! * **FreeRDP 2**: una línea por host en `<config>/freerdp/known_hosts2`,
//!   estilo `known_hosts` de OpenSSH: `host puerto huella [subject issuer]`.
//!
//! Se atienden los dos: el binario que haya en la máquina lo decide el usuario,
//! no nosotros. Y `<config>` tampoco es uno solo: bajo Flatpak el cliente corre
//! en el **host** heredando nuestro entorno, así que el certificado puede acabar
//! tanto en el `XDG_CONFIG_HOME` del sandbox como en el `~/.config` real.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};

/// Subdirectorio donde FreeRDP 3 guarda un PEM por host.
const SERVER_DIR: &str = "server";
/// Fichero de FreeRDP 2 con una línea por host.
const KNOWN_HOSTS: &str = "known_hosts2";

/// Frase con la que FreeRDP anuncia la huella del certificado recibido cuando
/// rechaza la conexión («The fingerprint for the host key sent by the remote
/// host is a1:b2:…»). Es la única forma de conocerla: el cliente muere antes de
/// guardarla en ningún sitio.
const PRESENTED_MARKER: &str = "sent by the remote host is";

// ─── Rutas ───────────────────────────────────────────────────────────────────

/// Directorios `freerdp` candidatos, en orden y sin repetidos.
///
/// `XDG_CONFIG_HOME` primero (es el que respeta el propio cliente) y el
/// `~/.config` clásico después. Suelen ser el mismo sitio; dejan de serlo dentro
/// de Flatpak, donde `XDG_CONFIG_HOME` apunta al sandbox y `HOME` al directorio
/// real del usuario.
fn freerdp_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        dirs.push(PathBuf::from(xdg).join("freerdp"));
    }
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        dirs.push(PathBuf::from(home).join(".config").join("freerdp"));
    }
    dirs.dedup();
    dirs
}

/// Nombre del PEM de un host tal y como lo compone FreeRDP 3.
#[must_use]
pub fn cert_file_name(host: &str, port: u16) -> String {
    format!("{host}_{port}.pem")
}

/// Un host solo puede nombrar un fichero **dentro** del almacén: el nombre se
/// compone con él, así que un `../` o una barra convertirían un «olvida este
/// certificado» en un borrado en cualquier parte del disco. El host llega del
/// perfil (y el perfil, de la sincronización o de un import), no de un sitio en
/// el que confiar a ciegas.
#[must_use]
pub fn host_is_safe(host: &str) -> bool {
    !host.is_empty()
        && host != ".."
        && !host.contains('/')
        && !host.contains('\\')
        && !host.contains(std::path::MAIN_SEPARATOR)
        && !host.chars().any(char::is_control)
}

// ─── Lógica pura ─────────────────────────────────────────────────────────────

/// Huella SHA-256 de un certificado DER en el formato con el que FreeRDP la
/// imprime: hex en **minúsculas** separado por dos puntos (`a1:b2:…`). Distinto
/// del de `ftps_certs` (mayúsculas, el de `openssl x509 -fingerprint`) a
/// propósito: aquí las dos huellas del diálogo —la recordada, que calculamos
/// nosotros, y la recibida, que copiamos de la salida del cliente— tienen que
/// poder compararse de un vistazo.
#[must_use]
pub fn fingerprint_sha256_hex(cert_der: &[u8]) -> String {
    Sha256::digest(cert_der)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// DER del primer certificado de un PEM. `None` si el texto no trae ninguno o
/// el base64 está corrupto: un almacén ilegible no debe impedir reconectar, solo
/// deja el diálogo sin la huella antigua.
#[must_use]
pub fn pem_first_der(pem: &str) -> Option<Vec<u8>> {
    let start = pem.find("-----BEGIN CERTIFICATE-----")?;
    let body = &pem[start + "-----BEGIN CERTIFICATE-----".len()..];
    let end = body.find("-----END CERTIFICATE-----")?;
    let base64: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD.decode(base64).ok()
}

/// Huella que el cliente dice haber recibido, extraída de su salida. `None` si
/// el aviso no la trae (versiones antiguas, salida recortada por la cola).
#[must_use]
pub fn presented_fingerprint(tail: &str) -> Option<String> {
    tail.lines()
        .filter_map(|line| {
            // `to_ascii_lowercase` conserva la longitud en bytes, así que el
            // índice que devuelve sirve para cortar la línea original.
            let rest = line
                .to_ascii_lowercase()
                .find(PRESENTED_MARKER)
                .map(|i| line[i + PRESENTED_MARKER.len()..].trim().to_string())?;
            // El separador de bytes es lo que distingue una huella del resto de
            // la frase; sin él no publicamos como huella lo primero que salga.
            let fp = rest.trim_end_matches('.').trim().to_string();
            (fp.contains(':') && !fp.is_empty()).then_some(fp)
        })
        .next_back()
}

/// ¿Es esta línea de `known_hosts2` la de `host:puerto`? El formato es
/// `host puerto huella …`, con el host tal cual lo escribió el cliente (se
/// compara sin distinguir mayúsculas, como los nombres de dominio).
#[must_use]
fn known_hosts_line_matches(line: &str, host: &str, port: u16) -> bool {
    let mut fields = line.split_whitespace();
    let (Some(h), Some(p)) = (fields.next(), fields.next()) else {
        return false;
    };
    h.eq_ignore_ascii_case(host) && p == port.to_string()
}

/// Huella registrada para `host:puerto` en un `known_hosts2` ya leído.
#[must_use]
pub fn known_hosts_fingerprint(content: &str, host: &str, port: u16) -> Option<String> {
    content
        .lines()
        .find(|l| known_hosts_line_matches(l, host, port))
        .and_then(|l| l.split_whitespace().nth(2))
        .map(str::to_string)
}

/// Contenido de `known_hosts2` sin las líneas de `host:puerto`. `None` si no
/// había ninguna, para no reescribir un fichero que no cambia.
#[must_use]
pub fn strip_known_hosts(content: &str, host: &str, port: u16) -> Option<String> {
    if !content
        .lines()
        .any(|l| known_hosts_line_matches(l, host, port))
    {
        return None;
    }
    let mut kept: String = content
        .lines()
        .filter(|l| !known_hosts_line_matches(l, host, port))
        .map(|l| format!("{l}\n"))
        .collect();
    if kept.trim().is_empty() {
        kept.clear();
    }
    Some(kept)
}

// ─── Almacén en disco ────────────────────────────────────────────────────────

/// Huella del certificado que el cliente recordaba para `host:puerto`, si la
/// hay. Mira primero el PEM de FreeRDP 3 y luego el `known_hosts2` de la 2.
#[must_use]
pub fn stored_fingerprint(host: &str, port: u16) -> Option<String> {
    stored_fingerprint_in(&freerdp_dirs(), host, port)
}

/// Rutas donde el cliente pudo dejar el PEM de `host:puerto`, en el mismo orden
/// en que se consultan (la primera es donde lo escribiría FreeRDP 3). Solo la
/// usa el test de integración, que siembra el almacén para provocar el aviso de
/// certificado cambiado con un cliente real.
#[cfg(test)]
#[must_use]
pub fn cert_paths(host: &str, port: u16) -> Vec<PathBuf> {
    freerdp_dirs()
        .into_iter()
        .map(|dir| dir.join(SERVER_DIR).join(cert_file_name(host, port)))
        .collect()
}

/// Igual, sobre unos directorios dados (los tests usan uno temporal en vez de
/// tocar el entorno del proceso, que es compartido por toda la batería).
#[must_use]
fn stored_fingerprint_in(dirs: &[PathBuf], host: &str, port: u16) -> Option<String> {
    if !host_is_safe(host) {
        return None;
    }
    for dir in dirs {
        let pem = dir.join(SERVER_DIR).join(cert_file_name(host, port));
        if let Some(fp) = std::fs::read_to_string(&pem)
            .ok()
            .and_then(|text| pem_first_der(&text))
            .map(|der| fingerprint_sha256_hex(&der))
        {
            return Some(fp);
        }
        if let Some(fp) = std::fs::read_to_string(dir.join(KNOWN_HOSTS))
            .ok()
            .and_then(|text| known_hosts_fingerprint(&text, host, port))
        {
            return Some(fp);
        }
    }
    None
}

/// Olvida el certificado recordado para `host:puerto` en todos los almacenes
/// donde aparezca, para que la siguiente conexión lo vuelva a aprender por TOFU.
/// Devuelve `true` si había algo que olvidar.
///
/// Es exactamente lo que el aviso pedía hacer a mano; la diferencia es que ahora
/// solo pasa cuando el usuario ha visto las dos huellas y ha aceptado el cambio.
pub fn forget(host: &str, port: u16) -> Result<bool, String> {
    forget_in(&freerdp_dirs(), host, port)
}

/// Igual, sobre unos directorios dados (ver `stored_fingerprint_in`).
fn forget_in(dirs: &[PathBuf], host: &str, port: u16) -> Result<bool, String> {
    if !host_is_safe(host) {
        return Err(format!("Host no válido para el almacén RDP: {host}"));
    }
    let mut forgotten = false;
    for dir in dirs {
        let pem = dir.join(SERVER_DIR).join(cert_file_name(host, port));
        match std::fs::remove_file(&pem) {
            Ok(()) => forgotten = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("No se pudo borrar {}: {e}", pem.display())),
        }
        forgotten |= strip_known_hosts_file(&dir.join(KNOWN_HOSTS), host, port)?;
    }
    Ok(forgotten)
}

/// Reescribe `known_hosts2` sin las líneas de `host:puerto`. La escritura es
/// atómica: un corte a mitad no puede dejar al usuario sin el resto de sus
/// certificados recordados.
fn strip_known_hosts_file(path: &Path, host: &str, port: u16) -> Result<bool, String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Ok(false); // No existe o no es texto: nada que quitar.
    };
    let Some(kept) = strip_known_hosts(&content, host, port) else {
        return Ok(false);
    };
    crate::atomic_file::write(path, kept.as_bytes(), false)
        .map_err(|e| format!("No se pudo reescribir {}: {e}", path.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn huella_en_minusculas_con_dos_puntos() {
        // SHA-256 de la cadena vacía, conocido.
        let fp = fingerprint_sha256_hex(b"");
        assert!(fp.starts_with("e3:b0:c4:42:98:fc"));
        assert_eq!(fp.split(':').count(), 32);
        assert_ne!(fp, fingerprint_sha256_hex(b"x"));
    }

    #[test]
    fn pem_se_decodifica_a_der() {
        // Certificado mínimo: el contenido da igual, lo que se prueba es el
        // recorte de cabeceras y el base64 multilínea.
        let der = b"\x30\x82\x01\x0a hola";
        let b64 = STANDARD.encode(der);
        let pem = format!(
            "comentario previo\n-----BEGIN CERTIFICATE-----\n{}\n{}\n-----END CERTIFICATE-----\n",
            &b64[..4],
            &b64[4..]
        );
        assert_eq!(pem_first_der(&pem).as_deref(), Some(&der[..]));
        assert_eq!(pem_first_der("no soy un pem"), None);
        assert_eq!(
            pem_first_der("-----BEGIN CERTIFICATE-----\n@@@\n-----END CERTIFICATE-----"),
            None
        );
    }

    #[test]
    fn huella_recibida_sale_del_aviso_de_freerdp() {
        let tail = "[13:20:01:123] [12345:12346] [ERROR][com.freerdp.crypto] - The host key for 10.0.0.5:3389 has changed\n\
                    [13:20:01:124] [12345:12346] [ERROR][com.freerdp.crypto] - The fingerprint for the host key sent by the remote host is a1:b2:c3:d4\n";
        assert_eq!(
            presented_fingerprint(tail).as_deref(),
            Some("a1:b2:c3:d4")
        );
        // Sin la frase, o sin huella reconocible, no se inventa nada.
        assert_eq!(presented_fingerprint("conexión rechazada"), None);
        assert_eq!(
            presented_fingerprint("the fingerprint sent by the remote host is desconocida"),
            None
        );
    }

    #[test]
    fn known_hosts_localiza_y_quita_solo_su_linea() {
        let content = "otro.local 3389 aa:bb\n10.0.0.5 3389 cc:dd subject issuer\n10.0.0.5 33890 ee:ff\n";
        assert_eq!(
            known_hosts_fingerprint(content, "10.0.0.5", 3389).as_deref(),
            Some("cc:dd")
        );
        // El puerto forma parte de la identidad: 3389 y 33890 son entradas
        // distintas (y `33890` no debe casar por prefijo).
        assert_eq!(
            known_hosts_fingerprint(content, "10.0.0.5", 33890).as_deref(),
            Some("ee:ff")
        );
        assert_eq!(known_hosts_fingerprint(content, "10.0.0.5", 3390), None);

        let kept = strip_known_hosts(content, "10.0.0.5", 3389).expect("había línea");
        assert_eq!(kept, "otro.local 3389 aa:bb\n10.0.0.5 33890 ee:ff\n");
        // Sin coincidencia no se reescribe el fichero.
        assert_eq!(strip_known_hosts(content, "ausente.local", 3389), None);
        // Quitar la única línea deja el fichero vacío, no una línea en blanco.
        assert_eq!(
            strip_known_hosts("10.0.0.5 3389 cc:dd\n", "10.0.0.5", 3389).as_deref(),
            Some("")
        );
    }

    #[test]
    fn el_nombre_del_pem_es_el_de_freerdp() {
        assert_eq!(cert_file_name("10.0.0.5", 3389), "10.0.0.5_3389.pem");
    }

    #[test]
    fn un_host_no_puede_salirse_del_almacen() {
        assert!(host_is_safe("10.0.0.5"));
        assert!(host_is_safe("servidor.interno.local"));
        assert!(!host_is_safe(""));
        assert!(!host_is_safe(".."));
        assert!(!host_is_safe("../../etc/passwd"));
        assert!(!host_is_safe("a/b"));
        assert!(!host_is_safe("a\\b"));
        assert!(!host_is_safe("host\nfalso"));
        // Y `forget` lo rechaza en vez de tocar nada.
        assert!(forget("../../etc/passwd", 3389).is_err());
    }

    #[test]
    fn olvidar_borra_el_pem_y_la_linea_de_known_hosts() {
        let base = std::env::temp_dir().join(format!("rustty-rdpcert-{}", uuid::Uuid::new_v4()));
        let dir = base.join("freerdp");
        std::fs::create_dir_all(dir.join(SERVER_DIR)).unwrap();
        let dirs = vec![dir.clone()];

        let der = b"certificado de mentira";
        let pem = format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            STANDARD.encode(der)
        );
        std::fs::write(dir.join(SERVER_DIR).join("10.0.0.5_3389.pem"), &pem).unwrap();
        std::fs::write(
            dir.join(KNOWN_HOSTS),
            "10.0.0.5 3389 vieja\notro.local 3389 intacta\n",
        )
        .unwrap();

        assert_eq!(
            stored_fingerprint_in(&dirs, "10.0.0.5", 3389).as_deref(),
            Some(fingerprint_sha256_hex(der).as_str()),
            "el PEM de FreeRDP 3 manda sobre el known_hosts2 de la 2"
        );

        assert!(forget_in(&dirs, "10.0.0.5", 3389).unwrap());
        assert!(!dir.join(SERVER_DIR).join("10.0.0.5_3389.pem").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join(KNOWN_HOSTS)).unwrap(),
            "otro.local 3389 intacta\n"
        );
        assert_eq!(stored_fingerprint_in(&dirs, "10.0.0.5", 3389), None);
        // Olvidar lo ya olvidado no es un error, simplemente no había nada.
        assert!(!forget_in(&dirs, "10.0.0.5", 3389).unwrap());

        let _ = std::fs::remove_dir_all(&base);
    }
}
