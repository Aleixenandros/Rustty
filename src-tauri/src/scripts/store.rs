//! Persistencia de `scripts.json` en el directorio de datos.
//!
//! Los scripts **no contienen secretos** (los pasos de contraseña llevan solo
//! referencias), por eso la escritura atómica NO es privada (`private = false`).
//! Aun así se usa `atomic_file::write` para no dejar el fichero a medias ante un
//! corte de corriente, igual que el resto de almacenes del backend.

use std::path::Path;

use crate::error::AppError;

use super::types::{RunRecord, Script};

/// Carga la lista de scripts del disco. Lista vacía si el fichero no existe.
///
/// Se **recupera** si el store está dañado (cuarentena + última copia válida),
/// igual que `profiles.json` y `credentials.json`: perder los runbooks por un
/// JSON truncado sería perder trabajo del usuario que no está en ningún otro
/// sitio (los scripts no se sincronizan).
pub fn load(path: &Path) -> Result<Vec<Script>, AppError> {
    let (data, _recovery) = crate::atomic_file::read_or_recover(path, false, |text| {
        text.trim().is_empty() || serde_json::from_str::<Vec<Script>>(text).is_ok()
    })?;
    let Some(data) = data else {
        return Ok(vec![]);
    };
    if data.trim().is_empty() {
        return Ok(vec![]);
    }
    let scripts: Vec<Script> = serde_json::from_str(&data)?;
    Ok(scripts)
}

/// Guarda la lista completa de scripts de forma atómica (no privada: sin
/// secretos). Crea el directorio padre si hace falta.
pub fn save(path: &Path, scripts: &[Script]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(scripts)?;
    crate::atomic_file::write(path, data.as_bytes(), false)?;
    Ok(())
}

// ─── Historial de ejecuciones (`script_runs.json`) ───────────────────────────

/// Carga el historial de ejecuciones. Lista vacía si el fichero no existe o
/// está corrupto (el historial es prescindible: nunca debe romper la app).
pub fn load_runs(path: &Path) -> Result<Vec<RunRecord>, AppError> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(path)?;
    if data.trim().is_empty() {
        return Ok(vec![]);
    }
    Ok(serde_json::from_str(&data).unwrap_or_default())
}

/// Guarda el historial de ejecuciones de forma atómica y **privada** (0600): la
/// salida de los comandos puede ser sensible aunque vaya ya redactada de
/// secretos. Crea el directorio padre si hace falta.
pub fn save_runs(path: &Path, runs: &[RunRecord]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(runs)?;
    crate::atomic_file::write(path, data.as_bytes(), true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripts::types::{Step, TargetSpec};

    fn sample(id: &str) -> Script {
        Script {
            id: id.to_string(),
            name: format!("Script {id}"),
            description: None,
            target: TargetSpec::Adhoc {
                profile_ids: vec![],
            },
            steps: vec![
                Step::Send {
                    text: "uptime".into(),
                },
                Step::WaitPrompt,
            ],
            created_at: "2026-07-04T10:00:00Z".into(),
            updated_at: "2026-07-04T10:00:00Z".into(),
        }
    }

    #[test]
    fn load_inexistente_es_vacio() {
        let dir = std::env::temp_dir().join(format!("rustty-scripts-{}", uuid::Uuid::new_v4()));
        let path = dir.join("scripts.json");
        assert!(load(&path).unwrap().is_empty());
    }

    #[test]
    fn save_y_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("rustty-scripts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("scripts.json");

        let scripts = vec![sample("a"), sample("b")];
        save(&path, &scripts).expect("guarda");
        let back = load(&path).expect("carga");
        assert_eq!(back, scripts);

        // No debe quedar ningún temporal `.rustty-*` tras el rename atómico.
        let sobras = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".rustty-"))
            .count();
        assert_eq!(sobras, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
