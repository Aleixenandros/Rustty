//! Permisos de ruta de un solo uso para el IPC de ficheros.
//!
//! Hasta v2.13.0 el renderer podía pedir `read_text_file("/cualquier/ruta")` o
//! `write_text_file(…)` y el backend obedecía: bastaba una XSS o un renderer
//! comprometido para leer `~/.ssh/id_ed25519` o reescribir `~/.bashrc`. Ahora la
//! ruta la elige **el usuario en un diálogo nativo que abre el backend**
//! (`commands::fs_pick`), y lo que vuelve al renderer es, además de la ruta para
//! enseñarla, un **permiso**: un token opaco que autoriza **una** operación
//! (leer o escribir) sobre **esa** ruta, durante un plazo corto.
//!
//! Tres garantías, todas comprobadas en los tests:
//!
//! - **Un solo uso.** [`FileGrants::take`] retira el permiso aunque la operación
//!   falle después: reintentar exige volver a elegir el fichero.
//! - **Modo exacto.** Un permiso de lectura no sirve para escribir, ni al revés.
//! - **La ruta no puede cambiar por debajo.** Se guarda canonicalizada al emitir
//!   (sin enlaces simbólicos) y se vuelve a canonicalizar justo antes de usarla:
//!   si un enlace de la ruta se cambió tras la selección para apuntar a otro
//!   sitio, las dos no coinciden y la operación se rechaza.
//!
//! La lectura de los `Include` de un `~/.ssh/config` es la única lectura sin
//! permiso que queda, y va acotada por [`check_ssh_config_path`]: solo bajo
//! `~/.ssh/` (o el `ssh` del sistema) y nunca un fichero que contenga una clave
//! privada ([`looks_like_private_key`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::locks::MutexExt;

/// Plazo de un permiso: cubre el tiempo que el usuario tarda en rellenar lo que
/// venga tras el diálogo (la passphrase de un backup, el asistente de import).
pub const GRANT_TTL: Duration = Duration::from_secs(15 * 60);

/// Tope de permisos vivos: los que nadie consumió (el usuario eligió fichero y
/// luego canceló) no pueden acumularse sin límite.
const MAX_GRANTS: usize = 32;

/// Prefijo estable de los errores de permiso, para que el frontend los traduzca
/// sin inspeccionar el resto del texto.
pub const GRANT_ERROR_MARKER: &str = "fs-grant:";

/// Qué autoriza un permiso.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantMode {
    /// Leer un fichero existente.
    Read,
    /// Crear o reemplazar un fichero.
    Write,
}

struct Grant {
    path: PathBuf,
    mode: GrantMode,
    issued: Instant,
}

/// Registro de permisos vivos, gestionado por Tauri como estado global.
#[derive(Default)]
pub struct FileGrants {
    inner: Mutex<HashMap<String, Grant>>,
}

fn grant_error(detail: &str) -> String {
    format!("{GRANT_ERROR_MARKER} {detail}")
}

impl FileGrants {
    pub fn new() -> Self {
        Self::default()
    }

    /// Emite un permiso para `path`. Falla si la ruta no sirve para `mode`
    /// (no existe, no es un fichero, su carpeta no existe…).
    pub fn issue(&self, path: &Path, mode: GrantMode) -> Result<String, String> {
        self.issue_at(path, mode, Instant::now())
    }

    fn issue_at(&self, path: &Path, mode: GrantMode, now: Instant) -> Result<String, String> {
        let canonical = canonical_target(path, mode)?;
        let token = uuid::Uuid::new_v4().to_string();
        let mut map = self.inner.lock_recover();
        map.retain(|_, g| now.saturating_duration_since(g.issued) <= GRANT_TTL);
        while map.len() >= MAX_GRANTS {
            let Some(oldest) = map
                .iter()
                .min_by_key(|(_, g)| g.issued)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            map.remove(&oldest);
        }
        map.insert(
            token.clone(),
            Grant {
                path: canonical,
                mode,
                issued: now,
            },
        );
        Ok(token)
    }

    /// Consume el permiso `token` para `mode` y devuelve la ruta a usar, ya
    /// revalidada. El permiso desaparece aunque este método falle.
    pub fn take(&self, token: &str, mode: GrantMode) -> Result<PathBuf, String> {
        self.take_at(token, mode, Instant::now())
    }

    fn take_at(&self, token: &str, mode: GrantMode, now: Instant) -> Result<PathBuf, String> {
        let grant = self
            .inner
            .lock_recover()
            .remove(token)
            .ok_or_else(|| grant_error("permiso desconocido o ya usado"))?;
        if grant.mode != mode {
            return Err(grant_error("el permiso no es para esta operación"));
        }
        if now.saturating_duration_since(grant.issued) > GRANT_TTL {
            return Err(grant_error("el permiso ha caducado"));
        }
        let again = canonical_target(&grant.path, mode)
            .map_err(|_| grant_error("la ruta ya no está disponible"))?;
        if again != grant.path {
            return Err(grant_error("la ruta ha cambiado desde que se eligió"));
        }
        Ok(grant.path)
    }
}

/// Forma canónica de la ruta que se va a leer o escribir.
///
/// - **Lectura**: el fichero debe existir y ser regular; se resuelven todos los
///   enlaces simbólicos.
/// - **Escritura**: el fichero puede no existir todavía, así que se canonicaliza
///   la **carpeta** y se le añade el nombre. Un enlace simbólico en el último
///   componente no se sigue: la escritura atómica (temporal + `rename`) lo
///   reemplaza en vez de escribir a través de él.
pub fn canonical_target(path: &Path, mode: GrantMode) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("la ruta no es absoluta".to_string());
    }
    match mode {
        GrantMode::Read => {
            let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
            if !canonical.is_file() {
                return Err("la ruta no es un fichero regular".to_string());
            }
            Ok(canonical)
        }
        GrantMode::Write => {
            let name = path
                .file_name()
                .ok_or_else(|| "la ruta no tiene nombre de fichero".to_string())?;
            let parent = path
                .parent()
                .ok_or_else(|| "la ruta no tiene carpeta".to_string())?;
            let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
            if !parent.is_dir() {
                return Err("la carpeta de destino no existe".to_string());
            }
            let target = parent.join(name);
            if target.is_dir() {
                return Err("el destino es una carpeta".to_string());
            }
            Ok(target)
        }
    }
}

/// Carpetas donde puede vivir un `Include` de un config de OpenSSH que se lee
/// sin permiso: la del usuario y la del sistema.
fn ssh_config_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![home.join(".ssh")];
    #[cfg(unix)]
    roots.push(PathBuf::from("/etc/ssh"));
    #[cfg(windows)]
    if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
        roots.push(PathBuf::from(program_data).join("ssh"));
    }
    roots
        .into_iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .collect()
}

/// Valida una ruta de `Include` de `~/.ssh/config`: debe resolver (enlaces
/// incluidos) a un fichero regular dentro de `~/.ssh/` o del `ssh` del sistema.
/// Devuelve la ruta canónica que hay que leer.
pub fn check_ssh_config_path(path: &Path, home: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.is_file() {
        return Err("la ruta no es un fichero regular".to_string());
    }
    if !ssh_config_roots(home)
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Err(grant_error(
            "un Include fuera de ~/.ssh no se lee sin elegirlo en un diálogo",
        ));
    }
    Ok(canonical)
}

/// ¿El texto parece una clave privada (PEM, OpenSSH, SSH2 o PuTTY)? Un `Include`
/// que apunte a una clave no se devuelve nunca al renderer.
pub fn looks_like_private_key(text: &str) -> bool {
    text.contains("PRIVATE KEY") || text.contains("PuTTY-User-Key-File-")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rustty-grants-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn un_permiso_de_lectura_se_usa_una_sola_vez() {
        let dir = test_dir("once");
        let file = dir.join("tema.json");
        std::fs::write(&file, "{}").unwrap();
        let grants = FileGrants::new();
        let token = grants.issue(&file, GrantMode::Read).unwrap();
        let path = grants.take(&token, GrantMode::Read).unwrap();
        assert_eq!(path, std::fs::canonicalize(&file).unwrap());
        let again = grants.take(&token, GrantMode::Read).unwrap_err();
        assert!(again.starts_with(GRANT_ERROR_MARKER), "{again}");
    }

    #[test]
    fn un_token_inventado_no_abre_nada() {
        let grants = FileGrants::new();
        let err = grants.take("no-existe", GrantMode::Read).unwrap_err();
        assert!(err.starts_with(GRANT_ERROR_MARKER));
    }

    #[test]
    fn el_modo_tiene_que_coincidir_y_el_fallo_consume_el_permiso() {
        let dir = test_dir("mode");
        let file = dir.join("export.json");
        std::fs::write(&file, "{}").unwrap();
        let grants = FileGrants::new();
        let token = grants.issue(&file, GrantMode::Read).unwrap();
        assert!(grants.take(&token, GrantMode::Write).is_err());
        // Ni siquiera con el modo bueno: el intento fallido ya lo retiró.
        assert!(grants.take(&token, GrantMode::Read).is_err());
    }

    #[test]
    fn un_permiso_caducado_se_rechaza() {
        let dir = test_dir("ttl");
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let grants = FileGrants::new();
        let t0 = Instant::now();
        let token = grants.issue_at(&file, GrantMode::Read, t0).unwrap();
        let later = t0 + GRANT_TTL + Duration::from_secs(1);
        let err = grants.take_at(&token, GrantMode::Read, later).unwrap_err();
        assert!(err.contains("caducado"), "{err}");
    }

    #[test]
    fn la_escritura_admite_un_fichero_que_aun_no_existe() {
        let dir = test_dir("write-new");
        let target = dir.join("nuevo.json");
        let grants = FileGrants::new();
        let token = grants.issue(&target, GrantMode::Write).unwrap();
        let path = grants.take(&token, GrantMode::Write).unwrap();
        assert_eq!(
            path,
            std::fs::canonicalize(&dir).unwrap().join("nuevo.json")
        );
    }

    #[test]
    fn no_se_emite_permiso_de_lectura_para_una_carpeta_ni_para_rutas_relativas() {
        let dir = test_dir("dir");
        let grants = FileGrants::new();
        assert!(grants.issue(&dir, GrantMode::Read).is_err());
        assert!(grants.issue(&dir, GrantMode::Write).is_err());
        assert!(grants
            .issue(Path::new("relativa.json"), GrantMode::Read)
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn un_enlace_cambiado_tras_elegir_la_ruta_invalida_el_permiso() {
        let dir = test_dir("swap");
        let legit = dir.join("legit");
        let secret = dir.join("secret");
        std::fs::create_dir_all(&legit).unwrap();
        std::fs::create_dir_all(&secret).unwrap();
        std::fs::write(legit.join("config.json"), "{}").unwrap();
        std::fs::write(secret.join("config.json"), "SECRETO").unwrap();
        let link = dir.join("carpeta");
        std::os::unix::fs::symlink(&legit, &link).unwrap();

        let grants = FileGrants::new();
        let token = grants
            .issue(&link.join("config.json"), GrantMode::Read)
            .unwrap();
        // El permiso quedó anclado a la ruta real (`legit/config.json`), no al
        // enlace: reapuntar el enlace no cambia lo que se lee.
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let path = grants.take(&token, GrantMode::Read).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{}");

        // Y si lo que cambia es un componente de la propia ruta canónica, se
        // rechaza en vez de seguir el enlace nuevo.
        let token = grants
            .issue(&legit.join("config.json"), GrantMode::Read)
            .unwrap();
        std::fs::rename(&legit, dir.join("legit-movido")).unwrap();
        std::os::unix::fs::symlink(&secret, &legit).unwrap();
        let err = grants.take(&token, GrantMode::Read).unwrap_err();
        assert!(err.starts_with(GRANT_ERROR_MARKER), "{err}");
    }

    #[test]
    fn los_permisos_sin_consumir_no_se_acumulan() {
        let dir = test_dir("cap");
        let file = dir.join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let grants = FileGrants::new();
        let first = grants.issue(&file, GrantMode::Read).unwrap();
        for _ in 0..MAX_GRANTS {
            grants.issue(&file, GrantMode::Read).unwrap();
        }
        assert!(grants.inner.lock_recover().len() <= MAX_GRANTS);
        // El más antiguo es el que se descartó.
        assert!(grants.take(&first, GrantMode::Read).is_err());
    }

    #[test]
    fn un_include_fuera_de_ssh_se_rechaza() {
        let home = test_dir("home");
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(ssh.join("config.d")).unwrap();
        let inside = ssh.join("config.d").join("work");
        std::fs::write(&inside, "Host work\n").unwrap();
        let outside = home.join("notas.txt");
        std::fs::write(&outside, "secreto").unwrap();

        assert_eq!(
            check_ssh_config_path(&inside, &home).unwrap(),
            std::fs::canonicalize(&inside).unwrap()
        );
        let err = check_ssh_config_path(&outside, &home).unwrap_err();
        assert!(err.starts_with(GRANT_ERROR_MARKER), "{err}");
        // `..` no sirve para salir: se juzga la ruta ya resuelta.
        let sneaky = ssh.join("..").join("notas.txt");
        assert!(check_ssh_config_path(&sneaky, &home).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn un_enlace_dentro_de_ssh_que_apunta_fuera_se_rechaza() {
        let home = test_dir("home-link");
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(&ssh).unwrap();
        let outside = home.join("fuera.txt");
        std::fs::write(&outside, "x").unwrap();
        let link = ssh.join("config-link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(check_ssh_config_path(&link, &home).is_err());
    }

    #[test]
    fn detecta_los_formatos_de_clave_privada() {
        assert!(looks_like_private_key(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn…\n-----END OPENSSH PRIVATE KEY-----\n"
        ));
        assert!(looks_like_private_key("-----BEGIN RSA PRIVATE KEY-----\n"));
        assert!(looks_like_private_key(
            "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n"
        ));
        assert!(looks_like_private_key(
            "PuTTY-User-Key-File-3: ssh-ed25519\n"
        ));
        assert!(!looks_like_private_key(
            "Host bastion\n  HostName 10.0.0.1\n  IdentityFile ~/.ssh/id_ed25519\n"
        ));
    }
}
