//! Importación de perfiles desde JSON en el **formato nativo** de
//! `ConnectionProfile`, pensada para la CLI (`rustty --import fichero.json`).
//!
//! El fichero es un array de objetos con los campos de `ConnectionProfile`
//! (los que falten toman el valor por defecto) más tres que la app **no**
//! persiste nunca en `profiles.json` y aquí sí se aceptan para que un volcado de
//! otro cliente pueda traer sus secretos: `password`, `passphrase` y
//! `extra_credentials[].password`. El importador los retira del perfil y los
//! guarda en el keyring del sistema bajo las mismas claves que usa la interfaz
//! (`password:<id>`, `passphrase:<id>`, `password:<id>:<credencial>`), es decir,
//! el modelo de contraseña **propia** del perfil (`password_source: own`).
//!
//! Lo que decide el resultado de cada entrada:
//! - **id**: si viene y existe, se actualiza ese perfil; si no viene o no
//!   existe, se busca por `workspace_id` + `name` (sin distinguir mayúsculas) y,
//!   de encontrarse, se actualiza **conservando el id** (las claves del keyring
//!   derivan de él); si tampoco, se crea con un UUID nuevo.
//! - **connection_type**: se normaliza (`SSH2` → `ssh`, `SFTP` → `ssh`, …); un
//!   valor desconocido descarta la entrada con motivo.
//! - **port**: si falta, el del protocolo. **auth_type**: si falta, `password`;
//!   **username**: si falta, vacío.
//!   **created_at**: si falta, ahora; al actualizar se conserva el original.
//! - Una entrada idéntica al perfil existente se cuenta como omitida («sin
//!   cambios»); dos entradas del mismo fichero que apunten al mismo perfil,
//!   la segunda se omite («duplicado en el fichero»).
//!
//! La persistencia va por `ProfileManager::save_many` —la misma transacción que
//! usa la interfaz— y el guardado de secretos por el keyring, inyectados como
//! closures para poder probar el núcleo sin disco ni keyring.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::profiles::ConnectionProfile;

/// Tipos que la interfaz sabe abrir, con sus alias de otros clientes.
const CONNECTION_TYPES: &[(&str, &[&str])] = &[
    ("ssh", &["ssh", "ssh1", "ssh2", "sftp", "scp"]),
    ("rdp", &["rdp", "mstsc"]),
    ("vnc", &["vnc"]),
    ("telnet", &["telnet"]),
    ("ftp", &["ftp"]),
    ("ftps", &["ftps"]),
];

/// `SSH2` → `ssh`, `RDP` → `rdp`… `None` si no es ningún tipo conocido.
pub fn normalize_connection_type(raw: &str) -> Option<&'static str> {
    let wanted = raw.trim().to_ascii_lowercase();
    if wanted.is_empty() {
        return Some("ssh");
    }
    CONNECTION_TYPES
        .iter()
        .find(|(_, aliases)| aliases.contains(&wanted.as_str()))
        .map(|(canonical, _)| *canonical)
}

pub fn default_port(connection_type: &str) -> u16 {
    match connection_type {
        "rdp" => 3389,
        "vnc" => 5900,
        "telnet" => 23,
        "ftp" | "ftps" => 21,
        _ => 22,
    }
}

/// Secreto que hay que dejar en el keyring: clave completa y valor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Secret {
    pub key: String,
    pub value: String,
}

/// Una entrada ya validada, con sus secretos aparte (nunca dentro del perfil).
#[derive(Debug, Clone)]
pub struct Prepared {
    pub profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    /// `(id de la credencial adicional, contraseña)`.
    extra_passwords: Vec<(String, String)>,
}

impl Prepared {
    /// Claves de keyring derivadas del id **actual** del perfil (que el plan
    /// puede haber cambiado por el de un perfil existente).
    pub fn secrets(&self) -> Vec<Secret> {
        let id = &self.profile.id;
        let mut out = Vec::new();
        if let Some(value) = &self.password {
            out.push(Secret {
                key: format!("password:{id}"),
                value: value.clone(),
            });
        }
        if let Some(value) = &self.passphrase {
            out.push(Secret {
                key: format!("passphrase:{id}"),
                value: value.clone(),
            });
        }
        for (cred_id, value) in &self.extra_passwords {
            out.push(Secret {
                key: format!("password:{id}:{cred_id}"),
                value: value.clone(),
            });
        }
        out
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub create: Vec<Prepared>,
    pub update: Vec<Prepared>,
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub imported: usize,
    pub updated: usize,
    pub skipped: Vec<Skipped>,
    pub secrets_stored: usize,
    pub secrets_failed: Vec<Skipped>,
    pub dry_run: bool,
    /// Lo rellena la CLI: dónde han ido a parar los perfiles.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<TargetWorkspace>,
}

/// Contexto de la preparación: workspace impuesto por `--workspace` (ya
/// resuelto a id) y el instante para `created_at`.
pub struct Options {
    pub workspace_id: Option<String>,
    pub now: String,
}

/// Parsea el fichero: un array de perfiles, **un solo perfil** (objeto con
/// `name`) o un envoltorio `{"profiles": [...]}`.
pub fn parse_entries(raw: &str) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(raw).map_err(|e| format!("JSON invalido: {e}"))?;
    match value {
        Value::Array(items) => Ok(items),
        Value::Object(mut obj) => match obj.remove("profiles") {
            Some(Value::Array(items)) => Ok(items),
            Some(_) => Err("\"profiles\" debe ser un array de perfiles.".into()),
            None if obj.contains_key("name") => Ok(vec![Value::Object(obj)]),
            None => Err("Se esperaba un perfil, un array de perfiles o un objeto con \"profiles\".".into()),
        },
        _ => Err("Se esperaba un perfil o un array de perfiles.".into()),
    }
}

/// Nombre del workspace que se crea cuando no se indica ninguno:
/// `import_2026-09-16_1830`.
pub fn import_workspace_name(now: &chrono::DateTime<chrono::Utc>) -> String {
    format!("import_{}", now.format("%Y-%m-%d_%H%M"))
}

/// Workspace de destino de la importación, para el resumen.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TargetWorkspace {
    pub id: String,
    pub name: String,
    /// `true` si lo crea esta importación.
    pub created: bool,
}

fn take_string(obj: &mut Map<String, Value>, key: &str) -> Option<String> {
    match obj.remove(key) {
        Some(Value::String(s)) => Some(s),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }
}

fn string_field(obj: &Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// Valida y completa una entrada. El error lleva el motivo para el resumen.
pub fn prepare(entry: Value, opts: &Options) -> Result<Prepared, String> {
    let Value::Object(mut obj) = entry else {
        return Err("la entrada no es un objeto".into());
    };
    let name = string_field(&obj, "name");
    if name.is_empty() {
        return Err("falta el nombre (name)".into());
    }
    if string_field(&obj, "host").is_empty() {
        return Err("falta el host".into());
    }

    let kind_raw = string_field(&obj, "connection_type");
    let kind = normalize_connection_type(&kind_raw)
        .ok_or_else(|| format!("tipo de conexion desconocido: {kind_raw}"))?;
    obj.insert("connection_type".into(), Value::String(kind.to_string()));

    // Secretos fuera del perfil antes de deserializarlo: `ConnectionProfile` no
    // tiene esos campos y no deben acabar en profiles.json bajo ningún nombre.
    let password = take_string(&mut obj, "password").filter(|s| !s.is_empty());
    let passphrase = take_string(&mut obj, "passphrase").filter(|s| !s.is_empty());
    let mut extra_passwords = Vec::new();
    if let Some(Value::Array(creds)) = obj.get_mut("extra_credentials") {
        for cred in creds.iter_mut() {
            let Value::Object(co) = cred else { continue };
            let cred_id = match string_field(co, "id") {
                id if id.is_empty() => {
                    let id = uuid::Uuid::new_v4().to_string();
                    co.insert("id".into(), Value::String(id.clone()));
                    id
                }
                id => id,
            };
            if let Some(pw) = take_string(co, "password").filter(|s| !s.is_empty()) {
                extra_passwords.push((cred_id, pw));
            }
        }
    }

    if string_field(&obj, "id").is_empty() {
        obj.insert("id".into(), Value::String(uuid::Uuid::new_v4().to_string()));
    }
    if string_field(&obj, "created_at").is_empty() {
        obj.insert("created_at".into(), Value::String(opts.now.clone()));
    }
    // Un perfil RDP/VNC de otro cliente puede venir sin usuario (lo pide el
    // servidor): el struct lo exige, así que se deja vacío.
    if !obj.get("username").is_some_and(|v| v.is_string()) {
        obj.insert("username".into(), Value::String(String::new()));
    }
    if !obj.get("auth_type").is_some_and(|v| v.is_string()) {
        obj.insert("auth_type".into(), Value::String("password".into()));
    }
    if !obj.get("port").is_some_and(|v| v.is_u64()) {
        obj.insert("port".into(), Value::from(default_port(kind)));
    }
    if let Some(ws) = &opts.workspace_id {
        obj.insert("workspace_id".into(), Value::String(ws.clone()));
    }
    // Mapa de otros clientes: la carpeta llega como ruta `A/B/C`; se limpia de
    // barras sobrantes y una vacía es «sin grupo».
    if let Some(Value::String(group)) = obj.get("group") {
        let cleaned = group.trim().trim_matches('/').to_string();
        obj.insert(
            "group".into(),
            if cleaned.is_empty() {
                Value::Null
            } else {
                Value::String(cleaned)
            },
        );
    }

    let profile: ConnectionProfile =
        serde_json::from_value(Value::Object(obj)).map_err(|e| format!("perfil invalido: {e}"))?;
    Ok(Prepared {
        profile,
        password,
        passphrase,
        extra_passwords,
    })
}

fn same_profile(a: &ConnectionProfile, b: &ConnectionProfile) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}

/// Cruza las entradas con los perfiles existentes y decide qué crear, qué
/// actualizar y qué omitir.
pub fn plan(existing: &[ConnectionProfile], entries: Vec<Prepared>) -> Plan {
    let mut plan = Plan::default();
    let mut touched: HashSet<String> = HashSet::new();
    for mut entry in entries {
        let by_id = existing.iter().find(|p| p.id == entry.profile.id);
        let by_name = by_id.or_else(|| {
            existing.iter().find(|p| {
                p.workspace_id == entry.profile.workspace_id
                    && p.name.eq_ignore_ascii_case(&entry.profile.name)
            })
        });
        match by_name {
            Some(current) => {
                entry.profile.id = current.id.clone();
                entry.profile.created_at = current.created_at.clone();
                if !touched.insert(current.id.clone()) {
                    plan.skipped.push(Skipped {
                        name: entry.profile.name.clone(),
                        reason: "duplicado en el fichero".into(),
                    });
                    continue;
                }
                if same_profile(current, &entry.profile) && entry.secrets().is_empty() {
                    plan.skipped.push(Skipped {
                        name: entry.profile.name.clone(),
                        reason: "sin cambios".into(),
                    });
                    continue;
                }
                plan.update.push(entry);
            }
            None => {
                let key = format!(
                    "{}\u{0}{}",
                    entry.profile.workspace_id,
                    entry.profile.name.to_ascii_lowercase()
                );
                if !touched.insert(key) {
                    plan.skipped.push(Skipped {
                        name: entry.profile.name.clone(),
                        reason: "duplicado en el fichero".into(),
                    });
                    continue;
                }
                plan.create.push(entry);
            }
        }
    }
    plan
}

/// Aplica el plan: una sola transacción de perfiles y, después, los secretos.
/// Con `dry_run` no se llama a nada y el resumen cuenta lo que habría pasado.
pub fn apply<S, K>(plan: Plan, dry_run: bool, save: S, mut store_secret: K) -> Result<Summary, String>
where
    S: FnOnce(Vec<ConnectionProfile>) -> Result<(), String>,
    K: FnMut(&Secret) -> Result<(), String>,
{
    let mut summary = Summary {
        imported: plan.create.len(),
        updated: plan.update.len(),
        skipped: plan.skipped,
        dry_run,
        ..Default::default()
    };
    let entries: Vec<Prepared> = plan.create.into_iter().chain(plan.update).collect();
    if dry_run {
        summary.secrets_stored = entries.iter().map(|e| e.secrets().len()).sum();
        return Ok(summary);
    }
    if !entries.is_empty() {
        save(entries.iter().map(|e| e.profile.clone()).collect())?;
    }
    for entry in &entries {
        for secret in entry.secrets() {
            match store_secret(&secret) {
                Ok(()) => summary.secrets_stored += 1,
                Err(err) => summary.secrets_failed.push(Skipped {
                    name: entry.profile.name.clone(),
                    reason: format!("{}: {err}", secret.key),
                }),
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opts() -> Options {
        Options {
            workspace_id: None,
            now: "2026-09-16T10:00:00Z".into(),
        }
    }

    fn existing(name: &str, id: &str) -> ConnectionProfile {
        serde_json::from_value(json!({
            "id": id, "name": name, "host": "h", "port": 22, "username": "u",
            "domain": null, "auth_type": "password", "key_path": null, "group": null,
            "created_at": "2026-01-01T00:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn normaliza_tipos_y_puertos() {
        assert_eq!(normalize_connection_type("SSH2"), Some("ssh"));
        assert_eq!(normalize_connection_type("sftp"), Some("ssh"));
        assert_eq!(normalize_connection_type(""), Some("ssh"));
        assert_eq!(normalize_connection_type("RDP"), Some("rdp"));
        assert_eq!(normalize_connection_type("Telnet"), Some("telnet"));
        assert_eq!(normalize_connection_type("http"), None);
        assert_eq!(default_port("rdp"), 3389);
        assert_eq!(default_port("vnc"), 5900);
        assert_eq!(default_port("ftps"), 21);
        assert_eq!(default_port("ssh"), 22);
    }

    #[test]
    fn completa_defaults_y_saca_los_secretos_del_perfil() {
        let entry = json!({
            "name": "web", "host": "10.0.0.5", "username": "root",
            "connection_type": "SSH2", "group": "/Prod/Web/",
            "password": "s3cret", "passphrase": "",
            "extra_credentials": [{"username": "deploy", "password": "d3ploy"}]
        });
        let prepared = prepare(entry, &opts()).unwrap();
        let p = &prepared.profile;
        assert!(!p.id.is_empty());
        assert_eq!(p.created_at, "2026-09-16T10:00:00Z");
        assert_eq!(p.connection_type, "ssh");
        assert_eq!(p.port, 22);
        assert_eq!(p.group.as_deref(), Some("Prod/Web"));
        assert_eq!(p.workspace_id, "default");
        assert_eq!(p.extra_credentials.len(), 1);
        // Los secretos no viven en el perfil serializado…
        let dumped = serde_json::to_string(p).unwrap();
        assert!(!dumped.contains("s3cret") && !dumped.contains("d3ploy"));
        // …sino en claves de keyring derivadas del id.
        let secrets = prepared.secrets();
        assert_eq!(secrets.len(), 2, "{secrets:?}");
        assert_eq!(secrets[0].key, format!("password:{}", p.id));
        assert_eq!(secrets[0].value, "s3cret");
        let cred_id = &p.extra_credentials[0].id;
        assert_eq!(secrets[1].key, format!("password:{}:{cred_id}", p.id));
    }

    #[test]
    fn rechaza_entradas_incompletas_o_de_tipo_desconocido() {
        assert!(prepare(json!({"host": "h"}), &opts()).unwrap_err().contains("name"));
        assert!(prepare(json!({"name": "x"}), &opts()).unwrap_err().contains("host"));
        let err = prepare(json!({"name": "x", "host": "h", "connection_type": "http"}), &opts()).unwrap_err();
        assert!(err.contains("http"));
        assert!(prepare(json!("no soy un objeto"), &opts()).is_err());
    }

    #[test]
    fn el_workspace_impuesto_gana_y_rdp_trae_su_puerto() {
        let o = Options {
            workspace_id: Some("ws-omnia".into()),
            now: "x".into(),
        };
        let p = prepare(json!({"name": "win", "host": "h", "connection_type": "RDP", "workspace_id": "otro", "domain": "CORP"}), &o)
            .unwrap()
            .profile;
        assert_eq!(p.workspace_id, "ws-omnia");
        assert_eq!(p.port, 3389);
        assert_eq!(p.domain.as_deref(), Some("CORP"));
    }

    #[test]
    fn el_plan_crea_actualiza_conservando_id_y_omite() {
        let current = vec![existing("Web", "id-web"), existing("Db", "id-db")];
        let entries = vec![
            // Mismo nombre, sin id: actualiza y hereda el id (y el created_at).
            prepare(json!({"name": "web", "host": "nuevo", "username": "u"}), &opts()).unwrap(),
            // Identico al existente: sin cambios.
            prepare(json!({"id": "id-db", "name": "Db", "host": "h", "port": 22, "username": "u", "created_at": "z"}), &opts()).unwrap(),
            // Nuevo.
            prepare(json!({"name": "cache", "host": "c", "username": "u"}), &opts()).unwrap(),
            // Duplicado del nuevo dentro del fichero.
            prepare(json!({"name": "CACHE", "host": "c2", "username": "u"}), &opts()).unwrap(),
        ];
        let plan = plan(&current, entries);
        assert_eq!(plan.update.len(), 1);
        assert_eq!(plan.update[0].profile.id, "id-web");
        assert_eq!(plan.update[0].profile.created_at, "2026-01-01T00:00:00Z");
        assert_eq!(plan.update[0].profile.host, "nuevo");
        assert_eq!(plan.create.len(), 1);
        assert_eq!(plan.create[0].profile.name, "cache");
        let reasons: Vec<&str> = plan.skipped.iter().map(|s| s.reason.as_str()).collect();
        assert_eq!(reasons, vec!["sin cambios", "duplicado en el fichero"]);
    }

    #[test]
    fn una_entrada_igual_pero_con_contrasena_si_cuenta_como_actualizacion() {
        let current = vec![existing("Db", "id-db")];
        let entry = prepare(json!({"id": "id-db", "name": "Db", "host": "h", "port": 22, "username": "u", "password": "pw"}), &opts()).unwrap();
        let plan = plan(&current, vec![entry]);
        assert_eq!(plan.update.len(), 1);
        assert_eq!(plan.update[0].secrets()[0].key, "password:id-db");
    }

    #[test]
    fn apply_guarda_en_una_transaccion_y_cuenta_los_secretos() {
        let entries = vec![
            prepare(json!({"name": "a", "host": "h", "username": "u", "password": "pa"}), &opts()).unwrap(),
            prepare(json!({"name": "b", "host": "h", "username": "u", "password": "pb"}), &opts()).unwrap(),
        ];
        let plan = plan(&[], entries);
        let mut saved = 0usize;
        let mut stored = Vec::new();
        let summary = apply(
            plan,
            false,
            |profiles| {
                saved = profiles.len();
                Ok(())
            },
            |secret| {
                if secret.value == "pb" {
                    return Err("keyring bloqueado".into());
                }
                stored.push(secret.key.clone());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(saved, 2);
        assert_eq!(summary.imported, 2);
        assert_eq!(summary.secrets_stored, 1);
        assert_eq!(summary.secrets_failed.len(), 1);
        assert_eq!(summary.secrets_failed[0].name, "b");
        assert!(summary.secrets_failed[0].reason.contains("keyring bloqueado"));
    }

    #[test]
    fn dry_run_no_toca_nada() {
        let entries = vec![prepare(json!({"name": "a", "host": "h", "username": "u", "password": "pa"}), &opts()).unwrap()];
        let plan = plan(&[], entries);
        let summary = apply(
            plan,
            true,
            |_| panic!("no debe guardar"),
            |_| panic!("no debe tocar el keyring"),
        )
        .unwrap();
        assert!(summary.dry_run);
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.secrets_stored, 1);
    }

    #[test]
    fn parse_entries_admite_array_objeto_unico_y_envoltorio() {
        assert_eq!(parse_entries("[{}, {}]").unwrap().len(), 2);
        assert_eq!(parse_entries(r#"{"profiles": [{}]}"#).unwrap().len(), 1);
        assert_eq!(parse_entries(r#"{"name": "solo", "host": "h"}"#).unwrap().len(), 1);
        assert!(parse_entries(r#"{"x": 1}"#).is_err());
        assert!(parse_entries("no json").is_err());
    }

    #[test]
    fn el_workspace_de_importacion_lleva_fecha_y_hora() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-16T18:30:05Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(import_workspace_name(&now), "import_2026-09-16_1830");
    }
}
