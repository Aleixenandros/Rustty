use std::fs::File;
use std::sync::Mutex;

use keepass::db::{Group};
use keepass::{Database, DatabaseKey};
use serde::Serialize;

use crate::error::AppError;

static UNLOCKED: Mutex<Option<UnlockedDb>> = Mutex::new(None);

struct UnlockedDb {
    db: Database,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntrySummary {
    pub uuid: String,
    pub title: String,
    pub username: String,
    pub url: String,
    pub group: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeepassStatus {
    pub unlocked: bool,
    pub path: Option<String>,
}

pub fn unlock(
    path: &str,
    password: Option<&str>,
    keyfile_path: Option<&str>,
) -> Result<(), AppError> {
    let mut file = File::open(path)?;

    let mut key = DatabaseKey::new();
    if let Some(pw) = password {
        if !pw.is_empty() {
            key = key.with_password(pw);
        }
    }
    if let Some(kp) = keyfile_path {
        if !kp.is_empty() {
            let mut kf = File::open(kp)?;
            key = key
                .with_keyfile(&mut kf)
                .map_err(|e| AppError::Io(e.to_string()))?;
        }
    }

    let db = Database::open(&mut file, key).map_err(|e| AppError::Auth(e.to_string()))?;

    *UNLOCKED.lock().unwrap() = Some(UnlockedDb {
        db,
        path: path.to_string(),
    });
    Ok(())
}

pub fn lock() {
    *UNLOCKED.lock().unwrap() = None;
}

pub fn status() -> KeepassStatus {
    let guard = UNLOCKED.lock().unwrap();
    match &*guard {
        Some(u) => KeepassStatus {
            unlocked: true,
            path: Some(u.path.clone()),
        },
        None => KeepassStatus {
            unlocked: false,
            path: None,
        },
    }
}

pub fn list_entries() -> Result<Vec<EntrySummary>, AppError> {
    let guard = UNLOCKED.lock().unwrap();
    let u = guard
        .as_ref()
        .ok_or_else(|| AppError::Auth("KeePass no desbloqueada".into()))?;
    let mut out = Vec::new();
    walk(&u.db.root, "", &mut out);
    out.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    Ok(out)
}

pub fn get_password(entry_uuid: &str) -> Result<Option<String>, AppError> {
    let guard = UNLOCKED.lock().unwrap();
    let u = guard
        .as_ref()
        .ok_or_else(|| AppError::Auth("KeePass no desbloqueada".into()))?;
    let uuid = match uuid::Uuid::parse_str(entry_uuid) {
        Ok(u) => u,
        Err(_) => return Ok(None),
    };
    Ok(u
        .db
        .root
        .entry_by_uuid(uuid)
        .map(|e| e.get_password().unwrap_or("").to_string()))
}

fn walk(group: &Group, path: &str, out: &mut Vec<EntrySummary>) {
    for e in &group.entries {
        out.push(EntrySummary {
            uuid: e.uuid.to_string(),
            title: e.get_title().unwrap_or("").to_string(),
            username: e.get_username().unwrap_or("").to_string(),
            url: e.get_url().unwrap_or("").to_string(),
            group: path.to_string(),
        });
    }
    for g in &group.groups {
        let next_path = if path.is_empty() {
            g.name.clone()
        } else {
            format!("{}/{}", path, g.name)
        };
        walk(g, &next_path, out);
    }
}
