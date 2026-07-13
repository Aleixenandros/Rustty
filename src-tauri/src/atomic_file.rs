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
//!
//! ## Límite conocido en Windows (`private` no fija una ACL por fichero)
//!
//! En Windows el flag `private` **no** aplica un DACL restrictivo al fichero: la
//! confidencialidad se apoya en que los datos de la app viven bajo `%APPDATA%`
//! (`C:\Users\<usuario>\AppData\Roaming\com.rustty.app`), un directorio cuyo ACL
//! por defecto ya concede acceso solo al propio usuario (y a los administradores
//! del equipo, que de todos modos pueden leer cualquier cosa de la sesión). No se
//! establece un DACL explícito por fichero **de forma deliberada**: hacerlo bien
//! exige la crate `windows-sys` (construir un SDDL y llamar a
//! `SetNamedSecurityInfo`) y validación real sobre Windows, y el riesgo de una ACL
//! mal formada —dejar el fichero inaccesible para la propia app— supera hoy la
//! ganancia frente a la herencia del directorio. Si en el futuro se endurece, el
//! punto único es `open_tmp` en la rama `#[cfg(not(unix))]`, sin tocar el resto
//! del módulo.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Marca de los temporales que crea este módulo. Se usa también para reconocer
/// (y barrer) los que dejó un proceso que murió a mitad de escritura.
const TMP_MARK: &str = ".rustty-";

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
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "ruta sin nombre de fichero"))?
        .to_string_lossy()
        .into_owned();
    let tmp = dir.join(format!(".{stem}{TMP_MARK}{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| {
        let mut file = open_tmp(&tmp, private)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        // El `rename` es atómico, pero la *entrada de directorio* que crea puede
        // quedar solo en el page cache: un corte de corriente justo después
        // dejaría el fichero sin nombre (o con el viejo) pese a que sus datos ya
        // estaban en disco. Sincronizar el directorio padre cierra esa ventana.
        sync_dir(&dir);
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// `fsync` del directorio, para que la entrada creada por el `rename` sea
/// duradera. En Windows no existe el equivalente (no se puede abrir un
/// directorio como fichero) y `ReplaceFile`/`MoveFileEx` ya dan la garantía; el
/// mejor esfuerzo aquí es no hacer nada.
#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

/// Retira los temporales huérfanos de `dir`: los que dejó un proceso que murió
/// entre el `open` y el `rename` (un `kill -9`, un corte de luz).
///
/// Solo borra ficheros que lleven la marca de este módulo **y** que estén
/// inactivos desde hace más de `min_age`. Esa espera no es cosmética: sin ella,
/// una segunda instancia (o esta misma, con otra escritura en vuelo) podría
/// barrer el temporal **vivo** de una escritura en curso.
///
/// Devuelve cuántos ha retirado. Los errores por fichero se ignoran a propósito:
/// es una limpieza oportunista, no una operación crítica.
pub fn sweep_orphan_temps(dir: &Path, min_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut swept = 0;

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with('.') || !name.contains(TMP_MARK) || !name.ends_with(".tmp") {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= min_age);
        if old_enough && std::fs::remove_file(entry.path()).is_ok() {
            swept += 1;
        }
    }
    swept
}

/// Qué ha hecho falta para poder leer un store.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Recovery {
    /// El fichero no existe todavía (primer arranque).
    Missing,
    /// El fichero estaba bien.
    Intact,
    /// El fichero no parseaba: se ha puesto en cuarentena y se ha restaurado la
    /// última copia buena. `corrupt` es dónde quedó el original, para que el
    /// usuario pueda rescatarlo a mano.
    RestoredFromBackup { corrupt: PathBuf },
    /// El fichero no parseaba y **no había copia buena**: se ha puesto en
    /// cuarentena y se arranca en blanco. Es el peor caso y hay que decírselo al
    /// usuario, no presentarle un catálogo vacío como si nada.
    Lost { corrupt: PathBuf },
}

/// Ruta de la copia de la última versión válida.
fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

/// Ruta de cuarentena, con marca de tiempo para no pisar una anterior.
fn quarantine_path(path: &Path) -> PathBuf {
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".corrupt-{ts}"));
    path.with_file_name(name)
}

/// Lee un store validando su contenido, y lo **recupera** si está dañado.
///
/// `is_valid` decide si el contenido parsea (normalmente un `serde_json::from_str`
/// que se descarta). El flujo:
///
/// 1. Si el fichero parsea → se refresca la copia `.bak` (esa es, por definición,
///    la última versión buena conocida) y se devuelve el contenido.
/// 2. Si **no** parsea → el original se mueve a cuarentena `<nombre>.corrupt-<ts>`
///    (no se borra: puede ser lo único que quede de los datos del usuario) y se
///    intenta la copia `.bak`. Si esa sí parsea, se restaura y se devuelve.
/// 3. Si tampoco hay copia buena → `Lost`. El llamador **debe** avisar: presentar
///    un catálogo vacío en silencio haría creer al usuario que ha perdido todo, y
///    el siguiente guardado escribiría encima de la nada.
///
/// `private` propaga los permisos 0600 a la copia de seguridad (los stores con
/// secretos no pueden filtrarlos por el `.bak`).
pub fn read_or_recover(
    path: &Path,
    private: bool,
    is_valid: impl Fn(&str) -> bool,
) -> io::Result<(Option<String>, Recovery)> {
    if !path.exists() {
        return Ok((None, Recovery::Missing));
    }

    let current = std::fs::read_to_string(path);
    if let Ok(text) = &current {
        if is_valid(text) {
            // Copia de seguridad de la última versión válida. Si falla, no es
            // motivo para abortar la carga: se sigue con el fichero bueno.
            let _ = write(&backup_path(path), text.as_bytes(), private);
            return Ok((Some(current.unwrap()), Recovery::Intact));
        }
    }

    // Dañado (ilegible o no parsea): a cuarentena, nunca a la papelera.
    let corrupt = quarantine_path(path);
    std::fs::rename(path, &corrupt)?;

    let backup = backup_path(path);
    if let Ok(text) = std::fs::read_to_string(&backup) {
        if is_valid(&text) {
            write(path, text.as_bytes(), private)?;
            return Ok((Some(text), Recovery::RestoredFromBackup { corrupt }));
        }
    }
    Ok((None, Recovery::Lost { corrupt }))
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
    // `_private` no tiene efecto en Windows (límite documentado en la cabecera del
    // módulo): la confidencialidad se apoya en el ACL de `%APPDATA%`, no en un DACL
    // por fichero. `create_new` sí mantiene la garantía anti-symlink/anti-carrera.
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(tmp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rustty-atomic-{tag}-{}", uuid::Uuid::new_v4()));
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

    /// Un JSON es válido si parsea como array.
    fn json_array_valido(text: &str) -> bool {
        serde_json::from_str::<Vec<serde_json::Value>>(text).is_ok()
    }

    #[test]
    fn barre_los_temporales_huerfanos_pero_no_los_recientes() {
        let dir = unique_test_dir("sweep");
        // Huérfano de un proceso que murió a mitad de escritura.
        let orphan = dir.join(".datos.json.rustty-abc.tmp");
        std::fs::write(&orphan, b"a medias").unwrap();
        // Temporal recién creado: puede ser una escritura VIVA de otra instancia.
        let fresh = dir.join(".datos.json.rustty-xyz.tmp");
        std::fs::write(&fresh, b"en curso").unwrap();
        // Fichero normal: no se toca jamás.
        let normal = dir.join("datos.json");
        std::fs::write(&normal, b"[]").unwrap();

        // `min_age` 0 barrería ambos; con una edad mínima alta no barre ninguno.
        assert_eq!(sweep_orphan_temps(&dir, Duration::from_secs(3600)), 0);
        assert!(orphan.exists() && fresh.exists());

        // Con `min_age` 0, los dos temporales se van y el fichero normal queda.
        assert_eq!(sweep_orphan_temps(&dir, Duration::ZERO), 2);
        assert!(!orphan.exists() && !fresh.exists());
        assert!(normal.exists(), "un fichero normal nunca se barre");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_store_intacto_refresca_su_copia_de_seguridad() {
        let dir = unique_test_dir("intact");
        let path = dir.join("profiles.json");
        std::fs::write(&path, br#"[{"id":"a"}]"#).unwrap();

        let (data, rec) = read_or_recover(&path, true, json_array_valido).expect("lee");
        assert_eq!(rec, Recovery::Intact);
        assert_eq!(data.as_deref(), Some(r#"[{"id":"a"}]"#));
        // La copia de seguridad es, por definición, la última versión buena.
        assert_eq!(
            std::fs::read_to_string(dir.join("profiles.json.bak")).unwrap(),
            r#"[{"id":"a"}]"#
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_store_danado_se_pone_en_cuarentena_y_se_restaura_la_copia() {
        let dir = unique_test_dir("restore");
        let path = dir.join("profiles.json");

        // Primera carga buena: deja la copia de seguridad.
        std::fs::write(&path, br#"[{"id":"bueno"}]"#).unwrap();
        read_or_recover(&path, true, json_array_valido).expect("primera carga");

        // El store se corrompe (disco lleno a mitad de escritura, p. ej.).
        std::fs::write(&path, b"{ esto no es json").unwrap();

        let (data, rec) = read_or_recover(&path, true, json_array_valido).expect("recupera");
        let Recovery::RestoredFromBackup { corrupt } = rec else {
            panic!("debía restaurar desde la copia, no {rec:?}");
        };
        // El fichero dañado NO se borra: puede ser lo único que quede.
        assert!(corrupt.exists());
        assert_eq!(std::fs::read_to_string(&corrupt).unwrap(), "{ esto no es json");
        // Y el store vuelve a tener la última versión buena.
        assert_eq!(data.as_deref(), Some(r#"[{"id":"bueno"}]"#));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"[{"id":"bueno"}]"#
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sin_copia_buena_el_store_se_declara_perdido_y_no_se_borra() {
        let dir = unique_test_dir("lost");
        let path = dir.join("profiles.json");
        std::fs::write(&path, b"basura").unwrap();

        let (data, rec) = read_or_recover(&path, true, json_array_valido).expect("procesa");
        let Recovery::Lost { corrupt } = rec else {
            panic!("sin copia debía declararse perdido, no {rec:?}");
        };
        assert!(data.is_none());
        // Se avisa (Lost) pero el original queda a salvo en cuarentena: nunca se
        // arranca en blanco borrando lo que hubiera.
        assert!(corrupt.exists());
        assert_eq!(std::fs::read_to_string(&corrupt).unwrap(), "basura");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
