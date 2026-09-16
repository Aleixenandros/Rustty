//! Índice de workspaces `{id, name}` para quien no tiene la interfaz delante.
//!
//! Los workspaces viven en las preferencias del frontend (`localStorage`), así
//! que el backend solo conoce el `workspace_id` de cada perfil. La interfaz
//! vuelca este índice a `workspaces.json` en el directorio de datos cada vez
//! que cambia (`save_workspace_index`), y la CLI lo lee para mostrar y filtrar
//! por **nombre**. Es una caché derivada: si falta o está corrupta, el nombre
//! cae al id y nada más se rompe.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "workspaces.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
}

/// Lee el índice; ausente o ilegible → vacío.
pub fn load(data_dir: &Path) -> Vec<WorkspaceEntry> {
    let Ok(raw) = std::fs::read(data_dir.join(FILE_NAME)) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<WorkspaceEntry>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.id.trim().is_empty())
        .collect()
}

/// Escribe el índice de forma atómica (solo si cambió: la interfaz lo manda
/// en cada guardado de preferencias).
pub fn save(data_dir: &Path, items: &[WorkspaceEntry]) -> std::io::Result<bool> {
    let path = data_dir.join(FILE_NAME);
    let payload = serde_json::to_vec_pretty(items).map_err(std::io::Error::other)?;
    if std::fs::read(&path).map(|cur| cur == payload).unwrap_or(false) {
        return Ok(false);
    }
    crate::atomic_file::write(&path, &payload, false)?;
    Ok(true)
}

/// Id nuevo con el mismo formato que genera la interfaz (`ws-<uuid>`).
pub fn new_id() -> String {
    format!("ws-{}", uuid::Uuid::new_v4())
}

/// Añade (o renombra) una entrada del índice y lo guarda. La interfaz, al
/// arrancar, crea en sus preferencias los workspaces que referencien perfiles
/// y toma de aquí el nombre.
pub fn add(data_dir: &Path, entry: WorkspaceEntry) -> std::io::Result<()> {
    let mut items = load(data_dir);
    match items.iter_mut().find(|w| w.id == entry.id) {
        Some(existing) => existing.name = entry.name,
        None => items.push(entry),
    }
    save(data_dir, &items).map(|_| ())
}

/// `id → nombre` (un nombre vacío cae al id).
pub fn name_map(items: &[WorkspaceEntry]) -> HashMap<String, String> {
    items
        .iter()
        .map(|w| {
            let name = if w.name.trim().is_empty() {
                w.id.clone()
            } else {
                w.name.clone()
            };
            (w.id.clone(), name)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("rustty-ws-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn guarda_y_lee_el_indice_y_no_reescribe_si_no_cambia() {
        let dir = tempdir();
        assert!(load(&dir).is_empty());
        let items = vec![
            WorkspaceEntry { id: "default".into(), name: "Default".into() },
            WorkspaceEntry { id: "ws-1".into(), name: "Omnia".into() },
        ];
        assert!(save(&dir, &items).unwrap());
        assert!(!save(&dir, &items).unwrap());
        assert_eq!(load(&dir), items);
        let map = name_map(&load(&dir));
        assert_eq!(map.get("ws-1").map(String::as_str), Some("Omnia"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_crea_o_renombra_sin_duplicar() {
        let dir = tempdir();
        add(&dir, WorkspaceEntry { id: "ws-1".into(), name: "Import".into() }).unwrap();
        add(&dir, WorkspaceEntry { id: "ws-1".into(), name: "Import 2".into() }).unwrap();
        add(&dir, WorkspaceEntry { id: "ws-2".into(), name: "Otro".into() }).unwrap();
        let items = load(&dir);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "Import 2");
        assert!(new_id().starts_with("ws-") && new_id() != new_id());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_indice_corrupto_o_con_ids_vacios_no_rompe_nada() {
        let dir = tempdir();
        std::fs::write(dir.join(FILE_NAME), b"{no es json").unwrap();
        assert!(load(&dir).is_empty());
        std::fs::write(dir.join(FILE_NAME), br#"[{"id":"","name":"x"},{"id":"a","name":""}]"#).unwrap();
        let items = load(&dir);
        assert_eq!(items.len(), 1);
        assert_eq!(name_map(&items).get("a").map(String::as_str), Some("a"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
