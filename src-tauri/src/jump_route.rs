//! Ruta de saltos de una conexión: qué servidores SSH hay entre este equipo y
//! el destino, en orden, y con qué credenciales se entra en cada uno.
//!
//! Un salto puede ser de dos clases:
//!
//! - **De perfil** (`proxy_jump_profile_id`, o uno que la interfaz pone delante
//!   con el salto activo o «Conectar a través de»): un perfil SSH/SFTP guardado,
//!   con **su** host, puerto, usuario, autenticación, secretos y algoritmos
//!   heredados. Puede tener a su vez su propio bastión de perfil: cadenas.
//! - **De texto** (`proxy_jump`, `[user@]host[:port]`): la dirección manual de
//!   siempre, autenticada con las credenciales del perfil que la declara.
//!
//! La interfaz calcula qué perfiles-salto van delante del destino (salto
//! activo, `ignore_active_jump`, «Sin saltos», «Conectar a través de»…) y los
//! manda en `jumps`, en orden. El backend construye con ellos los saltos
//! reales ([`plan_hops`]): delante de cada perfil-salto que tenga bastión de
//! texto y no de perfil mete ese salto de texto, y al final el bastión de texto
//! del destino. Con `jumps: None` (llamadores antiguos, CLI) expande él solo el
//! `proxy_jump_profile_id` del destino. Las mismas reglas que aplica la
//! interfaz, para la CLI, están en [`jump_ids`].
//!
//! Lo puro (planificación, validación de bucles y del tope) se prueba aquí sin
//! red; lo que lee secretos ([`app_route`]) usa los ayudantes de `commands`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::credentials::{self, CredentialStore};
use crate::locks::MutexExt;
use crate::profiles::{AuthType, ConnectionProfile};
use crate::ssh_manager::parse_jump_spec;
use crate::ssh_transport::jump_spec;

/// Tope de saltos de una ruta, contando los de texto. Una cadena más larga es
/// casi seguro un error de configuración, y cada salto suma un handshake.
pub(crate) const MAX_JUMP_HOPS: usize = 8;

// ─── Contrato IPC ─────────────────────────────────────────────────────────────

/// Un salto de la ruta tal como lo manda el frontend, en orden (el primero es
/// el más cercano a este equipo). Los secretos pueden ir a `None` si la
/// conexión al salto ya está viva en el pool (ver `jump_pool_ready`) o si los
/// resuelve el backend (keyring, KeePass, credencial maestra).
#[derive(Clone, Deserialize)]
pub struct JumpRequest {
    pub profile_id: String,
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub ask_answers: Option<HashMap<String, String>>,
}

/// A mano para no volcar secretos en un `{:?}`.
impl std::fmt::Debug for JumpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JumpRequest")
            .field("profile_id", &self.profile_id)
            .field("password", &self.password.as_ref().map(|_| "••••"))
            .field("passphrase", &self.passphrase.as_ref().map(|_| "••••"))
            .finish_non_exhaustive()
    }
}

/// Resultado de «Probar el salto» (`jump_probe`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct JumpProbeReport {
    /// Se llegó al último salto y se autenticó en todos.
    pub ok: bool,
    /// Los saltos reales de la ruta, en orden: «nombre (user@host:port)».
    pub hops: Vec<String>,
    /// El último salto deja abrir túneles (`direct-tcpip`).
    pub forwarding: bool,
    /// Resumen para el usuario.
    pub message: String,
}

// ─── Errores de la ruta ───────────────────────────────────────────────────────

/// Una ruta que no se puede construir. El mensaje (`Display`) es para el
/// usuario; `Missing` se clasifica como `notFound` en la frontera IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RouteError {
    /// Un salto apunta a un perfil que ya no existe. `referenced_by` es el
    /// nombre del perfil que lo usa como bastión, si se sabe.
    Missing {
        id: String,
        referenced_by: Option<String>,
    },
    /// El perfil del salto no es SSH ni SFTP: no puede abrir túneles.
    NotSsh { name: String },
    /// La ruta pasa dos veces por el mismo perfil (o por el propio destino).
    Loop { name: String },
    /// Más saltos que [`MAX_JUMP_HOPS`], contando los de texto.
    TooMany { count: usize },
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RouteError::Missing {
                id,
                referenced_by: Some(name),
            } => write!(
                f,
                "El perfil de salto que usa «{name}» ({id}) ya no existe: elige otro bastión o conecta sin saltos."
            ),
            RouteError::Missing {
                id,
                referenced_by: None,
            } => write!(
                f,
                "El perfil de salto {id} ya no existe: elige otro o conecta sin saltos."
            ),
            RouteError::NotSsh { name } => write!(
                f,
                "«{name}» no puede ser un salto: solo los perfiles SSH o SFTP abren túneles."
            ),
            RouteError::Loop { name } => write!(
                f,
                "La ruta de saltos pasa dos veces por «{name}»: revisa los bastiones de los perfiles."
            ),
            RouteError::TooMany { count } => write!(
                f,
                "La ruta tiene {count} saltos y el máximo es {MAX_JUMP_HOPS}: acórtala."
            ),
        }
    }
}

impl From<RouteError> for crate::ipc_error::IpcError {
    fn from(err: RouteError) -> Self {
        use crate::ipc_error::{IpcError, IpcErrorKind};
        let kind = match err {
            RouteError::Missing { .. } => IpcErrorKind::NotFound,
            _ => IpcErrorKind::Internal,
        };
        IpcError::new(kind, err.to_string())
    }
}

// ─── Reglas puras ─────────────────────────────────────────────────────────────

/// Bastión de perfil del perfil, si tiene uno. Vacío o en blanco = ninguno.
pub(crate) fn profile_jump_id(profile: &ConnectionProfile) -> Option<&str> {
    profile
        .proxy_jump_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Tipo SSH (el vacío es SSH, como en el resto de la app).
fn is_ssh_type(kind: &str) -> bool {
    let kind = kind.trim();
    kind.is_empty() || kind.eq_ignore_ascii_case("ssh")
}

/// ¿Puede este perfil hacer de salto? Solo SSH y SFTP abren `direct-tcpip`.
pub(crate) fn can_be_jump(profile: &ConnectionProfile) -> bool {
    is_ssh_type(&profile.connection_type) || profile.connection_type.eq_ignore_ascii_case("sftp")
}

/// ¿Puede este destino ir por un salto? SSH y SFTP directamente; RDP, VNC y
/// Telnet por un reenvío local. FTP/FTPS/WebDAV no (los datos de FTP pasivo
/// usan otros puertos y HTTPS rompería el nombre del certificado).
pub(crate) fn supports_jump(profile: &ConnectionProfile) -> bool {
    can_be_jump(profile)
        || ["rdp", "vnc", "telnet"]
            .iter()
            .any(|kind| profile.connection_type.eq_ignore_ascii_case(kind))
}

fn find<'a>(profiles: &'a [ConnectionProfile], id: &str) -> Option<&'a ConnectionProfile> {
    profiles.iter().find(|p| p.id == id)
}

/// `chain(P)` de la especificación: los ids de los perfiles-salto que hay
/// **antes** de `start` siguiendo `proxy_jump_profile_id`, del más cercano a
/// este equipo al más cercano a `start`. Valida que cada uno exista y sea SSH o
/// SFTP, y corta los bucles y las cadenas que pasen del tope.
pub(crate) fn chain_of(
    profiles: &[ConnectionProfile],
    start: &ConnectionProfile,
) -> Result<Vec<String>, RouteError> {
    let mut seen: HashSet<&str> = HashSet::from([start.id.as_str()]);
    let mut out: Vec<String> = Vec::new();
    let mut current = start;
    while let Some(next_id) = profile_jump_id(current) {
        let Some(next) = find(profiles, next_id) else {
            return Err(RouteError::Missing {
                id: next_id.to_string(),
                referenced_by: Some(current.name.clone()),
            });
        };
        if !seen.insert(next.id.as_str()) {
            return Err(RouteError::Loop {
                name: next.name.clone(),
            });
        }
        if !can_be_jump(next) {
            return Err(RouteError::NotSsh {
                name: next.name.clone(),
            });
        }
        out.push(next.id.clone());
        if out.len() > MAX_JUMP_HOPS {
            return Err(RouteError::TooMany { count: out.len() });
        }
        current = next;
    }
    out.reverse();
    Ok(out)
}

/// Por dónde quiere salir esta conexión.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RouteChoice<'a> {
    /// Lo de siempre: el salto activo (si hay y aplica) delante de la ruta
    /// propia del perfil.
    Auto { active: Option<&'a str> },
    /// «Sin saltos»: ni salto activo ni bastión propio. Quien llama quita
    /// además el bastión de texto del destino.
    Direct,
    /// «Conectar a través de» este perfil, puntual.
    Via(&'a str),
}

/// Ids de los perfiles-salto de la ruta según las reglas que aplica la
/// interfaz (la CLI las necesita igual): `prefix` del salto activo o del
/// «a través de», más la ruta propia del destino. Sin los bastiones de texto,
/// que mete [`plan_hops`].
pub(crate) fn jump_ids(
    profiles: &[ConnectionProfile],
    target: &ConnectionProfile,
    choice: RouteChoice<'_>,
) -> Result<Vec<String>, RouteError> {
    let jump_profile = |id: &str| -> Result<&ConnectionProfile, RouteError> {
        let profile = find(profiles, id).ok_or_else(|| RouteError::Missing {
            id: id.to_string(),
            referenced_by: None,
        })?;
        if !can_be_jump(profile) {
            return Err(RouteError::NotSsh {
                name: profile.name.clone(),
            });
        }
        Ok(profile)
    };
    let mut prefix: Vec<String> = match choice {
        RouteChoice::Direct => return Ok(Vec::new()),
        RouteChoice::Via(id) => {
            let via = jump_profile(id)?;
            let mut chain = chain_of(profiles, via)?;
            chain.push(via.id.clone());
            chain
        }
        RouteChoice::Auto { active: Some(id) }
            if supports_jump(target) && target.id != id && !target.ignore_active_jump =>
        {
            let active = jump_profile(id)?;
            let mut chain = chain_of(profiles, active)?;
            if chain.contains(&target.id) {
                // El destino es un salto de la cadena del salto activo: va
                // directo a él, no a través de sí mismo.
                Vec::new()
            } else {
                chain.push(active.id.clone());
                chain
            }
        }
        RouteChoice::Auto { .. } => Vec::new(),
    };
    let own = chain_of(profiles, target)?;
    // La ruta propia ya pasa por el salto activo (o lo es): no se duplica.
    if own.iter().any(|id| prefix.contains(id)) {
        prefix.clear();
    }
    let mut ids = prefix;
    ids.extend(own);
    check_unique(profiles, target, &ids)?;
    Ok(ids)
}

/// Un salto ya colocado en la ruta, todavía sin secretos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlannedHop {
    /// Un perfil guardado usado como salto.
    Profile(String),
    /// El bastión de texto (`proxy_jump`) de `owner`, autenticado con sus
    /// credenciales. `owner: None` = el del destino.
    Text { spec: String, owner: Option<String> },
}

/// Sin perfiles repetidos ni el destino dentro de la ruta: las dos cosas son un
/// bucle.
fn check_unique(
    profiles: &[ConnectionProfile],
    target: &ConnectionProfile,
    ids: &[String],
) -> Result<(), RouteError> {
    let mut seen: HashSet<&str> = HashSet::new();
    for id in ids {
        if id == &target.id || !seen.insert(id.as_str()) {
            let name = find(profiles, id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| id.clone());
            return Err(RouteError::Loop { name });
        }
    }
    Ok(())
}

/// Los saltos reales de una lista de perfiles-salto, en orden: delante de cada
/// uno que tenga bastión de texto **y no** de perfil, ese salto de texto. Valida
/// que existan, que sean SSH/SFTP y que ninguno se repita (ni sea `target_id`).
pub(crate) fn plan_jump_hops(
    profiles: &[ConnectionProfile],
    ids: &[String],
    target_id: Option<&str>,
) -> Result<Vec<PlannedHop>, RouteError> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut hops = Vec::new();
    for id in ids {
        let profile = find(profiles, id).ok_or_else(|| RouteError::Missing {
            id: id.clone(),
            referenced_by: None,
        })?;
        if Some(id.as_str()) == target_id || !seen.insert(id.as_str()) {
            return Err(RouteError::Loop {
                name: profile.name.clone(),
            });
        }
        if !can_be_jump(profile) {
            return Err(RouteError::NotSsh {
                name: profile.name.clone(),
            });
        }
        if profile_jump_id(profile).is_none() {
            if let Some(spec) = jump_spec(profile) {
                hops.push(PlannedHop::Text {
                    spec: spec.to_string(),
                    owner: Some(profile.id.clone()),
                });
            }
        }
        hops.push(PlannedHop::Profile(profile.id.clone()));
    }
    if hops.len() > MAX_JUMP_HOPS {
        return Err(RouteError::TooMany { count: hops.len() });
    }
    Ok(hops)
}

/// Los saltos reales hasta `target`. `jumps: Some` = los perfiles-salto que
/// mandó la interfaz (ya con el salto activo y la ruta propia); `None` = la ruta
/// propia del destino (`proxy_jump_profile_id`), sin salto activo. Detrás va el
/// bastión de texto del destino si lo tiene y no tiene uno de perfil.
pub(crate) fn plan_hops(
    profiles: &[ConnectionProfile],
    target: &ConnectionProfile,
    jumps: Option<&[String]>,
) -> Result<Vec<PlannedHop>, RouteError> {
    let ids = match jumps {
        Some(ids) => ids.to_vec(),
        None => chain_of(profiles, target)?,
    };
    let mut hops = plan_jump_hops(profiles, &ids, Some(&target.id))?;
    if profile_jump_id(target).is_none() {
        if let Some(spec) = jump_spec(target) {
            hops.push(PlannedHop::Text {
                spec: spec.to_string(),
                owner: None,
            });
        }
    }
    if hops.len() > MAX_JUMP_HOPS {
        return Err(RouteError::TooMany { count: hops.len() });
    }
    Ok(hops)
}

// ─── Saltos resueltos ─────────────────────────────────────────────────────────

/// Secretos con los que se entra en un salto. `unavailable` guarda por qué no
/// se pudieron resolver: solo es un error si hay que **construir** el salto (si
/// la conexión está viva en el pool no se necesitan).
#[derive(Clone, Default)]
pub(crate) struct HopSecrets {
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub unavailable: Option<String>,
}

/// Secretos con los que se construyó de verdad la conexión con un salto, para
/// volver a construirla sin pedirlos (ver [`ResolvedHop::learned`]). Se borran
/// de memoria al soltarse.
#[derive(Clone, Default)]
pub(crate) struct StoredSecrets {
    pub password: Option<Zeroizing<String>>,
    pub passphrase: Option<Zeroizing<String>>,
}

impl StoredSecrets {
    fn is_empty(&self) -> bool {
        self.password.is_none() && self.passphrase.is_none()
    }
}

/// Un salto listo para conectar: dirección, identidad y algoritmos.
#[derive(Clone)]
pub(crate) struct ResolvedHop {
    /// Id del perfil del salto; `None` en un salto de texto.
    pub profile_id: Option<String>,
    /// Nombre para el registro y los errores: el del perfil o la dirección de
    /// texto tal cual.
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub key_path: Option<String>,
    pub secrets: HopSecrets,
    pub allow_legacy_algorithms: bool,
    pub legacy_algorithms: Option<Vec<String>>,
    /// Secretos aprendidos del pool. La interfaz no manda la contraseña de un
    /// salto cuya conexión ya está viva (`jump_pool_ready`); si esa conexión
    /// muere después, la reconexión de la sesión necesita con qué volver a
    /// entrar. Al reutilizar una conexión del pool, sus secretos se copian aquí
    /// y, como la ruta viaja en la sesión (sus copias comparten esta celda),
    /// sirven a todas sus reconexiones y mueren con ella.
    pub learned: Arc<Mutex<Option<StoredSecrets>>>,
}

/// A mano para no volcar secretos en un `{:?}`.
impl std::fmt::Debug for ResolvedHop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedHop")
            .field("profile_id", &self.profile_id)
            .field("name", &self.name)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

/// Identidad de un salto en el pool: con el mismo perfil, servidor y usuario,
/// dos conexiones comparten la del salto.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct HopKey {
    /// Id del perfil; vacío en un salto de texto.
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

impl ResolvedHop {
    /// Salto de perfil: todo sale del propio perfil (ya con sus `${var:}`
    /// resueltos).
    pub(crate) fn from_profile(profile: &ConnectionProfile, secrets: HopSecrets) -> Self {
        ResolvedHop {
            profile_id: Some(profile.id.clone()),
            name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            auth_type: profile.auth_type.clone(),
            key_path: profile.key_path.clone(),
            secrets,
            allow_legacy_algorithms: profile.allow_legacy_algorithms,
            legacy_algorithms: profile.legacy_algorithms.clone(),
            learned: Arc::default(),
        }
    }

    /// Salto de texto `[user@]host[:port]` de `owner`: sin usuario en el texto,
    /// el de `owner`; la autenticación, los secretos y los algoritmos también
    /// son los suyos, como hasta ahora con el bastión del destino.
    pub(crate) fn text(spec: &str, owner: &ConnectionProfile, secrets: HopSecrets) -> Self {
        let (username, host, port) = parse_jump_spec(spec, &owner.username);
        ResolvedHop {
            profile_id: None,
            name: spec.trim().to_string(),
            host,
            port,
            username,
            auth_type: owner.auth_type.clone(),
            key_path: owner.key_path.clone(),
            secrets,
            allow_legacy_algorithms: owner.allow_legacy_algorithms,
            legacy_algorithms: owner.legacy_algorithms.clone(),
            learned: Arc::default(),
        }
    }

    /// ¿Trae la ruta secretos propios (de la interfaz o de lo guardado)?
    fn has_own_secrets(&self) -> bool {
        self.secrets.password.is_some() || self.secrets.passphrase.is_some()
    }

    /// El salto con los secretos con los que construirlo: los propios si los
    /// trae; si no, los aprendidos del pool por esta ruta y, en su defecto,
    /// `saved` (los de la entrada del pool, si la conexión murió hace poco).
    pub(crate) fn with_fallback(&self, saved: Option<&StoredSecrets>) -> ResolvedHop {
        if self.has_own_secrets() {
            return self.clone();
        }
        let learned = self.learned.lock_recover().clone();
        let Some(found) = learned.or_else(|| saved.cloned()).filter(|s| !s.is_empty()) else {
            return self.clone();
        };
        let mut hop = self.clone();
        hop.secrets.password = found.password.as_ref().map(|p| p.to_string());
        hop.secrets.passphrase = found.passphrase.as_ref().map(|p| p.to_string());
        if hop.secrets.password.is_some() {
            hop.secrets.unavailable = None;
        }
        hop
    }

    /// Los secretos de este salto, para guardarlos con su conexión.
    pub(crate) fn stored_secrets(&self) -> StoredSecrets {
        StoredSecrets {
            password: self.secrets.password.clone().map(Zeroizing::new),
            passphrase: self.secrets.passphrase.clone().map(Zeroizing::new),
        }
    }

    /// Aprende los secretos de la conexión del pool que se ha reutilizado, si
    /// la ruta no traía los suyos.
    pub(crate) fn learn(&self, saved: &StoredSecrets) {
        if self.has_own_secrets() || saved.is_empty() {
            return;
        }
        *self.learned.lock_recover() = Some(saved.clone());
    }

    /// `host:puerto` para conectar y para el registro.
    pub(crate) fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// «nombre (user@host:port)», para el informe de la prueba del salto.
    pub(crate) fn display(&self) -> String {
        format!(
            "{} ({}@{}:{})",
            self.name, self.username, self.host, self.port
        )
    }

    pub(crate) fn key(&self) -> HopKey {
        HopKey {
            profile_id: self.profile_id.clone().unwrap_or_default(),
            host: self.host.to_ascii_lowercase(),
            port: self.port,
            user: self.username.clone(),
        }
    }
}

/// Saltos reales de una conexión, en orden. Vacía = directa.
#[derive(Clone, Debug, Default)]
pub(crate) struct JumpRoute {
    pub hops: Vec<ResolvedHop>,
}

impl JumpRoute {
    pub(crate) fn is_empty(&self) -> bool {
        self.hops.is_empty()
    }

    pub(crate) fn len(&self) -> usize {
        self.hops.len()
    }

    /// Clave del pool de los `upto` primeros saltos.
    pub(crate) fn key(&self, upto: usize) -> Vec<HopKey> {
        self.hops.iter().take(upto).map(ResolvedHop::key).collect()
    }

    /// «A → B», para el registro y los avisos.
    pub(crate) fn describe(&self) -> String {
        self.hops
            .iter()
            .map(|h| h.name.as_str())
            .collect::<Vec<_>>()
            .join(" → ")
    }

    /// Los secretos de los saltos, para redactar los mensajes de error como los
    /// del destino.
    pub(crate) fn secret_values(&self) -> Vec<Zeroizing<String>> {
        self.hops
            .iter()
            .flat_map(|h| {
                let learned = h.learned.lock_recover().clone().unwrap_or_default();
                [
                    h.secrets.password.clone(),
                    h.secrets.passphrase.clone(),
                    learned.password.map(|p| p.to_string()),
                    learned.passphrase.map(|p| p.to_string()),
                ]
            })
            .flatten()
            .filter(|s| !s.is_empty())
            .map(Zeroizing::new)
            .collect()
    }
}

/// Convierte los saltos planificados en saltos listos. `prepare` deja un perfil
/// listo para conectar (sus `${var:}` resueltos); `secrets_for` le busca los
/// secretos. Cada perfil se prepara y se resuelve **una** vez aunque aparezca
/// dos (su salto de texto y él mismo). Un salto de texto del destino usa
/// `target`: el perfil (ya preparado por quien llama) y sus secretos; sin
/// destino (la prueba del salto) no hay salto de texto suyo que resolver.
pub(crate) fn resolve_route(
    planned: &[PlannedHop],
    profiles: &[ConnectionProfile],
    target: Option<(&ConnectionProfile, &HopSecrets)>,
    prepare: &mut dyn FnMut(&ConnectionProfile) -> ConnectionProfile,
    secrets_for: &mut dyn FnMut(&ConnectionProfile) -> HopSecrets,
) -> JumpRoute {
    let mut cache: HashMap<String, (ConnectionProfile, HopSecrets)> = HashMap::new();
    let mut ready = |id: &str| -> Option<(ConnectionProfile, HopSecrets)> {
        if let Some(hit) = cache.get(id) {
            return Some(hit.clone());
        }
        let profile = prepare(find(profiles, id)?);
        let secrets = secrets_for(&profile);
        cache.insert(id.to_string(), (profile.clone(), secrets.clone()));
        Some((profile, secrets))
    };
    let mut hops = Vec::new();
    for hop in planned {
        match hop {
            PlannedHop::Profile(id) => {
                if let Some((profile, secrets)) = ready(id) {
                    hops.push(ResolvedHop::from_profile(&profile, secrets));
                }
            }
            PlannedHop::Text {
                spec,
                owner: Some(id),
            } => {
                if let Some((profile, secrets)) = ready(id) {
                    // El texto ya preparado (con sus `${var:}`), si lo tiene.
                    let spec = jump_spec(&profile).unwrap_or(spec).to_string();
                    hops.push(ResolvedHop::text(&spec, &profile, secrets));
                }
            }
            PlannedHop::Text { spec, owner: None } => {
                if let Some((target, target_secrets)) = target {
                    let spec = jump_spec(target).unwrap_or(spec).to_string();
                    hops.push(ResolvedHop::text(&spec, target, target_secrets.clone()));
                }
            }
        }
    }
    JumpRoute { hops }
}

/// Ruta de `target` con un catálogo de perfiles a mano: `prepare` deja cada
/// perfil-salto listo para conectar y `secrets_for` le da sus secretos. La usan
/// la CLI (que los pregunta por la terminal) y los tests; la app pasa por
/// [`app_route`].
pub(crate) fn route_with(
    profiles: &[ConnectionProfile],
    target: &ConnectionProfile,
    target_secrets: HopSecrets,
    jumps: Option<&[String]>,
    prepare: &mut dyn FnMut(&ConnectionProfile) -> ConnectionProfile,
    secrets_for: &mut dyn FnMut(&ConnectionProfile) -> HopSecrets,
) -> Result<JumpRoute, RouteError> {
    let planned = plan_hops(profiles, target, jumps)?;
    Ok(resolve_route(
        &planned,
        profiles,
        Some((target, &target_secrets)),
        prepare,
        secrets_for,
    ))
}

// ─── Resolución en la app ─────────────────────────────────────────────────────

/// Secretos de un perfil-salto en la app: los que mandó la interfaz (pasados
/// por el motor de sustitución, como los del destino) o, si no mandó, los
/// guardados (keyring, KeePass, credencial maestra). Un fallo no corta la ruta:
/// queda en `unavailable` por si hay que construir el salto.
fn app_hop_secrets(
    profile: &ConnectionProfile,
    request: Option<&JumpRequest>,
    store: &CredentialStore,
) -> HopSecrets {
    let answers = request
        .and_then(|r| r.ask_answers.clone())
        .unwrap_or_default();
    // Solo lo que el método de autenticación del salto va a usar: un salto por
    // clave no necesita su contraseña, ni uno por contraseña su passphrase (ni
    // el agente o `keyboard-interactive`, ninguna). Leer del keyring lo que no
    // se usa es una consulta (y quizá un desbloqueo) para nada.
    let password = match profile.auth_type {
        AuthType::Password => match request.and_then(|r| r.password.clone()) {
            Some(given) => crate::commands::resolve_profile_password(
                profile,
                store,
                Some(given),
                Some(answers),
            ),
            None => crate::commands::resolve_stored_password(profile, store, &answers),
        },
        AuthType::PublicKey | AuthType::Agent | AuthType::KeyboardInteractive => Ok(None),
    };
    let passphrase = match profile.auth_type {
        AuthType::PublicKey => request
            .and_then(|r| r.passphrase.clone())
            .or_else(|| crate::commands::stored_passphrase(profile)),
        AuthType::Password | AuthType::Agent | AuthType::KeyboardInteractive => None,
    };
    match password {
        Ok(password) => HopSecrets {
            password,
            passphrase,
            unavailable: None,
        },
        Err(err) => HopSecrets {
            password: None,
            passphrase,
            unavailable: Some(err),
        },
    }
}

/// Ruta de una conexión de la app: planifica con `jumps` (o la ruta propia del
/// destino) y resuelve los secretos de cada salto. `target` llega ya preparado
/// (identidad, overrides y `${var:}` aplicados) y `target_secrets` son los
/// suyos, que valen para su bastión de texto.
pub(crate) fn app_route(
    profiles: &[ConnectionProfile],
    target: &ConnectionProfile,
    target_secrets: HopSecrets,
    jumps: Option<&[JumpRequest]>,
    store: &CredentialStore,
) -> Result<JumpRoute, RouteError> {
    let ids: Option<Vec<String>> =
        jumps.map(|list| list.iter().map(|j| j.profile_id.clone()).collect());
    let planned = plan_hops(profiles, target, ids.as_deref())?;
    Ok(resolve_planned_for_app(
        &planned,
        profiles,
        Some((target, &target_secrets)),
        jumps.unwrap_or_default(),
        store,
    ))
}

/// Como [`app_route`], para una lista de saltos sin destino (la prueba del
/// salto y la consulta del pool).
pub(crate) fn app_jump_route(
    profiles: &[ConnectionProfile],
    jumps: &[JumpRequest],
    store: &CredentialStore,
) -> Result<JumpRoute, RouteError> {
    let ids: Vec<String> = jumps.iter().map(|j| j.profile_id.clone()).collect();
    let planned = plan_jump_hops(profiles, &ids, None)?;
    Ok(resolve_planned_for_app(
        &planned, profiles, None, jumps, store,
    ))
}

fn resolve_planned_for_app(
    planned: &[PlannedHop],
    profiles: &[ConnectionProfile],
    target: Option<(&ConnectionProfile, &HopSecrets)>,
    jumps: &[JumpRequest],
    store: &CredentialStore,
) -> JumpRoute {
    let requests: HashMap<&str, &JumpRequest> =
        jumps.iter().map(|j| (j.profile_id.as_str(), j)).collect();
    resolve_route(
        planned,
        profiles,
        target,
        &mut |profile| {
            let mut ready = profile.clone();
            credentials::substitute_connection_fields(&mut ready, store);
            ready
        },
        &mut |profile| app_hop_secrets(profile, requests.get(profile.id.as_str()).copied(), store),
    )
}

/// Claves del pool de una lista de perfiles-salto, con sus saltos de texto
/// (para `jump_pool_ready`). Sin secretos: solo hacen falta las direcciones.
pub(crate) fn pool_key_for(
    profiles: &[ConnectionProfile],
    ids: &[String],
    store: &CredentialStore,
) -> Result<Vec<HopKey>, RouteError> {
    let planned = plan_jump_hops(profiles, ids, None)?;
    let route = resolve_route(
        &planned,
        profiles,
        None,
        &mut |profile| {
            let mut ready = profile.clone();
            credentials::substitute_connection_fields(&mut ready, store);
            ready
        },
        &mut |_| HopSecrets::default(),
    );
    Ok(route.key(route.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, kind: &str) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": format!("n-{id}"),
            "host": format!("{id}.lan"),
            "port": 22,
            "username": format!("u-{id}"),
            "connection_type": kind,
            "domain": null,
            "auth_type": "password",
            "key_path": null,
            "group": null,
            "created_at": "2026-10-25T00:00:00Z"
        }))
        .expect("perfil de prueba")
    }

    fn with_jump(mut p: ConnectionProfile, via: &str) -> ConnectionProfile {
        p.proxy_jump_profile_id = Some(via.to_string());
        p
    }

    fn with_text(mut p: ConnectionProfile, spec: &str) -> ConnectionProfile {
        p.proxy_jump = Some(spec.to_string());
        p
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn la_cadena_sigue_los_bastiones_de_perfil_hasta_el_primero() {
        // t → b → a: chain(t) = [a, b] (de este equipo hacia el destino).
        let profiles = vec![
            profile("a", "ssh"),
            with_jump(profile("b", "ssh"), "a"),
            with_jump(profile("t", "ssh"), "b"),
        ];
        assert_eq!(chain_of(&profiles, &profiles[2]).unwrap(), ids(&["a", "b"]));
        assert_eq!(
            chain_of(&profiles, &profiles[0]).unwrap(),
            Vec::<String>::new()
        );
        // Vacío o en blanco = sin bastión de perfil.
        let mut blank = profile("x", "ssh");
        blank.proxy_jump_profile_id = Some("  ".into());
        assert_eq!(chain_of(&profiles, &blank).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn un_bucle_de_bastiones_se_detecta() {
        let profiles = vec![
            with_jump(profile("a", "ssh"), "b"),
            with_jump(profile("b", "ssh"), "a"),
            with_jump(profile("t", "ssh"), "a"),
        ];
        assert!(matches!(
            chain_of(&profiles, &profiles[2]),
            Err(RouteError::Loop { .. })
        ));
        // Un perfil que se usa a sí mismo de bastión también es un bucle.
        let me = vec![with_jump(profile("m", "ssh"), "m")];
        assert!(matches!(
            chain_of(&me, &me[0]),
            Err(RouteError::Loop { .. })
        ));
    }

    #[test]
    fn un_bastion_que_no_existe_o_no_es_ssh_se_rechaza_con_nombre() {
        let profiles = vec![
            with_jump(profile("t", "ssh"), "fantasma"),
            profile("win", "rdp"),
            with_jump(profile("t2", "ssh"), "win"),
        ];
        match chain_of(&profiles, &profiles[0]) {
            Err(RouteError::Missing { id, referenced_by }) => {
                assert_eq!(id, "fantasma");
                assert_eq!(referenced_by.as_deref(), Some("n-t"));
            }
            other => panic!("se esperaba Missing, salió {other:?}"),
        }
        assert_eq!(
            chain_of(&profiles, &profiles[2]),
            Err(RouteError::NotSsh {
                name: "n-win".into()
            })
        );
        // Un perfil SFTP sí sirve de salto.
        let sftp = vec![profile("s", "sftp"), with_jump(profile("t", "ssh"), "s")];
        assert_eq!(chain_of(&sftp, &sftp[1]).unwrap(), ids(&["s"]));
    }

    #[test]
    fn la_ruta_no_pasa_del_tope_de_saltos() {
        // Cadena de nueve perfiles: uno más que el tope.
        let mut profiles = vec![profile("h0", "ssh")];
        for i in 1..=MAX_JUMP_HOPS {
            profiles.push(with_jump(
                profile(&format!("h{i}"), "ssh"),
                &format!("h{}", i - 1),
            ));
        }
        let target = with_jump(profile("t", "ssh"), &format!("h{MAX_JUMP_HOPS}"));
        profiles.push(target.clone());
        assert!(matches!(
            chain_of(&profiles, &target),
            Err(RouteError::TooMany { .. })
        ));
        // Ocho de perfil justos caben; con un bastión de texto del destino, no.
        let eight: Vec<String> = (0..MAX_JUMP_HOPS).map(|i| format!("h{i}")).collect();
        let free = profile("libre", "ssh");
        let mut plain = profiles.clone();
        // h0 sin bastión y los demás encadenados: la lista explícita no mira
        // `proxy_jump_profile_id`, así que vale tal cual.
        plain.push(free.clone());
        assert_eq!(
            plan_hops(&plain, &free, Some(&eight)).unwrap().len(),
            MAX_JUMP_HOPS
        );
        let texted = with_text(free, "ops@bastion:2222");
        assert!(matches!(
            plan_hops(&plain, &texted, Some(&eight)),
            Err(RouteError::TooMany { count }) if count == MAX_JUMP_HOPS + 1
        ));
    }

    #[test]
    fn los_saltos_de_texto_se_insertan_delante_de_su_perfil_y_al_final_el_del_destino() {
        // a tiene bastión de texto (y no de perfil): va delante de a, con las
        // credenciales de a. b tiene los dos: manda el de perfil y su texto no
        // entra. El destino tiene texto: va al final.
        let profiles = vec![
            with_text(profile("a", "ssh"), "ops@gw.a:2200"),
            with_text(with_jump(profile("b", "ssh"), "a"), "ignorado@x"),
            with_text(profile("t", "ssh"), "jump.t"),
        ];
        let hops = plan_hops(&profiles, &profiles[2], Some(&ids(&["a", "b"]))).unwrap();
        assert_eq!(
            hops,
            vec![
                PlannedHop::Text {
                    spec: "ops@gw.a:2200".into(),
                    owner: Some("a".into())
                },
                PlannedHop::Profile("a".into()),
                PlannedHop::Profile("b".into()),
                PlannedHop::Text {
                    spec: "jump.t".into(),
                    owner: None
                },
            ]
        );
        // Si el destino tiene bastión de perfil, su texto no entra.
        let mut t = profiles[2].clone();
        t.proxy_jump_profile_id = Some("b".into());
        let hops = plan_hops(&profiles, &t, Some(&ids(&["a", "b"]))).unwrap();
        assert_eq!(hops.last(), Some(&PlannedHop::Profile("b".into())));
    }

    #[test]
    fn sin_lista_se_expande_la_ruta_propia_del_destino() {
        let profiles = vec![profile("a", "ssh"), with_jump(profile("b", "ssh"), "a")];
        let target = with_jump(profile("t", "ssh"), "b");
        let hops = plan_hops(&profiles, &target, None).unwrap();
        assert_eq!(
            hops,
            vec![
                PlannedHop::Profile("a".into()),
                PlannedHop::Profile("b".into())
            ]
        );
        // Una lista vacía es «sin saltos de perfil»: el texto del destino sigue.
        let texted = with_text(profile("t", "ssh"), "x@y");
        assert_eq!(
            plan_hops(&profiles, &texted, Some(&[])).unwrap(),
            vec![PlannedHop::Text {
                spec: "x@y".into(),
                owner: None
            }]
        );
    }

    #[test]
    fn la_lista_no_admite_repetidos_ni_el_propio_destino() {
        let profiles = vec![profile("a", "ssh"), profile("t", "ssh")];
        assert!(matches!(
            plan_hops(&profiles, &profiles[1], Some(&ids(&["a", "a"]))),
            Err(RouteError::Loop { .. })
        ));
        assert!(matches!(
            plan_hops(&profiles, &profiles[1], Some(&ids(&["t"]))),
            Err(RouteError::Loop { .. })
        ));
        assert!(matches!(
            plan_hops(&profiles, &profiles[1], Some(&ids(&["nadie"]))),
            Err(RouteError::Missing { .. })
        ));
    }

    #[test]
    fn el_salto_activo_va_delante_salvo_las_excepciones() {
        let profiles = vec![
            profile("a", "ssh"),
            with_jump(profile("b", "ssh"), "a"),
            profile("t", "ssh"),
            profile("ftp", "ftp"),
        ];
        let auto = |active| RouteChoice::Auto { active };
        // Con salto activo b (cuya cadena es a): [a, b] delante del destino.
        assert_eq!(
            jump_ids(&profiles, &profiles[2], auto(Some("b"))).unwrap(),
            ids(&["a", "b"])
        );
        // El propio salto activo y los de su cadena van directos.
        assert_eq!(
            jump_ids(&profiles, &profiles[1], auto(Some("b"))).unwrap(),
            ids(&["a"])
        );
        assert!(jump_ids(&profiles, &profiles[0], auto(Some("b")))
            .unwrap()
            .is_empty());
        // Un perfil que lo ignora, o un tipo que no admite salto, tampoco.
        let mut ignorer = profiles[2].clone();
        ignorer.ignore_active_jump = true;
        assert!(jump_ids(&profiles, &ignorer, auto(Some("b")))
            .unwrap()
            .is_empty());
        assert!(jump_ids(&profiles, &profiles[3], auto(Some("b")))
            .unwrap()
            .is_empty());
        // Sin salto activo, nada.
        assert!(jump_ids(&profiles, &profiles[2], auto(None))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn la_ruta_propia_que_ya_pasa_por_el_salto_activo_no_lo_duplica() {
        let profiles = vec![
            profile("a", "ssh"),
            profile("c", "ssh"),
            with_jump(profile("t", "ssh"), "a"),
            with_jump(profile("t2", "ssh"), "c"),
        ];
        let auto = RouteChoice::Auto { active: Some("a") };
        // El bastión propio de t ES el salto activo: solo la ruta propia.
        assert_eq!(
            jump_ids(&profiles, &profiles[2], auto).unwrap(),
            ids(&["a"])
        );
        // Bastión propio distinto: el salto activo va delante.
        assert_eq!(
            jump_ids(&profiles, &profiles[3], auto).unwrap(),
            ids(&["a", "c"])
        );
    }

    #[test]
    fn sin_saltos_y_a_traves_de_son_puntuales() {
        let free = profile("libre", "ssh");
        let profiles = vec![
            profile("a", "ssh"),
            with_jump(profile("v", "ssh"), "a"),
            with_jump(profile("t", "ssh"), "a"),
            free.clone(),
        ];
        assert!(jump_ids(&profiles, &profiles[2], RouteChoice::Direct)
            .unwrap()
            .is_empty());
        // «A través de v»: su cadena y v delante del destino.
        assert_eq!(
            jump_ids(&profiles, &free, RouteChoice::Via("v")).unwrap(),
            ids(&["a", "v"])
        );
        // Si la ruta propia del destino ya pasa por la cadena de v (aquí, por
        // a), manda la ruta propia, como con el salto activo.
        assert_eq!(
            jump_ids(&profiles, &profiles[2], RouteChoice::Via("v")).unwrap(),
            ids(&["a"])
        );
        // A través de sí mismo: bucle.
        assert!(matches!(
            jump_ids(&profiles, &free, RouteChoice::Via("libre")),
            Err(RouteError::Loop { .. })
        ));
        // Un salto activo que ya no existe es un error, no una conexión directa
        // a escondidas.
        assert!(matches!(
            jump_ids(
                &profiles,
                &free,
                RouteChoice::Auto {
                    active: Some("borrado")
                }
            ),
            Err(RouteError::Missing { .. })
        ));
    }

    #[test]
    fn un_salto_solo_resuelve_los_secretos_de_su_metodo() {
        // Agente o `keyboard-interactive`: nada que leer, ni siquiera con una
        // contraseña en la petición (no se usaría).
        let dir = std::env::temp_dir().join(format!("rustty-hop-secrets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = CredentialStore::new(dir.clone());
        let request = JumpRequest {
            profile_id: "a".into(),
            password: Some("pw".into()),
            passphrase: Some("pp".into()),
            ask_answers: None,
        };
        for auth in [AuthType::Agent, AuthType::KeyboardInteractive] {
            let mut p = profile("a", "ssh");
            p.auth_type = auth.clone();
            let found = app_hop_secrets(&p, Some(&request), &store);
            assert!(
                found.password.is_none() && found.passphrase.is_none(),
                "{auth:?}"
            );
            assert!(found.unavailable.is_none(), "{auth:?}");
        }
        // Por clave: la passphrase de la petición, no la contraseña.
        let mut by_key = profile("a", "ssh");
        by_key.auth_type = AuthType::PublicKey;
        let found = app_hop_secrets(&by_key, Some(&request), &store);
        assert_eq!(found.password, None);
        assert_eq!(found.passphrase.as_deref(), Some("pp"));
        // Por contraseña: la de la petición, y ninguna passphrase.
        let found = app_hop_secrets(&profile("a", "ssh"), Some(&request), &store);
        assert_eq!(found.password.as_deref(), Some("pw"));
        assert_eq!(found.passphrase, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_resolucion_usa_las_credenciales_de_cada_dueno() {
        let mut a = with_text(profile("a", "ssh"), "gw.a");
        a.auth_type = AuthType::PublicKey;
        a.key_path = Some("/k/a".into());
        a.allow_legacy_algorithms = true;
        let target = with_text(profile("t", "ssh"), "ops@jump.t:2222");
        let profiles = vec![a.clone(), target.clone()];
        let planned = plan_hops(&profiles, &target, Some(&ids(&["a"]))).unwrap();
        let mut prepared = 0;
        let target_secrets = HopSecrets {
            password: Some("pw-t".into()),
            ..Default::default()
        };
        let route = resolve_route(
            &planned,
            &profiles,
            Some((&target, &target_secrets)),
            &mut |p| {
                prepared += 1;
                p.clone()
            },
            &mut |p| HopSecrets {
                password: Some(format!("pw-{}", p.id)),
                ..Default::default()
            },
        );
        // a se prepara una vez aunque aparezca dos (su texto y él).
        assert_eq!(prepared, 1);
        assert_eq!(route.len(), 3);
        // Texto de a: usuario de a, clave de a, algoritmos de a.
        let gw = &route.hops[0];
        assert_eq!(gw.profile_id, None);
        assert_eq!(
            (gw.host.as_str(), gw.port, gw.username.as_str()),
            ("gw.a", 22, "u-a")
        );
        assert_eq!(gw.auth_type, AuthType::PublicKey);
        assert_eq!(gw.key_path.as_deref(), Some("/k/a"));
        assert!(gw.allow_legacy_algorithms);
        assert_eq!(gw.secrets.password.as_deref(), Some("pw-a"));
        // El perfil a.
        assert_eq!(route.hops[1].profile_id.as_deref(), Some("a"));
        assert_eq!(route.hops[1].host, "a.lan");
        // Texto del destino: su usuario explícito y los secretos del destino.
        let jt = &route.hops[2];
        assert_eq!(
            (jt.host.as_str(), jt.port, jt.username.as_str()),
            ("jump.t", 2222, "ops")
        );
        assert_eq!(jt.secrets.password.as_deref(), Some("pw-t"));
        assert_eq!(route.describe(), "gw.a → n-a → ops@jump.t:2222");
        // Las claves del pool distinguen salto de texto y de perfil.
        let keys = route.key(2);
        assert_eq!(keys[0].profile_id, "");
        assert_eq!(keys[1].profile_id, "a");
        // Los secretos se pueden redactar.
        assert_eq!(route.secret_values().len(), 3);
        // Y el Debug no los saca.
        assert!(!format!("{:?}", route).contains("pw-"));
    }
}
