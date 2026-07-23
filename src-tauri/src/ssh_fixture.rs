//! Servidor OpenSSH de verdad para los tests de integración.
//!
//! A diferencia del fixture RDP —que finge el protocolo—, aquí levantamos el
//! `sshd` **real** del sistema, sin privilegios: puerto efímero, host key y
//! claves de usuario propias, autenticación por clave pública contra el usuario
//! que corre el test. Así el flujo de conexión de Rustty (`russh_connect_addr`,
//! `authenticate_handle` y, sobre todo, el TOFU de `host_keys`) se ejercita
//! contra un servidor auténtico, no contra otra instancia de la misma librería.
//!
//! Todo vive en un directorio temporal que se borra al soltar el fixture, y el
//! `known_hosts` se redirige a ese directorio (`host_keys::client_with_known_hosts`)
//! para no tocar el `~/.ssh/known_hosts` de la máquina.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

/// `sshd` en marcha. Al soltarlo mata el proceso y borra el directorio temporal.
pub struct FakeSshServer {
    pub port: u16,
    /// Ruta a la clave privada del usuario, para autenticarse.
    pub user_key: PathBuf,
    /// Usuario del sistema contra el que autentica (el que corre el test).
    pub username: String,
    child: Child,
    dir: PathBuf,
}

impl Drop for FakeSshServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl FakeSshServer {
    /// Ruta a un `known_hosts` propio dentro del directorio del fixture. Empieza
    /// sin existir: la primera conexión lo crea (TOFU).
    pub fn known_hosts_path(&self) -> PathBuf {
        self.dir.join("known_hosts")
    }

    /// Fingerprint de la host key del servidor, en el formato de una línea de
    /// `known_hosts` (`[127.0.0.1]:puerto tipo base64`). Sirve para pre-sembrar
    /// un `known_hosts` con una clave *distinta* y provocar el aviso de cambio.
    pub fn host_key_line_for(&self, other_pubkey: &str) -> String {
        format!("[127.0.0.1]:{} {}", self.port, other_pubkey)
    }
}

/// Localiza el binario `sshd`. No suele estar en el `PATH` de un usuario normal.
fn find_sshd() -> Option<PathBuf> {
    ["/usr/sbin/sshd", "/usr/bin/sshd", "/sbin/sshd"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// Genera un par de claves con `ssh-keygen` (formato OpenSSH correcto, que es lo
/// que espera tanto `sshd` como `load_secret_key` de russh).
fn keygen(path: &Path) -> std::io::Result<()> {
    let status = Command::new("ssh-keygen")
        .args(["-t", "ed25519", "-N", "", "-q", "-f"])
        .arg(path)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other("ssh-keygen falló"));
    }
    Ok(())
}

/// Arranca el servidor. `None` si la máquina no tiene `sshd` o `ssh-keygen`
/// (el test que lo use debe saltarse con gracia, no fallar).
pub fn start() -> std::io::Result<Option<FakeSshServer>> {
    let Some(sshd) = find_sshd() else {
        return Ok(None);
    };
    // Sin `ssh-keygen` no hay forma de generar las claves; el test se salta.
    if Command::new("ssh-keygen").arg("-?").output().is_err() {
        return Ok(None);
    }

    let dir = std::env::temp_dir().join(format!("rustty-sshd-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;

    let host_key = dir.join("hostkey");
    let user_key = dir.join("userkey");
    keygen(&host_key)?;
    keygen(&user_key)?;

    // authorized_keys con la clave pública del usuario; permisos estrictos
    // porque, aunque `StrictModes no` los relaja, no está de más.
    let authorized = dir.join("authorized_keys");
    std::fs::copy(user_key.with_extension("pub"), &authorized)?;
    set_mode(&authorized, 0o600)?;

    let port = free_port()?;
    let config = dir.join("sshd_config");
    write_sshd_config(&config, &dir, &host_key, &authorized, port)?;

    // `-D` mantiene sshd en primer plano (lo gobierna nuestro `Child`); `-e`
    // manda los logs a stderr, donde no molestan.
    let child = Command::new(&sshd)
        .arg("-f")
        .arg(&config)
        .args(["-D", "-e"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;

    let username = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "root".to_string());

    let server = FakeSshServer {
        port,
        user_key,
        username,
        child,
        dir,
    };

    // sshd tarda unos ms en abrir el socket; esperamos a que acepte conexión.
    if !wait_until_listening(port, std::time::Duration::from_secs(5)) {
        return Err(std::io::Error::other("sshd no llegó a escuchar a tiempo"));
    }
    Ok(Some(server))
}

fn write_sshd_config(
    path: &Path,
    dir: &Path,
    host_key: &Path,
    authorized: &Path,
    port: u16,
) -> std::io::Result<()> {
    let mut f = std::fs::File::create(path)?;
    // `StrictModes no`: sin él sshd rechaza el home del usuario si no tiene
    // permisos 755, algo que no controlamos en un runner. `UsePAM no` evita el
    // camino de PAM (que exige privilegios). Solo publickey.
    write!(
        f,
        "Port {port}\n\
         ListenAddress 127.0.0.1\n\
         HostKey {hostkey}\n\
         PidFile {pid}\n\
         AuthorizedKeysFile {authorized}\n\
         StrictModes no\n\
         UsePAM no\n\
         PasswordAuthentication no\n\
         PubkeyAuthentication yes\n\
         Subsystem sftp internal-sftp\n",
        hostkey = host_key.display(),
        pid = dir.join("sshd.pid").display(),
        authorized = authorized.display(),
    )
}

fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    // El listener se cierra al salir; sshd toma el puerto acto seguido. La
    // ventana de carrera es teórica en localhost dentro de un test.
    Ok(port)
}

fn wait_until_listening(port: u16, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    false
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}
