//! Motor de scripts: recetas interactivas pequeñas ejecutadas por host.
//!
//! - `types` — modelos serde (`Script`, `Step`, `TargetSpec`, `RunOptions`…).
//! - `store` — persistencia atómica de `scripts.json` (sin secretos).
//! - `runner` — runner de una sesión (máquina de estados sobre los pasos) y el
//!   orquestador de fan-out por host con concurrencia acotada.
//!
//! Invariantes de seguridad (ver `memoria/AGENTS.md`):
//! - `scripts.json` **nunca** guarda contraseñas: los pasos de contraseña solo
//!   llevan referencias (`profileId` del keyring o `uuid` de KeePass).
//! - Ningún secreto viaja en logs ni en payloads de evento: toda la salida
//!   emitida se pasa por `subst::redact_secrets` con los valores enviados.
//! - Reutiliza la auth/host-key de `ssh_manager` (respeta el TOFU), no duplica
//!   la lógica de conexión.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub mod runner;
pub mod store;
pub mod types;

pub use types::*;

/// Registro global de ejecuciones activas (mapa `run_id` → handle).
pub type RunRegistry = Arc<Mutex<HashMap<String, RunHandle>>>;

/// Handle de una ejecución en curso. Permite abortar el run completo o un host
/// concreto poniendo el flag correspondiente, que el runner consulta entre pasos.
#[derive(Clone)]
pub struct RunHandle {
    /// Cancela TODO el run (no arranca más hosts y aborta los en curso).
    pub cancel_run: Arc<AtomicBool>,
    /// Flag de cancelación por host (`profile_id` → flag).
    pub host_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

/// Estado gestionado por Tauri: directorio de datos, caché de scripts y el
/// registro de ejecuciones activas para poder abortarlas.
pub struct ScriptManager {
    data_dir: PathBuf,
    cache: Mutex<Option<Vec<Script>>>,
    runs: RunRegistry,
}

impl ScriptManager {
    pub fn new(data_dir: PathBuf) -> Self {
        ScriptManager {
            data_dir,
            cache: Mutex::new(None),
            runs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn path(&self) -> PathBuf {
        self.data_dir.join("scripts.json")
    }

    /// Devuelve todos los scripts (cacheados en memoria tras la primera carga).
    pub fn get_all(&self) -> Result<Vec<Script>, String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "caché de scripts corrupta".to_string())?;
        if let Some(cached) = cache.as_ref() {
            return Ok(cached.clone());
        }
        let loaded = store::load(&self.path()).map_err(|e| e.to_string())?;
        *cache = Some(loaded.clone());
        Ok(loaded)
    }

    /// Devuelve un script por id (o `None`).
    pub fn get(&self, id: &str) -> Result<Option<Script>, String> {
        Ok(self.get_all()?.into_iter().find(|s| s.id == id))
    }

    /// Upsert por id + guardado atómico. Actualiza `updatedAt`.
    pub fn upsert(&self, mut script: Script) -> Result<(), String> {
        if script.steps.len() > types::MAX_STEPS {
            return Err(format!(
                "El script supera el máximo de {} pasos",
                types::MAX_STEPS
            ));
        }
        script.updated_at = chrono::Utc::now().to_rfc3339();
        let mut scripts = self.get_all()?;
        match scripts.iter().position(|s| s.id == script.id) {
            Some(idx) => scripts[idx] = script,
            None => scripts.push(script),
        }
        store::save(&self.path(), &scripts).map_err(|e| e.to_string())?;
        *self
            .cache
            .lock()
            .map_err(|_| "caché de scripts corrupta".to_string())? = Some(scripts);
        Ok(())
    }

    /// Elimina un script por id + guardado atómico.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut scripts = self.get_all()?;
        scripts.retain(|s| s.id != id);
        store::save(&self.path(), &scripts).map_err(|e| e.to_string())?;
        *self
            .cache
            .lock()
            .map_err(|_| "caché de scripts corrupta".to_string())? = Some(scripts);
        Ok(())
    }

    /// Devuelve un clon del `Arc` del registro (para que el fan-out se
    /// desregistre al terminar).
    pub fn runs(&self) -> RunRegistry {
        Arc::clone(&self.runs)
    }

    /// Registra una ejecución con un flag de cancelación por host preinstalado
    /// (así `abort` puede marcar hosts que aún no han arrancado).
    pub fn register_run(&self, run_id: &str, profile_ids: &[String]) -> RunHandle {
        let host_cancels = profile_ids
            .iter()
            .map(|id| (id.clone(), Arc::new(AtomicBool::new(false))))
            .collect();
        let handle = RunHandle {
            cancel_run: Arc::new(AtomicBool::new(false)),
            host_cancels: Arc::new(Mutex::new(host_cancels)),
        };
        if let Ok(mut runs) = self.runs.lock() {
            runs.insert(run_id.to_string(), handle.clone());
        }
        handle
    }

    /// Aborta el run completo (`profile_id == None`) o un host concreto.
    pub fn abort(&self, run_id: &str, profile_id: Option<&str>) {
        let Ok(runs) = self.runs.lock() else { return };
        let Some(handle) = runs.get(run_id) else {
            return;
        };
        match profile_id {
            Some(pid) => {
                if let Ok(map) = handle.host_cancels.lock() {
                    if let Some(flag) = map.get(pid) {
                        flag.store(true, Ordering::Relaxed);
                    }
                }
            }
            None => {
                handle.cancel_run.store(true, Ordering::Relaxed);
                if let Ok(map) = handle.host_cancels.lock() {
                    for flag in map.values() {
                        flag.store(true, Ordering::Relaxed);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripts::types::{Step, TargetSpec};

    fn manager() -> (ScriptManager, PathBuf) {
        let dir = std::env::temp_dir().join(format!("rustty-sm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (ScriptManager::new(dir.clone()), dir)
    }

    fn script(id: &str) -> Script {
        Script {
            id: id.to_string(),
            name: id.to_string(),
            description: None,
            target: TargetSpec::Adhoc {
                profile_ids: vec![],
            },
            steps: vec![Step::Send {
                text: "uptime".into(),
            }],
            created_at: "2026-07-04T10:00:00Z".into(),
            updated_at: "2026-07-04T10:00:00Z".into(),
        }
    }

    #[test]
    fn upsert_get_delete() {
        let (mgr, dir) = manager();
        assert!(mgr.get_all().unwrap().is_empty());

        mgr.upsert(script("a")).unwrap();
        mgr.upsert(script("b")).unwrap();
        assert_eq!(mgr.get_all().unwrap().len(), 2);

        // updatedAt se refresca al guardar (no conserva el del script entrante).
        let a = mgr.get("a").unwrap().unwrap();
        assert_ne!(a.updated_at, "2026-07-04T10:00:00Z");

        // Upsert no duplica.
        mgr.upsert(script("a")).unwrap();
        assert_eq!(mgr.get_all().unwrap().len(), 2);

        mgr.delete("a").unwrap();
        assert_eq!(mgr.get_all().unwrap().len(), 1);
        assert!(mgr.get("a").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_rechaza_mas_de_max_steps() {
        let (mgr, dir) = manager();
        let mut s = script("grande");
        s.steps = (0..=types::MAX_STEPS)
            .map(|_| Step::Send { text: "eco".into() })
            .collect();
        let err = mgr.upsert(s).unwrap_err();
        assert!(err.contains("50"), "el error debe citar el tope: {err}");
        assert!(mgr.get_all().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn abort_marca_flags() {
        let (mgr, _dir) = manager();
        let handle = mgr.register_run("run1", &["p1".to_string(), "p2".to_string()]);
        assert!(!handle.cancel_run.load(Ordering::Relaxed));

        // Abortar un host concreto solo marca su flag.
        mgr.abort("run1", Some("p1"));
        let flags = handle.host_cancels.lock().unwrap();
        assert!(flags.get("p1").unwrap().load(Ordering::Relaxed));
        assert!(!flags.get("p2").unwrap().load(Ordering::Relaxed));
        drop(flags);

        // Abortar el run completo marca todo.
        mgr.abort("run1", None);
        assert!(handle.cancel_run.load(Ordering::Relaxed));
        let flags = handle.host_cancels.lock().unwrap();
        assert!(flags.get("p2").unwrap().load(Ordering::Relaxed));
    }
}
