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

use crate::locks::MutexExt;

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

    fn history_path(&self) -> PathBuf {
        self.data_dir.join("script_runs.json")
    }

    /// Devuelve el historial de ejecuciones (las más recientes primero).
    pub fn history_get(&self) -> Result<Vec<RunRecord>, String> {
        store::load_runs(&self.history_path()).map_err(|e| e.to_string())
    }

    /// Añade una ejecución al historial (al frente), deduplica por id y recorta
    /// al tope `MAX_RUN_HISTORY`. Guardado atómico y privado.
    pub fn history_save(&self, record: RunRecord) -> Result<(), String> {
        let mut runs = self.history_get()?;
        runs.insert(0, record);
        let mut seen = std::collections::HashSet::new();
        runs.retain(|r| seen.insert(r.id.clone()));
        if runs.len() > types::MAX_RUN_HISTORY {
            runs.truncate(types::MAX_RUN_HISTORY);
        }
        store::save_runs(&self.history_path(), &runs).map_err(|e| e.to_string())
    }

    /// Vacía el historial de ejecuciones.
    pub fn history_clear(&self) -> Result<(), String> {
        store::save_runs(&self.history_path(), &[]).map_err(|e| e.to_string())
    }

    /// Devuelve todos los scripts (cacheados en memoria tras la primera carga).
    pub fn get_all(&self) -> Result<Vec<Script>, String> {
        let mut cache = self.cache.lock_recover();
        Ok(self.cached(&mut cache)?.clone())
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
        self.transact(|scripts| {
            match scripts.iter().position(|s| s.id == script.id) {
                Some(idx) => scripts[idx] = script,
                None => scripts.push(script),
            }
            Ok(())
        })
    }

    /// Elimina un script por id + guardado atómico.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.transact(|scripts| {
            scripts.retain(|s| s.id != id);
            Ok(())
        })
    }

    /// Aplica una mutación de la lista de scripts **dentro de la transacción**:
    /// el guard de la caché se mantiene tomado durante todo el ciclo
    /// leer→modificar→escribir→refrescar caché.
    ///
    /// El mutex de la caché hace de lock de transacción (mismo papel que el `tx`
    /// de `ProfileManager`): sin él, dos guardados concurrentes leen la misma
    /// lista y el segundo en escribir borra el script que acaba de crear el
    /// primero. Si el guardado falla, la caché **no** se actualiza: no puede
    /// quedarse afirmando algo que no está en disco.
    fn transact(&self, mutate: impl FnOnce(&mut Vec<Script>) -> Result<(), String>) -> Result<(), String> {
        let mut cache = self.cache.lock_recover();
        let mut scripts = self.cached(&mut cache)?.clone();
        mutate(&mut scripts)?;
        store::save(&self.path(), &scripts).map_err(|e| e.to_string())?;
        *cache = Some(scripts);
        Ok(())
    }

    /// Devuelve la lista cacheada, cargándola del disco la primera vez. Recibe el
    /// guard ya tomado para que el llamador decida el alcance de la exclusión.
    fn cached<'a>(
        &self,
        cache: &'a mut Option<Vec<Script>>,
    ) -> Result<&'a mut Vec<Script>, String> {
        if cache.is_none() {
            *cache = Some(store::load(&self.path()).map_err(|e| e.to_string())?);
        }
        Ok(cache.as_mut().expect("acabamos de rellenar la caché"))
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
        self.runs
            .lock_recover()
            .insert(run_id.to_string(), handle.clone());
        handle
    }

    /// Aborta el run completo (`profile_id == None`) o un host concreto.
    ///
    /// Los locks se toman con `lock_recover`: con un `if let Ok(…)` un mutex
    /// envenenado convertía esto en un no-op silencioso, y el usuario se quedaba
    /// sin poder parar un script en marcha sin saber por qué.
    pub fn abort(&self, run_id: &str, profile_id: Option<&str>) {
        let runs = self.runs.lock_recover();
        let Some(handle) = runs.get(run_id) else {
            return;
        };
        let flags = handle.host_cancels.lock_recover();
        match profile_id {
            Some(pid) => {
                if let Some(flag) = flags.get(pid) {
                    flag.store(true, Ordering::Relaxed);
                }
            }
            None => {
                handle.cancel_run.store(true, Ordering::Relaxed);
                for flag in flags.values() {
                    flag.store(true, Ordering::Relaxed);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locks::MutexExt;
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

    fn run_record(id: &str) -> RunRecord {
        RunRecord {
            id: id.to_string(),
            script_id: "s1".into(),
            script_name: "Demo".into(),
            started_at: "2026-07-07T10:00:00Z".into(),
            finished_at: "2026-07-07T10:00:05Z".into(),
            mode: "parallel".into(),
            ok_count: 1,
            error_count: 0,
            total: 1,
            hosts: vec![],
        }
    }

    #[test]
    fn history_save_recorta_y_deduplica() {
        let (mgr, dir) = manager();
        assert!(mgr.history_get().unwrap().is_empty());

        // Guardar más del tope: se conservan los MAX_RUN_HISTORY más recientes.
        for i in 0..(types::MAX_RUN_HISTORY + 5) {
            mgr.history_save(run_record(&format!("r{i}"))).unwrap();
        }
        let hist = mgr.history_get().unwrap();
        assert_eq!(hist.len(), types::MAX_RUN_HISTORY);
        // El último guardado queda el primero (orden: más reciente al frente).
        assert_eq!(hist[0].id, format!("r{}", types::MAX_RUN_HISTORY + 4));

        // Reguardar un id existente no duplica y lo mueve al frente.
        mgr.history_save(run_record("r10")).unwrap();
        let hist = mgr.history_get().unwrap();
        assert_eq!(hist[0].id, "r10");
        assert_eq!(hist.iter().filter(|r| r.id == "r10").count(), 1);

        mgr.history_clear().unwrap();
        assert!(mgr.history_get().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn abort_marca_flags() {
        let (mgr, _dir) = manager();
        let handle = mgr.register_run("run1", &["p1".to_string(), "p2".to_string()]);
        assert!(!handle.cancel_run.load(Ordering::Relaxed));

        // Abortar un host concreto solo marca su flag.
        mgr.abort("run1", Some("p1"));
        let flags = handle.host_cancels.lock_recover();
        assert!(flags.get("p1").unwrap().load(Ordering::Relaxed));
        assert!(!flags.get("p2").unwrap().load(Ordering::Relaxed));
        drop(flags);

        // Abortar el run completo marca todo.
        mgr.abort("run1", None);
        assert!(handle.cancel_run.load(Ordering::Relaxed));
        let flags = handle.host_cancels.lock_recover();
        assert!(flags.get("p2").unwrap().load(Ordering::Relaxed));
    }
}
