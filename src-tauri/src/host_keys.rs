use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use russh::client;
use russh::keys::{known_hosts, ssh_key::PublicKey, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::ipc::{event_name, EventKind, HOST_KEY_PROMPT};
use crate::locks::MutexExt;

// ── Política de primera conexión (TOFU estricto) ─────────────────────────────
//
// Hasta v1.54.0 la primera host key de un servidor se aprendía **en silencio**:
// un man-in-the-middle en esa primera conexión pasaba inadvertido (el aviso solo
// salta cuando la clave *cambia*). Ahora, por defecto, se pide confirmar la huella
// antes de guardarla; el TOFU automático queda como opción explícita.
//
// La política es **global** (una preferencia del usuario), no por perfil: por eso
// vive aquí y no en la firma de `client()`, que construyen catorce llamadores
// distintos (SSH, SFTP, scripts, CLI y cada salto ProxyJump).

/// `true` = preguntar antes de aprender una clave nueva (default).
static STRICT_FIRST_CONNECT: AtomicBool = AtomicBool::new(true);

/// `true` (default) = ante una host key **cambiada**, preguntar al usuario:
/// aceptar reemplaza la(s) entrada(s) de known_hosts de forma atómica y la
/// conexión continúa; rechazar (o agotar el plazo) no toca nada. `false` =
/// comportamiento clásico: rechazar siempre con instrucciones manuales.
static PROMPT_ON_KEY_CHANGE: AtomicBool = AtomicBool::new(true);

/// Handle de la app para emitir el evento de confirmación. Ausente en la CLI,
/// que cae al prompt por stdin.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Confirmaciones en vuelo: `promptId` → canal por el que llega la respuesta.
static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Serializa las escrituras de known_hosts de este proceso. El reemplazo de una
/// clave cambiada reescribe el fichero entero (temporal + `rename`): sin este
/// candado, un aprendizaje TOFU que añadiera una línea a la vez desde otra
/// sesión se perdería con el `rename`, y dos reemplazos se pisarían.
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

/// Plazo para que el usuario conteste. Agotado, la conexión se rechaza: preferimos
/// no conectar a aprender una clave que nadie miró.
const HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Fija la política de primera conexión (la llama el frontend al cargar/guardar
/// preferencias).
pub fn set_strict_first_connect(strict: bool) {
    STRICT_FIRST_CONNECT.store(strict, Ordering::Relaxed);
}

#[must_use]
pub fn strict_first_connect() -> bool {
    STRICT_FIRST_CONNECT.load(Ordering::Relaxed)
}

/// Fija la política ante una host key cambiada (la llama el frontend al
/// cargar/guardar preferencias).
pub fn set_prompt_on_key_change(prompt: bool) {
    PROMPT_ON_KEY_CHANGE.store(prompt, Ordering::Relaxed);
}

#[must_use]
pub fn prompt_on_key_change() -> bool {
    PROMPT_ON_KEY_CHANGE.load(Ordering::Relaxed)
}

// ── La política, para quien no tiene la interfaz delante ─────────────────────
//
// Las preferencias viven en el `localStorage` del frontend, que la CLI no puede
// leer: hasta v2.18.0 `rustty -c` corría siempre con la política por defecto
// aunque el usuario hubiera desactivado la confirmación en Preferencias →
// Seguridad (y el mensaje de error le mandaba justo ahí). La interfaz fija la
// política por IPC al cargar y al guardar preferencias; en ese momento se
// vuelca aquí, al directorio de datos, y la CLI la lee antes de conectar. Es
// una caché derivada, como `workspaces.json`: si falta, rige el default.

/// Fichero de la política en el directorio de datos.
pub const POLICY_FILE_NAME: &str = "host-key-policy.json";

/// Las dos políticas de host keys que la interfaz deja guardadas para la CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPolicy {
    pub strict_first_connect: bool,
    pub prompt_on_key_change: bool,
}

impl HostKeyPolicy {
    /// La política en vigor en este proceso.
    #[must_use]
    pub fn current() -> Self {
        Self {
            strict_first_connect: strict_first_connect(),
            prompt_on_key_change: prompt_on_key_change(),
        }
    }

    /// Pone esta política en vigor en el proceso.
    pub fn apply(&self) {
        set_strict_first_connect(self.strict_first_connect);
        set_prompt_on_key_change(self.prompt_on_key_change);
    }
}

/// Vuelca la política en vigor al directorio de datos, solo si cambió (la
/// interfaz la manda en cada guardado de preferencias). Escritura atómica.
pub fn save_policy(data_dir: &Path) -> std::io::Result<bool> {
    write_policy(data_dir, &HostKeyPolicy::current())
}

fn write_policy(data_dir: &Path, policy: &HostKeyPolicy) -> std::io::Result<bool> {
    let path = data_dir.join(POLICY_FILE_NAME);
    let payload = serde_json::to_vec_pretty(policy).map_err(std::io::Error::other)?;
    if std::fs::read(&path).map(|cur| cur == payload).unwrap_or(false) {
        return Ok(false);
    }
    crate::atomic_file::write(&path, &payload, false)?;
    Ok(true)
}

/// Lee la política que dejó guardada la interfaz. `None` si no hay fichero o
/// no se entiende: entonces rige el default (estricto), que es lo seguro.
#[must_use]
pub fn load_policy(data_dir: &Path) -> Option<HostKeyPolicy> {
    let raw = std::fs::read(data_dir.join(POLICY_FILE_NAME)).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Normaliza una huella SHA256 tal como la escribe la gente: `SHA256:xxx`
/// (como la muestra Rustty o `ssh-keygen -lf`), sin el prefijo, con `=` de
/// relleno, o dentro de la línea entera de `ssh-keygen -lf` o de
/// `plink -hostkey` (`ssh-ed25519 255 SHA256:xxx`). Devuelve `SHA256:<43 chars
/// base64>`, el mismo formato que [`fingerprint_sha256`], o `None` si nada
/// parece una huella SHA256. Las MD5 (`aa:bb:…`) no se aceptan: Rustty solo
/// enseña SHA256, así que una MD5 nunca podría compararse con lo que ve el
/// usuario.
#[must_use]
pub fn normalize_fingerprint(input: &str) -> Option<String> {
    input.split_whitespace().rev().find_map(|token| {
        let raw = token
            .strip_prefix("SHA256:")
            .or_else(|| token.strip_prefix("sha256:"))
            .unwrap_or(token)
            .trim_end_matches('=');
        let looks_like_sha256 = raw.len() == 43
            && raw
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/');
        looks_like_sha256.then(|| format!("SHA256:{raw}"))
    })
}

/// Registra el `AppHandle` (en `setup`). Sin él —CLI— se pregunta por stdin.
pub fn register_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Entrada previa de known_hosts mostrada en el diálogo de clave cambiada.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviousHostKey {
    line: usize,
    fingerprint: String,
}

/// Payload de `ssh-hostkey-prompt` (espejo de `HostKeyPromptEvent` en events.js).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyPrompt {
    prompt_id: String,
    host: String,
    port: u16,
    fingerprint: String,
    key_type: String,
    via_jump: bool,
    /// `true` = la clave de un host YA CONOCIDO ha cambiado (posible MITM):
    /// el diálogo debe ser el de peligro, no el de primera conexión.
    changed: bool,
    /// Con `changed`: las entradas registradas que se reemplazarían al aceptar.
    previous: Vec<PreviousHostKey>,
}

/// Entrega la respuesta del usuario a una confirmación en vuelo.
/// Devuelve `false` si el `promptId` ya no existe (timeout o respuesta duplicada).
pub fn resolve_prompt(prompt_id: &str, accept: bool) -> bool {
    let sender = PENDING.lock_recover().remove(prompt_id);
    match sender {
        Some(tx) => tx.send(accept).is_ok(),
        None => false,
    }
}

/// Pide confirmación de una host key. `previous` vacío = primera conexión;
/// con entradas = la clave de un host YA CONOCIDO **ha cambiado** y aceptar
/// implica reemplazarlas. `Ok(true)` = el usuario la acepta.
async fn confirm_host_key(
    host: &str,
    port: u16,
    via_jump: bool,
    key: &PublicKey,
    previous: &[(usize, String)],
) -> Result<bool, String> {
    let fingerprint = fingerprint_sha256(key);
    let key_type = key.algorithm().as_str().to_string();
    let changed = !previous.is_empty();

    let Some(app) = APP.get() else {
        // Sin interfaz (CLI): preguntar por la terminal.
        return confirm_on_stdin(host, port, &fingerprint, &key_type, previous);
    };

    let prompt_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock_recover().insert(prompt_id.clone(), tx);

    let payload = HostKeyPrompt {
        prompt_id: prompt_id.clone(),
        host: host.to_string(),
        port,
        fingerprint,
        key_type,
        via_jump,
        changed,
        previous: previous
            .iter()
            .map(|(line, fingerprint)| PreviousHostKey {
                line: *line,
                fingerprint: fingerprint.clone(),
            })
            .collect(),
    };
    if let Err(err) = app.emit(HOST_KEY_PROMPT, payload) {
        PENDING.lock_recover().remove(&prompt_id);
        return Err(format!("no se pudo pedir confirmación de la host key: {err}"));
    }

    match tokio::time::timeout(HOST_KEY_PROMPT_TIMEOUT, rx).await {
        Ok(Ok(accepted)) => Ok(accepted),
        // El canal se cerró sin respuesta (la ventana se fue, p. ej.).
        Ok(Err(_)) => Ok(false),
        Err(_) => {
            PENDING.lock_recover().remove(&prompt_id);
            Err(format!(
                "nadie confirmó la host key de {host}:{port} en {} s; conexión cancelada",
                HOST_KEY_PROMPT_TIMEOUT.as_secs()
            ))
        }
    }
}

/// Texto de la pregunta de host key de la CLI: primera conexión o, con
/// `previous`, la ALERTA de clave cambiada con las entradas registradas.
fn write_host_key_question(
    out: &mut impl std::io::Write,
    host: &str,
    port: u16,
    fingerprint: &str,
    key_type: &str,
    previous: &[(usize, String)],
) -> std::io::Result<()> {
    if previous.is_empty() {
        writeln!(out, "La autenticidad del host {host}:{port} no se puede establecer.")?;
        writeln!(out, "Huella de la clave {key_type}: {fingerprint}")?;
        write!(out, "¿Confiar en este host y guardar su clave? (sí/no): ")
    } else {
        writeln!(out, "¡ALERTA! La host key de {host}:{port} HA CAMBIADO.")?;
        for (line, prev) in previous {
            writeln!(out, "  registrada (known_hosts línea {line}): {prev}")?;
        }
        writeln!(out, "  recibida ahora ({key_type}): {fingerprint}")?;
        writeln!(
            out,
            "Esto puede indicar un ataque de intermediario. Acepta SOLO si el cambio es esperado."
        )?;
        write!(out, "¿Reemplazar la clave registrada y continuar? (sí/no): ")
    }
}

/// Confirmación por terminal, para la CLI (sin ventana que preguntar). La
/// respuesta se lee de stdin, que tiene que ser una terminal; la pregunta se
/// escribe en stderr.
fn confirm_on_stdin(
    host: &str,
    port: u16,
    fingerprint: &str,
    key_type: &str,
    previous: &[(usize, String)],
) -> Result<bool, String> {
    use std::io::{BufRead, IsTerminal, Write};

    let changed = !previous.is_empty();
    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        // Sin terminal interactiva no hay a quién preguntar: rechazar es lo
        // seguro. El mensaje enumera las salidas, con la huella recibida ya
        // puesta en `--host-key` para que un script pueda fijarla tal cual.
        if changed {
            return Err(format!(
                "ALERTA: la host key de {host}:{port} ha cambiado ({key_type}, {fingerprint}). \
                 Sin terminal interactiva no se puede confirmar el cambio: conecta desde la \
                 app para revisarlo y decidir. Si el cambio es esperado, --host-key \
                 {fingerprint} acepta solo esa huella sin tocar known_hosts."
            ));
        }
        return Err(format!(
            "host key desconocida de {host}:{port} ({key_type}, {fingerprint}). \
             Sin terminal interactiva no se puede confirmar. Opciones: conecta una vez \
             desde la app o desde una terminal; --host-key {fingerprint} acepta solo esa \
             huella (sin tocar known_hosts); --accept-host-key la aprende sin preguntar; \
             o desactiva «Confirmar la huella en la primera conexión» en Preferencias → \
             Seguridad."
        ));
    }
    // La pregunta va por stderr, como el resto de avisos y preguntas de la CLI
    // (`prompt_secret`, `auth_prompt::ask_on_terminal`): stdout lleva solo la
    // salida del comando o el JSON. Por stdout, con `> fichero` o `| jq` la
    // pregunta (y la ALERTA de un cambio) acababa en el fichero y el proceso
    // parecía colgado esperando un «sí» que nadie veía.
    let mut err = std::io::stderr().lock();
    let _ = write_host_key_question(&mut err, host, port, fingerprint, key_type, previous);
    let _ = err.flush();
    drop(err);

    let mut line = String::new();
    if stdin.lock().read_line(&mut line).is_err() {
        return Ok(false);
    }
    let answer = line.trim().to_lowercase();
    Ok(matches!(answer.as_str(), "si" | "sí" | "s" | "yes" | "y"))
}

/// Handler TOFU para russh:
/// - si la host key ya coincide con known_hosts, acepta;
/// - si no hay entrada, la aprende automáticamente;
/// - si hay entrada con el mismo algoritmo pero otra clave, rechaza.
///
/// Además, si los flags `agent_forwarding` o `x11_forwarding` están activos,
/// acepta canales abiertos por el servidor para reenviarlos al agente local
/// (`$SSH_AUTH_SOCK`) o al X server local (`localhost:6000`) respectivamente.
pub struct KnownHostsClient {
    host: String,
    port: u16,
    failure: Arc<Mutex<Option<String>>>,
    agent_forwarding: bool,
    x11_forwarding: bool,
    remote_forwards: RemoteForwardMap,
    /// Fichero `known_hosts` a usar. `None` —el caso de producción— deja que
    /// russh use el default (`~/.ssh/known_hosts`). `Some(path)` lo redirige, y
    /// solo lo hacen los tests de integración: sin esto, un test que ejercitara
    /// el TOFU escribiría en el `known_hosts` real del usuario.
    known_hosts_path: Option<std::path::PathBuf>,
    /// Huella SHA256 que se espera del servidor (`--host-key` de la CLI), ya
    /// normalizada por [`normalize_fingerprint`]. Con ella, la clave recibida
    /// se compara con la huella y **known_hosts no interviene**: ni se consulta
    /// ni se escribe. Es la verificación sin estado de `plink -hostkey`, para
    /// scripts que no quieren depender del `known_hosts` de quien los lanza.
    expected_fingerprint: Option<String>,
    /// El servidor es un **salto** de la ruta (bastión), no el destino: viaja
    /// en la pregunta de host key (`viaJump`) para que el diálogo lo diga.
    via_jump: bool,
    /// `true` mientras se espera a que el usuario conteste una pregunta de host
    /// key de este servidor. Quien pone plazo al handshake para el reloj
    /// mientras tanto: el usuario tiene sus 120 s para leer la huella.
    prompting: Arc<AtomicBool>,
}

/// Marca una pregunta de host key en curso mientras vive (también si el futuro
/// que espera la respuesta se suelta a medias).
struct PromptInFlight<'a>(&'a AtomicBool);

impl<'a> PromptInFlight<'a> {
    fn start(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::Relaxed);
        Self(flag)
    }
}

impl Drop for PromptInFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

impl KnownHostsClient {
    /// Fija la huella esperada del servidor (ver `expected_fingerprint`).
    pub fn expect_fingerprint(&mut self, fingerprint: Option<String>) {
        self.expected_fingerprint = fingerprint;
    }

    /// Marca este servidor como un salto de la ruta (ver `via_jump`).
    pub fn mark_jump(&mut self) {
        self.via_jump = true;
    }

    /// Marca de «pregunta de host key en curso» (ver `prompting`), para quien
    /// mide el plazo del handshake desde fuera.
    pub fn prompt_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.prompting)
    }

    /// `check_known_hosts` de russh, contra el fichero de este cliente.
    fn check_known_hosts(&self, key: &PublicKey) -> Result<bool, russh::keys::Error> {
        match &self.known_hosts_path {
            Some(path) => known_hosts::check_known_hosts_path(&self.host, self.port, key, path),
            None => known_hosts::check_known_hosts(&self.host, self.port, key),
        }
    }

    /// `known_host_keys` de russh, contra el fichero de este cliente.
    fn known_host_keys(&self) -> Result<Vec<(usize, PublicKey)>, russh::keys::Error> {
        match &self.known_hosts_path {
            Some(path) => known_hosts::known_host_keys_path(&self.host, self.port, path),
            None => known_hosts::known_host_keys(&self.host, self.port),
        }
    }

    /// `learn_known_hosts` de russh, contra el fichero de este cliente.
    fn learn_known_hosts(&self, key: &PublicKey) -> Result<(), russh::keys::Error> {
        match &self.known_hosts_path {
            Some(path) => known_hosts::learn_known_hosts_path(&self.host, self.port, key, path),
            None => known_hosts::learn_known_hosts(&self.host, self.port, key),
        }
    }

    /// Fichero known_hosts de este cliente (el de los tests o el del usuario).
    fn known_hosts_file(&self) -> Result<std::path::PathBuf, String> {
        match &self.known_hosts_path {
            Some(path) => Ok(path.clone()),
            None => default_known_hosts_path(),
        }
    }

    /// Contenido del known_hosts de este cliente; vacío si aún no existe.
    fn read_known_hosts(&self) -> Result<String, String> {
        let path = self.known_hosts_file()?;
        match std::fs::read_to_string(&path) {
            Ok(contents) => Ok(contents),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(err) => Err(format!("no se pudo leer {}: {err}", path.display())),
        }
    }

    /// Entradas de russh (`known_host_keys`) como `(línea física, huella)`,
    /// que es lo que se enseña en el diálogo, en la CLI y en los mensajes: la
    /// línea que ve el usuario en un editor y en el gestor de known_hosts. Es
    /// solo para mostrar; el borrado se recalcula al aceptar.
    fn describe_entries(&self, keys: &[(usize, PublicKey)]) -> Vec<(usize, String)> {
        let contents = self.read_known_hosts().unwrap_or_default();
        let physical = russh_lines_to_physical(&contents);
        keys.iter()
            .map(|(line, key)| (physical_line(&physical, *line), fingerprint_sha256(key)))
            .collect()
    }

    /// Entradas registradas para este host:puerto como `(línea física, huella)`.
    fn recorded_entries(&self) -> Vec<(usize, String)> {
        self.known_host_keys()
            .map(|keys| self.describe_entries(&keys))
            .unwrap_or_default()
    }

    /// Línea física de la `line` que numera russh (para el aviso de respaldo).
    fn physical_line_of(&self, line: usize) -> usize {
        let contents = self.read_known_hosts().unwrap_or_default();
        physical_line(&russh_lines_to_physical(&contents), line)
    }

    /// Reemplaza las entradas de este host en known_hosts por `key`. `seen`
    /// son las entradas que el usuario tenía delante al aceptar.
    ///
    /// No borra por los números calculados antes del diálogo: entre medias
    /// pueden haber pasado hasta dos minutos y otro programa (OpenSSH,
    /// `ssh-keygen -R`, el usuario) puede haber movido líneas. Bajo el candado
    /// de escritura se vuelve a preguntar a russh, se traduce su numeración
    /// (que no cuenta los comentarios) a la física comprobando que cada línea
    /// lleva la clave que russh dijo, y si las entradas ya no son las que vio
    /// el usuario no se toca nada. La reescritura es **atómica** con 0600: un
    /// corte a mitad de un write directo truncaría known_hosts y se perderían
    /// todos los pins TOFU.
    fn replace_known_hosts_entries(
        &self,
        seen: &[(usize, String)],
        key: &PublicKey,
    ) -> Result<(), String> {
        let _guard = KNOWN_HOSTS_LOCK.lock_recover();
        let changed_meanwhile = || {
            format!(
                "known_hosts ha cambiado mientras decidías y no se ha tocado; vuelve a \
                 conectar a {}:{} para revisar la clave otra vez",
                self.host, self.port
            )
        };
        let current = self.known_host_keys().map_err(|e| e.to_string())?;
        // Otra conexión al mismo host (otra pestaña, el panel SFTP por el mismo
        // bastión) ya aceptó esta misma clave mientras este diálogo esperaba:
        // known_hosts ya está como el usuario quería, no es un cambio ajeno.
        if !current.is_empty() && current.iter().all(|(_, k)| k == key) {
            return Ok(());
        }
        let contents = self.read_known_hosts()?;
        let lines = physical_lines_for(&contents, &current).ok_or_else(changed_meanwhile)?;

        let mut current_fps: Vec<String> =
            current.iter().map(|(_, k)| fingerprint_sha256(k)).collect();
        let mut seen_fps: Vec<String> = seen.iter().map(|(_, fp)| fp.clone()).collect();
        current_fps.sort();
        seen_fps.sort();
        if current_fps != seen_fps {
            return Err(changed_meanwhile());
        }

        let path = self.known_hosts_file()?;
        crate::atomic_file::write(&path, without_lines(&contents, &lines).as_bytes(), true)
            .map_err(|e| e.to_string())?;
        self.learn_known_hosts(key).map_err(|e| e.to_string())
    }
}

/// `~/.ssh/known_hosts`, el mismo default que usa russh.
fn default_known_hosts_path() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .ok_or_else(|| "No se pudo localizar el directorio home".to_string())
}

/// Numeración de russh → numeración física. `known_host_keys_path` cuenta desde
/// 1 pero **se salta** las líneas cuyo primer byte es `#` (sin sumar), mientras
/// que el editor, el gestor de known_hosts y [`without_lines`] cuentan todas.
/// Devuelve, para la línea `n` de russh, la física en la posición `n - 1`. La
/// regla es la misma que la de russh: solo el primer byte (un `  # sangrado`
/// sí cuenta, y una línea vacía también); `split_inclusive` corta por `\n`
/// igual que su `read_line`, y un `\r` final no cambia el primer byte.
fn russh_lines_to_physical(contents: &str) -> Vec<usize> {
    contents
        .split_inclusive('\n')
        .enumerate()
        .filter(|(_, raw)| raw.as_bytes().first() != Some(&b'#'))
        .map(|(idx, _)| idx + 1)
        .collect()
}

/// Línea física de la `line` de russh; si no existe (el fichero encogió), la
/// misma `line`: solo se usa para mostrar.
fn physical_line(physical: &[usize], line: usize) -> usize {
    line.checked_sub(1)
        .and_then(|idx| physical.get(idx))
        .copied()
        .unwrap_or(line)
}

/// Líneas físicas de las entradas que russh devolvió para un host, comprobando
/// que cada una lleva **esa** clave (tercer campo, partido por espacios como en
/// russh). `None` si alguna no cuadra: el fichero cambió entre la lectura de
/// russh y la nuestra, y borrar por número podría llevarse la línea de otro
/// host. Mejor no tocar nada.
fn physical_lines_for(contents: &str, entries: &[(usize, PublicKey)]) -> Option<Vec<usize>> {
    let raw_lines: Vec<&str> = contents.split_inclusive('\n').collect();
    let physical = russh_lines_to_physical(contents);
    entries
        .iter()
        .map(|(line, key)| {
            let phys = *physical.get(line.checked_sub(1)?)?;
            let field = raw_lines.get(phys - 1)?.trim_end().split(' ').nth(2)?;
            let recorded = russh::keys::parse_public_key_base64(field).ok()?;
            (recorded == *key).then_some(phys)
        })
        .collect()
}

/// `contents` sin las líneas físicas `lines` (1-indexed). Cada línea que queda
/// conserva su propio fin de línea (`\n` o `\r\n`) y su texto exacto:
/// comentarios, líneas vacías y marcadores (`@revoked`, `@cert-authority`)
/// siguen ahí, porque el fichero es el mismo que usa OpenSSH.
fn without_lines(contents: &str, lines: &[usize]) -> String {
    contents
        .split_inclusive('\n')
        .enumerate()
        .filter(|(idx, _)| !lines.contains(&(idx + 1)))
        .map(|(_, raw)| raw)
        .collect()
}

/// Quita la línea física `line` (1-indexed) de `path` —la de Preferencias →
/// known_hosts— bajo el mismo candado que el TOFU y el reemplazo de claves: sin
/// él, un aprendizaje simultáneo se perdería con el `rename`.
pub(crate) fn remove_known_hosts_line(path: &Path, line: usize) -> std::io::Result<()> {
    let _guard = KNOWN_HOSTS_LOCK.lock_recover();
    let contents = std::fs::read_to_string(path)?;
    crate::atomic_file::write(path, without_lines(&contents, &[line]).as_bytes(), true)
}

#[derive(Clone)]
pub struct RemoteForwardTarget {
    pub host: String,
    pub port: u16,
    pub session_id: String,
    pub tunnel_id: String,
    pub app_handle: AppHandle,
    /// Tráfico acumulado del túnel, compartido por todas sus conexiones.
    pub traffic: Arc<crate::tunnel_throttle::TunnelTraffic>,
}

pub type RemoteForwardMap = Arc<Mutex<HashMap<(String, u32), RemoteForwardTarget>>>;

pub fn remote_forward_map() -> RemoteForwardMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn client(
    host: String,
    port: u16,
    agent_forwarding: bool,
    x11_forwarding: bool,
) -> (KnownHostsClient, Arc<Mutex<Option<String>>>) {
    client_with_remote_forwards(
        host,
        port,
        agent_forwarding,
        x11_forwarding,
        remote_forward_map(),
    )
}

pub fn client_with_remote_forwards(
    host: String,
    port: u16,
    agent_forwarding: bool,
    x11_forwarding: bool,
    remote_forwards: RemoteForwardMap,
) -> (KnownHostsClient, Arc<Mutex<Option<String>>>) {
    let failure = Arc::new(Mutex::new(None));
    (
        KnownHostsClient {
            host,
            port,
            failure: Arc::clone(&failure),
            agent_forwarding,
            x11_forwarding,
            remote_forwards,
            known_hosts_path: None,
            expected_fingerprint: None,
            via_jump: false,
            prompting: Arc::new(AtomicBool::new(false)),
        },
        failure,
    )
}

/// Como [`client`], pero con el `known_hosts` en un fichero concreto en vez del
/// `~/.ssh/known_hosts` del usuario. Existe **solo para los tests de
/// integración**, que ejercitan el flujo TOFU real contra un `sshd` de pruebas y
/// no deben tocar el known_hosts de la máquina (y que, como el fixture, solo
/// corren en Linux).
#[cfg(all(test, target_os = "linux"))]
pub fn client_with_known_hosts(
    host: String,
    port: u16,
    known_hosts_path: std::path::PathBuf,
) -> (KnownHostsClient, Arc<Mutex<Option<String>>>) {
    let failure = Arc::new(Mutex::new(None));
    (
        KnownHostsClient {
            host,
            port,
            failure: Arc::clone(&failure),
            agent_forwarding: false,
            x11_forwarding: false,
            remote_forwards: remote_forward_map(),
            known_hosts_path: Some(known_hosts_path),
            expected_fingerprint: None,
            via_jump: false,
            prompting: Arc::new(AtomicBool::new(false)),
        },
        failure,
    )
}

pub fn take_failure(failure: &Arc<Mutex<Option<String>>>) -> Option<String> {
    failure.lock().ok().and_then(|mut value| value.take())
}

impl KnownHostsClient {
    fn set_failure(&self, message: String) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(message);
        }
    }

    /// La clave del host **ha cambiado** respecto a known_hosts (posible
    /// MITM). Con la política de preguntar (default): diálogo de peligro y,
    /// si el usuario acepta explícitamente, se reemplazan las entradas
    /// registradas por la nueva y la conexión **continúa**. Rechazo, plazo
    /// agotado o política desactivada → se rechaza sin tocar known_hosts.
    async fn handle_changed_key(&self, key: &PublicKey, previous: Vec<(usize, String)>) -> bool {
        let new_fp = fingerprint_sha256(key);
        let prev_desc = previous
            .iter()
            .map(|(line, fp)| format!("línea {line}: {fp}"))
            .collect::<Vec<_>>()
            .join("; ");

        if !prompt_on_key_change() {
            // Política clásica: rechazo con instrucciones manuales.
            self.set_failure(format!(
                "{} ALERTA: la host key de {}:{} ha cambiado. \
                 Fingerprint recibido: {new_fp}. \
                 Entradas previas en known_hosts → {prev_desc}. \
                 Si reconoces el cambio, elimina las líneas correspondientes de \
                 ~/.ssh/known_hosts y vuelve a conectar (o activa la pregunta de \
                 cambio de clave en Preferencias → Seguridad).",
                crate::ipc_error::HOSTKEY_CHANGED_MARKER,
                self.host,
                self.port,
            ));
            return false;
        }

        let asked = {
            let _prompt = PromptInFlight::start(&self.prompting);
            confirm_host_key(&self.host, self.port, self.via_jump, key, &previous).await
        };
        match asked {
            Ok(true) => {
                match self.replace_known_hosts_entries(&previous, key) {
                    Ok(()) => true,
                    Err(err) => {
                        self.set_failure(format!(
                            "Aceptaste la clave nueva de {}:{} pero no se pudo \
                             actualizar known_hosts: {err}",
                            self.host, self.port,
                        ));
                        false
                    }
                }
            }
            Ok(false) => {
                self.set_failure(format!(
                    "{} ALERTA: la host key de {}:{} ha cambiado y se ha RECHAZADO. \
                     Fingerprint recibido: {new_fp}; registrado → {prev_desc}. \
                     known_hosts queda intacto.",
                    crate::ipc_error::HOSTKEY_CHANGED_MARKER,
                    self.host,
                    self.port,
                ));
                false
            }
            Err(err) => {
                self.set_failure(err);
                false
            }
        }
    }
}

impl client::Handler for KnownHostsClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Desde russh 0.63 el handler recibe la clave **o un certificado** de
        // host. Un certificado se verifica contra la CA declarada en
        // known_hosts (`@cert-authority`), no comparando huellas, así que no
        // tiene traducción en este camino TOFU: aquí se rechaza con un mensaje
        // que lo dice. No es alcanzable mientras no anunciemos algoritmos
        // `*-cert-v01@openssh.com` (`Preferred::host_key_certificates`, vacío
        // por defecto y también en `legacy_preferred`); queda como la única
        // respuesta honesta si algún día se activan.
        let server_public_key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(cert) => {
                self.set_failure(format!(
                    "{} {}:{} ha presentado un CERTIFICADO de host ({}), y Rustty \
                     todavía no verifica certificados: solo claves en known_hosts. \
                     Conexión rechazada.",
                    crate::ipc_error::HOSTKEY_UNKNOWN_MARKER,
                    self.host,
                    self.port,
                    cert.algorithm(),
                ));
                return Ok(false);
            }
        };
        // Huella fijada (`--host-key`): la verificación es contra ella y solo
        // contra ella. known_hosts no se consulta ni se toca, de modo que el
        // resultado no depende de lo que haya aprendido quien lanza el script.
        if let Some(expected) = &self.expected_fingerprint {
            let received = fingerprint_sha256(server_public_key);
            if received == *expected {
                return Ok(true);
            }
            self.set_failure(format!(
                "La host key de {}:{} ({}) no coincide con la huella indicada en --host-key: \
                 esperada {expected}, recibida {received}. Conexión rechazada; known_hosts \
                 no se ha tocado.",
                self.host,
                self.port,
                server_public_key.algorithm().as_str(),
            ));
            return Ok(false);
        }
        match self.check_known_hosts(server_public_key) {
            // Coincide exactamente con una entrada existente (mismo algoritmo
            // y misma clave): aceptamos.
            Ok(true) => Ok(true),
            Ok(false) => {
                // `check_known_hosts` solo compara claves del mismo algoritmo.
                // Si el servidor pasa de p. ej. ssh-rsa a ssh-ed25519, llegamos
                // aquí aunque hubiese una entrada previa para el host. Antes de
                // aprender la clave nueva, comprobamos si ya teníamos alguna
                // entrada registrada para este host:puerto: si la había, la
                // clave realmente ha cambiado y debemos avisar en vez de
                // aceptarla en silencio.
                match self.known_host_keys() {
                    Ok(recorded) if !recorded.is_empty() => {
                        // La clave ha cambiado (de algoritmo, además): mismo
                        // tratamiento que un `KeyChanged`, con confirmación.
                        let previous = self.describe_entries(&recorded);
                        Ok(self.handle_changed_key(server_public_key, previous).await)
                    }
                    Ok(_) | Err(_) => {
                        // No hay entradas previas: es la PRIMERA conexión a este
                        // host. Con el modo estricto (default) el usuario confirma
                        // la huella antes de aprenderla; sin él, TOFU clásico.
                        if strict_first_connect() {
                            let asked = {
                                let _prompt = PromptInFlight::start(&self.prompting);
                                confirm_host_key(
                                    &self.host,
                                    self.port,
                                    self.via_jump,
                                    server_public_key,
                                    &[],
                                )
                                .await
                            };
                            match asked {
                                Ok(true) => {}
                                Ok(false) => {
                                    self.set_failure(format!(
                                        "{} Host key de {}:{} rechazada: no se ha confirmado la huella {}. \
                                         La clave no se ha guardado.",
                                        crate::ipc_error::HOSTKEY_UNKNOWN_MARKER,
                                        self.host,
                                        self.port,
                                        fingerprint_sha256(server_public_key)
                                    ));
                                    return Ok(false);
                                }
                                Err(err) => {
                                    self.set_failure(err);
                                    return Ok(false);
                                }
                            }
                        }
                        // Bajo el candado: que un reemplazo en curso de otra
                        // sesión no se lleve esta línea con su `rename`.
                        let learned = {
                            let _guard = KNOWN_HOSTS_LOCK.lock_recover();
                            self.learn_known_hosts(server_public_key)
                        };
                        match learned {
                            Ok(()) => Ok(true),
                            Err(err) => {
                                self.set_failure(format!(
                                    "No se pudo guardar la host key de {}:{} en known_hosts: {err}",
                                    self.host, self.port
                                ));
                                Ok(false)
                            }
                        }
                    }
                }
            }
            Err(russh::keys::Error::KeyChanged { line }) => {
                // Mismo algoritmo, clave distinta. Las entradas registradas
                // salen del propio fichero; si no se pudieran listar, al menos
                // la línea que denuncia russh (traducida a la física).
                let mut previous = self.recorded_entries();
                if previous.is_empty() {
                    previous.push((self.physical_line_of(line), "(no legible)".to_string()));
                }
                Ok(self.handle_changed_key(server_public_key, previous).await)
            }
            Err(err) => {
                self.set_failure(format!(
                    "No se pudo verificar la host key de {}:{}: {err}",
                    self.host, self.port
                ));
                Ok(false)
            }
        }
    }

    // Desde russh 0.62 los canales que abre el servidor se aceptan o rechazan de
    // forma explícita con `reply`: soltar el handle sin contestar equivale a un
    // rechazo `AdministrativelyProhibited`. Aquí eso encaja con la política que
    // ya teníamos: si el forwarding correspondiente no está activo en el perfil,
    // el canal se rechaza (antes se ignoraba y quedaba a medio abrir).
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<russh::client::Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if !self.agent_forwarding {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let _ = forward_to_agent(channel).await;
        });
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        channel: Channel<russh::client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if !self.x11_forwarding {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let _ = forward_to_x11(channel).await;
        });
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.remote_forwards.lock().ok().and_then(|map| {
            map.get(&(connected_address.to_string(), connected_port))
                .cloned()
                .or_else(|| map.get(&("0.0.0.0".to_string(), connected_port)).cloned())
                .or_else(|| map.get(&("".to_string(), connected_port)).cloned())
        });
        let Some(target) = target else {
            // Conexión entrante a un puerto remoto que no tenemos reenviado:
            // se rechaza el canal en vez de aceptarlo y cerrarlo acto seguido.
            reply
                .reject(russh::ChannelOpenFailure::ConnectFailed)
                .await;
            let _ = channel.close().await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            if let Ok(stream) =
                tokio::net::TcpStream::connect((target.host.as_str(), target.port)).await
            {
                let _ = pump_channel_with_traffic(
                    channel,
                    stream,
                    TrafficSink {
                        session_id: target.session_id,
                        tunnel_id: target.tunnel_id,
                        app_handle: target.app_handle,
                        totals: target.traffic,
                    },
                )
                .await;
            }
        });
        Ok(())
    }
}

pub fn fingerprint_sha256(public_key: &PublicKey) -> String {
    let bytes = public_key.to_bytes().unwrap_or_default();
    let digest = Sha256::digest(bytes);
    format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

#[cfg(unix)]
async fn forward_to_agent(channel: Channel<russh::client::Msg>) -> std::io::Result<()> {
    let sock_path = std::env::var("SSH_AUTH_SOCK").map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "SSH_AUTH_SOCK no está definido",
        )
    })?;
    let stream = tokio::net::UnixStream::connect(sock_path).await?;
    pump_channel(channel, stream).await
}

#[cfg(not(unix))]
async fn forward_to_agent(_channel: Channel<russh::client::Msg>) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Agent forwarding solo está disponible en Unix",
    ))
}

async fn forward_to_x11(channel: Channel<russh::client::Msg>) -> std::io::Result<()> {
    // DISPLAY=:N → TCP localhost:6000+N. Si no hay DISPLAY, asume :0.
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    let display_num = display
        .rsplit(':')
        .next()
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    let port = 6000u16.saturating_add(display_num);
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    pump_channel(channel, stream).await
}

/// Bombea datos en ambas direcciones entre un canal russh y un stream local
/// (Unix socket o TCP). Termina cuando cualquiera de los dos extremos cierra.
async fn pump_channel<S>(channel: Channel<russh::client::Msg>, stream: S) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    pump_channel_inner(channel, stream, None).await
}

/// Destino de los eventos de tráfico de una conexión de túnel remoto.
struct TrafficSink {
    session_id: String,
    tunnel_id: String,
    app_handle: AppHandle,
    /// Contadores del túnel entero: el evento lleva el acumulado, no el de la
    /// conexión (ver [`crate::tunnel_throttle::TunnelTraffic`]).
    totals: Arc<crate::tunnel_throttle::TunnelTraffic>,
}

async fn pump_channel_with_traffic<S>(
    channel: Channel<russh::client::Msg>,
    stream: S,
    sink: TrafficSink,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    pump_channel_inner(channel, stream, Some(sink)).await
}

async fn pump_channel_inner<S>(
    mut channel: Channel<russh::client::Msg>,
    stream: S,
    traffic: Option<TrafficSink>,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut local_rx, mut local_tx) = tokio::io::split(stream);
    let mut buf = vec![0u8; 8192];
    let mut bytes_up = 0u64;
    let mut bytes_down = 0u64;
    // Coalescing de los eventos de tráfico (ver `tunnel_throttle`): emitir a lo
    // sumo cada intervalo/umbral en vez de por chunk, con flush final exacto.
    let mut last_emit = std::time::Instant::now();
    let mut last_emit_total = 0u64;
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if local_tx.write_all(&data).await.is_err() {
                            break;
                        }
                        bytes_down = bytes_down.saturating_add(data.len() as u64);
                        add_traffic(&traffic, 0, data.len() as u64);
                        maybe_emit_traffic(&traffic, bytes_up, bytes_down, &mut last_emit, &mut last_emit_total);
                    }
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => break,
                    Some(_) => {}
                    None => break,
                }
            }
            n = local_rx.read(&mut buf) => {
                match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if channel.data(&buf[..n]).await.is_err() {
                            break;
                        }
                        bytes_up = bytes_up.saturating_add(n as u64);
                        add_traffic(&traffic, n as u64, 0);
                        maybe_emit_traffic(&traffic, bytes_up, bytes_down, &mut last_emit, &mut last_emit_total);
                    }
                }
            }
        }
    }
    // Flush final con los totales exactos por si el último chunk no cruzó el umbral.
    if bytes_up.saturating_add(bytes_down) != last_emit_total {
        emit_tunnel_traffic(&traffic);
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    Ok(())
}

/// Suma los bytes de esta conexión a los contadores del túnel.
fn add_traffic(traffic: &Option<TrafficSink>, up: u64, down: u64) {
    if let Some(sink) = traffic {
        sink.totals.add(up, down);
    }
}

/// Emite un evento de tráfico solo si el throttle lo permite (ver
/// [`crate::tunnel_throttle`]), actualizando el estado de coalescing. El ritmo
/// se decide con los bytes de ESTA conexión (`bytes_up`/`bytes_down`); el
/// evento lleva el acumulado del túnel.
fn maybe_emit_traffic(
    traffic: &Option<TrafficSink>,
    bytes_up: u64,
    bytes_down: u64,
    last_emit: &mut std::time::Instant,
    last_emit_total: &mut u64,
) {
    if traffic.is_none() {
        return;
    }
    let total = bytes_up.saturating_add(bytes_down);
    if crate::tunnel_throttle::should_emit_traffic(
        last_emit.elapsed(),
        total.saturating_sub(*last_emit_total),
    ) {
        emit_tunnel_traffic(traffic);
        *last_emit = std::time::Instant::now();
        *last_emit_total = total;
    }
}

fn emit_tunnel_traffic(traffic: &Option<TrafficSink>) {
    let Some(TrafficSink { session_id, tunnel_id, app_handle, totals }) = traffic else {
        return;
    };
    let (bytes_up, bytes_down) = totals.totals();
    let _ = app_handle.emit(
        &event_name(EventKind::SshTunnelTraffic, session_id),
        serde_json::json!({
            "id": tunnel_id,
            "bytesUp": bytes_up,
            "bytesDown": bytes_down,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::PublicKey;

    // `fingerprint_sha256` debe producir exactamente el mismo SHA256 que
    // `ssh-keygen -lf` (SHA256 de la clave en formato wire, base64 sin padding,
    // prefijado con "SHA256:"). Usamos un par ed25519 fijo cuyo fingerprint
    // conocemos de antemano.
    const PUB_ED25519: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPLoaKpum+TqpMC1HCq9Fz7K6oNPtWxK03HhP6sgLLMV";
    const FP_ED25519: &str = "SHA256:uQAtx5MA1iF9jq547yBEjEJYlWBFUsApAs9ILZLdZQU";

    #[test]
    fn fingerprint_coincide_con_ssh_keygen() {
        let key = PublicKey::from_openssh(PUB_ED25519).expect("clave pública válida");
        assert_eq!(fingerprint_sha256(&key), FP_ED25519);
    }

    #[test]
    fn fingerprint_tiene_prefijo_sha256() {
        let key = PublicKey::from_openssh(PUB_ED25519).expect("clave pública válida");
        let fp = fingerprint_sha256(&key);
        assert!(fp.starts_with("SHA256:"));
        // Base64 sin padding: no debe contener '='.
        assert!(!fp.contains('='));
    }

    #[test]
    fn fingerprints_distintos_para_claves_distintas() {
        // Otra clave ed25519 cualquiera debe dar un fingerprint diferente.
        const OTRA_PUB: &str =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINbq6kVZ1dQK4mZ1J3l2YbXq8q0XlqW7t8q4Q1qS9aaa";
        let a = PublicKey::from_openssh(PUB_ED25519).expect("clave pública válida");
        // La segunda puede o no parsear según el padding; solo comparamos si lo hace.
        if let Ok(b) = PublicKey::from_openssh(OTRA_PUB) {
            assert_ne!(fingerprint_sha256(&a), fingerprint_sha256(&b));
        }
    }

    #[test]
    fn el_modo_estricto_es_el_default_y_se_puede_desactivar() {
        // El default es preguntar: aprender una clave nueva en silencio pasa a
        // ser una decisión explícita del usuario.
        assert!(strict_first_connect());
        set_strict_first_connect(false);
        assert!(!strict_first_connect());
        set_strict_first_connect(true);
        assert!(strict_first_connect());
    }

    #[test]
    fn responder_a_un_prompt_inexistente_no_entra_en_panico() {
        // Una respuesta tardía (el prompt ya caducó) o duplicada devuelve false
        // en vez de romper: el frontend puede reintentar sin consecuencias.
        assert!(!resolve_prompt("no-existe", true));
        assert!(!resolve_prompt("no-existe", false));
    }

    #[test]
    fn la_huella_se_normaliza_desde_cualquier_forma_habitual() {
        // Como la enseña Rustty, sin prefijo, con `=` de relleno, línea entera
        // de `ssh-keygen -lf` y formato de `plink -hostkey`: todas acaban en el
        // formato de `fingerprint_sha256`.
        let want = Some(FP_ED25519.to_string());
        let raw = FP_ED25519.trim_start_matches("SHA256:");
        assert_eq!(normalize_fingerprint(FP_ED25519), want);
        assert_eq!(normalize_fingerprint(&format!("  {FP_ED25519}\n")), want);
        assert_eq!(normalize_fingerprint(raw), want);
        assert_eq!(normalize_fingerprint(&format!("{raw}=")), want);
        assert_eq!(normalize_fingerprint(&format!("sha256:{raw}")), want);
        assert_eq!(
            normalize_fingerprint(&format!("256 {FP_ED25519} usuario@equipo (ED25519)")),
            want
        );
        assert_eq!(normalize_fingerprint(&format!("ssh-ed25519 255 {FP_ED25519}")), want);
        // Lo que no es una huella SHA256 se rechaza: MD5, vacío, truncada.
        assert_eq!(normalize_fingerprint("MD5:aa:bb:cc:dd"), None);
        assert_eq!(normalize_fingerprint(""), None);
        assert_eq!(normalize_fingerprint(&raw[..20]), None);
        assert_eq!(normalize_fingerprint("SHA256:no-es-base64-por-el-guion-ni-tiene-el-largo"), None);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn con_huella_fijada_se_acepta_sin_known_hosts_y_otra_se_rechaza() {
        use russh::client::Handler as _;

        // La huella fijada es la verificación entera: con la correcta el
        // handler acepta aunque el known_hosts esté vacío (y sigue vacío
        // después); con otra, rechaza con un mensaje que enseña las dos.
        let key = PublicKey::from_openssh(PUB_ED25519).expect("clave pública válida");
        let dir = std::env::temp_dir().join(format!("rustty-pin-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (mut handler, failure) =
            client_with_known_hosts("pin.example".into(), 22, dir.join("known_hosts"));
        handler.expect_fingerprint(Some(FP_ED25519.to_string()));
        let server_key = PublicKeyOrCertificate::PublicKey {
            key: key.clone(),
            hash_alg: None,
        };
        assert_eq!(handler.check_server_key(&server_key).await.ok(), Some(true));
        assert!(!dir.join("known_hosts").exists(), "la pin no escribe known_hosts");

        handler.expect_fingerprint(Some(
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        ));
        assert_eq!(handler.check_server_key(&server_key).await.ok(), Some(false));
        let err = take_failure(&failure).expect("motivo del rechazo");
        assert!(err.contains("--host-key") && err.contains(FP_ED25519), "{err}");
        assert!(!dir.join("known_hosts").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_politica_se_guarda_y_se_lee_sin_reescribir_si_no_cambia() {
        let dir = std::env::temp_dir().join(format!("rustty-policy-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load_policy(&dir), None, "sin fichero no hay política");
        let policy = HostKeyPolicy {
            strict_first_connect: false,
            prompt_on_key_change: true,
        };
        assert!(write_policy(&dir, &policy).unwrap());
        assert!(!write_policy(&dir, &policy).unwrap(), "sin cambios no se reescribe");
        assert_eq!(load_policy(&dir), Some(policy));
        // Un fichero roto no rompe nada: rige el default.
        std::fs::write(dir.join(POLICY_FILE_NAME), b"{ esto no es json").unwrap();
        assert_eq!(load_policy(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn sin_app_ni_terminal_la_clave_desconocida_se_rechaza() {
        // En la CLI sin TTY (p. ej. dentro de un script) no hay a quién
        // preguntar: se rechaza con un error accionable en vez de aprender la
        // clave a ciegas. En el test, stdin no es un terminal.
        let err = confirm_on_stdin("host.example", 22, "SHA256:abc", "ssh-ed25519", &[])
            .expect_err("sin TTY debe fallar");
        assert!(err.contains("host.example"));
        assert!(err.contains("SHA256:abc"));
    }

    #[tokio::test]
    async fn sin_terminal_la_clave_cambiada_tambien_se_rechaza() {
        // El caso cambiado sin TTY: mismo rechazo seguro, pero el mensaje debe
        // hablar del CAMBIO (es la señal de un posible MITM, no una primera
        // conexión).
        let previous = vec![(33, "SHA256:vieja".to_string())];
        let err = confirm_on_stdin("host.example", 22, "SHA256:abc", "ssh-ed25519", &previous)
            .expect_err("sin TTY debe fallar");
        assert!(err.contains("ha cambiado"), "{err}");
        assert!(err.contains("host.example"));
    }

    /// Clave real generada con ssh-keygen (solo para los tests; sin privada).
    const NUEVA: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHiVQ7pP9Gkw4Ce6/iSwB16+zfQQK08zZ0xMXi3zO2yy";
    /// Otra, ECDSA, para el cambio de algoritmo (ssh-keygen; sin privada).
    const PUB_ECDSA: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHfkim7wkjVMzwxjAFP2tYP79Het/hkeBrQkt382xF1CxRj0m8J55i+1FhiRudJZmqZNeCggMXtbwvsAf7ym0hU=";
    /// Entrada hasheada del test de russh: `example.com:22`.
    const HASHED_EXAMPLE_COM: &str = "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    /// known_hosts temporal con `contents`, y un cliente que lo usa para
    /// `host:port` (el literal del struct: `client_with_known_hosts` solo
    /// existe en Linux y estos tests corren en todas las plataformas).
    fn kh_fixture(contents: &str, host: &str, port: u16) -> (std::path::PathBuf, KnownHostsClient) {
        let dir = std::env::temp_dir().join(format!("rustty-kh-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let kh = dir.join("known_hosts");
        std::fs::write(&kh, contents).unwrap();
        let client = KnownHostsClient {
            host: host.into(),
            port,
            failure: Arc::new(Mutex::new(None)),
            agent_forwarding: false,
            x11_forwarding: false,
            remote_forwards: remote_forward_map(),
            known_hosts_path: Some(kh.clone()),
            expected_fingerprint: None,
            via_jump: false,
            prompting: Arc::new(AtomicBool::new(false)),
        };
        (kh, client)
    }

    fn cleanup(kh: &std::path::Path) {
        if let Some(dir) = kh.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// Contrato con la dependencia: russh numera las líneas de known_hosts
    /// **sin contar** las que empiezan por `#`. Si una versión futura cambia la
    /// regla, este test lo dice al subirla (y la traducción se ajusta).
    #[test]
    fn la_numeracion_de_russh_se_salta_los_comentarios() {
        let contents =
            format!("# a\n# b\nuno {PUB_ED25519}\n[cambia.example]:2222 {PUB_ED25519}\n");
        let (kh, _) = kh_fixture(&contents, "cambia.example", 2222);
        let lines: Vec<usize> = known_hosts::known_host_keys_path("cambia.example", 2222, &kh)
            .unwrap()
            .into_iter()
            .map(|(line, _)| line)
            .collect();
        assert_eq!(lines, vec![2], "russh cuenta solo las líneas no comentadas");
        assert_eq!(physical_line(&russh_lines_to_physical(&contents), 2), 4);
        cleanup(&kh);
    }

    /// La traducción, contrastada con russh sobre el mismo fichero: comentarios
    /// arriba y en medio, `  # sangrado` (cuenta), línea vacía (cuenta), CRLF y
    /// sin `\n` final.
    #[test]
    fn la_traduccion_de_lineas_coincide_con_russh_en_cualquier_fichero() {
        let contents = format!(
            "# cabecera\r\n\
             a.example {PUB_ED25519}\r\n\
             \n\
             # en medio\n\
             \x20 # sangrado: para russh no es comentario\n\
             b.example {PUB_ED25519}\n\
             #pegado\n\
             c.example {PUB_ED25519}"
        );
        let physical = russh_lines_to_physical(&contents);
        let (kh, _) = kh_fixture(&contents, "x", 22);
        for (host, want) in [("a.example", 2), ("b.example", 6), ("c.example", 8)] {
            let entries = known_hosts::known_host_keys_path(host, 22, &kh).unwrap();
            assert_eq!(entries.len(), 1, "{host}");
            assert_eq!(physical_line(&physical, entries[0].0), want, "{host}");
            assert_eq!(physical_lines_for(&contents, &entries), Some(vec![want]), "{host}");
        }
        cleanup(&kh);
    }

    /// Borrar líneas no toca el resto: cada línea conserva su fin (`\r\n`
    /// incluido) y la última sin `\n` sigue sin él.
    #[test]
    fn quitar_lineas_conserva_el_resto_tal_cual() {
        let contents = "# uno\r\nborrar\r\n\ndos\nborrar\ntres";
        assert_eq!(without_lines(contents, &[2, 5]), "# uno\r\n\ndos\ntres");
        assert_eq!(without_lines(contents, &[6]), "# uno\r\nborrar\r\n\ndos\nborrar\n");
        assert_eq!(without_lines(contents, &[]), contents);
    }

    /// Borrar una entrada desde Preferencias quita esa línea física y nada más:
    /// el comentario de encima, los CRLF y las demás entradas siguen igual.
    #[test]
    fn borrar_una_linea_de_known_hosts_conserva_el_resto() {
        let dir = std::env::temp_dir().join(format!("rustty-kh-rm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        std::fs::write(&path, "# equipo\r\na.example ssh-ed25519 AAAA\r\nb.example ssh-ed25519 BBBB\n").unwrap();
        remove_known_hosts_line(&path, 2).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# equipo\r\nb.example ssh-ed25519 BBBB\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Una línea que no lleva la clave que dijo russh (el fichero cambió entre
    /// las dos lecturas) no se traduce: no se borra por número a ciegas.
    #[test]
    fn una_linea_que_no_lleva_la_clave_esperada_no_se_traduce() {
        let vieja = PublicKey::from_openssh(PUB_ED25519).unwrap();
        let nueva = PublicKey::from_openssh(NUEVA).unwrap();
        let contents = format!("# c\nh.example {NUEVA}\n");
        assert_eq!(physical_lines_for(&contents, &[(1, nueva)]), Some(vec![2]));
        assert_eq!(physical_lines_for(&contents, &[(1, vieja.clone())]), None);
        assert_eq!(physical_lines_for(&contents, &[(5, vieja)]), None);
    }

    /// Aceptar una clave cambiada reemplaza SOLO la entrada vieja de ese host:
    /// con comentarios por encima, la línea que denuncia russh no es la física
    /// y antes se borraba la de otro host (perdía su pin) mientras la vieja se
    /// quedaba (y la siguiente conexión volvía a avisar).
    #[test]
    fn reemplazar_entradas_actualiza_known_hosts_atomicamente() {
        let contents = format!(
            "# producción\notro.example {PUB_ED25519}\n# más\n[cambia.example]:2222 {PUB_ED25519}\n"
        );
        let (kh, client) = kh_fixture(&contents, "cambia.example", 2222);
        let vieja = PublicKey::from_openssh(PUB_ED25519).unwrap();
        let nueva = PublicKey::from_openssh(NUEVA).unwrap();

        // Lo que ve el usuario es la línea física.
        let seen = client.recorded_entries();
        assert_eq!(seen, vec![(4, FP_ED25519.to_string())]);

        client.replace_known_hosts_entries(&seen, &nueva).expect("reemplazar");

        let after = std::fs::read_to_string(&kh).unwrap();
        let kept = format!("# producción\notro.example {PUB_ED25519}\n# más\n");
        assert!(after.starts_with(&kept), "{after}");
        assert_eq!(after.matches("cambia.example").count(), 1, "{after}");
        assert!(known_hosts::check_known_hosts_path("otro.example", 22, &vieja, &kh).unwrap());
        assert!(
            known_hosts::check_known_hosts_path("cambia.example", 2222, &nueva, &kh).unwrap()
        );
        assert!(
            matches!(
                known_hosts::check_known_hosts_path("cambia.example", 2222, &vieja, &kh),
                Err(russh::keys::Error::KeyChanged { .. })
            ),
            "la clave vieja debe denunciarse como cambiada"
        );
        cleanup(&kh);
    }

    /// Dos conexiones al mismo host preguntan a la vez por la misma clave
    /// cambiada: aceptar la segunda, con known_hosts ya actualizado por la
    /// primera, no es «ha cambiado mientras decidías».
    #[test]
    fn aceptar_dos_veces_la_misma_clave_cambiada_no_falla() {
        let contents = format!("# c\n[cambia.example]:2222 {PUB_ED25519}\n");
        let (kh, client) = kh_fixture(&contents, "cambia.example", 2222);
        let nueva = PublicKey::from_openssh(NUEVA).unwrap();
        let seen = client.recorded_entries();
        client.replace_known_hosts_entries(&seen, &nueva).expect("primera");
        let after_first = std::fs::read_to_string(&kh).unwrap();
        client.replace_known_hosts_entries(&seen, &nueva).expect("segunda, con la misma clave");
        assert_eq!(std::fs::read_to_string(&kh).unwrap(), after_first, "no se toca de nuevo");
        cleanup(&kh);
    }

    /// Lo mismo con una entrada hasheada (`|1|…`, HashKnownHosts de OpenSSH):
    /// el emparejamiento del host sigue siendo el de russh.
    #[test]
    fn reemplazar_una_entrada_hasheada_bajo_un_comentario() {
        let contents =
            format!("# hasheadas\notro.example {PUB_ED25519}\n{HASHED_EXAMPLE_COM}\n");
        let (kh, client) = kh_fixture(&contents, "example.com", 22);
        let nueva = PublicKey::from_openssh(NUEVA).unwrap();
        let seen = client.recorded_entries();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, 3);

        client.replace_known_hosts_entries(&seen, &nueva).expect("reemplazar");
        let after = std::fs::read_to_string(&kh).unwrap();
        assert!(!after.contains("|1|"), "{after}");
        assert!(after.contains("# hasheadas\notro.example"), "{after}");
        assert!(known_hosts::check_known_hosts_path("example.com", 22, &nueva, &kh).unwrap());
        cleanup(&kh);
    }

    /// Cambio de algoritmo (known_hosts antiguo con ECDSA, el servidor ofrece
    /// Ed25519): la entrada vieja no vuelve a disparar nada, así que un borrado
    /// equivocado pasaría en silencio. Debe irse la ECDSA de ese host y nada más.
    #[test]
    fn reemplazar_tras_un_cambio_de_algoritmo_conserva_las_lineas_ajenas() {
        let contents = format!(
            "# antiguo\nvecino.example {PUB_ED25519}\n# otro comentario\nalgo.example {PUB_ECDSA}\n"
        );
        let (kh, client) = kh_fixture(&contents, "algo.example", 22);
        let nueva = PublicKey::from_openssh(NUEVA).unwrap();
        let vecina = PublicKey::from_openssh(PUB_ED25519).unwrap();
        let seen = client.recorded_entries();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, 4);

        client.replace_known_hosts_entries(&seen, &nueva).expect("reemplazar");
        let after = std::fs::read_to_string(&kh).unwrap();
        assert!(!after.contains("ecdsa-sha2-nistp256"), "{after}");
        assert!(after.contains("# antiguo\nvecino.example"), "{after}");
        assert!(after.contains("# otro comentario\n"), "{after}");
        assert!(known_hosts::check_known_hosts_path("vecino.example", 22, &vecina, &kh).unwrap());
        assert!(known_hosts::check_known_hosts_path("algo.example", 22, &nueva, &kh).unwrap());
        cleanup(&kh);
    }

    /// Si mientras el usuario decidía otro programa cambió las entradas del host
    /// (`ssh-keygen -R`, OpenSSH, otra aceptación), aceptar no toca el fichero:
    /// los números que vio ya no valen.
    #[test]
    fn reemplazar_no_toca_nada_si_las_entradas_cambiaron_mientras_tanto() {
        let contents =
            format!("otro.example {PUB_ED25519}\n[cambia.example]:2222 {PUB_ED25519}\n");
        let (kh, client) = kh_fixture(&contents, "cambia.example", 2222);
        let nueva = PublicKey::from_openssh(NUEVA).unwrap();
        let seen = client.recorded_entries();

        // Alguien añade un comentario arriba y la entrada ya es otra clave,
        // distinta de la que el usuario acepta (si fuera la misma, known_hosts
        // ya estaría como quería: ver el test de aceptar dos veces).
        let movido =
            format!("# nuevo\notro.example {PUB_ED25519}\n[cambia.example]:2222 {PUB_ECDSA}\n");
        std::fs::write(&kh, &movido).unwrap();
        let err = client
            .replace_known_hosts_entries(&seen, &nueva)
            .expect_err("debe negarse");
        assert!(err.contains("ha cambiado mientras decidías"), "{err}");
        assert_eq!(std::fs::read_to_string(&kh).unwrap(), movido);
        cleanup(&kh);
    }

    /// La pregunta de la CLI: la huella, las líneas registradas y la ALERTA.
    #[test]
    fn la_pregunta_de_la_cli_lleva_la_huella_y_la_alerta() {
        let mut out = Vec::new();
        write_host_key_question(&mut out, "h.example", 2222, "SHA256:nueva", "ssh-ed25519", &[])
            .unwrap();
        let first = String::from_utf8(out).unwrap();
        assert!(first.contains("h.example:2222") && first.contains("SHA256:nueva"), "{first}");

        let mut out = Vec::new();
        let previous = vec![(7, "SHA256:vieja".to_string())];
        write_host_key_question(&mut out, "h.example", 22, "SHA256:nueva", "ssh-ed25519", &previous)
            .unwrap();
        let changed = String::from_utf8(out).unwrap();
        assert!(changed.contains("HA CAMBIADO"), "{changed}");
        assert!(changed.contains("línea 7): SHA256:vieja"), "{changed}");
    }

    /// La pregunta de host key de la CLI no puede ir por stdout: es el canal de
    /// la salida del comando y del `--json`, y con `> fichero` o `| jq` la
    /// pregunta (y la ALERTA de un cambio) se escondía ahí.
    #[test]
    fn la_pregunta_de_la_cli_no_escribe_en_stdout() {
        let src = include_str!("host_keys.rs");
        let start = src.find("fn confirm_on_stdin(").unwrap();
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        for forbidden in [" println!(", " print!(", "stdout()"] {
            assert!(!body.contains(forbidden), "confirm_on_stdin usa {forbidden}");
        }
        assert!(body.contains("stderr()"));
    }
}
