//! Almacén de credenciales (catálogo `credentials.json` + keyring) y resolución
//! de los marcadores `${master:}` / `${secret:}` / `${var:}` del motor de
//! sustitución.
//!
//! Fase 2 del «Motor de variables, secretos y credenciales maestras». El
//! catálogo guarda **solo metadatos** (mismo patrón que `ProfileManager`); los
//! valores secretos (`master`/`secret`) viven en el keyring del SO, indexados
//! por **id** (UUID) para que renombrar no reescriba el keyring. El valor de las
//! variables `var` no es secreto y puede vivir en el propio catálogo.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::atomic_file;
use crate::error::AppError;
use crate::profiles::ConnectionProfile;
use crate::subst::{InternalVar, Resolver, SubstContext};

/// Servicio usado para todas las entradas de keyring de Rustty.
const KEYRING_SERVICE: &str = "rustty";

/// Tipo de credencial del catálogo.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    /// Credencial maestra: el valor es un secreto (contraseña / token).
    Master,
    /// Variable de texto NO secreta (reutilizable como `${var:nombre}`).
    Var,
    /// Secreto suelto referenciable como `${secret:nombre}`.
    Secret,
}

/// Metadatos de una credencial del catálogo. Nunca contiene valores secretos:
/// para `Master`/`Secret`, `value` es siempre `None` (el valor vive en keyring);
/// para `Var`, `value` puede traer el texto no secreto.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialMeta {
    /// UUID estable. Clave de keyring derivada de este id.
    pub id: String,
    /// Nombre único (case-sensitive, sin espacios) dentro del mismo `kind`. Es
    /// lo que el usuario escribe en el marcador (`${master:nombre}`, etc.).
    pub name: String,
    /// Tipo de credencial.
    pub kind: CredentialKind,
    /// Descripción opcional para la UI. No secreta.
    #[serde(default)]
    pub description: Option<String>,
    /// Para `kind == Var`, valor de texto NO secreto. Para `Master`/`Secret`
    /// SIEMPRE es `None` y el valor va al keyring.
    #[serde(default)]
    pub value: Option<String>,
    /// Timestamp ISO 8601 de creación.
    pub created_at: String,
    /// Timestamp ISO 8601 de la última modificación.
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Valida un nombre de credencial: empieza por letra o `_`, y continúa con
/// letras, dígitos, `_`, `-` o `.`. Case-sensitive, sin espacios. Coincide con
/// la gramática `nombre` del contrato (`subst::engine::is_valid_name`).
fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Genera el timestamp ISO 8601 actual (UTC) para `created_at`/`updated_at`.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Clave de keyring para el valor de una credencial según su tipo e id.
/// Devuelve `None` para `Var` (no usa keyring).
fn keyring_key(kind: CredentialKind, id: &str) -> Option<String> {
    match kind {
        CredentialKind::Master => Some(format!("master:{id}")),
        CredentialKind::Secret => Some(format!("secret:{id}")),
        CredentialKind::Var => None,
    }
}

/// Escribe el valor de una credencial secreta en el keyring.
fn keyring_set_value(kind: CredentialKind, id: &str, value: &str) -> Result<(), AppError> {
    let Some(key) = keyring_key(kind, id) else {
        return Ok(());
    };
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| AppError::Auth(e.to_string()))?;
    entry
        .set_password(value)
        .map_err(|e| AppError::Auth(e.to_string()))
}

/// Lee el valor de una credencial secreta del keyring. `None` si no existe.
fn keyring_get_value(kind: CredentialKind, id: &str) -> Option<String> {
    let key = keyring_key(kind, id)?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).ok()?;
    match entry.get_password() {
        Ok(value) => {
            #[cfg(target_os = "linux")]
            {
                // El backend combinado de Linux lee las entradas legacy de
                // keyutils como caché y reescribe en Secret Service para que
                // persistan tras reiniciar (mismo patrón que `keyring_get`).
                let _ = entry.set_password(&value);
            }
            Some(value)
        }
        Err(_) => None,
    }
}

/// Borra el valor de una credencial secreta del keyring (idempotente).
fn keyring_delete_value(kind: CredentialKind, id: &str) {
    let Some(key) = keyring_key(kind, id) else {
        return;
    };
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &key) {
        let _ = entry.delete_credential();
    }
}

/// Gestor del catálogo de credenciales. Persiste los metadatos en
/// `app_data_dir/credentials.json` con permisos `0o600` (igual que
/// `ProfileManager`). Los valores secretos se gestionan aparte en el keyring.
pub struct CredentialStore {
    credentials_path: PathBuf,
}

impl CredentialStore {
    pub fn new(data_dir: PathBuf) -> Self {
        CredentialStore {
            credentials_path: data_dir.join("credentials.json"),
        }
    }

    /// Carga todos los metadatos del disco. Lista vacía si el fichero no existe.
    ///
    /// Igual que `profiles.json`, el store se **recupera** si está dañado
    /// (cuarentena + última copia válida): un catálogo de credenciales que no
    /// parsea dejaría a los perfiles que lo referencian sin poder autenticarse.
    pub fn load_all(&self) -> Result<Vec<CredentialMeta>, AppError> {
        let (data, _recovery) =
            atomic_file::read_or_recover(&self.credentials_path, true, |text| {
                serde_json::from_str::<Vec<CredentialMeta>>(text).is_ok()
            })?;
        let Some(data) = data else {
            return Ok(vec![]);
        };
        let creds: Vec<CredentialMeta> = serde_json::from_str(&data)?;
        Ok(creds)
    }

    /// Guarda o actualiza una credencial (upsert por id). Parte de la API
    /// análoga a `ProfileManager`; las altas/ediciones del flujo Tauri usan
    /// `cred_set` (que además gestiona el keyring), de ahí que pueda no tener
    /// llamantes directos todavía.
    #[allow(dead_code)]
    pub fn save(&self, cred: CredentialMeta) -> Result<(), AppError> {
        let mut creds = self.load_all()?;
        match creds.iter().position(|c| c.id == cred.id) {
            Some(idx) => creds[idx] = cred,
            None => creds.push(cred),
        }
        self.write_all(&creds)
    }

    /// Elimina una credencial del catálogo por id.
    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        let mut creds = self.load_all()?;
        creds.retain(|c| c.id != id);
        self.write_all(&creds)
    }

    fn write_all(&self, creds: &[CredentialMeta]) -> Result<(), AppError> {
        if let Some(parent) = self.credentials_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(creds)?;
        // Atómica + 0600: el catálogo de credenciales no queda a medias ni
        // legible por otros usuarios.
        crate::atomic_file::write(&self.credentials_path, data.as_bytes(), true)?;
        Ok(())
    }
}

// ─── Resolución nombre → id → valor ──────────────────────────────────────────

/// Busca en el catálogo la credencial de un `kind` por su nombre exacto.
fn find_by_name<'a>(
    catalog: &'a [CredentialMeta],
    kind: CredentialKind,
    name: &str,
) -> Option<&'a CredentialMeta> {
    catalog.iter().find(|c| c.kind == kind && c.name == name)
}

/// Resuelve `${master:nombre}` → valor del keyring `master:<id>`.
pub fn resolve_master(catalog: &[CredentialMeta], name: &str) -> Option<String> {
    let cred = find_by_name(catalog, CredentialKind::Master, name)?;
    keyring_get_value(CredentialKind::Master, &cred.id)
}

/// Resuelve `${secret:nombre}` → valor del keyring `secret:<id>`.
pub fn resolve_secret(catalog: &[CredentialMeta], name: &str) -> Option<String> {
    let cred = find_by_name(catalog, CredentialKind::Secret, name)?;
    keyring_get_value(CredentialKind::Secret, &cred.id)
}

/// Resuelve `${var:nombre}` → `value` del catálogo (no usa keyring).
pub fn resolve_var(catalog: &[CredentialMeta], name: &str) -> Option<String> {
    let cred = find_by_name(catalog, CredentialKind::Var, name)?;
    cred.value.clone()
}

/// Resolver para campos de conexión de texto (host, usuario, bastion): resuelve
/// solo variables de texto (`${var:}`) y entorno (`${env:}`). Deja literales los
/// internos (evita recursión de `${host}` dentro del propio host) y nunca expone
/// secretos/maestras en un campo no protegido.
struct ConnFieldResolver<'a> {
    catalog: &'a [CredentialMeta],
}

impl Resolver for ConnFieldResolver<'_> {
    fn internal(&self, _var: InternalVar) -> Option<String> {
        None
    }
    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
    fn var(&self, name: &str) -> Option<String> {
        resolve_var(self.catalog, name)
    }
    fn secret(&self, _name: &str) -> Option<String> {
        None
    }
    fn master(&self, _name: &str) -> Option<String> {
        None
    }
    fn ask(&self, _label: &str, _options: &[String]) -> Option<String> {
        None
    }
}

/// Sustituye `${var:}` / `${env:}` en los campos de conexión de texto del perfil
/// (host, usuario y bastion) justo antes de conectar. No toca contraseñas ni
/// otros campos; los marcadores sin resolver quedan literales. Permite, p. ej.,
/// completar un host con `servidor.${var:dominio}`.
pub fn substitute_connection_fields(profile: &mut ConnectionProfile, store: &CredentialStore) {
    let needs = profile.host.contains("${")
        || profile.username.contains("${")
        || profile
            .proxy_jump
            .as_deref()
            .is_some_and(|s| s.contains("${"));
    if !needs {
        return;
    }
    let catalog = store.load_all().unwrap_or_default();
    let resolver = ConnFieldResolver { catalog: &catalog };
    if profile.host.contains("${") {
        profile.host = crate::subst::substitute(&profile.host, &resolver);
    }
    if profile.username.contains("${") {
        profile.username = crate::subst::substitute(&profile.username, &resolver);
    }
    if let Some(pj) = profile.proxy_jump.clone() {
        if pj.contains("${") {
            profile.proxy_jump = Some(crate::subst::substitute(&pj, &resolver));
        }
    }
}

// ─── Integración con el motor de sustitución ─────────────────────────────────

/// `Resolver` concreto: resuelve internos + `env` (como `DefaultResolver`) y
/// además `var`/`secret`/`master` consultando el catálogo (y el keyring para
/// los secretos). En la Fase 5 también resuelve `${ask:}` a partir de las
/// respuestas provistas por el frontend (clave = etiqueta del `ask`). `cmd`
/// sigue sin resolver (reservado).
///
/// Toma el catálogo ya cargado por valor para no acoplarse al ciclo de vida del
/// `CredentialStore` durante una sustitución.
pub struct CredentialResolver {
    ctx: SubstContext,
    catalog: Vec<CredentialMeta>,
    /// Respuestas a los `${ask:Etiqueta}` provistas por el frontend al conectar.
    /// Clave = etiqueta del `ask`; un `ask` sin respuesta queda literal.
    ask_answers: std::collections::HashMap<String, String>,
}

impl CredentialResolver {
    /// Crea el resolver sin respuestas de `ask` (equivalente a la Fase 4).
    #[allow(dead_code)]
    pub fn new(ctx: SubstContext, catalog: Vec<CredentialMeta>) -> Self {
        CredentialResolver {
            ctx,
            catalog,
            ask_answers: std::collections::HashMap::new(),
        }
    }

    /// Crea el resolver con las respuestas a los `${ask:}` provistas al conectar.
    pub fn with_ask_answers(
        ctx: SubstContext,
        catalog: Vec<CredentialMeta>,
        ask_answers: std::collections::HashMap<String, String>,
    ) -> Self {
        CredentialResolver {
            ctx,
            catalog,
            ask_answers,
        }
    }
}

impl Resolver for CredentialResolver {
    fn internal(&self, var: InternalVar) -> Option<String> {
        let value = match var {
            InternalVar::Host => self.ctx.host.clone(),
            InternalVar::Port => self.ctx.port.to_string(),
            InternalVar::User => self.ctx.user.clone(),
            InternalVar::ProfileName => self.ctx.profile_name.clone(),
            InternalVar::Workspace => self.ctx.workspace.clone(),
            InternalVar::Date => chrono::Local::now().format("%Y-%m-%d").to_string(),
            InternalVar::Time => chrono::Local::now().format("%H:%M:%S").to_string(),
        };
        Some(value)
    }

    fn env(&self, name: &str) -> Option<String> {
        // Conforme al contrato: si la variable no existe, cadena vacía.
        Some(std::env::var(name).unwrap_or_default())
    }

    fn var(&self, name: &str) -> Option<String> {
        resolve_var(&self.catalog, name)
    }

    fn secret(&self, name: &str) -> Option<String> {
        resolve_secret(&self.catalog, name)
    }

    fn master(&self, name: &str) -> Option<String> {
        resolve_master(&self.catalog, name)
    }

    fn ask(&self, label: &str, _options: &[String]) -> Option<String> {
        // Respuesta provista por el frontend (clave = etiqueta). Si no hay
        // respuesta, devolvemos `None` y el marcador queda literal.
        self.ask_answers.get(label).cloned()
    }
}

/// Especificación de una pregunta `${ask:}` extraída de los campos de un
/// perfil: etiqueta a mostrar y opciones (vacío = entrada de texto libre).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AskSpec {
    /// Texto que se muestra al usuario (y clave de respuesta).
    pub label: String,
    /// Opciones de selección (vacío = entrada de texto libre).
    pub options: Vec<String>,
}

/// Escanea un texto y devuelve los `${ask:}` que contiene, reutilizando el
/// parser del motor (no duplica la gramática). Mantiene el orden de aparición.
pub fn collect_asks(text: &str) -> Vec<AskSpec> {
    use crate::subst::Marker;
    crate::subst::parse(text)
        .into_iter()
        .filter_map(|m| match m {
            Marker::Ask { label, options } => Some(AskSpec { label, options }),
            _ => None,
        })
        .collect()
}

// ─── Lógica de los comandos (sin la capa #[tauri::command]) ──────────────────

/// Crea o actualiza una credencial en el catálogo (y el keyring si aplica).
///
/// Valida nombre (sin espacios, gramática del contrato) y unicidad case-sensitive
/// dentro del mismo `kind`. Para `Master`/`Secret`, escribe `value` al keyring y
/// NUNCA lo guarda en el catálogo. Para `Var`, guarda `value` en el catálogo.
pub fn cred_set(
    store: &CredentialStore,
    id: Option<String>,
    name: String,
    kind: CredentialKind,
    description: Option<String>,
    value: Option<String>,
) -> Result<CredentialMeta, AppError> {
    if !is_valid_name(&name) {
        return Err(AppError::Auth(format!(
            "Nombre de credencial inválido «{name}»: sin espacios; empieza por letra o «_» y solo letras, dígitos, «_», «-» o «.»."
        )));
    }

    let mut catalog = store.load_all()?;

    // Unicidad del nombre dentro del mismo kind (excluyendo la propia entrada).
    if let Some(other) = catalog
        .iter()
        .find(|c| c.kind == kind && c.name == name && Some(&c.id) != id.as_ref())
    {
        return Err(AppError::Auth(format!(
            "Ya existe una credencial «{}» de ese tipo (id {}).",
            name, other.id
        )));
    }

    let now = now_iso();

    let meta = match id {
        // Actualización de una credencial existente.
        Some(existing_id) => {
            let idx = catalog
                .iter()
                .position(|c| c.id == existing_id)
                .ok_or_else(|| {
                    AppError::Auth(format!("Credencial {existing_id} no encontrada."))
                })?;
            let created_at = catalog[idx].created_at.clone();

            // Si cambia el kind y el anterior era secreto, limpiamos su keyring.
            let prev_kind = catalog[idx].kind;
            if prev_kind != kind {
                keyring_delete_value(prev_kind, &existing_id);
            }

            // El valor de Master/Secret va al keyring; el de Var, al catálogo.
            let catalog_value = match kind {
                CredentialKind::Var => value.clone(),
                CredentialKind::Master | CredentialKind::Secret => {
                    if let Some(v) = value.as_deref() {
                        keyring_set_value(kind, &existing_id, v)?;
                    }
                    None
                }
            };

            let meta = CredentialMeta {
                id: existing_id,
                name,
                kind,
                description,
                value: catalog_value,
                created_at,
                updated_at: Some(now),
            };
            catalog[idx] = meta.clone();
            store.write_all(&catalog)?;
            meta
        }
        // Alta nueva: generamos UUID.
        None => {
            let new_id = uuid::Uuid::new_v4().to_string();

            let catalog_value = match kind {
                CredentialKind::Var => value.clone(),
                CredentialKind::Master | CredentialKind::Secret => {
                    if let Some(v) = value.as_deref() {
                        keyring_set_value(kind, &new_id, v)?;
                    }
                    None
                }
            };

            let meta = CredentialMeta {
                id: new_id,
                name,
                kind,
                description,
                value: catalog_value,
                created_at: now.clone(),
                updated_at: Some(now),
            };
            catalog.push(meta.clone());
            store.write_all(&catalog)?;
            meta
        }
    };

    Ok(meta)
}

/// Aplica unos metadatos sincronizados haciendo **upsert por id** en el
/// catálogo SIN tocar el keyring. Sirve para reescribir el catálogo con los
/// metadatos que llegan por sync, conservando el `id` original. Para
/// `kind == Var` conserva el `value` del meta (no es secreto); para
/// `Master`/`Secret` ignora cualquier `value` (el valor real viaja aparte como
/// item `secret:*` y se rehidrata al keyring por separado).
pub fn cred_import(store: &CredentialStore, meta: CredentialMeta) -> Result<(), AppError> {
    let value = match meta.kind {
        CredentialKind::Var => meta.value.clone(),
        CredentialKind::Master | CredentialKind::Secret => None,
    };
    let imported = CredentialMeta { value, ..meta };

    let mut catalog = store.load_all()?;
    match catalog.iter().position(|c| c.id == imported.id) {
        Some(idx) => catalog[idx] = imported,
        None => catalog.push(imported),
    }
    store.write_all(&catalog)
}

/// Elimina una credencial del catálogo y su valor del keyring.
///
/// Si `force == false` y algún perfil la referencia (`master_credential_id`),
/// devuelve un error indicando cuántos perfiles la usan. El conteo se hace
/// leyendo `profiles.json` de forma tolerante (si el campo aún no existe, 0).
pub fn cred_delete(
    store: &CredentialStore,
    data_dir: &std::path::Path,
    id: String,
    force: bool,
) -> Result<(), AppError> {
    let catalog = store.load_all()?;
    let Some(cred) = catalog.iter().find(|c| c.id == id) else {
        // Idempotente: si no existe en el catálogo, intentamos limpiar keyring
        // de ambos tipos por si quedó huérfano y salimos sin error.
        keyring_delete_value(CredentialKind::Master, &id);
        keyring_delete_value(CredentialKind::Secret, &id);
        return Ok(());
    };
    let kind = cred.kind;

    if !force {
        let count = count_profiles_referencing(data_dir, &id);
        if count > 0 {
            return Err(AppError::Auth(format!(
                "La credencial está en uso por {count} perfil(es). Use «force» para eliminarla de todas formas."
            )));
        }
    }

    keyring_delete_value(kind, &id);
    store.delete(&id)?;
    Ok(())
}

/// Cuenta cuántos perfiles de `profiles.json` referencian la credencial por su
/// `master_credential_id`. Tolerante: si el fichero/campo no existe, devuelve 0.
fn count_profiles_referencing(data_dir: &std::path::Path, id: &str) -> usize {
    let path = data_dir.join("profiles.json");
    let Ok(data) = fs::read_to_string(&path) else {
        return 0;
    };
    // Parseamos como JSON genérico para no acoplarnos a la presencia del campo
    // `master_credential_id` (que aún no existe en `ConnectionProfile`: Fase 4).
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) else {
        return 0;
    };
    let Some(profiles) = value.as_array() else {
        return 0;
    };
    profiles
        .iter()
        .filter(|p| p.get("master_credential_id").and_then(|v| v.as_str()) == Some(id))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> SubstContext {
        SubstContext {
            host: "10.0.0.1".to_string(),
            port: 22,
            user: "ada".to_string(),
            profile_name: "Demo".to_string(),
            workspace: "default".to_string(),
        }
    }

    fn meta(kind: CredentialKind, name: &str, value: Option<&str>) -> CredentialMeta {
        CredentialMeta {
            id: format!("id-{name}"),
            name: name.to_string(),
            kind,
            description: None,
            value: value.map(|v| v.to_string()),
            created_at: "2026-06-02T10:00:00Z".to_string(),
            updated_at: None,
        }
    }

    #[test]
    fn resolve_var_lee_del_catalogo() {
        let catalog = vec![meta(CredentialKind::Var, "dominio", Some("CORP"))];
        assert_eq!(resolve_var(&catalog, "dominio"), Some("CORP".to_string()));
        // No existe → None (queda literal en el motor).
        assert_eq!(resolve_var(&catalog, "otro"), None);
        // Un secret con el mismo nombre no debe resolverse como var.
        let mixed = vec![meta(CredentialKind::Secret, "token", None)];
        assert_eq!(resolve_var(&mixed, "token"), None);
    }

    #[test]
    fn nombre_a_id_distingue_por_kind() {
        // Mismo nombre en kinds distintos son entradas independientes.
        let catalog = vec![
            meta(CredentialKind::Var, "comun", Some("texto")),
            meta(CredentialKind::Secret, "comun", None),
        ];
        let var = find_by_name(&catalog, CredentialKind::Var, "comun").unwrap();
        let secret = find_by_name(&catalog, CredentialKind::Secret, "comun").unwrap();
        assert_eq!(var.id, "id-comun");
        assert_eq!(secret.id, "id-comun");
        assert_eq!(var.kind, CredentialKind::Var);
        assert_eq!(secret.kind, CredentialKind::Secret);
    }

    #[test]
    fn nombres_invalidos() {
        assert!(is_valid_name("dominio"));
        assert!(is_valid_name("mi-var.sub_1"));
        assert!(is_valid_name("_oculto"));
        assert!(!is_valid_name("con espacio"));
        assert!(!is_valid_name("1mal"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("mal!"));
    }

    /// `Resolver` de prueba que NO toca el keyring real: inyecta los valores de
    /// master/secret en un mapa, replicando la lógica nombre→id→valor.
    struct TestResolver {
        base: CredentialResolver,
        secrets: std::collections::HashMap<String, String>,
    }

    impl Resolver for TestResolver {
        fn internal(&self, var: InternalVar) -> Option<String> {
            self.base.internal(var)
        }
        fn env(&self, name: &str) -> Option<String> {
            self.base.env(name)
        }
        fn var(&self, name: &str) -> Option<String> {
            self.base.var(name)
        }
        fn secret(&self, name: &str) -> Option<String> {
            let cred = find_by_name(&self.base.catalog, CredentialKind::Secret, name)?;
            self.secrets.get(&cred.id).cloned()
        }
        fn master(&self, name: &str) -> Option<String> {
            let cred = find_by_name(&self.base.catalog, CredentialKind::Master, name)?;
            self.secrets.get(&cred.id).cloned()
        }
        fn ask(&self, _label: &str, _options: &[String]) -> Option<String> {
            None
        }
    }

    #[test]
    fn motor_resuelve_var_secret_master_sin_keyring_real() {
        let catalog = vec![
            meta(CredentialKind::Var, "dominio", Some("CORP")),
            meta(CredentialKind::Secret, "token", None),
            meta(CredentialKind::Master, "bastion", None),
        ];
        let mut secrets = std::collections::HashMap::new();
        secrets.insert("id-token".to_string(), "s3cr3t".to_string());
        secrets.insert("id-bastion".to_string(), "p4ssw0rd".to_string());

        let resolver = TestResolver {
            base: CredentialResolver::new(ctx(), catalog),
            secrets,
        };

        // var desde catálogo, master/secret desde el mapa inyectado.
        assert_eq!(
            crate::subst::substitute("${var:dominio}", &resolver),
            "CORP"
        );
        assert_eq!(
            crate::subst::substitute("${secret:token}", &resolver),
            "s3cr3t"
        );
        assert_eq!(
            crate::subst::substitute("${master:bastion}", &resolver),
            "p4ssw0rd"
        );
        // Internos + env siguen funcionando junto a las credenciales.
        assert_eq!(
            crate::subst::substitute("${user}@${host} dom=${var:dominio}", &resolver),
            "ada@10.0.0.1 dom=CORP"
        );
        // No existentes → literal.
        assert_eq!(
            crate::subst::substitute("${var:noexiste}", &resolver),
            "${var:noexiste}"
        );
        assert_eq!(
            crate::subst::substitute("${master:noexiste}", &resolver),
            "${master:noexiste}"
        );
    }

    #[test]
    fn collect_asks_extrae_unicos_en_orden() {
        // Reutiliza el parser del motor; deduplica por etiqueta conservando orden.
        let texto = "${ask:Entorno|prod|staging} y ${ask:Token} y ${ask:Entorno|prod|staging}";
        let asks: Vec<AskSpec> = collect_asks(texto)
            .into_iter()
            .fold(Vec::new(), |mut acc, a| {
                if !acc.iter().any(|x: &AskSpec| x.label == a.label) {
                    acc.push(a);
                }
                acc
            });
        assert_eq!(
            asks,
            vec![
                AskSpec {
                    label: "Entorno".into(),
                    options: vec!["prod".into(), "staging".into()],
                },
                AskSpec {
                    label: "Token".into(),
                    options: vec![],
                },
            ]
        );
        // Sin `${ask:}` → lista vacía.
        assert!(collect_asks("solo ${var:x} literal").is_empty());
    }

    #[test]
    fn resolver_usa_ask_answers() {
        let mut answers = std::collections::HashMap::new();
        answers.insert("Entorno".to_string(), "prod".to_string());
        answers.insert("PIN".to_string(), "1234".to_string());

        let resolver = CredentialResolver::with_ask_answers(ctx(), vec![], answers);

        // Respuesta provista → se sustituye.
        assert_eq!(
            crate::subst::substitute("${ask:Entorno|prod|staging}", &resolver),
            "prod"
        );
        assert_eq!(
            crate::subst::substitute("pwd-${ask:PIN}", &resolver),
            "pwd-1234"
        );
        // Sin respuesta para esa etiqueta → queda literal.
        assert_eq!(
            crate::subst::substitute("${ask:NoRespondida}", &resolver),
            "${ask:NoRespondida}"
        );
    }

    #[test]
    fn cred_import_upsert_por_id_y_descarta_valor_secreto() {
        let dir = std::env::temp_dir().join(format!("rustty-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = CredentialStore::new(dir.clone());

        // Var: conserva el value (no es secreto).
        let var = meta(CredentialKind::Var, "dominio", Some("CORP"));
        cred_import(&store, var.clone()).unwrap();
        // Master con value: el value NO debe persistirse en el catálogo.
        let mut master = meta(CredentialKind::Master, "bastion", Some("no-debe-guardarse"));
        cred_import(&store, master.clone()).unwrap();

        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 2);
        let got_var = all.iter().find(|c| c.id == var.id).unwrap();
        assert_eq!(got_var.value.as_deref(), Some("CORP"));
        let got_master = all.iter().find(|c| c.id == master.id).unwrap();
        assert_eq!(got_master.value, None);

        // Upsert por id: reimportar con cambios sustituye, no duplica.
        master.name = "bastion_prod".to_string();
        cred_import(&store, master.clone()).unwrap();
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 2);
        let got_master = all.iter().find(|c| c.id == master.id).unwrap();
        assert_eq!(got_master.name, "bastion_prod");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolver_sin_ask_answers_deja_literal() {
        let resolver = CredentialResolver::new(ctx(), vec![]);
        assert_eq!(
            crate::subst::substitute("${ask:Etiqueta}", &resolver),
            "${ask:Etiqueta}"
        );
    }
}
