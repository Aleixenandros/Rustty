//! Escritura de ficheros atómica y, opcionalmente, con permisos restrictivos.
//!
//! El contenido se vuelca primero a un temporal hermano con nombre aleatorio y
//! después se renombra sobre el destino. El `rename` reemplaza el fichero de
//! golpe, así que:
//! - un corte de corriente o un crash a mitad **no** deja el destino vacío ni a
//!   medias (el fichero previo permanece intacto hasta el `rename`);
//! - **no** se escribe a través de un symlink preparado en el destino (el
//!   `rename` sustituye el propio enlace por un fichero regular).
//!
//! Con `private = true`, en Unix el temporal se crea con modo 0600 desde el
//! primer instante, de modo que los secretos (`profiles.json`, `credentials.json`,
//! notas) nunca quedan legibles por otros usuarios ni durante la ventana de
//! escritura.

use std::io;
use std::path::Path;

/// Escribe `data` en `path` de forma atómica. Si `private` es true, el fichero
/// resultante queda con permisos 0600 en Unix (en otras plataformas el flag no
/// tiene efecto y se confía en las ACL del directorio de datos del usuario).
pub fn write(path: &Path, data: &[u8], private: bool) -> io::Result<()> {
    use std::io::Write;

    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => std::path::PathBuf::from("."),
    };
    let stem = path
        .file_name()
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "ruta sin nombre de fichero")
        })?
        .to_string_lossy()
        .into_owned();
    let tmp = dir.join(format!(".{}.rustty-{}.tmp", stem, uuid::Uuid::new_v4()));

    let result = (|| {
        let mut file = open_tmp(&tmp, private)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(unix)]
fn open_tmp(tmp: &Path, private: bool) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut opts = std::fs::OpenOptions::new();
    // `create_new` sobre un nombre aleatorio evita seguir un symlink colocado en
    // la ruta del temporal.
    opts.create_new(true).write(true);
    if private {
        opts.mode(0o600);
    }
    let file = opts.open(tmp)?;
    if private {
        // Fuerza 0600 con independencia del umask del proceso.
        let mut perms = file.metadata()?.permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o600);
        std::fs::set_permissions(tmp, perms)?;
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_tmp(tmp: &Path, _private: bool) -> io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(tmp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rustty-atomic-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("crea dir temporal de test");
        dir
    }

    #[test]
    fn escribe_reemplaza_y_no_deja_temporales() {
        let dir = unique_test_dir("basic");
        let path = dir.join("datos.txt");
        write(&path, b"primero", false).expect("primera escritura");
        assert_eq!(std::fs::read(&path).unwrap(), b"primero");
        write(&path, b"segundo mas largo", false).expect("sobrescritura");
        assert_eq!(std::fs::read(&path).unwrap(), b"segundo mas largo");
        let sobras = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".rustty-"))
            .count();
        assert_eq!(sobras, 0, "no deben quedar temporales");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn reemplaza_symlink_sin_seguirlo() {
        let dir = unique_test_dir("symlink");
        let target = dir.join("target");
        std::fs::write(&target, b"DESTINO-ORIGINAL").expect("crea destino");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&target, &link).expect("crea symlink");
        write(&link, b"NUEVO", false).expect("escribe sobre el symlink");
        assert_eq!(std::fs::read(&target).unwrap(), b"DESTINO-ORIGINAL");
        assert_eq!(std::fs::read(&link).unwrap(), b"NUEVO");
        assert!(!std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn modo_privado_deja_permisos_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_test_dir("perms");
        let path = dir.join("secreto.json");
        write(&path, b"{}", true).expect("escritura privada");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "el fichero privado debe quedar 0600");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
