//! «Acceso sin contraseña»: el equivalente integrado de `ssh-copy-id`.
//!
//! Desde el menú contextual de un perfil, Rustty (1) garantiza un par de
//! claves local (`~/.ssh/id_ed25519`, generado **sin passphrase** si no
//! existe: el objetivo es el acceso desatendido y así lo elige el usuario),
//! (2) se conecta con las credenciales actuales del perfil e instala la
//! pública en el `authorized_keys` remoto de forma **idempotente** (sin
//! duplicados, con los permisos canónicos), (3) **verifica** reconectando con
//! la clave antes de dar nada por bueno, y (4) opcionalmente añade un bloque
//! `Host` a `~/.ssh/config` para el `ssh` de la terminal — solo si el alias
//! no existe: jamás se toca configuración previa del usuario.
//!
//! La frontera de seguridad del comando remoto es la misma que en `mux`:
//! **restricción de charset**, no escapado. La línea pública es base64, tipo
//! y comentario saneado; se comprueba además que no contenga comillas ni
//! saltos antes de interpolarla entre comillas simples.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::ssh_key::{Algorithm, LineEnding, PrivateKey, PublicKey};
use russh::ChannelMsg;

use crate::host_keys;
use crate::profiles::ConnectionProfile;
use crate::ssh_manager::{authenticate_handle, russh_connect_addr};
use russh::client::AuthResult;

/// Plazo para el comando remoto de instalación.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Informe del asistente (espejo camelCase para el frontend).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySetupReport {
    pub key_path: String,
    /// La clave local se ha generado en esta pasada (no existía).
    pub generated: bool,
    /// La reconexión de verificación con la clave funcionó.
    pub verified: bool,
    /// Con `verified = false`: por qué no se pudo verificar.
    pub verify_error: Option<String>,
    /// Se añadió el bloque `Host` a `~/.ssh/config`.
    pub ssh_config_added: bool,
    /// Alias usado en el bloque (si se pidió tocar el config).
    pub alias: Option<String>,
}

/// Comentario/alias saneado al charset `[A-Za-z0-9@._-]` (misma filosofía que
/// `mux::sanitize_session_name`: restricción, no escapado). Vacío → fallback.
fn sanitize_token(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-') {
            out.push(c);
            prev_dash = c == '-';
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Línea `authorized_keys` de la clave con el comentario saneado. La línea
/// resultante solo puede contener base64/tipo/comentario seguro; se verifica
/// defensivamente antes de que nadie la interpole en un comando.
pub fn public_key_line(key: &PublicKey, comment: &str) -> Result<String, String> {
    let mut key = key.clone();
    key.set_comment(sanitize_token(comment, "rustty"));
    let line = key.to_openssh().map_err(|e| e.to_string())?;
    let line = line.trim().to_string();
    if line.contains('\'') || line.contains('\n') || line.contains('\\') {
        return Err("la línea de la clave pública contiene caracteres inesperados".to_string());
    }
    Ok(line)
}

/// Comando remoto idempotente de instalación en `~/.ssh` (lo que hace
/// `ssh-copy-id`): crea el directorio y el fichero con permisos canónicos y
/// añade la línea SOLO si no está ya.
pub fn install_command(pub_line: &str) -> String {
    install_command_at(pub_line, "~/.ssh")
}

/// Variante con directorio explícito. Existe para el test de integración
/// (que instala en el `authorized_keys` del sshd de pruebas, no en el real).
pub fn install_command_at(pub_line: &str, dir: &str) -> String {
    format!(
        "mkdir -p {dir} && chmod 700 {dir} && touch {dir}/authorized_keys && \
         chmod 600 {dir}/authorized_keys && \
         (grep -qxF '{pub_line}' {dir}/authorized_keys || echo '{pub_line}' >> {dir}/authorized_keys)"
    )
}

/// ¿Existe ya un `Host` con este alias en un ssh_config?
pub fn ssh_config_has_host(contents: &str, alias: &str) -> bool {
    contents.lines().any(|line| {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        let Some(rest_len) = lower.strip_prefix("host ").map(str::len) else {
            return false;
        };
        line[line.len() - rest_len..]
            .split_whitespace()
            .any(|tok| tok == alias)
    })
}

/// Bloque `Host` para `~/.ssh/config`.
pub fn ssh_config_block(alias: &str, host: &str, port: u16, user: &str, identity: &Path) -> String {
    format!(
        "\n# Añadido por Rustty\nHost {alias}\n    HostName {host}\n    Port {port}\n    User {user}\n    IdentityFile {}\n",
        identity.display()
    )
}

fn pub_path(private: &Path) -> PathBuf {
    let mut name = private.file_name().unwrap_or_default().to_os_string();
    name.push(".pub");
    private.with_file_name(name)
}

/// Garantiza el par de claves local. Si el fichero no existe, genera una
/// ed25519 nueva sin passphrase (privada 0600 por `atomic_file`, `.pub` al
/// lado). Si existe, usa su `.pub` (no hace falta descifrar la privada) o la
/// deriva de una privada sin cifrar. Devuelve `(pública, generada)`.
pub fn ensure_local_key(private_path: &Path) -> Result<(PublicKey, bool), String> {
    if private_path.exists() {
        let pub_file = pub_path(private_path);
        if pub_file.exists() {
            let text = std::fs::read_to_string(&pub_file)
                .map_err(|e| format!("no se pudo leer {}: {e}", pub_file.display()))?;
            let key = PublicKey::from_openssh(text.trim())
                .map_err(|e| format!("{} no parece una clave pública OpenSSH: {e}", pub_file.display()))?;
            return Ok((key, false));
        }
        let private = PrivateKey::read_openssh_file(private_path).map_err(|e| {
            format!(
                "existe {} pero sin su .pub y la privada no se pudo leer ({e}); \
                 genera el .pub con `ssh-keygen -y` o elimina la clave",
                private_path.display()
            )
        })?;
        if private.is_encrypted() {
            return Err(format!(
                "existe {} pero está cifrada y falta su .pub; genera el .pub con `ssh-keygen -y`",
                private_path.display()
            ));
        }
        return Ok((private.public_key().clone(), false));
    }

    let mut private = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|e| format!("no se pudo generar la clave: {e}"))?;
    private.set_comment("rustty");
    let pem = private
        .to_openssh(LineEnding::LF)
        .map_err(|e| e.to_string())?;
    crate::atomic_file::write(private_path, pem.as_bytes(), true)
        .map_err(|e| format!("no se pudo escribir {}: {e}", private_path.display()))?;
    let public = private.public_key().clone();
    let line = public_key_line(&public, "rustty")?;
    crate::atomic_file::write(&pub_path(private_path), format!("{line}\n").as_bytes(), false)
        .map_err(|e| e.to_string())?;
    Ok((public, true))
}

/// Añade el bloque `Host` si el alias no existe todavía. Nunca modifica
/// entradas previas; escritura atómica y privada (0600). Devuelve si añadió.
pub fn add_ssh_config_host(
    config_path: &Path,
    alias: &str,
    host: &str,
    port: u16,
    user: &str,
    identity: &Path,
) -> Result<bool, String> {
    let existing = std::fs::read_to_string(config_path).unwrap_or_default();
    if ssh_config_has_host(&existing, alias) {
        return Ok(false);
    }
    let mut out = existing;
    out.push_str(&ssh_config_block(alias, host, port, user, identity));
    crate::atomic_file::write(config_path, out.as_bytes(), true).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Ejecuta un comando por `exec` sobre el handle autenticado y devuelve su
/// exit status (con la cola de salida para diagnóstico si falla).
async fn run_remote(
    handle: &client::Handle<host_keys::KnownHostsClient>,
    command: &str,
) -> Result<(), String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("no se pudo abrir el canal: {e}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("no se pudo lanzar el comando remoto: {e}"))?;
    let mut output = Vec::new();
    let mut status: Option<u32> = None;
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => output.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => {
                    status = Some(exit_status);
                    break;
                }
                ChannelMsg::Close | ChannelMsg::ExitSignal { .. } => break,
                // Eof puede llegar ANTES que el exit status: se sigue leyendo.
                _ => {}
            }
        }
    };
    tokio::time::timeout(INSTALL_TIMEOUT, read)
        .await
        .map_err(|_| "el comando remoto no terminó a tiempo".to_string())?;
    match status {
        Some(0) => Ok(()),
        other => {
            let tail = String::from_utf8_lossy(&output);
            let tail = tail.trim();
            Err(format!(
                "el comando remoto terminó con estado {other:?}{}{}",
                if tail.is_empty() { "" } else { ": " },
                tail
            ))
        }
    }
}

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        keepalive_interval: None,
        ..Default::default()
    })
}

async fn connect(
    profile: &ConnectionProfile,
) -> Result<client::Handle<host_keys::KnownHostsClient>, String> {
    let addr = format!("{}:{}", profile.host, profile.port);
    let (handler, failure) = host_keys::client(profile.host.clone(), profile.port, false, false);
    russh_connect_addr(client_config(), &addr, handler)
        .await
        .map_err(|e| host_keys::take_failure(&failure).unwrap_or_else(|| e.to_string()))
}

/// Flujo completo del asistente. Corre en un runtime dedicado (ver el
/// comando en `commands.rs`).
pub async fn setup_key_access(
    profile: &ConnectionProfile,
    password: Option<&str>,
    passphrase: Option<&str>,
    write_ssh_config: bool,
) -> Result<KeySetupReport, String> {
    // 1. Clave local.
    let home = dirs::home_dir().ok_or_else(|| "no se pudo localizar el home".to_string())?;
    let ssh_dir = home.join(".ssh");
    if !ssh_dir.exists() {
        std::fs::create_dir_all(&ssh_dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&ssh_dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let key_path = ssh_dir.join("id_ed25519");
    let (public, generated) = ensure_local_key(&key_path)?;
    let pub_line = public_key_line(&public, "rustty")?;

    // 2. Conectar y autenticar con las credenciales ACTUALES del perfil.
    let mut handle = connect(profile).await?;
    let password_owned = password.map(str::to_string);
    let passphrase_owned = passphrase.map(str::to_string);
    match authenticate_handle(
        &mut handle,
        &profile.auth_type,
        &profile.username,
        password_owned.as_ref(),
        passphrase_owned.as_ref(),
        profile.key_path.as_deref(),
    )
    .await
    {
        Ok(AuthResult::Success) => {}
        Ok(AuthResult::Failure { .. }) => {
            return Err("la autenticación con las credenciales actuales falló".to_string())
        }
        Err(e) => return Err(e.to_string()),
    }

    // 3. Instalar la pública en el remoto (idempotente).
    run_remote(&handle, &install_command(&pub_line)).await?;
    let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;

    // 4. Verificar: reconexión REAL autenticando con la clave. Solo si esto
    // funciona el perfil debe cambiar a autenticación por clave.
    let (verified, verify_error) = match verify_with_key(profile, &key_path).await {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e)),
    };

    // 5. Bloque en ~/.ssh/config (opcional, nunca pisa entradas existentes).
    let mut ssh_config_added = false;
    let mut alias = None;
    if write_ssh_config {
        let a = sanitize_token(&profile.name, &profile.host);
        ssh_config_added = add_ssh_config_host(
            &ssh_dir.join("config"),
            &a,
            &profile.host,
            profile.port,
            &profile.username,
            &key_path,
        )?;
        alias = Some(a);
    }

    Ok(KeySetupReport {
        key_path: key_path.display().to_string(),
        generated,
        verified,
        verify_error,
        ssh_config_added,
        alias,
    })
}

async fn verify_with_key(profile: &ConnectionProfile, key_path: &Path) -> Result<(), String> {
    let mut handle = connect(profile).await?;
    let key_path_str = key_path.display().to_string();
    match authenticate_handle(
        &mut handle,
        &crate::profiles::AuthType::PublicKey,
        &profile.username,
        None,
        None,
        Some(&key_path_str),
    )
    .await
    {
        Ok(AuthResult::Success) => {
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
            Ok(())
        }
        Ok(AuthResult::Failure { .. }) => {
            Err("el servidor no aceptó la clave recién instalada".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUB: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHiVQ7pP9Gkw4Ce6/iSwB16+zfQQK08zZ0xMXi3zO2yy";

    #[test]
    fn la_linea_publica_sanea_el_comentario() {
        let key = PublicKey::from_openssh(PUB).unwrap();
        let line = public_key_line(&key, "equipo de aleix'; rm -rf /").unwrap();
        assert!(line.starts_with("ssh-ed25519 AAAA"), "{line}");
        assert!(!line.contains('\''), "{line}");
        assert!(line.ends_with("equipo-de-aleix-rm--rf"), "{line}");
    }

    #[test]
    fn el_comando_de_instalacion_es_idempotente_por_grep() {
        let cmd = install_command("ssh-ed25519 AAAA rustty");
        assert!(cmd.contains("grep -qxF 'ssh-ed25519 AAAA rustty'"), "{cmd}");
        assert!(cmd.contains("chmod 700 ~/.ssh"), "{cmd}");
        assert!(cmd.contains("chmod 600 ~/.ssh/authorized_keys"), "{cmd}");
    }

    #[test]
    fn ssh_config_detecta_alias_existentes() {
        let contents = "Host otro\n    HostName x\n\nhost mi-alias produccion\n";
        assert!(ssh_config_has_host(contents, "mi-alias"));
        assert!(ssh_config_has_host(contents, "produccion"));
        assert!(ssh_config_has_host(contents, "otro"));
        assert!(!ssh_config_has_host(contents, "alias"));
        assert!(!ssh_config_has_host("", "alias"));
    }

    #[test]
    fn add_ssh_config_no_pisa_ni_duplica() {
        let dir = std::env::temp_dir().join(format!("rustty-sshcfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config");
        std::fs::write(&cfg, "Host viejo\n    HostName 1.2.3.4\n").unwrap();

        let id = dir.join("id_ed25519");
        let added =
            add_ssh_config_host(&cfg, "nuevo", "example.com", 2222, "aleix", &id).unwrap();
        assert!(added);
        let contents = std::fs::read_to_string(&cfg).unwrap();
        assert!(contents.starts_with("Host viejo\n"), "no debe tocar lo previo");
        assert!(contents.contains("Host nuevo\n"));
        assert!(contents.contains("Port 2222"));

        // Segunda pasada con el mismo alias: no duplica.
        let again =
            add_ssh_config_host(&cfg, "nuevo", "example.com", 2222, "aleix", &id).unwrap();
        assert!(!again);
        assert_eq!(contents, std::fs::read_to_string(&cfg).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_local_key_genera_y_luego_reutiliza() {
        let dir = std::env::temp_dir().join(format!("rustty-keygen-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_ed25519");

        let (public, generated) = ensure_local_key(&path).expect("genera");
        assert!(generated);
        assert!(path.exists());
        assert!(pub_path(&path).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "la privada debe nacer 0600");
        }

        // Segunda llamada: reutiliza la misma clave (no regenera).
        let (public2, generated2) = ensure_local_key(&path).expect("reutiliza");
        assert!(!generated2);
        assert_eq!(
            public_key_line(&public, "c").unwrap(),
            public_key_line(&public2, "c").unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
