//! Reanudación de descargas interrumpidas.
//!
//! Una descarga se materializa en `<nombre>.rustty-part` y solo ocupa su nombre
//! definitivo cuando ha terminado bien. Hasta ahora ese temporal se truncaba
//! siempre: un corte de red en el minuto 55 de una hora obligaba a empezar de
//! cero. Con la reanudación activada, el trozo ya bajado se conserva y la
//! descarga siguiente continúa donde se quedó.
//!
//! **Opcional y apagada por defecto**: sin activarla, el comportamiento es el
//! de siempre —temporal limpio en cada intento y ni un resto en el disco del
//! usuario—. Ese es justo el precio de reanudar: para poder continuar hay que
//! **conservar** el trozo cuando algo va mal, así que el `.part` sobrevive a un
//! fallo o a una cancelación en vez de borrarse.
//!
//! Continuar a ciegas sería peor que no continuar: si el fichero del servidor
//! cambió entre los dos intentos, pegar los bytes nuevos detrás de los viejos
//! produce un fichero que no es ninguna de las dos versiones y que **pasa la
//! verificación de tamaño**. Por eso junto al temporal se escribe una ficha
//! ([`PartMeta`]) con la ruta remota, el tamaño y la fecha de modificación del
//! origen, y solo se reanuda si el servidor sigue diciendo exactamente lo
//! mismo. Ante cualquier duda —ficha ausente, ilegible o discrepante— se
//! empieza de cero, que es la respuesta segura.
//!
//! La decisión es una función pura ([`plan`]) que no toca el disco: recibe lo
//! que dicen la ficha, el temporal y el servidor, y devuelve qué hacer.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

/// Extensión de la ficha que acompaña al temporal de una descarga.
const META_SUFFIX: &str = ".meta";

/// Preferencia viva: `false` = comportamiento de siempre.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Activa o desactiva la reanudación. La llama el frontend al cargar y al
/// guardar preferencias.
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// `true` si las descargas interrumpidas deben conservarse y reanudarse.
#[must_use]
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Ficha de un temporal: de qué fichero remoto viene y en qué estado estaba el
/// origen cuando se empezó a bajar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartMeta {
    /// Ruta remota completa del fichero de origen.
    pub remote: String,
    /// Tamaño total que anunciaba el servidor.
    pub size: u64,
    /// Fecha de modificación remota en segundos desde epoch, si el servidor la
    /// da (`None` = no la da; entonces solo se compara ruta y tamaño).
    pub mtime: Option<u64>,
}

/// Qué hacer con el temporal encontrado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumePlan {
    /// Empezar de cero: truncar el temporal y bajarlo entero.
    Fresh,
    /// Continuar desde este desplazamiento.
    Continue(u64),
    /// El temporal ya tiene el fichero completo: solo falta publicarlo.
    Complete,
}

/// Ruta de la ficha que acompaña a un temporal.
#[must_use]
pub fn meta_path(part: &Path) -> PathBuf {
    let mut name = part
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_else(|| std::ffi::OsString::from("descarga"));
    name.push(META_SUFFIX);
    part.with_file_name(name)
}

/// Decide qué hacer con un temporal de `part_len` bytes, dado lo que dice su
/// ficha y lo que dice ahora el servidor. Pura: no mira el disco.
#[must_use]
pub fn plan(
    meta: Option<&PartMeta>,
    part_len: u64,
    remote: &str,
    size: u64,
    mtime: Option<u64>,
) -> ResumePlan {
    // Sin trozo previo no hay nada que reanudar.
    if part_len == 0 {
        return ResumePlan::Fresh;
    }
    // Sin ficha no se sabe de qué fichero es ese temporal: puede ser de otra
    // descarga que dejó su resto con el mismo nombre.
    let Some(meta) = meta else {
        return ResumePlan::Fresh;
    };
    // El origen tiene que ser el mismo fichero y estar igual que estaba.
    if meta.remote != remote || meta.size != size || meta.mtime != mtime {
        return ResumePlan::Fresh;
    }
    // Un temporal más largo que el origen no puede ser un trozo suyo.
    if part_len > size {
        return ResumePlan::Fresh;
    }
    if part_len == size {
        return ResumePlan::Complete;
    }
    ResumePlan::Continue(part_len)
}

/// Lee del disco lo que hace falta (tamaño del temporal y su ficha) y aplica
/// [`plan`]. Cualquier error de lectura se traduce en empezar de cero.
pub async fn plan_on_disk(part: &Path, remote: &str, size: u64, mtime: Option<u64>) -> ResumePlan {
    let Ok(part_meta) = tokio::fs::metadata(part).await else {
        return ResumePlan::Fresh;
    };
    let stored = read_meta(part).await;
    plan(stored.as_ref(), part_meta.len(), remote, size, mtime)
}

/// Lee la ficha de un temporal. `None` si no existe o no se entiende.
pub async fn read_meta(part: &Path) -> Option<PartMeta> {
    let raw = tokio::fs::read(meta_path(part)).await.ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Escribe la ficha del temporal. Un fallo aquí no rompe la descarga: solo
/// significa que el intento siguiente empezará de cero.
pub async fn write_meta(part: &Path, meta: &PartMeta) {
    let Ok(raw) = serde_json::to_vec(meta) else {
        return;
    };
    let _ = tokio::fs::write(meta_path(part), raw).await;
}

/// Borra la ficha de un temporal (al publicar la descarga o al descartarla).
pub async fn remove_meta(part: &Path) {
    let _ = tokio::fs::remove_file(meta_path(part)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> PartMeta {
        PartMeta {
            remote: "/srv/datos/iso.img".to_string(),
            size: 1_000,
            mtime: Some(1_700_000_000),
        }
    }

    #[test]
    fn sin_trozo_previo_se_empieza_de_cero() {
        assert_eq!(
            plan(Some(&meta()), 0, "/srv/datos/iso.img", 1_000, Some(1_700_000_000)),
            ResumePlan::Fresh
        );
    }

    #[test]
    fn un_trozo_a_medias_del_mismo_fichero_continua() {
        assert_eq!(
            plan(
                Some(&meta()),
                400,
                "/srv/datos/iso.img",
                1_000,
                Some(1_700_000_000)
            ),
            ResumePlan::Continue(400)
        );
    }

    #[test]
    fn un_trozo_completo_solo_hay_que_publicarlo() {
        assert_eq!(
            plan(
                Some(&meta()),
                1_000,
                "/srv/datos/iso.img",
                1_000,
                Some(1_700_000_000)
            ),
            ResumePlan::Complete
        );
    }

    #[test]
    fn sin_ficha_no_se_reanuda() {
        // Un `.part` huérfano (de una versión anterior o de otra descarga) no
        // dice de qué fichero es: pegarle bytes detrás sería inventarse un
        // fichero.
        assert_eq!(
            plan(None, 400, "/srv/datos/iso.img", 1_000, Some(1_700_000_000)),
            ResumePlan::Fresh
        );
    }

    #[test]
    fn si_el_fichero_remoto_cambio_se_empieza_de_cero() {
        // Las tres señales de que el origen ya no es el mismo. Cualquiera basta:
        // continuar produciría un fichero mezcla que además pasaría la
        // verificación de tamaño.
        let m = meta();
        assert_eq!(
            plan(Some(&m), 400, "/srv/otro/iso.img", 1_000, Some(1_700_000_000)),
            ResumePlan::Fresh
        );
        assert_eq!(
            plan(Some(&m), 400, "/srv/datos/iso.img", 2_000, Some(1_700_000_000)),
            ResumePlan::Fresh
        );
        assert_eq!(
            plan(Some(&m), 400, "/srv/datos/iso.img", 1_000, Some(1_700_000_999)),
            ResumePlan::Fresh
        );
    }

    #[test]
    fn un_servidor_sin_fecha_se_conforma_con_ruta_y_tamano() {
        // Hay servidores que no devuelven mtime. Se reanuda igual, pero solo si
        // la ficha tampoco la tenía: si antes había fecha y ahora no, algo ha
        // cambiado.
        let sin_fecha = PartMeta {
            mtime: None,
            ..meta()
        };
        assert_eq!(
            plan(Some(&sin_fecha), 400, "/srv/datos/iso.img", 1_000, None),
            ResumePlan::Continue(400)
        );
        assert_eq!(
            plan(Some(&meta()), 400, "/srv/datos/iso.img", 1_000, None),
            ResumePlan::Fresh
        );
    }

    #[test]
    fn un_trozo_mas_largo_que_el_origen_es_basura() {
        assert_eq!(
            plan(
                Some(&meta()),
                1_500,
                "/srv/datos/iso.img",
                1_000,
                Some(1_700_000_000)
            ),
            ResumePlan::Fresh
        );
    }

    #[test]
    fn la_ficha_vive_junto_al_temporal() {
        let p = Path::new("/tmp/descargas/iso.img.rustty-part");
        assert_eq!(
            meta_path(p),
            Path::new("/tmp/descargas/iso.img.rustty-part.meta")
        );
    }

    #[tokio::test]
    async fn la_ficha_se_escribe_se_lee_y_se_borra() {
        let dir = std::env::temp_dir().join(format!("rustty-resume-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let part = dir.join("iso.img.rustty-part");
        tokio::fs::write(&part, b"1234").await.unwrap();

        write_meta(&part, &meta()).await;
        assert_eq!(read_meta(&part).await, Some(meta()));

        // El plan sobre disco combina el tamaño real del temporal con la ficha.
        assert_eq!(
            plan_on_disk(&part, "/srv/datos/iso.img", 1_000, Some(1_700_000_000)).await,
            ResumePlan::Continue(4)
        );

        remove_meta(&part).await;
        assert_eq!(read_meta(&part).await, None);
        // Sin ficha, un temporal superviviente no engaña a nadie.
        assert_eq!(
            plan_on_disk(&part, "/srv/datos/iso.img", 1_000, Some(1_700_000_000)).await,
            ResumePlan::Fresh
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn un_temporal_que_no_existe_no_reanuda_nada() {
        let inexistente = std::env::temp_dir().join("rustty-no-existe.rustty-part");
        assert_eq!(
            plan_on_disk(&inexistente, "/srv/datos/iso.img", 1_000, None).await,
            ResumePlan::Fresh
        );
    }
}
