//! Idioma de los mensajes de la CLI: español o inglés.
//!
//! La CLI habla solo estos dos idiomas (la interfaz tiene siete): español si
//! el usuario lo es, inglés para todo lo demás. Cómo se elige, en orden:
//!
//! 1. El idioma elegido en la interfaz (Preferencias → Idioma). Vive en el
//!    `localStorage` del frontend, que la CLI no ve, así que la interfaz lo
//!    vuelca a [`FILE_NAME`] en el directorio de datos al arrancar y al
//!    guardar preferencias (`save_cli_language`). Es una caché derivada, como
//!    `workspaces.json` o `host-key-policy.json`: si falta, se sigue al paso 2.
//! 2. Con «Sistema» (o sin fichero), el locale del entorno: `LC_ALL`, luego
//!    `LC_MESSAGES`, luego `LANG` (el primero que no esté vacío, como POSIX).
//! 3. Si el entorno no dice nada (lo normal en Windows), el idioma que la
//!    interfaz detectó para «Sistema» (`detected` en el mismo fichero).
//! 4. Inglés.
//!
//! El idioma solo se fija en el proceso de la CLI ([`init_for_cli`]). En la app
//! gráfica [`current`] devuelve siempre español: los mensajes del backend que
//! comparten la CLI y la interfaz (host keys, autenticación, saltos) siguen
//! llegando a la interfaz exactamente como antes, que hay código del frontend
//! que los reconoce por el texto.
//!
//! Los textos viven junto a su uso con [`tr!`]: `tr!("texto", "text")`, con los
//! argumentos de `format!`.

use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Fichero del idioma de la interfaz en el directorio de datos.
pub const FILE_NAME: &str = "cli-language.json";

/// Idioma de los mensajes de la CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Es,
    En,
}

static LANG: OnceLock<Lang> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static TEST_LANG: std::cell::Cell<Option<Lang>> = const { std::cell::Cell::new(None) };
}

/// Idioma en vigor. Español mientras nadie llame a [`init_for_cli`] (la app
/// gráfica nunca lo hace).
#[must_use]
pub fn current() -> Lang {
    #[cfg(test)]
    if let Some(lang) = TEST_LANG.with(std::cell::Cell::get) {
        return lang;
    }
    LANG.get().copied().unwrap_or(Lang::Es)
}

/// Ejecuta `f` con los mensajes en `lang`, solo en este hilo (tests).
#[cfg(test)]
pub fn with_lang<R>(lang: Lang, f: impl FnOnce() -> R) -> R {
    let prev = TEST_LANG.with(|c| c.replace(Some(lang)));
    let out = f();
    TEST_LANG.with(|c| c.set(prev));
    out
}

/// Fija el idioma del proceso de la CLI a partir del fichero de la interfaz y
/// del entorno. Se llama una vez, antes de escribir nada.
pub fn init_for_cli(data_dir: &Path) {
    let saved = load(data_dir);
    let lang = resolve(saved.as_ref(), |name| std::env::var(name).ok());
    let _ = LANG.set(lang);
}

/// Mensaje en el idioma en vigor: `tr!("Conectando a {x}", "Connecting to {x}")`.
/// Acepta los argumentos de `format!` (también los capturados por nombre) y
/// devuelve un `String`.
macro_rules! tr {
    ($es:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        match $crate::cli_lang::current() {
            $crate::cli_lang::Lang::Es => format!($es $(, $arg)*),
            $crate::cli_lang::Lang::En => format!($en $(, $arg)*),
        }
    };
}
pub(crate) use tr;

/// Lo que la interfaz deja guardado para la CLI.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedLanguage {
    /// Idioma elegido en la interfaz (`es`, `en`, `fr`…); `None` = «Sistema».
    #[serde(default)]
    pub lang: Option<String>,
    /// Con «Sistema», el que la interfaz detectó (respaldo si el entorno no
    /// tiene locale).
    #[serde(default)]
    pub detected: Option<String>,
}

/// Lee lo que dejó la interfaz; `None` si no hay fichero o no se entiende.
#[must_use]
pub fn load(data_dir: &Path) -> Option<SavedLanguage> {
    let raw = std::fs::read(data_dir.join(FILE_NAME)).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Lo guarda de forma atómica, solo si cambió.
pub fn save(data_dir: &Path, saved: &SavedLanguage) -> std::io::Result<bool> {
    let path = data_dir.join(FILE_NAME);
    let payload = serde_json::to_vec_pretty(saved).map_err(std::io::Error::other)?;
    if std::fs::read(&path).map(|cur| cur == payload).unwrap_or(false) {
        return Ok(false);
    }
    crate::atomic_file::write(&path, &payload, false)?;
    Ok(true)
}

/// Idioma de un código de la interfaz (`es`, `en`, `zh-TW`…) o de un locale
/// (`es_ES.UTF-8`, `es-MX`, `en_US`). `None` si está vacío o es `auto`/`system`.
fn lang_of(code: &str) -> Option<Lang> {
    let code = code.trim();
    if code.is_empty() || code.eq_ignore_ascii_case("auto") || code.eq_ignore_ascii_case("system") {
        return None;
    }
    let primary = code
        .split(['_', '-', '.', '@'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    Some(if primary == "es" { Lang::Es } else { Lang::En })
}

/// Resolución pura (ver el comentario del módulo). `env` lee una variable.
pub fn resolve(saved: Option<&SavedLanguage>, env: impl Fn(&str) -> Option<String>) -> Lang {
    if let Some(lang) = saved.and_then(|s| s.lang.as_deref()).and_then(lang_of) {
        return lang;
    }
    let from_env = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| env(name).filter(|v| !v.trim().is_empty()));
    if let Some(value) = from_env {
        return lang_of(&value).unwrap_or(Lang::En);
    }
    saved
        .and_then(|s| s.detected.as_deref())
        .and_then(lang_of)
        .unwrap_or(Lang::En)
}

/// ¿La respuesta a una pregunta sí/no es un sí? En los dos idiomas.
#[must_use]
pub fn is_yes(answer: &str) -> bool {
    matches!(
        answer.trim().to_lowercase().as_str(),
        "sí" | "si" | "s" | "yes" | "y"
    )
}

/// La coletilla de una pregunta sí/no: `(sí/no)` o `(yes/no)`.
#[must_use]
pub fn yes_no() -> &'static str {
    match current() {
        Lang::Es => "(sí/no)",
        Lang::En => "(yes/no)",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    fn saved(lang: Option<&str>, detected: Option<&str>) -> SavedLanguage {
        SavedLanguage {
            lang: lang.map(str::to_string),
            detected: detected.map(str::to_string),
        }
    }

    #[test]
    fn el_idioma_elegido_en_la_interfaz_manda_sobre_el_entorno() {
        let es_env = env(&[("LANG", "es_ES.UTF-8")]);
        assert_eq!(resolve(Some(&saved(Some("en"), None)), &es_env), Lang::En);
        let en_env = env(&[("LANG", "en_US.UTF-8")]);
        assert_eq!(resolve(Some(&saved(Some("es"), None)), &en_env), Lang::Es);
    }

    #[test]
    fn los_otros_idiomas_de_la_interfaz_caen_al_ingles() {
        let es_env = env(&[("LANG", "es_ES.UTF-8")]);
        for code in ["fr", "pt", "de", "zh-TW", "id"] {
            assert_eq!(resolve(Some(&saved(Some(code), None)), &es_env), Lang::En, "{code}");
        }
    }

    #[test]
    fn con_sistema_manda_el_entorno_en_orden_posix() {
        let auto = saved(None, Some("en"));
        assert_eq!(resolve(Some(&auto), env(&[("LANG", "es_ES.UTF-8")])), Lang::Es);
        // LC_ALL gana a LC_MESSAGES, y este a LANG.
        let vars = env(&[("LC_ALL", "en_GB.UTF-8"), ("LC_MESSAGES", "es_ES"), ("LANG", "es_ES")]);
        assert_eq!(resolve(Some(&auto), vars), Lang::En);
        let vars = env(&[("LC_MESSAGES", "es_MX.UTF-8"), ("LANG", "en_US.UTF-8")]);
        assert_eq!(resolve(None, vars), Lang::Es);
        // Uno vacío no cuenta: se pasa al siguiente.
        let vars = env(&[("LC_ALL", ""), ("LANG", "es_AR.UTF-8")]);
        assert_eq!(resolve(None, vars), Lang::Es);
        // `"auto"` guardado es lo mismo que «Sistema».
        assert_eq!(resolve(Some(&saved(Some("auto"), None)), env(&[("LANG", "es")])), Lang::Es);
    }

    #[test]
    fn variantes_del_espanol_y_locales_raros() {
        for code in ["es", "es_ES.UTF-8", "es-MX", "ES_es", "es_ES@euro", "es.UTF-8"] {
            assert_eq!(lang_of(code), Some(Lang::Es), "{code}");
        }
        for code in ["C", "POSIX", "C.UTF-8", "en_US.UTF-8", "fr_FR", "pt_BR", "est"] {
            assert_eq!(lang_of(code), Some(Lang::En), "{code}");
        }
        assert_eq!(lang_of(""), None);
        assert_eq!(lang_of("auto"), None);
    }

    #[test]
    fn sin_nada_en_el_entorno_vale_lo_detectado_y_si_no_ingles() {
        assert_eq!(resolve(Some(&saved(None, Some("es"))), env(&[])), Lang::Es);
        assert_eq!(resolve(Some(&saved(None, Some("de"))), env(&[])), Lang::En);
        assert_eq!(resolve(None, env(&[])), Lang::En);
    }

    #[test]
    fn el_fichero_de_la_interfaz_se_guarda_y_se_lee() {
        let dir = std::env::temp_dir().join(format!("rustty-cli-lang-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load(&dir), None);
        let value = saved(Some("en"), Some("es"));
        assert!(save(&dir, &value).unwrap());
        assert!(!save(&dir, &value).unwrap(), "sin cambios no se reescribe");
        assert_eq!(load(&dir), Some(value));
        // Sin campos (o con otros) también se entiende: «Sistema».
        std::fs::write(dir.join(FILE_NAME), b"{}").unwrap();
        assert_eq!(load(&dir), Some(SavedLanguage::default()));
        std::fs::write(dir.join(FILE_NAME), b"no es json").unwrap();
        assert_eq!(load(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn si_y_no_en_los_dos_idiomas() {
        for yes in ["sí", "Sí", "SI", "si", "s", "S", "yes", "YES", "y", " Y \n"] {
            assert!(is_yes(yes), "{yes:?}");
        }
        for no in ["no", "n", "", "nope", "sip", "yeah", "ok"] {
            assert!(!is_yes(no), "{no:?}");
        }
    }

    #[test]
    fn tr_elige_el_idioma_y_admite_argumentos() {
        let host = "h";
        let es = with_lang(Lang::Es, || tr!("Conectando a {host} ({})", "Connecting to {host} ({})", 22));
        let en = with_lang(Lang::En, || tr!("Conectando a {host} ({})", "Connecting to {host} ({})", 22));
        assert_eq!(es, "Conectando a h (22)");
        assert_eq!(en, "Connecting to h (22)");
        assert_eq!(with_lang(Lang::En, yes_no), "(yes/no)");
        assert_eq!(with_lang(Lang::Es, yes_no), "(sí/no)");
        // Fuera de la CLI (sin `init_for_cli`), español.
        assert_eq!(current(), Lang::Es);
    }
}
