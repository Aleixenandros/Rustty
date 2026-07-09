//! Notas Markdown por conexión («runbooks»).
//!
//! Cada perfil puede tener una nota en `app_data_dir/notes/<profile_id>.md`: un
//! fichero Markdown autocontenido con frontmatter YAML para sus metadatos
//! (título, conexión, tags, fechas). El `.md` es la fuente de verdad de las
//! notas; el campo histórico `ConnectionProfile.notes` solo sirve como semilla
//! de migración y fallback de lectura para clientes antiguos.
//!
//! Los ficheros se escriben con permisos `0o600` (mismo patrón que
//! `ProfileManager`/`CredentialStore`). El `updated_at` del frontmatter es la
//! marca LWW para la sincronización (item `note:<id>`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::profiles::ConnectionProfile;

/// Documento de nota completo (frontmatter + cuerpo Markdown).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDoc {
    pub profile_id: String,
    #[serde(default)]
    pub title: String,
    /// Snapshot del nombre del perfil, para navegar la carpeta `notes/` desde
    /// fuera de la app (los ficheros se llaman `<uuid>.md`).
    #[serde(default)]
    pub connection: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

/// Resumen de una nota para el índice del frontend (badge, búsqueda).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub profile_id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub updated_at: String,
    /// Primeras líneas del cuerpo (sin marcado) para tooltip/preview.
    pub excerpt: String,
    pub byte_len: usize,
}

/// Frontmatter YAML serializable (todo menos el cuerpo).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct FrontMatter {
    #[serde(default)]
    title: String,
    #[serde(default)]
    connection: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
}

/// Genera el timestamp ISO 8601 actual (UTC).
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Valida que un `profile_id` sea seguro como nombre de fichero (evita
/// path traversal en `note_import`, que recibe ids arbitrarios por sync).
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Separa el frontmatter YAML inicial del cuerpo Markdown. Tolera BOM y CRLF.
/// Si no hay un bloque `---\n…\n---` bien formado al inicio, devuelve el texto
/// completo como cuerpo y un frontmatter por defecto.
fn split_frontmatter(raw: &str) -> (FrontMatter, String) {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let mut lines = raw.lines();
    if lines.next() != Some("---") {
        return (FrontMatter::default(), raw.to_string());
    }
    let mut yaml = String::new();
    let mut found_close = false;
    for line in lines.by_ref() {
        if line == "---" {
            found_close = true;
            break;
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !found_close {
        return (FrontMatter::default(), raw.to_string());
    }
    let body: Vec<&str> = lines.collect();
    let body = body.join("\n");
    let fm = serde_yaml_ng::from_str::<FrontMatter>(&yaml).unwrap_or_default();
    (fm, body.trim_start_matches('\n').to_string())
}

/// `updated_at` de respaldo a partir del mtime del fichero (notas externas sin
/// frontmatter). Si falla, usa la hora actual.
fn file_mtime_iso(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_else(|_| now_iso())
}

/// Reconstruye un `NoteDoc` a partir del contenido bruto del fichero.
fn parse_note(profile_id: &str, raw: &str, path: &Path) -> NoteDoc {
    let (fm, body) = split_frontmatter(raw);
    let updated_at = if fm.updated_at.trim().is_empty() {
        file_mtime_iso(path)
    } else {
        fm.updated_at
    };
    let created_at = if fm.created_at.trim().is_empty() {
        updated_at.clone()
    } else {
        fm.created_at
    };
    NoteDoc {
        profile_id: profile_id.to_string(),
        title: fm.title,
        connection: fm.connection,
        tags: fm.tags,
        body,
        created_at,
        updated_at,
    }
}

/// Texto plano resumido del cuerpo Markdown para el excerpt (quita marcas de
/// encabezado/lista/énfasis básicas y colapsa espacios). No pretende ser un
/// stripper completo; basta para un tooltip de una línea.
fn excerpt_of(body: &str) -> String {
    let mut text = String::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("---") || line.starts_with("```") {
            continue;
        }
        let cleaned = line
            .trim_start_matches('#')
            .trim_start_matches('>')
            .trim_start_matches(['-', '*', '+'])
            .replace(['`', '*', '_'], "")
            .trim()
            .to_string();
        if cleaned.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&cleaned);
        if text.len() >= 160 {
            break;
        }
    }
    if text.chars().count() > 160 {
        let truncated: String = text.chars().take(157).collect();
        format!("{truncated}…")
    } else {
        text
    }
}

/// Gestor de notas Markdown. Opera sobre `app_data_dir/notes/`.
pub struct NotesManager {
    dir: PathBuf,
}

impl NotesManager {
    pub fn new(data_dir: PathBuf) -> Self {
        NotesManager {
            dir: data_dir.join("notes"),
        }
    }

    /// Ruta del fichero de notas de un perfil.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path_for(&self, profile_id: &str) -> PathBuf {
        self.dir.join(format!("{profile_id}.md"))
    }

    /// Lee la nota de un perfil. `None` si no existe.
    pub fn read(&self, profile_id: &str) -> Result<Option<NoteDoc>, AppError> {
        if !is_safe_id(profile_id) {
            return Ok(None);
        }
        let path = self.path_for(profile_id);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&path)?;
        Ok(Some(parse_note(profile_id, &raw, &path)))
    }

    /// Escribe (crea o sobrescribe) la nota de un perfil con permisos `0o600`.
    pub fn write(&self, doc: &NoteDoc) -> Result<(), AppError> {
        if !is_safe_id(&doc.profile_id) {
            return Err(AppError::Io(format!(
                "profile_id inválido para una nota: {}",
                doc.profile_id
            )));
        }
        fs::create_dir_all(&self.dir)?;
        let fm = FrontMatter {
            title: doc.title.clone(),
            connection: doc.connection.clone(),
            tags: doc.tags.clone(),
            created_at: doc.created_at.clone(),
            updated_at: doc.updated_at.clone(),
        };
        let yaml =
            serde_yaml_ng::to_string(&fm).map_err(|e| AppError::Serialization(e.to_string()))?;
        let body = doc.body.trim_end_matches('\n');
        let content = format!("---\n{yaml}---\n\n{body}\n");
        // Atómica + 0600: una nota puede referenciar rutas/hosts sensibles.
        crate::atomic_file::write(&self.path_for(&doc.profile_id), content.as_bytes(), true)?;
        Ok(())
    }

    /// Crea o actualiza la nota de un perfil. Fija `updated_at = now`, conserva
    /// `created_at` si la nota ya existía. Devuelve el documento resultante.
    pub fn set(
        &self,
        profile_id: &str,
        body: String,
        title: String,
        connection: String,
        tags: Vec<String>,
    ) -> Result<NoteDoc, AppError> {
        let now = now_iso();
        let created_at = self
            .read(profile_id)?
            .map(|d| d.created_at)
            .filter(|c| !c.trim().is_empty())
            .unwrap_or_else(|| now.clone());
        let doc = NoteDoc {
            profile_id: profile_id.to_string(),
            title,
            connection,
            tags,
            body,
            created_at,
            updated_at: now,
        };
        self.write(&doc)?;
        Ok(doc)
    }

    /// Borra la nota de un perfil (idempotente).
    pub fn delete(&self, profile_id: &str) -> Result<(), AppError> {
        if !is_safe_id(profile_id) {
            return Ok(());
        }
        let path = self.path_for(profile_id);
        if path.exists() {
            fs::remove_file(&path)?;
        }
        Ok(())
    }

    /// Devuelve todos los documentos completos (volcado para sync).
    pub fn export_all(&self) -> Result<Vec<NoteDoc>, AppError> {
        let mut docs = Vec::new();
        if !self.dir.exists() {
            return Ok(docs);
        }
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_safe_id(id) {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                docs.push(parse_note(id, &raw, &path));
            }
        }
        Ok(docs)
    }

    /// Upsert desde un documento sincronizado (escribe tal cual, preservando su
    /// `updated_at`/`created_at`, que ya vienen resueltos por el merge LWW).
    pub fn import(&self, mut doc: NoteDoc) -> Result<(), AppError> {
        if doc.updated_at.trim().is_empty() {
            doc.updated_at = now_iso();
        }
        if doc.created_at.trim().is_empty() {
            doc.created_at = doc.updated_at.clone();
        }
        self.write(&doc)
    }

    /// Resúmenes de todas las notas (índice del frontend).
    pub fn list(&self) -> Result<Vec<NoteSummary>, AppError> {
        let docs = self.export_all()?;
        Ok(docs.into_iter().map(summary_of).collect())
    }

    /// Migra el campo inline `ConnectionProfile.notes` a ficheros `.md`. Para
    /// cada perfil con `notes` no vacío y sin `<id>.md` existente, crea el
    /// fichero. Idempotente: no toca notas ya migradas ni perfiles sin notas.
    pub fn migrate_from_profiles(&self, profiles: &[ConnectionProfile]) {
        for p in profiles {
            let Some(notes) = p.notes.as_deref() else {
                continue;
            };
            let body = notes.trim();
            if body.is_empty() || !is_safe_id(&p.id) {
                continue;
            }
            if self.path_for(&p.id).exists() {
                continue;
            }
            let ts = p
                .updated_at
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    if p.created_at.trim().is_empty() {
                        now_iso()
                    } else {
                        p.created_at.clone()
                    }
                });
            let doc = NoteDoc {
                profile_id: p.id.clone(),
                title: String::new(),
                connection: p.name.clone(),
                tags: vec![],
                body: body.to_string(),
                created_at: ts.clone(),
                updated_at: ts,
            };
            let _ = self.write(&doc);
        }
    }
}

fn summary_of(doc: NoteDoc) -> NoteSummary {
    let byte_len = doc.body.len();
    NoteSummary {
        excerpt: excerpt_of(&doc.body),
        profile_id: doc.profile_id,
        title: doc.title,
        tags: doc.tags,
        updated_at: doc.updated_at,
        byte_len,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_mgr() -> (NotesManager, PathBuf) {
        let dir = std::env::temp_dir().join(format!("rustty-notes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (NotesManager::new(dir.clone()), dir)
    }

    #[test]
    fn set_read_roundtrip_con_frontmatter() {
        let (mgr, dir) = temp_mgr();
        let id = "abc-123";
        let doc = mgr
            .set(
                id,
                "# Hola\ncontenido `${host}`".to_string(),
                "Mi título".to_string(),
                "web-prod".to_string(),
                vec!["prod".to_string(), "db".to_string()],
            )
            .unwrap();
        assert!(!doc.updated_at.is_empty());
        let got = mgr.read(id).unwrap().unwrap();
        assert_eq!(got.title, "Mi título");
        assert_eq!(got.connection, "web-prod");
        assert_eq!(got.tags, vec!["prod".to_string(), "db".to_string()]);
        assert!(got.body.contains("# Hola"));
        assert!(got.body.contains("${host}"));
        assert_eq!(got.created_at, doc.created_at);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_sin_frontmatter_usa_cuerpo_completo() {
        let (mgr, dir) = temp_mgr();
        let path = mgr.path_for("plain");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "solo texto plano\nsegunda línea").unwrap();
        let got = mgr.read("plain").unwrap().unwrap();
        assert!(got.body.contains("solo texto plano"));
        assert!(got.title.is_empty());
        assert!(!got.updated_at.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_es_idempotente() {
        let (mgr, dir) = temp_mgr();
        mgr.delete("noexiste").unwrap();
        mgr.set("x1", "body".into(), "".into(), "".into(), vec![])
            .unwrap();
        assert!(mgr.read("x1").unwrap().is_some());
        mgr.delete("x1").unwrap();
        assert!(mgr.read("x1").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_inseguro_no_escribe_fuera() {
        let (mgr, dir) = temp_mgr();
        let doc = NoteDoc {
            profile_id: "../escape".to_string(),
            title: String::new(),
            connection: String::new(),
            tags: vec![],
            body: "x".to_string(),
            created_at: now_iso(),
            updated_at: now_iso(),
        };
        assert!(mgr.write(&doc).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_import_preserva_timestamps() {
        let (mgr, dir) = temp_mgr();
        let doc = NoteDoc {
            profile_id: "imp1".into(),
            title: "T".into(),
            connection: "C".into(),
            tags: vec!["a".into()],
            body: "cuerpo".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-02-02T00:00:00Z".into(),
        };
        mgr.import(doc.clone()).unwrap();
        let all = mgr.export_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].updated_at, "2026-02-02T00:00:00Z");
        assert_eq!(all[0].created_at, "2026-01-01T00:00:00Z");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
