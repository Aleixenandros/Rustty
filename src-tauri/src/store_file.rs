//! Envelope versionado de los almacenes locales (`profiles.json`,
//! `credentials.json`, `scripts.json`).
//!
//! Hasta v1.54.0 los stores eran un **array JSON pelado**: no había dónde
//! declarar el esquema ni de dónde volver si una migración salía mal. Este módulo
//! los envuelve:
//!
//! ```json
//! { "version": 2, "kind": "profiles", "items": [ … ] }
//! ```
//!
//! ## Qué garantiza
//!
//! - **Lectura retrocompatible.** Un array pelado se reconoce como formato v1 (el
//!   legado) y se lee igual. No hay que convertir nada a mano.
//! - **Copia antes de migrar.** Al subir de formato, el fichero original se copia
//!   a `<nombre>.v<N>-<ts>.bak` **antes** de reescribirlo, y esa copia no se borra
//!   nunca. Es el «de dónde volver» que faltaba: también sirve para volver a una
//!   versión anterior de Rustty, que no entiende el envelope.
//! - **Un formato futuro no se destruye.** Si el fichero declara una versión
//!   *mayor* que [`CURRENT_VERSION`] —el usuario abrió una build más nueva y luego
//!   una vieja— se devuelve [`AppError::Store`] y **no se toca el fichero**. Sin
//!   esto, el JSON «raro» acabaría en cuarentena y el siguiente guardado escribiría
//!   encima: la app antigua se comería los datos de la nueva.
//!
//! El módulo se apoya en [`crate::atomic_file`] para la escritura atómica y la
//! recuperación de ficheros dañados; aquí solo vive el **formato**.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::atomic_file::{self, Recovery};
use crate::error::AppError;

/// Versión del formato que escribe esta build.
pub const CURRENT_VERSION: u32 = 2;

/// Versión implícita del formato legado: un array JSON sin envoltorio, que es lo
/// que escribían las builds hasta v1.54.0 incluida.
pub const LEGACY_VERSION: u32 = 1;

/// Forma del fichero en disco, determinada **sin** deserializar los items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Array JSON pelado (formato v1).
    Legacy,
    /// Envelope `{version, kind, items}` con la versión que declara.
    Versioned(u32),
}

/// Envelope tal y como se escribe (toma prestados los items: no los clona).
#[derive(Serialize)]
struct EnvelopeOut<'a, T> {
    version: u32,
    kind: &'a str,
    items: &'a [T],
}

/// Envelope tal y como se lee.
#[derive(Deserialize)]
struct EnvelopeIn<T> {
    #[serde(default)]
    kind: String,
    items: Vec<T>,
}

/// Reconoce la forma del contenido sin mirar los items.
///
/// Devuelve `None` solo si el texto **no es interpretable** (ni array ni envelope
/// con `items`): eso sí es corrupción. Un envelope de versión futura devuelve
/// `Some(Versioned(n))` a propósito — no está dañado, simplemente no sabemos
/// leerlo, y tratarlo como basura lo mandaría a cuarentena.
pub fn shape_of(text: &str) -> Option<Shape> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.is_array() {
        return Some(Shape::Legacy);
    }
    let obj = value.as_object()?;
    let version = u32::try_from(obj.get("version")?.as_u64()?).ok()?;
    obj.get("items")?.as_array()?;
    Some(Shape::Versioned(version))
}

/// Deserializa el contenido de un store, venga en envelope o en el array legado.
/// Devuelve los items y la versión de formato con la que estaban escritos.
pub fn parse<T: DeserializeOwned>(text: &str, kind: &str) -> Result<(Vec<T>, u32), AppError> {
    match shape_of(text) {
        Some(Shape::Legacy) => Ok((serde_json::from_str::<Vec<T>>(text)?, LEGACY_VERSION)),
        Some(Shape::Versioned(version)) if version <= CURRENT_VERSION => {
            let envelope: EnvelopeIn<T> = serde_json::from_str(text)?;
            // El `kind` es una red contra ficheros cruzados (un `credentials.json`
            // copiado sobre `profiles.json`): los items podrían incluso
            // deserializar a medias y dejar un catálogo mutilado.
            if !envelope.kind.is_empty() && envelope.kind != kind {
                return Err(AppError::Store(format!(
                    "El almacén «{kind}» contiene datos de «{}»: no se carga para no sobrescribirlo.",
                    envelope.kind
                )));
            }
            Ok((envelope.items, version))
        }
        Some(Shape::Versioned(version)) => Err(AppError::Store(format!(
            "«{kind}» está en formato v{version} y esta versión de Rustty entiende \
             hasta la v{CURRENT_VERSION}. Lo ha escrito una versión más reciente: \
             actualiza Rustty para no perder estos datos."
        ))),
        None => Err(AppError::Serialization(format!(
            "«{kind}» no tiene un formato reconocible"
        ))),
    }
}

/// Devuelve los items como JSON genérico, venga el fichero en envelope o en el
/// array legado. Para los llamadores que solo miran un campo suelto y no quieren
/// acoplarse al tipo completo (p. ej. contar qué perfiles usan una credencial).
///
/// Existe para que ese código **no** vuelva a asumir que el fichero es un array:
/// si lo hiciera, con el envelope leería cero items en silencio y la comprobación
/// que hace pasaría a no comprobar nada.
pub fn items_value(text: &str) -> Option<Vec<serde_json::Value>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    match value {
        serde_json::Value::Array(items) => Some(items),
        serde_json::Value::Object(mut obj) => match obj.remove("items")? {
            serde_json::Value::Array(items) => Some(items),
            _ => None,
        },
        _ => None,
    }
}

/// Serializa los items en el formato actual.
pub fn encode<T: Serialize>(kind: &str, items: &[T]) -> Result<String, AppError> {
    let envelope = EnvelopeOut {
        version: CURRENT_VERSION,
        kind,
        items,
    };
    Ok(serde_json::to_string_pretty(&envelope)?)
}

/// Ruta de la copia previa a una migración de esquema: `<nombre>.v<N>-<ts>.bak`.
/// Lleva la versión de origen y la marca de tiempo, así que ni pisa una copia
/// anterior ni se confunde con el `.bak` rotatorio de `atomic_file`.
fn migration_backup_path(path: &Path, from: u32) -> PathBuf {
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".v{from}-{ts}.bak"));
    path.with_file_name(name)
}

/// Lee un store: lo **recupera** si está dañado y lo **migra** si viene en un
/// formato antiguo, guardando antes una copia intacta del original.
///
/// Devuelve los items y qué hizo falta para leerlos ([`Recovery`]), que el
/// llamador propaga al frontend (un `Lost` no se puede callar).
pub fn read<T: DeserializeOwned + Serialize>(
    path: &Path,
    kind: &str,
    private: bool,
) -> Result<(Vec<T>, Recovery), AppError> {
    let (data, recovery) = atomic_file::read_or_recover(path, private, |text| {
        // Un fichero vacío es un store vacío, no un store roto (lo escribían así
        // algunas versiones de `scripts.json`).
        text.trim().is_empty() || shape_of(text).is_some()
    })?;

    let Some(data) = data else {
        return Ok((vec![], recovery));
    };
    if data.trim().is_empty() {
        return Ok((vec![], recovery));
    }

    let (items, version) = parse::<T>(&data, kind)?;

    if version < CURRENT_VERSION {
        // Migración de esquema: copia del original **antes** de reescribir nada.
        // Si la copia falla, no se migra: seguimos leyendo el legado sin tocarlo
        // (perder la vuelta atrás es peor que arrastrar el formato viejo un rato).
        let backup = migration_backup_path(path, version);
        std::fs::write(&backup, data.as_bytes())?;
        if private {
            set_private(&backup);
        }
        write(path, kind, &items, private)?;
        log::info!(
            "«{kind}»: migrado del formato v{version} a v{CURRENT_VERSION}; copia previa en {}",
            backup.display()
        );
    }

    Ok((items, recovery))
}

/// Escribe el store completo, atómicamente, en el formato actual.
pub fn write<T: Serialize>(
    path: &Path,
    kind: &str,
    items: &[T],
    private: bool,
) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = encode(kind, items)?;
    atomic_file::write(path, data.as_bytes(), private)?;
    Ok(())
}

/// 0600 para la copia de migración de un store privado: la vuelta atrás no puede
/// ser el agujero por el que se filtren los datos que el store protege.
#[cfg(unix)]
fn set_private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct Item {
        id: String,
    }

    fn item(id: &str) -> Item {
        Item { id: id.to_string() }
    }

    fn test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rustty-store-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("crea dir temporal");
        dir
    }

    #[test]
    fn reconoce_las_dos_formas_y_rechaza_la_basura() {
        assert_eq!(shape_of("[]"), Some(Shape::Legacy));
        assert_eq!(
            shape_of(r#"{"version":2,"kind":"profiles","items":[]}"#),
            Some(Shape::Versioned(2))
        );
        // Versión futura: forma válida (no es basura), aunque no sepamos leerla.
        assert_eq!(
            shape_of(r#"{"version":99,"items":[]}"#),
            Some(Shape::Versioned(99))
        );
        assert_eq!(shape_of("{ no soy json"), None);
        assert_eq!(shape_of(r#"{"version":2}"#), None, "un envelope sin items");
    }

    #[test]
    fn el_array_pelado_se_lee_como_v1_y_se_migra_guardando_copia() {
        let dir = test_dir("migra");
        let path = dir.join("profiles.json");
        std::fs::write(&path, r#"[{"id":"a"},{"id":"b"}]"#).unwrap();

        let (items, _) = read::<Item>(&path, "profiles", true).expect("lee el legado");
        assert_eq!(items, vec![item("a"), item("b")]);

        // El fichero queda ya en el formato nuevo…
        let escrito = std::fs::read_to_string(&path).unwrap();
        assert_eq!(shape_of(&escrito), Some(Shape::Versioned(CURRENT_VERSION)));

        // …y el original sigue existiendo intacto, para poder volver atrás.
        let copias: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".v1-"))
            .collect();
        assert_eq!(copias.len(), 1, "debe quedar una copia pre-migración");
        assert_eq!(
            std::fs::read_to_string(copias[0].path()).unwrap(),
            r#"[{"id":"a"},{"id":"b"}]"#
        );

        // Releer no vuelve a migrar (es idempotente): no aparece una segunda copia.
        let (items, _) = read::<Item>(&path, "profiles", true).expect("relee");
        assert_eq!(items.len(), 2);
        let copias = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".v1-"))
            .count();
        assert_eq!(copias, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_formato_futuro_no_se_lee_ni_se_toca() {
        let dir = test_dir("futuro");
        let path = dir.join("profiles.json");
        let futuro = r#"{"version":99,"kind":"profiles","items":[{"id":"del futuro"}]}"#;
        std::fs::write(&path, futuro).unwrap();

        let err = read::<Item>(&path, "profiles", true).expect_err("no debe leerse");
        assert!(
            matches!(&err, AppError::Store(msg) if msg.contains("v99")),
            "el error debe explicar la versión: {err}"
        );
        // Y sobre todo: el fichero sigue ahí, entero. Una build vieja que lo
        // sobrescribiera se comería los datos de la nueva.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), futuro);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_carga_un_store_de_otro_tipo() {
        let dir = test_dir("cruzado");
        let path = dir.join("profiles.json");
        std::fs::write(&path, r#"{"version":2,"kind":"credentials","items":[]}"#).unwrap();

        let err = read::<Item>(&path, "profiles", true).expect_err("kind cruzado");
        assert!(matches!(err, AppError::Store(_)), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trip_en_el_formato_actual() {
        let dir = test_dir("roundtrip");
        let path = dir.join("scripts.json");
        let items = vec![item("uno"), item("dos")];

        write(&path, "scripts", &items, false).expect("escribe");
        let (back, rec) = read::<Item>(&path, "scripts", false).expect("lee");
        assert_eq!(back, items);
        assert_eq!(rec, Recovery::Intact);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_store_vacio_es_una_lista_vacia() {
        let dir = test_dir("vacio");
        let path = dir.join("scripts.json");
        std::fs::write(&path, "").unwrap();
        let (items, _) = read::<Item>(&path, "scripts", false).expect("lee vacío");
        assert!(items.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
