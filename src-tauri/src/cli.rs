//! CLI de Rustty: listar perfiles, abrir sesiones, ejecutar comandos en uno o
//! varios servidores y copiar ficheros por SFTP sin abrir la interfaz.
//!
//! Contrato de salida pensado para scripts:
//! - **Código de salida** = el del comando remoto (`ssh` semántica): `255` si
//!   la conexión o la autenticación fallan, `124` si se agota `--timeout`, `2`
//!   por uso incorrecto o perfil no encontrado. En multi-host: `0` si todos
//!   acabaron en `0`, `1` si alguno no.
//! - **stdout** lleva solo la salida del comando (o el JSON con `--json`); los
//!   avisos («Conectando a…»), las preguntas y los resúmenes van por stderr y
//!   `--quiet` los silencia.
//! - **stdin**: si es un terminal y no hay `--tty`, se cierra al momento (como
//!   `ssh -n`), para que un comando que lea de él no se quede colgado; si es una
//!   tubería o un fichero, se reenvía al comando (`--exec "bash -s" < f.sh`);
//!   `--script f.sh` lo manda por stdin a `bash -s`; `-n` lo cierra siempre.

use std::collections::HashMap;
use std::env;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use russh::client::{self, AuthResult};
use russh::keys::load_secret_key;
use russh::{ChannelMsg, Preferred};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::credentials::{self, CredentialKind, CredentialStore};
use crate::host_keys;
use crate::profiles::{AuthType, ConnectionProfile, PasswordSource, ProfileManager};
use crate::ssh_manager::{authenticate_handle, legacy_preferred, parse_jump_spec};
use crate::workspace_index;

use crate::keyring_scope::SERVICE as KEYRING_SERVICE;

/// Conexión o autenticación fallidas (misma convención que `ssh`).
pub const EXIT_CONNECT_FAILED: i32 = 255;
/// Se agotó `--timeout` (misma convención que `timeout(1)`).
pub const EXIT_TIMEOUT: i32 = 124;
/// Uso incorrecto, perfil no encontrado, secreto no disponible.
const EXIT_USAGE: i32 = 2;
/// Conexiones simultáneas por defecto en multi-host.
const DEFAULT_PARALLEL: usize = 4;

#[derive(Debug, PartialEq)]
enum CliCommand {
    List {
        json: bool,
        selector: HostSelector,
    },
    Connect {
        query: String,
        remote_command: Option<RemoteCommand>,
        selector: HostSelector,
        opts: RunOptions,
    },
    Run {
        selector: HostSelector,
        remote_command: RemoteCommand,
        opts: RunOptions,
    },
    Transfer {
        query: String,
        selector: HostSelector,
        op: TransferOp,
        opts: RunOptions,
    },
    Help,
    Invalid(String),
}

/// Qué perfiles entran en juego: por workspace (nombre o id), por grupo
/// (carpeta, con sus subcarpetas) o todos. Con `-c` acota la búsqueda.
#[derive(Debug, Default, Clone, PartialEq)]
struct HostSelector {
    workspace: Option<String>,
    group: Option<String>,
    all: bool,
}

impl HostSelector {
    fn is_empty(&self) -> bool {
        self.workspace.is_none() && self.group.is_none() && !self.all
    }
}

#[derive(Debug, Clone, PartialEq)]
struct RunOptions {
    json: bool,
    quiet: bool,
    timeout: Option<Duration>,
    parallel: usize,
    sudo: bool,
    no_stdin: bool,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            json: false,
            quiet: false,
            timeout: None,
            parallel: DEFAULT_PARALLEL,
            sudo: false,
            no_stdin: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct RemoteCommand {
    /// Comando tal como lo escribió el usuario (vacío con `--script`).
    command: String,
    tty: bool,
    /// Fichero local que viaja por stdin a `bash -s`.
    script: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
enum TransferOp {
    Get { remote: String, local: String },
    Put { local: String, remote: String },
}

#[derive(Debug)]
struct CliSecrets {
    password: Option<String>,
    passphrase: Option<String>,
}

/// De dónde sale el stdin del comando remoto.
#[derive(Debug, Clone, PartialEq)]
enum StdinMode {
    /// Reenviar el stdin local en vivo (sesión única con tubería o `--tty`).
    Inherit,
    /// Mandar estos bytes y cerrar (`--script`, o el stdin leído entero para
    /// repartirlo entre varios servidores).
    Bytes(Vec<u8>),
    /// Cerrar sin mandar nada (`-n`, o un stdin que es un terminal sin `--tty`).
    Closed,
}

/// Resultado de un `exec` sobre un canal ya abierto.
#[derive(Debug, Default, PartialEq)]
struct ExecOutcome {
    /// `None` si el servidor cerró el canal sin mandar código de salida.
    exit_code: Option<u32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug)]
enum ExecError {
    /// Conexión, autenticación o canal: el comando ni se ejecutó.
    Connect(String),
    Timeout(Duration),
    /// Falló escribir en el terminal local o leer stdin.
    Io(String),
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRef {
    id: String,
    name: String,
}

/// Fila de `--json` para ejecuciones: uno por servidor.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct HostResult {
    profile: String,
    name: String,
    host: String,
    username: String,
    workspace: WorkspaceRef,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u128,
    error: Option<String>,
}

/// Fila de `--json` para `--get`/`--put`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct TransferResult {
    profile: String,
    name: String,
    host: String,
    op: &'static str,
    local: String,
    remote: String,
    bytes: u64,
    duration_ms: u128,
    error: Option<String>,
}

struct RawModeGuard;

impl RawModeGuard {
    fn enter() -> Result<Self, String> {
        enable_raw_mode().map_err(|e| format!("No se pudo activar modo raw del terminal: {e}"))?;
        Ok(Self)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliProfile<'a> {
    id: &'a str,
    name: &'a str,
    host: &'a str,
    port: u16,
    username: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    group: Option<&'a str>,
    workspace: WorkspaceRef,
}

/// Perfiles cargados más el índice de nombres de workspace (`workspaces.json`,
/// que la interfaz mantiene al día; sin él, el nombre es el id).
struct Catalog {
    profiles: Vec<ConnectionProfile>,
    workspace_names: HashMap<String, String>,
}

impl Catalog {
    fn workspace_ref(&self, profile: &ConnectionProfile) -> WorkspaceRef {
        let id = profile.workspace_id.clone();
        let name = self
            .workspace_names
            .get(&id)
            .cloned()
            .unwrap_or_else(|| id.clone());
        WorkspaceRef { id, name }
    }
}

pub fn try_run_from_env() -> Option<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = parse_cli_command(&args)?;
    let code = match run_cli(command) {
        Ok(code) => code,
        Err(err) => {
            eprintln!("{err}");
            EXIT_USAGE
        }
    };
    Some(code)
}

/// Primer argumento que convierte la invocación en CLI. Cualquier otro (p. ej.
/// `--minimized` del autostart, o un fichero) es de la interfaz gráfica.
const CLI_ENTRY_FLAGS: &[&str] = &[
    "-l",
    "--list",
    "-c",
    "--connect",
    "-h",
    "--help",
    "--workspace",
    "--group",
    "--all",
];

fn parse_cli_command(args: &[String]) -> Option<CliCommand> {
    let first = args.first()?.as_str();
    if !CLI_ENTRY_FLAGS.contains(&first) {
        return None;
    }
    Some(parse_cli_args(args))
}

fn invalid(message: impl Into<String>) -> CliCommand {
    CliCommand::Invalid(message.into())
}

/// Parseo completo. Las opciones pueden ir en cualquier orden; `--exec` toma un
/// argumento (los sueltos que sigan se le añaden, como antes) y `--` el resto.
fn parse_cli_args(args: &[String]) -> CliCommand {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut list = false;
    let mut help = false;
    let mut query: Option<String> = None;
    let mut selector = HostSelector::default();
    let mut opts = RunOptions::default();
    let mut tty = false;
    let mut script: Option<PathBuf> = None;
    let mut command: Option<String> = None;
    let mut transfer: Option<TransferOp> = None;

    fn value<'a>(args: &[&'a str], i: usize, flag: &str) -> Result<&'a str, String> {
        match args.get(i) {
            Some(v) if !v.is_empty() => Ok(v),
            _ => Err(format!("{flag} necesita un valor.")),
        }
    }

    let mut i = 0;
    while i < args.len() {
        let arg = args[i];
        match arg {
            "-l" | "--list" => list = true,
            "-h" | "--help" => help = true,
            "--json" => opts.json = true,
            "-q" | "--quiet" => opts.quiet = true,
            "-t" | "--tty" => tty = true,
            "--sudo" => opts.sudo = true,
            "-n" | "--no-stdin" => opts.no_stdin = true,
            "--all" => selector.all = true,
            "-c" | "--connect" => {
                i += 1;
                match value(&args, i, "-c") {
                    Ok(v) => query = Some(v.to_string()),
                    Err(_) => return invalid("Indica una busqueda para -c."),
                }
            }
            "--workspace" | "-w" => {
                i += 1;
                match value(&args, i, "--workspace") {
                    Ok(v) => selector.workspace = Some(v.to_string()),
                    Err(e) => return invalid(e),
                }
            }
            "--group" | "-g" => {
                i += 1;
                match value(&args, i, "--group") {
                    Ok(v) => selector.group = Some(v.to_string()),
                    Err(e) => return invalid(e),
                }
            }
            "--timeout" => {
                i += 1;
                let raw = match value(&args, i, "--timeout") {
                    Ok(v) => v,
                    Err(e) => return invalid(e),
                };
                match raw.parse::<u64>() {
                    Ok(secs) if secs > 0 => opts.timeout = Some(Duration::from_secs(secs)),
                    _ => return invalid("--timeout espera un numero de segundos mayor que 0."),
                }
            }
            "--parallel" => {
                i += 1;
                let raw = match value(&args, i, "--parallel") {
                    Ok(v) => v,
                    Err(e) => return invalid(e),
                };
                match raw.parse::<usize>() {
                    Ok(n) if n > 0 => opts.parallel = n,
                    _ => return invalid("--parallel espera un numero mayor que 0."),
                }
            }
            "--script" => {
                i += 1;
                match value(&args, i, "--script") {
                    Ok(v) => script = Some(PathBuf::from(v)),
                    Err(e) => return invalid(e),
                }
            }
            "--get" | "--put" => {
                let (a, b) = match (args.get(i + 1), args.get(i + 2)) {
                    (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => (*a, *b),
                    _ => {
                        return invalid(format!(
                            "{arg} necesita dos rutas: {}.",
                            if arg == "--get" {
                                "--get <remoto> <local>"
                            } else {
                                "--put <local> <remoto>"
                            }
                        ))
                    }
                };
                if transfer.is_some() {
                    return invalid("Solo se admite una operacion --get/--put por invocacion.");
                }
                transfer = Some(if arg == "--get" {
                    TransferOp::Get {
                        remote: a.to_string(),
                        local: b.to_string(),
                    }
                } else {
                    TransferOp::Put {
                        local: a.to_string(),
                        remote: b.to_string(),
                    }
                });
                i += 2;
            }
            "-e" | "--exec" => {
                i += 1;
                match value(&args, i, "--exec") {
                    Ok(v) => command = Some(v.to_string()),
                    Err(_) => return invalid("Indica el comando remoto despues de --exec o --."),
                }
            }
            "--" => {
                let rest = args[i + 1..].join(" ");
                if rest.trim().is_empty() {
                    return invalid("Indica el comando remoto despues de --exec o --.");
                }
                command = Some(rest.trim().to_string());
                break;
            }
            other if other.starts_with('-') && other.len() > 1 => {
                return invalid(format!("Opcion CLI desconocida: {other}"));
            }
            positional => {
                // Alias breve (`rustty -c prod "df -h"`) o palabras sueltas tras
                // `--exec` sin comillas: se van sumando al comando.
                match &mut command {
                    Some(cmd) => {
                        cmd.push(' ');
                        cmd.push_str(positional);
                    }
                    None if query.is_some() && !list => {
                        command = Some(positional.to_string());
                    }
                    None => return invalid(format!("Argumento inesperado: {positional}")),
                }
            }
        }
        i += 1;
    }

    if help {
        return CliCommand::Help;
    }
    if let Some(cmd) = &command {
        if cmd.trim().is_empty() {
            return invalid("El comando remoto no puede estar vacio.");
        }
    }
    if list {
        if command.is_some() || script.is_some() || transfer.is_some() {
            return invalid("-l no se combina con --exec, --script, --get ni --put.");
        }
        return CliCommand::List {
            json: opts.json,
            selector,
        };
    }
    if let Some(op) = transfer {
        if command.is_some() || script.is_some() {
            return invalid("--get/--put no se combinan con --exec ni --script.");
        }
        let Some(query) = query else {
            return invalid("--get/--put necesitan -c <perfil>.");
        };
        return CliCommand::Transfer {
            query,
            selector,
            op,
            opts,
        };
    }
    let remote_command = match (command, script) {
        (Some(_), Some(_)) => {
            return invalid("--script y --exec son excluyentes: el script ya es el comando.")
        }
        (Some(command), None) => Some(RemoteCommand {
            command: command.trim().to_string(),
            tty,
            script: None,
        }),
        (None, Some(path)) => Some(RemoteCommand {
            command: String::new(),
            tty,
            script: Some(path),
        }),
        (None, None) => None,
    };
    match (query, remote_command) {
        (Some(query), remote_command) => CliCommand::Connect {
            query,
            remote_command,
            selector,
            opts,
        },
        (None, Some(remote_command)) if !selector.is_empty() => {
            if tty {
                return invalid("--tty solo vale con -c <perfil>, no en multi-host.");
            }
            CliCommand::Run {
                selector,
                remote_command,
                opts,
            }
        }
        (None, Some(_)) => invalid("Indica -c <perfil>, --workspace <x>, --group <x> o --all."),
        (None, None) => invalid("Con --workspace, --group o --all hace falta --exec o --script."),
    }
}

fn run_cli(command: CliCommand) -> Result<i32, String> {
    match command {
        CliCommand::List { json, selector } => {
            list_profiles(json, &selector)?;
            Ok(0)
        }
        CliCommand::Connect {
            query,
            remote_command,
            selector,
            opts,
        } => connect_single(&query, remote_command, &selector, opts),
        CliCommand::Run {
            selector,
            remote_command,
            opts,
        } => run_many(&selector, remote_command, opts),
        CliCommand::Transfer {
            query,
            selector,
            op,
            opts,
        } => run_transfer_command(&query, &selector, op, opts),
        CliCommand::Help => {
            print_help();
            Ok(0)
        }
        CliCommand::Invalid(message) => Err(message),
    }
}

fn print_help() {
    println!(
        r#"Rustty CLI (SSH/SFTP)

Uso:
  rustty -l | --list [--json]                 Lista conexiones SSH/SFTP guardadas, con su workspace
  rustty -l --workspace <w> | --group <g>     Solo las de ese workspace (nombre o id) o carpeta
  rustty -c <nombre|id|ip|host>               Conecta sin abrir la interfaz grafica
  rustty -c <perfil> --exec "cmd"             Ejecuta un comando remoto y sale con su codigo
  rustty -c <perfil> -- cmd                   Ejecuta un comando remoto y sale
  rustty -c <perfil> --tty -- cmd             Ejecuta con pseudo-terminal (stdin interactivo)
  rustty -c <perfil> --script f.sh            Manda el script local por stdin a bash -s
  rustty -c <perfil> --get <remoto> <local>   Descarga un fichero por SFTP
  rustty -c <perfil> --put <local> <remoto>   Sube un fichero por SFTP
  rustty --workspace <w> --exec "cmd"         Ejecuta en todos los perfiles SSH del workspace
  rustty --group <g> --exec "cmd"             ...o de la carpeta (y subcarpetas); --all = todos

Opciones:
  --json          Salida JSON: listado, o un objeto por servidor (salida, codigo, duracion)
  -q, --quiet     Sin avisos por stderr ("Conectando a...", resumenes)
  --timeout <s>   Limite por servidor, en segundos; al agotarse sale con 124
  --parallel <n>  Conexiones simultaneas en multi-host (por defecto {DEFAULT_PARALLEL})
  --sudo          Ejecuta con sudo -n (sin --tty exige NOPASSWD)
  -n, --no-stdin  No reenvia stdin al comando remoto (como ssh -n)

Codigos de salida: el del comando remoto; 255 si no conecta; 124 por --timeout; 2 por uso
incorrecto. En multi-host, 0 si todos acabaron en 0 y 1 si alguno no. Sin --tty, un stdin
que es un terminal se cierra al instante; una tuberia o un fichero se reenvian."#
    );
}

// ─── Catálogo y selección ─────────────────────────────────────────────────────

fn load_catalog() -> Result<Catalog, String> {
    let data_dir = crate::resolve_data_dir();
    let profiles = ProfileManager::new(data_dir.clone())
        .load_all()
        .map_err(|e| format!("No se pudieron cargar los perfiles: {e}"))?;
    let workspace_names = workspace_index::name_map(&workspace_index::load(&data_dir));
    Ok(Catalog {
        profiles,
        workspace_names,
    })
}

/// SSH puro: admite `--exec`, sesión interactiva y SFTP.
fn is_ssh_profile(profile: &ConnectionProfile) -> bool {
    profile.connection_type.trim().is_empty() || profile.connection_type.eq_ignore_ascii_case("ssh")
}

/// Perfil que la CLI sabe usar: SSH, o SFTP (solo `--get`/`--put`, p. ej. un
/// StorageBox sin shell).
fn is_cli_profile(profile: &ConnectionProfile) -> bool {
    is_ssh_profile(profile) || profile.connection_type.eq_ignore_ascii_case("sftp")
}

fn profile_kind(profile: &ConnectionProfile) -> &'static str {
    if is_ssh_profile(profile) {
        "ssh"
    } else {
        "sftp"
    }
}

/// ¿El perfil cae dentro del selector? El workspace casa por nombre o por id
/// (sin distinguir mayúsculas); el grupo, por igualdad o como carpeta padre
/// (`Producción` incluye `Producción/Web`).
fn matches_selector(
    profile: &ConnectionProfile,
    selector: &HostSelector,
    workspace_names: &HashMap<String, String>,
) -> bool {
    if let Some(ws) = &selector.workspace {
        let name = workspace_names
            .get(&profile.workspace_id)
            .map(String::as_str)
            .unwrap_or("");
        if !(profile.workspace_id.eq_ignore_ascii_case(ws) || name.eq_ignore_ascii_case(ws)) {
            return false;
        }
    }
    if let Some(group) = &selector.group {
        let wanted = group.trim().trim_matches('/').to_ascii_lowercase();
        let actual = profile
            .group
            .as_deref()
            .unwrap_or("")
            .trim()
            .trim_matches('/')
            .to_ascii_lowercase();
        if !(actual == wanted || actual.starts_with(&format!("{wanted}/"))) {
            return false;
        }
    }
    true
}

/// Perfiles utilizables desde la CLI que casan con el selector, ordenados por
/// nombre. Con un workspace que no existe, el error lista los disponibles.
fn select_profiles<'a>(
    catalog: &'a Catalog,
    selector: &HostSelector,
) -> Result<Vec<&'a ConnectionProfile>, String> {
    let mut items: Vec<&ConnectionProfile> = catalog
        .profiles
        .iter()
        .filter(|p| is_cli_profile(p) && matches_selector(p, selector, &catalog.workspace_names))
        .collect();
    items.sort_by_key(|p| p.name.to_ascii_lowercase());
    if items.is_empty() {
        if let Some(ws) = &selector.workspace {
            let known = catalog
                .profiles
                .iter()
                .any(|p| p.workspace_id.eq_ignore_ascii_case(ws))
                || catalog
                    .workspace_names
                    .iter()
                    .any(|(id, name)| id.eq_ignore_ascii_case(ws) || name.eq_ignore_ascii_case(ws));
            if !known {
                let mut names: Vec<String> = catalog
                    .profiles
                    .iter()
                    .map(|p| {
                        catalog
                            .workspace_names
                            .get(&p.workspace_id)
                            .cloned()
                            .unwrap_or_else(|| p.workspace_id.clone())
                    })
                    .collect();
                names.sort_by_key(|n| n.to_ascii_lowercase());
                names.dedup();
                return Err(format!(
                    "No existe el workspace '{ws}'. Disponibles: {}",
                    names.join(", ")
                ));
            }
        }
    }
    Ok(items)
}

fn list_profiles(json: bool, selector: &HostSelector) -> Result<(), String> {
    let catalog = load_catalog()?;
    let profiles = select_profiles(&catalog, selector)?;
    if json {
        let items: Vec<CliProfile<'_>> = profiles
            .iter()
            .map(|p| CliProfile {
                id: &p.id,
                name: &p.name,
                host: &p.host,
                port: p.port,
                username: &p.username,
                kind: profile_kind(p),
                group: p.group.as_deref(),
                workspace: catalog.workspace_ref(p),
            })
            .collect();
        let payload = serde_json::to_string_pretty(&items)
            .map_err(|e| format!("No se pudo generar JSON: {e}"))?;
        println!("{payload}");
        return Ok(());
    }

    if profiles.is_empty() {
        println!("No hay conexiones SSH/SFTP guardadas que casen.");
        return Ok(());
    }

    let width = |min: usize, f: &dyn Fn(&ConnectionProfile) -> usize| {
        profiles.iter().map(|p| f(p)).max().unwrap_or(min).max(min)
    };
    let name_w = width(6, &|p| p.name.chars().count());
    let host_w = width(7, &|p| p.host.chars().count());
    let user_w = width(7, &|p| p.username.chars().count());
    let ws_w = width(9, &|p| catalog.workspace_ref(p).name.chars().count());

    println!(
        "{:<name_w$}  {:<host_w$}  {:<user_w$}  {:>6}  {:<4}  {:<ws_w$}  GRUPO",
        "NOMBRE", "HOST/IP", "USUARIO", "PUERTO", "TIPO", "WORKSPACE",
    );
    println!(
        "{:-<name_w$}  {:-<host_w$}  {:-<user_w$}  ------  ----  {:-<ws_w$}  -----",
        "", "", "", "",
    );
    for profile in profiles {
        println!(
            "{:<name_w$}  {:<host_w$}  {:<user_w$}  {:>6}  {:<4}  {:<ws_w$}  {}",
            profile.name,
            profile.host,
            profile.username,
            profile.port,
            profile_kind(profile),
            catalog.workspace_ref(profile).name,
            profile.group.as_deref().unwrap_or(""),
        );
    }
    Ok(())
}

fn find_profile<'a>(
    candidates: &[&'a ConnectionProfile],
    query: &str,
) -> Result<&'a ConnectionProfile, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Indica una busqueda para -c.".into());
    }
    if candidates.is_empty() {
        return Err("No hay conexiones SSH/SFTP guardadas que casen.".into());
    }

    let query_l = query.to_ascii_lowercase();
    let exact: Vec<&ConnectionProfile> = candidates
        .iter()
        .copied()
        .filter(|p| {
            p.id.eq_ignore_ascii_case(query)
                || p.name.eq_ignore_ascii_case(query)
                || p.host.eq_ignore_ascii_case(query)
        })
        .collect();
    if let Some(profile) = single_or_ambiguous(&exact, query)? {
        return Ok(profile);
    }

    let partial: Vec<&ConnectionProfile> = candidates
        .iter()
        .copied()
        .filter(|p| {
            p.name.to_ascii_lowercase().contains(&query_l)
                || p.host.to_ascii_lowercase().contains(&query_l)
                || p.username.to_ascii_lowercase().contains(&query_l)
                || p.group
                    .as_deref()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .contains(&query_l)
        })
        .collect();
    if let Some(profile) = single_or_ambiguous(&partial, query)? {
        return Ok(profile);
    }

    Err(format!(
        "No se encontro ninguna conexion SSH/SFTP para '{query}'."
    ))
}

fn single_or_ambiguous<'a>(
    matches: &[&'a ConnectionProfile],
    query: &str,
) -> Result<Option<&'a ConnectionProfile>, String> {
    match matches {
        [] => Ok(None),
        [profile] => Ok(Some(*profile)),
        many => {
            let mut message =
                format!("La busqueda '{query}' coincide con varias conexiones:\n");
            for profile in many.iter().take(12) {
                message.push_str(&format!(
                    "  - {}  {}@{}:{}\n",
                    profile.name, profile.username, profile.host, profile.port
                ));
            }
            message.push_str(
                "Afina la busqueda usando el nombre completo, id o host/IP, o acota con --workspace/--group.",
            );
            Err(message)
        }
    }
}

// ─── Secretos ─────────────────────────────────────────────────────────────────

fn resolve_secrets(profile: &ConnectionProfile) -> Result<CliSecrets, String> {
    let password = match profile.auth_type {
        AuthType::Password => {
            // Credencial maestra: resolvemos su valor del keyring vía catálogo.
            // KeePass-en-CLI queda fuera de alcance (no hay DB desbloqueada sin
            // la app); para esos perfiles caemos al prompt/keyring habitual.
            if profile.password_source == PasswordSource::Master {
                Some(resolve_master_secret(profile)?)
            } else {
                let stored = read_keyring_secret(&format!("password:{}", profile.id));
                let prompt = format!("Contrasena para {}@{}: ", profile.username, profile.host);
                let value = stored
                    .unwrap_or_else(|| prompt_secret(&prompt))
                    .map_err(|e| {
                        format!("No se pudo obtener la contrasena de {}: {e}", profile.name)
                    })?;
                // La contraseña propia pasa por el motor de sustitución, igual que
                // en la GUI: soporta `${var:}`/`${secret:}`/`${master:}`. Sin este
                // paso, un perfil cuya contraseña es un marcador conecta en la app
                // pero envía el marcador literal desde `rustty -c`.
                Some(resolve_password_markers(profile, value)?)
            }
        }
        // La interactiva no tiene secreto que resolver por adelantado: las
        // respuestas las pregunta el servidor durante la conexión.
        AuthType::PublicKey | AuthType::Agent | AuthType::KeyboardInteractive => None,
    };

    let passphrase = match profile.auth_type {
        AuthType::PublicKey => resolve_passphrase(profile)?,
        AuthType::Password | AuthType::Agent | AuthType::KeyboardInteractive => None,
    };

    Ok(CliSecrets {
        password,
        passphrase,
    })
}

/// Aplica el motor de sustitución a una contraseña «propia» leída del keyring:
/// resuelve `${var:}`/`${secret:}`/`${master:}` construyendo el catálogo de
/// credenciales sobre el directorio de datos. Sin marcadores devuelve el texto
/// tal cual (el motor es de una sola pasada). `${ask:}` no se puede resolver sin
/// diálogo, así que en CLI queda sin respuestas (mapa vacío).
fn resolve_password_markers(profile: &ConnectionProfile, raw: String) -> Result<String, String> {
    if !raw.contains("${") {
        return Ok(raw);
    }
    let data_dir = crate::resolve_data_dir();
    let store = CredentialStore::new(data_dir);
    let catalog = store.load_all().map_err(|e| e.to_string())?;
    let ctx = crate::subst::SubstContext::from_profile(profile);
    let resolver = credentials::CredentialResolver::with_ask_answers(
        ctx,
        catalog,
        std::collections::HashMap::new(),
    );
    Ok(crate::subst::substitute(&raw, &resolver))
}

/// Resuelve el valor de la credencial maestra referenciada por el perfil
/// (`password_source == Master`) construyendo un `CredentialStore` sobre el
/// directorio de datos y leyendo `master:<id>` del keyring.
fn resolve_master_secret(profile: &ConnectionProfile) -> Result<String, String> {
    let id = profile
        .master_credential_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "El perfil {} no referencia ninguna credencial maestra",
                profile.name
            )
        })?;
    let data_dir = crate::resolve_data_dir();
    let store = CredentialStore::new(data_dir);
    let catalog = store.load_all().map_err(|e| e.to_string())?;
    let cred = catalog
        .iter()
        .find(|c| c.id == id && c.kind == CredentialKind::Master)
        .ok_or_else(|| "Credencial maestra no encontrada".to_string())?;
    credentials::resolve_master(&catalog, &cred.name)
        .ok_or_else(|| "Credencial maestra no encontrada".to_string())
}

fn resolve_passphrase(profile: &ConnectionProfile) -> Result<Option<String>, String> {
    if let Some(stored) = read_keyring_secret(&format!("passphrase:{}", profile.id)) {
        return stored.map(Some);
    }

    let Some(key_path) = profile.key_path.as_deref().filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    if load_secret_key(Path::new(key_path), None).is_ok() {
        return Ok(None);
    }

    let prompt = format!("Passphrase para la clave de {}: ", profile.name);
    prompt_secret(&prompt).map(Some)
}

fn read_keyring_secret(key: &str) -> Option<Result<String, String>> {
    let entry = match keyring::Entry::new(KEYRING_SERVICE, key) {
        Ok(entry) => entry,
        Err(err) => return Some(Err(err.to_string())),
    };
    match entry.get_password() {
        Ok(secret) => {
            #[cfg(target_os = "linux")]
            {
                let _ = entry.set_password(&secret);
            }
            Some(Ok(secret))
        }
        Err(keyring::Error::NoEntry) => None,
        Err(err) => Some(Err(err.to_string())),
    }
}

/// Pregunta un secreto por stderr, no por stdout: la salida del comando queda
/// limpia para tuberías y `--json` aunque haya que pedir una contraseña.
fn prompt_secret(prompt: &str) -> Result<String, String> {
    use std::io::Write;
    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    rpassword::read_password().map_err(|e| e.to_string())
}

// ─── Configuración de conexión ────────────────────────────────────────────────

fn client_config(profile: &ConnectionProfile) -> Arc<client::Config> {
    let keepalive_interval = profile
        .keep_alive_secs
        .filter(|secs| *secs > 0)
        .map(|secs| Duration::from_secs(secs as u64))
        .unwrap_or_else(|| Duration::from_secs(crate::ssh_manager::DEFAULT_SSH_KEEPALIVE_SECS));
    let preferred = if profile.allow_legacy_algorithms {
        legacy_preferred(profile.legacy_algorithms.as_deref())
    } else {
        Preferred::default()
    };
    Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        keepalive_interval: Some(keepalive_interval),
        keepalive_max: crate::ssh_manager::DEFAULT_SSH_KEEPALIVE_MAX,
        preferred,
        ..Default::default()
    })
}

fn announce(profile: &ConnectionProfile, opts: &RunOptions) {
    if opts.quiet || opts.json {
        return;
    }
    eprintln!(
        "Conectando a {} ({}@{}:{})...",
        profile.name, profile.username, profile.host, profile.port
    );
}

fn build_runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("No se pudo crear runtime tokio: {e}"))
}

// ─── Sesión interactiva ───────────────────────────────────────────────────────

async fn run_ssh_session(profile: ConnectionProfile, secrets: CliSecrets) -> Result<(), String> {
    let config = client_config(&profile);
    let mut handle = connect_handle(&profile, config, &secrets).await?;
    authenticate_target(&mut handle, &profile, &secrets).await?;

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("No se pudo abrir canal SSH: {e}"))?;

    if profile.agent_forwarding {
        let _ = channel.agent_forward(false).await;
    }

    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    let term = env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
    channel
        .request_pty(true, &term, cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| format!("No se pudo solicitar PTY: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("No se pudo abrir shell: {e}"))?;

    let _raw = RawModeGuard::enter()?;
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut stdin_buf = [0u8; 8192];

    loop {
        tokio::select! {
            read = stdin.read(&mut stdin_buf) => {
                let n = read.map_err(|e| format!("Error leyendo stdin: {e}"))?;
                if n == 0 {
                    let _ = channel.eof().await;
                    break;
                }
                channel
                    .data(&stdin_buf[..n])
                    .await
                    .map_err(|e| format!("Error enviando datos al servidor: {e}"))?;
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        stdout
                            .write_all(&data)
                            .await
                            .map_err(|e| format!("Error escribiendo stdout: {e}"))?;
                        stdout
                            .flush()
                            .await
                            .map_err(|e| format!("Error vaciando stdout: {e}"))?;
                    }
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => break,
                    Some(_) => {}
                    None => break,
                }
            }
        }
    }

    let _ = channel.close().await;
    Ok(())
}

// ─── Ejecución remota ─────────────────────────────────────────────────────────

/// Comando que se manda de verdad: `--script` corre en `bash -s` y `--sudo`
/// envuelve con `sudo` (`-n` salvo con `--tty`, donde sudo puede preguntar).
fn effective_command(remote: &RemoteCommand, sudo: bool) -> String {
    let base = if remote.script.is_some() {
        "bash -s".to_string()
    } else {
        remote.command.clone()
    };
    if !sudo {
        return base;
    }
    let flag = if remote.tty { "" } else { "-n " };
    if remote.script.is_some() {
        format!("sudo {flag}bash -s")
    } else {
        format!("sudo {flag}sh -c {}", shell_single_quote(&base))
    }
}

/// Entrecomillado POSIX con comillas simples: `it's` → `'it'\''s'`.
fn shell_single_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Decide de dónde sale el stdin del comando, leyendo el script si lo hay.
/// `many` = se va a repartir entre varios servidores, así que una tubería se
/// lee entera una vez en vez de reenviarse en vivo.
fn stdin_mode(remote: &RemoteCommand, opts: &RunOptions, many: bool) -> Result<StdinMode, String> {
    if let Some(path) = &remote.script {
        let bytes = std::fs::read(path)
            .map_err(|e| format!("No se pudo leer el script {}: {e}", path.display()))?;
        return Ok(StdinMode::Bytes(bytes));
    }
    if opts.no_stdin {
        return Ok(StdinMode::Closed);
    }
    if std::io::stdin().is_terminal() {
        // Un terminal sin --tty no tiene nada que decirle al comando: cerrar ya
        // evita que `plesk db`, `cat` o `mysql` se queden esperando para siempre.
        return Ok(if remote.tty && !many {
            StdinMode::Inherit
        } else {
            StdinMode::Closed
        });
    }
    if many {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Error leyendo stdin: {e}"))?;
        return Ok(StdinMode::Bytes(bytes));
    }
    Ok(StdinMode::Inherit)
}

/// Conecta, autentica y ejecuta. Los errores previos al `exec` son `Connect`
/// (código 255); el código del comando viene en el `ExecOutcome`.
async fn exec_remote(
    profile: &ConnectionProfile,
    secrets: &CliSecrets,
    remote: &RemoteCommand,
    stdin: StdinMode,
    opts: &RunOptions,
    capture: bool,
) -> Result<ExecOutcome, ExecError> {
    let config = client_config(profile);
    let mut handle = connect_handle(profile, config, secrets)
        .await
        .map_err(ExecError::Connect)?;
    authenticate_target(&mut handle, profile, secrets)
        .await
        .map_err(ExecError::Connect)?;
    let command = effective_command(remote, opts.sudo);
    exec_on_handle(
        &mut handle,
        &command,
        remote.tty,
        profile.agent_forwarding,
        stdin,
        capture,
    )
    .await
}

/// Abre un canal `exec` sobre una conexión autenticada y lo lleva hasta el
/// cierre. Con `capture`, stdout/stderr se acumulan en vez de escribirse en el
/// terminal (para `--json` y para no mezclar servidores en multi-host).
///
/// El código de salida llega en `ExitStatus`, que el servidor manda **después**
/// del `Eof`: por eso el `Eof` no termina el bucle (era el bug del 255 fijo).
async fn exec_on_handle(
    handle: &mut client::Handle<host_keys::KnownHostsClient>,
    command: &str,
    tty: bool,
    agent_forwarding: bool,
    stdin: StdinMode,
    capture: bool,
) -> Result<ExecOutcome, ExecError> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| ExecError::Connect(format!("No se pudo abrir canal SSH: {e}")))?;

    if agent_forwarding {
        let _ = channel.agent_forward(false).await;
    }

    let _raw = if tty {
        let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
        let term = env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
        channel
            .request_pty(true, &term, cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| ExecError::Connect(format!("No se pudo solicitar PTY: {e}")))?;
        Some(RawModeGuard::enter().map_err(ExecError::Io)?)
    } else {
        None
    };

    channel
        .exec(true, command)
        .await
        .map_err(|e| ExecError::Connect(format!("No se pudo ejecutar el comando remoto: {e}")))?;

    let mut inherit_stdin = false;
    match stdin {
        StdinMode::Inherit => inherit_stdin = true,
        StdinMode::Bytes(bytes) => {
            if !bytes.is_empty() {
                channel
                    .data(&bytes[..])
                    .await
                    .map_err(|e| ExecError::Io(format!("Error enviando stdin al comando remoto: {e}")))?;
            }
            let _ = channel.eof().await;
        }
        StdinMode::Closed => {
            let _ = channel.eof().await;
        }
    }

    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut stderr = tokio::io::stderr();
    let mut stdin_buf = [0u8; 8192];
    let mut stdin_closed = !inherit_stdin;
    let mut outcome = ExecOutcome::default();
    let mut remote_eof = false;

    loop {
        tokio::select! {
            read = stdin.read(&mut stdin_buf), if !stdin_closed => {
                match read {
                    Ok(0) => {
                        stdin_closed = true;
                        let _ = channel.eof().await;
                    }
                    Ok(n) => {
                        channel
                            .data(&stdin_buf[..n])
                            .await
                            .map_err(|e| ExecError::Io(format!("Error enviando stdin al comando remoto: {e}")))?;
                    }
                    Err(e) => return Err(ExecError::Io(format!("Error leyendo stdin: {e}"))),
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if capture {
                            outcome.stdout.extend_from_slice(&data);
                        } else {
                            stdout.write_all(&data).await.map_err(|e| ExecError::Io(format!("Error escribiendo stdout: {e}")))?;
                            stdout.flush().await.map_err(|e| ExecError::Io(format!("Error vaciando stdout: {e}")))?;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if capture {
                            outcome.stderr.extend_from_slice(&data);
                        } else {
                            stderr.write_all(&data).await.map_err(|e| ExecError::Io(format!("Error escribiendo stderr: {e}")))?;
                            stderr.flush().await.map_err(|e| ExecError::Io(format!("Error vaciando stderr: {e}")))?;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        outcome.exit_code = Some(exit_status);
                        if !stdin_closed {
                            stdin_closed = true;
                            let _ = channel.eof().await;
                        }
                        if remote_eof {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitSignal { .. }) => {
                        outcome.exit_code = Some(EXIT_CONNECT_FAILED as u32);
                        if !stdin_closed {
                            stdin_closed = true;
                            let _ = channel.eof().await;
                        }
                        if remote_eof {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) => {
                        // El servidor ya no manda más salida, pero el código de
                        // salida viene detrás: seguimos hasta tenerlo o hasta Close.
                        remote_eof = true;
                        if outcome.exit_code.is_some() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
        }
    }

    let _ = channel.close().await;
    Ok(outcome)
}

fn normalize_exit_code(code: u32) -> i32 {
    code.min(255) as i32
}

/// Ejecuta en un servidor con `--timeout` y devuelve siempre un `HostResult`:
/// el fallo se cuenta, no se propaga (en multi-host, un servidor caído no
/// impide ver los demás).
async fn run_host(
    profile: ConnectionProfile,
    secrets: Result<CliSecrets, String>,
    remote: RemoteCommand,
    stdin: StdinMode,
    opts: RunOptions,
    capture: bool,
    workspace: WorkspaceRef,
) -> HostResult {
    let started = Instant::now();
    let mut result = HostResult {
        profile: profile.id.clone(),
        name: profile.name.clone(),
        host: profile.host.clone(),
        username: profile.username.clone(),
        workspace,
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        duration_ms: 0,
        error: None,
    };
    let secrets = match secrets {
        Ok(s) => s,
        Err(err) => {
            result.error = Some(err);
            result.exit_code = Some(EXIT_CONNECT_FAILED);
            result.duration_ms = started.elapsed().as_millis();
            return result;
        }
    };
    let fut = exec_remote(&profile, &secrets, &remote, stdin, &opts, capture);
    let outcome = match opts.timeout {
        Some(limit) => match tokio::time::timeout(limit, fut).await {
            Ok(r) => r,
            Err(_) => Err(ExecError::Timeout(limit)),
        },
        None => fut.await,
    };
    result.duration_ms = started.elapsed().as_millis();
    match outcome {
        Ok(out) => {
            // Sin código de salida (canal cerrado a secas): 255, como ssh.
            result.exit_code = Some(normalize_exit_code(
                out.exit_code.unwrap_or(EXIT_CONNECT_FAILED as u32),
            ));
            result.stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            result.stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        }
        Err(ExecError::Connect(err)) => {
            result.error = Some(err);
            result.exit_code = Some(EXIT_CONNECT_FAILED);
        }
        Err(ExecError::Timeout(limit)) => {
            result.error = Some(format!("Tiempo agotado tras {} s", limit.as_secs()));
            result.exit_code = Some(EXIT_TIMEOUT);
        }
        Err(ExecError::Io(err)) => {
            result.error = Some(err);
            result.exit_code = Some(EXIT_CONNECT_FAILED);
        }
    }
    result
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(value)
        .map_err(|e| format!("No se pudo generar JSON: {e}"))?;
    println!("{payload}");
    Ok(())
}

/// Salida agrupada de un servidor en multi-host sin `--json`: cabecera y
/// resumen por stderr, la salida del comando por donde le toca.
fn print_grouped(result: &HostResult, quiet: bool) {
    use std::io::Write;
    if !quiet {
        eprintln!("==> {} ({}@{})", result.name, result.username, result.host);
    }
    if !result.stdout.is_empty() {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(result.stdout.as_bytes());
        let _ = out.flush();
    }
    if !result.stderr.is_empty() {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(result.stderr.as_bytes());
        let _ = err.flush();
    }
    if let Some(error) = &result.error {
        eprintln!("{}: {error}", result.name);
    }
    if !quiet {
        eprintln!(
            "<== {}: codigo {} en {} ms",
            result.name,
            result
                .exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".to_string()),
            result.duration_ms
        );
    }
}

fn connect_single(
    query: &str,
    remote_command: Option<RemoteCommand>,
    selector: &HostSelector,
    opts: RunOptions,
) -> Result<i32, String> {
    let catalog = load_catalog()?;
    let candidates = select_profiles(&catalog, selector)?;
    let profile = find_profile(&candidates, query)?.clone();
    if remote_command.is_some() && !is_ssh_profile(&profile) {
        return Err(format!(
            "'{}' es un perfil SFTP sin shell: usa --get/--put.",
            profile.name
        ));
    }
    let workspace = catalog.workspace_ref(&profile);
    let runtime = build_runtime()?;
    match remote_command {
        None => {
            if !is_ssh_profile(&profile) {
                return Err(format!(
                    "'{}' es un perfil SFTP sin shell: usa --get/--put.",
                    profile.name
                ));
            }
            let secrets = resolve_secrets(&profile)?;
            announce(&profile, &opts);
            match runtime.block_on(run_ssh_session(profile, secrets)) {
                Ok(()) => Ok(0),
                Err(err) => {
                    eprintln!("{err}");
                    Ok(EXIT_CONNECT_FAILED)
                }
            }
        }
        Some(remote) => {
            let secrets = resolve_secrets(&profile);
            let stdin = stdin_mode(&remote, &opts, false)?;
            announce(&profile, &opts);
            let capture = opts.json;
            let result = runtime.block_on(run_host(
                profile, secrets, remote, stdin, opts.clone(), capture, workspace,
            ));
            if opts.json {
                print_json(&[&result])?;
            } else if let Some(error) = &result.error {
                eprintln!("{error}");
            }
            Ok(result.exit_code.unwrap_or(EXIT_CONNECT_FAILED))
        }
    }
}

fn run_many(
    selector: &HostSelector,
    remote: RemoteCommand,
    opts: RunOptions,
) -> Result<i32, String> {
    let catalog = load_catalog()?;
    let profiles: Vec<ConnectionProfile> = select_profiles(&catalog, selector)?
        .into_iter()
        .filter(|p| is_ssh_profile(p))
        .cloned()
        .collect();
    if profiles.is_empty() {
        return Err("Ningun perfil SSH casa con la seleccion.".into());
    }
    let stdin = stdin_mode(&remote, &opts, true)?;
    // Los secretos se resuelven en serie ANTES de conectar: pueden preguntar por
    // el terminal, y varias preguntas a la vez serían ilegibles.
    let jobs: Vec<(ConnectionProfile, Result<CliSecrets, String>, WorkspaceRef)> = profiles
        .into_iter()
        .map(|p| {
            let ws = catalog.workspace_ref(&p);
            let secrets = resolve_secrets(&p);
            (p, secrets, ws)
        })
        .collect();
    if !opts.quiet && !opts.json {
        eprintln!(
            "Ejecutando en {} servidores ({} a la vez)...",
            jobs.len(),
            opts.parallel.min(jobs.len())
        );
    }

    let runtime = build_runtime()?;
    let local = tokio::task::LocalSet::new();
    let json = opts.json;
    let quiet = opts.quiet;
    let results: Vec<HostResult> = local.block_on(&runtime, async move {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(opts.parallel));
        let mut set = tokio::task::JoinSet::new();
        for (profile, secrets, ws) in jobs {
            let semaphore = semaphore.clone();
            let remote = remote.clone();
            let stdin = stdin.clone();
            let opts = opts.clone();
            set.spawn_local(async move {
                // El permiso vive hasta que la tarea termina: `parallel` acota
                // conexiones abiertas, no solo lanzamientos.
                let _permit = semaphore.acquire_owned().await;
                run_host(profile, secrets, remote, stdin, opts, true, ws).await
            });
        }
        let mut results = Vec::new();
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(result) => {
                    if !json {
                        print_grouped(&result, quiet);
                    }
                    results.push(result);
                }
                Err(err) => eprintln!("Tarea de ejecucion cancelada: {err}"),
            }
        }
        results
    });

    let mut results = results;
    results.sort_by_key(|r| r.name.to_ascii_lowercase());
    if json {
        print_json(&results)?;
    }
    let failed = results
        .iter()
        .filter(|r| r.exit_code != Some(0))
        .count();
    if !quiet && !json {
        eprintln!(
            "{} servidores, {} con fallo.",
            results.len(),
            failed
        );
    }
    Ok(if failed == 0 { 0 } else { 1 })
}

// ─── SFTP: --get / --put ──────────────────────────────────────────────────────

fn run_transfer_command(
    query: &str,
    selector: &HostSelector,
    op: TransferOp,
    opts: RunOptions,
) -> Result<i32, String> {
    let catalog = load_catalog()?;
    let candidates = select_profiles(&catalog, selector)?;
    let profile = find_profile(&candidates, query)?.clone();
    let secrets = resolve_secrets(&profile)?;
    announce(&profile, &opts);
    let runtime = build_runtime()?;
    let started = Instant::now();
    let (op_name, local, remote) = match &op {
        TransferOp::Get { remote, local } => ("get", local.clone(), remote.clone()),
        TransferOp::Put { local, remote } => ("put", local.clone(), remote.clone()),
    };
    let fut = transfer_file(&profile, &secrets, &op);
    let outcome = match opts.timeout {
        Some(limit) => match runtime.block_on(tokio::time::timeout(limit, fut)) {
            Ok(r) => r,
            Err(_) => Err((
                EXIT_TIMEOUT,
                format!("Tiempo agotado tras {} s", limit.as_secs()),
            )),
        },
        None => runtime.block_on(fut),
    };
    let duration_ms = started.elapsed().as_millis();
    let (code, bytes, error) = match outcome {
        Ok(bytes) => (0, bytes, None),
        Err((code, err)) => (code, 0, Some(err)),
    };
    if opts.json {
        print_json(&TransferResult {
            profile: profile.id.clone(),
            name: profile.name.clone(),
            host: profile.host.clone(),
            op: op_name,
            local,
            remote,
            bytes,
            duration_ms,
            error,
        })?;
    } else if let Some(err) = error {
        eprintln!("{err}");
    } else if !opts.quiet {
        eprintln!("{bytes} bytes copiados en {duration_ms} ms.");
    }
    Ok(code)
}

/// Nombre de fichero de una ruta; una ruta que acaba en «/» es una carpeta y
/// no tiene ninguno.
fn file_name_of(path: &str) -> Option<String> {
    if path.ends_with('/') {
        return None;
    }
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
}

/// Copia un fichero. Devuelve los bytes copiados; el error lleva el código de
/// salida: 255 si no conecta, 1 si la copia falla.
async fn transfer_file(
    profile: &ConnectionProfile,
    secrets: &CliSecrets,
    op: &TransferOp,
) -> Result<u64, (i32, String)> {
    let connect = |e: String| (EXIT_CONNECT_FAILED, e);
    let config = client_config(profile);
    let mut handle = connect_handle(profile, config, secrets).await.map_err(connect)?;
    authenticate_target(&mut handle, profile, secrets)
        .await
        .map_err(connect)?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| connect(format!("No se pudo abrir canal SSH: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| connect(format!("No se pudo abrir el subsistema SFTP: {e}")))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| connect(format!("No se pudo iniciar SFTP: {e}")))?;

    let fail = |e: String| (1, e);
    let bytes = match op {
        TransferOp::Get { remote, local } => {
            // Destino que es una carpeta (o acaba en «/»): el nombre del remoto.
            let local_path = {
                let p = PathBuf::from(local);
                if local.ends_with('/') || p.is_dir() {
                    match file_name_of(remote) {
                        Some(name) => p.join(name),
                        None => return Err(fail(format!("Ruta remota sin nombre de fichero: {remote}"))),
                    }
                } else {
                    p
                }
            };
            let mut source = sftp
                .open(remote.clone())
                .await
                .map_err(|e| fail(format!("No se pudo abrir el remoto {remote}: {e}")))?;
            let mut target = tokio::fs::File::create(&local_path)
                .await
                .map_err(|e| fail(format!("No se pudo crear {}: {e}", local_path.display())))?;
            let n = tokio::io::copy(&mut source, &mut target)
                .await
                .map_err(|e| fail(format!("Error copiando {remote}: {e}")))?;
            target
                .flush()
                .await
                .map_err(|e| fail(format!("Error escribiendo {}: {e}", local_path.display())))?;
            n
        }
        TransferOp::Put { local, remote } => {
            let remote_path = if remote.ends_with('/') {
                match file_name_of(local) {
                    Some(name) => format!("{remote}{name}"),
                    None => return Err(fail(format!("Ruta local sin nombre de fichero: {local}"))),
                }
            } else {
                remote.clone()
            };
            let mut source = tokio::fs::File::open(local)
                .await
                .map_err(|e| fail(format!("No se pudo abrir {local}: {e}")))?;
            let mut target = sftp
                .create(remote_path.clone())
                .await
                .map_err(|e| fail(format!("No se pudo crear el remoto {remote_path}: {e}")))?;
            let n = tokio::io::copy(&mut source, &mut target)
                .await
                .map_err(|e| fail(format!("Error copiando a {remote_path}: {e}")))?;
            target
                .shutdown()
                .await
                .map_err(|e| fail(format!("Error cerrando el remoto {remote_path}: {e}")))?;
            n
        }
    };
    let _ = sftp.close().await;
    Ok(bytes)
}

// ─── Conexión ─────────────────────────────────────────────────────────────────

async fn connect_handle(
    profile: &ConnectionProfile,
    config: Arc<client::Config>,
    secrets: &CliSecrets,
) -> Result<client::Handle<host_keys::KnownHostsClient>, String> {
    let addr = format!("{}:{}", profile.host, profile.port);
    let proxy_spec = profile
        .proxy_jump
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Some(spec) = proxy_spec {
        let (b_user, b_host, b_port) = parse_jump_spec(spec, &profile.username);
        let bastion_addr = format!("{}:{}", b_host, b_port);
        let (bastion_handler, bastion_failure) =
            host_keys::client(b_host.clone(), b_port, false, false);
        let mut bastion =
            crate::ssh_manager::russh_connect_addr(config.clone(), &bastion_addr, bastion_handler)
                .await
                .map_err(|err| {
                    host_keys::take_failure(&bastion_failure).unwrap_or_else(|| {
                        format!("No se puede conectar al bastion {bastion_addr}: {err}")
                    })
                })?;

        match authenticate_handle(
            &mut bastion,
            &profile.auth_type,
            &b_user,
            &b_host,
            secrets.password.as_ref(),
            secrets.passphrase.as_ref(),
            profile.key_path.as_deref(),
        )
        .await
        .map_err(|e| format!("Bastion: {e}"))?
        {
            AuthResult::Success => {}
            AuthResult::Failure {
                remaining_methods, ..
            } => {
                return Err(format!(
                    "Autenticacion contra bastion fallida. Metodos restantes: {:?}",
                    remaining_methods
                ));
            }
        }

        let channel = bastion
            .channel_open_direct_tcpip(
                profile.host.clone(),
                profile.port as u32,
                "127.0.0.1".to_string(),
                0,
            )
            .await
            .map_err(|e| {
                format!("No se pudo abrir direct-tcpip hacia {addr} a traves del bastion: {e}")
            })?;
        let stream = channel.into_stream();
        let (target_handler, target_failure) = host_keys::client(
            profile.host.clone(),
            profile.port,
            profile.agent_forwarding,
            false,
        );
        client::connect_stream(config, stream, target_handler)
            .await
            .map_err(|err| {
                host_keys::take_failure(&target_failure).unwrap_or_else(|| {
                    format!("No se puede establecer SSH con {addr} a traves del bastion: {err}")
                })
            })
    } else {
        let (client_handler, host_key_failure) = host_keys::client(
            profile.host.clone(),
            profile.port,
            profile.agent_forwarding,
            false,
        );
        crate::ssh_manager::russh_connect_addr(config, &addr, client_handler)
            .await
            .map_err(|err| {
                host_keys::take_failure(&host_key_failure)
                    .unwrap_or_else(|| format!("No se puede conectar a {addr}: {err}"))
            })
    }
}

async fn authenticate_target(
    handle: &mut client::Handle<host_keys::KnownHostsClient>,
    profile: &ConnectionProfile,
    secrets: &CliSecrets,
) -> Result<(), String> {
    match authenticate_handle(
        handle,
        &profile.auth_type,
        &profile.username,
        &profile.host,
        secrets.password.as_ref(),
        secrets.passphrase.as_ref(),
        profile.key_path.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?
    {
        AuthResult::Success => Ok(()),
        AuthResult::Failure {
            remaining_methods, ..
        } => Err(format!(
            "Autenticacion fallida. Metodos restantes: {:?}",
            remaining_methods
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    /// Perfil mínimo por JSON (como en `profiles.rs`): el struct no tiene
    /// `Default` y serde rellena el resto con los valores por defecto reales.
    fn profile(name: &str, workspace: &str, group: Option<&str>, kind: &str) -> ConnectionProfile {
        let json = serde_json::json!({
            "id": format!("id-{name}"),
            "name": name,
            "host": format!("{name}.example"),
            "port": 22,
            "username": "root",
            "domain": null,
            "auth_type": "password",
            "key_path": null,
            "group": group,
            "workspace_id": workspace,
            "connection_type": kind,
            "created_at": "2026-05-08T12:00:00Z"
        });
        serde_json::from_value(json).expect("perfil de prueba valido")
    }

    fn catalog() -> Catalog {
        let mut names = HashMap::new();
        names.insert("ws-omnia".to_string(), "Omnia".to_string());
        names.insert("default".to_string(), "Default".to_string());
        Catalog {
            profiles: vec![
                profile("web", "ws-omnia", Some("VPS"), "ssh"),
                profile("db", "ws-omnia", Some("VPS/Datos"), "ssh"),
                profile("box", "ws-omnia", None, "sftp"),
                profile("casa", "default", None, "ssh"),
                profile("rdp", "default", None, "rdp"),
            ],
            workspace_names: names,
        }
    }

    #[test]
    fn parses_interactive_connect() {
        match parse_cli_command(&args(&["-c", "prod"])) {
            Some(CliCommand::Connect {
                query,
                remote_command: None,
                ..
            }) => assert_eq!(query, "prod"),
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_exec_command() {
        match parse_cli_command(&args(&["-c", "prod", "--exec", "uptime"])) {
            Some(CliCommand::Connect {
                query,
                remote_command: Some(remote),
                ..
            }) => {
                assert_eq!(query, "prod");
                assert_eq!(remote.command, "uptime");
                assert!(!remote.tty);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_double_dash_command_with_tty() {
        match parse_cli_command(&args(&[
            "-c",
            "prod",
            "--tty",
            "--",
            "sudo",
            "systemctl",
            "restart",
            "nginx",
        ])) {
            Some(CliCommand::Connect {
                query,
                remote_command: Some(remote),
                ..
            }) => {
                assert_eq!(query, "prod");
                assert_eq!(remote.command, "sudo systemctl restart nginx");
                assert!(remote.tty);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_trailing_command_alias() {
        match parse_cli_command(&args(&["-c", "prod", "hostname"])) {
            Some(CliCommand::Connect {
                query,
                remote_command: Some(remote),
                ..
            }) => {
                assert_eq!(query, "prod");
                assert_eq!(remote.command, "hostname");
                assert!(!remote.tty);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_exec_command() {
        match parse_cli_command(&args(&["-c", "prod", "--exec"])) {
            Some(CliCommand::Invalid(message)) => {
                assert!(message.contains("comando remoto"));
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn los_argumentos_de_la_interfaz_no_son_cli() {
        assert_eq!(parse_cli_command(&args(&["--minimized"])), None);
        assert_eq!(parse_cli_command(&args(&["fichero.txt"])), None);
        assert_eq!(parse_cli_command(&args(&[])), None);
    }

    #[test]
    fn las_opciones_pueden_ir_detras_de_exec() {
        // `--exec` toma un argumento, así que --json/--timeout ya no se le pegan.
        match parse_cli_command(&args(&[
            "-c", "prod", "--exec", "df -h", "--json", "--timeout", "30", "-q", "--sudo", "-n",
        ])) {
            Some(CliCommand::Connect {
                remote_command: Some(remote),
                opts,
                ..
            }) => {
                assert_eq!(remote.command, "df -h");
                assert!(opts.json && opts.quiet && opts.sudo && opts.no_stdin);
                assert_eq!(opts.timeout, Some(Duration::from_secs(30)));
            }
            other => panic!("unexpected command: {other:?}"),
        }
        // Y las palabras sueltas tras --exec se siguen sumando al comando.
        match parse_cli_command(&args(&["-c", "prod", "--exec", "sudo", "ls", "/root"])) {
            Some(CliCommand::Connect {
                remote_command: Some(remote),
                ..
            }) => assert_eq!(remote.command, "sudo ls /root"),
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn multi_host_por_workspace_grupo_o_todos() {
        match parse_cli_command(&args(&[
            "--workspace", "Omnia", "--exec", "uptime", "--parallel", "8", "--json",
        ])) {
            Some(CliCommand::Run {
                selector,
                remote_command,
                opts,
            }) => {
                assert_eq!(selector.workspace.as_deref(), Some("Omnia"));
                assert_eq!(remote_command.command, "uptime");
                assert_eq!(opts.parallel, 8);
                assert!(opts.json);
            }
            other => panic!("unexpected command: {other:?}"),
        }
        assert!(matches!(
            parse_cli_command(&args(&["--group", "VPS", "--script", "x.sh"])),
            Some(CliCommand::Run { remote_command: RemoteCommand { script: Some(_), .. }, .. })
        ));
        assert!(matches!(
            parse_cli_command(&args(&["--all", "--", "uname", "-a"])),
            Some(CliCommand::Run { selector: HostSelector { all: true, .. }, .. })
        ));
        // Sin comando no hay nada que ejecutar; con --tty tampoco (no hay un
        // terminal que repartir).
        assert!(matches!(
            parse_cli_command(&args(&["--workspace", "Omnia"])),
            Some(CliCommand::Invalid(_))
        ));
        assert!(matches!(
            parse_cli_command(&args(&["--workspace", "Omnia", "--tty", "--exec", "top"])),
            Some(CliCommand::Invalid(_))
        ));
    }

    #[test]
    fn el_selector_acota_la_busqueda_con_c() {
        match parse_cli_command(&args(&["--workspace", "Omnia", "-c", "web", "--exec", "id"])) {
            Some(CliCommand::Connect {
                query, selector, ..
            }) => {
                assert_eq!(query, "web");
                assert_eq!(selector.workspace.as_deref(), Some("Omnia"));
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn listado_con_filtros_y_sin_comando() {
        match parse_cli_command(&args(&["-l", "--json", "--workspace", "Omnia"])) {
            Some(CliCommand::List { json, selector }) => {
                assert!(json);
                assert_eq!(selector.workspace.as_deref(), Some("Omnia"));
            }
            other => panic!("unexpected command: {other:?}"),
        }
        assert!(matches!(
            parse_cli_command(&args(&["-l", "--exec", "uptime"])),
            Some(CliCommand::Invalid(_))
        ));
    }

    #[test]
    fn script_y_exec_son_excluyentes() {
        assert!(matches!(
            parse_cli_command(&args(&["-c", "prod", "--script", "a.sh", "--exec", "ls"])),
            Some(CliCommand::Invalid(_))
        ));
        match parse_cli_command(&args(&["-c", "prod", "--script", "deploy.sh", "--sudo"])) {
            Some(CliCommand::Connect {
                remote_command: Some(remote),
                opts,
                ..
            }) => {
                assert_eq!(remote.script.as_deref(), Some(Path::new("deploy.sh")));
                assert!(remote.command.is_empty());
                assert!(opts.sudo);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn get_y_put_toman_dos_rutas_y_exigen_perfil() {
        match parse_cli_command(&args(&["-c", "box", "--get", "/srv/a.tgz", "./backups/"])) {
            Some(CliCommand::Transfer { query, op, .. }) => {
                assert_eq!(query, "box");
                assert_eq!(
                    op,
                    TransferOp::Get {
                        remote: "/srv/a.tgz".into(),
                        local: "./backups/".into()
                    }
                );
            }
            other => panic!("unexpected command: {other:?}"),
        }
        assert!(matches!(
            parse_cli_command(&args(&["-c", "box", "--put", "local.txt"])),
            Some(CliCommand::Invalid(_))
        ));
        assert!(matches!(
            parse_cli_command(&args(&["--all", "--put", "a", "b"])),
            Some(CliCommand::Invalid(_))
        ));
    }

    #[test]
    fn timeout_y_parallel_validan_el_numero() {
        assert!(matches!(
            parse_cli_command(&args(&["-c", "p", "--timeout", "0", "--exec", "ls"])),
            Some(CliCommand::Invalid(_))
        ));
        assert!(matches!(
            parse_cli_command(&args(&["-c", "p", "--timeout", "diez", "--exec", "ls"])),
            Some(CliCommand::Invalid(_))
        ));
        assert!(matches!(
            parse_cli_command(&args(&["--all", "--parallel", "0", "--exec", "ls"])),
            Some(CliCommand::Invalid(_))
        ));
    }

    #[test]
    fn sudo_envuelve_el_comando_y_el_script() {
        let plain = RemoteCommand {
            command: "echo it's ok | wc -c".into(),
            tty: false,
            script: None,
        };
        assert_eq!(effective_command(&plain, false), "echo it's ok | wc -c");
        assert_eq!(
            effective_command(&plain, true),
            "sudo -n sh -c 'echo it'\\''s ok | wc -c'"
        );
        let tty = RemoteCommand { tty: true, ..plain.clone() };
        assert!(effective_command(&tty, true).starts_with("sudo sh -c "));
        let script = RemoteCommand {
            command: String::new(),
            tty: false,
            script: Some(PathBuf::from("x.sh")),
        };
        assert_eq!(effective_command(&script, false), "bash -s");
        assert_eq!(effective_command(&script, true), "sudo -n bash -s");
    }

    #[test]
    fn el_selector_casa_workspace_por_nombre_o_id_y_grupo_con_subcarpetas() {
        let cat = catalog();
        let by_name = HostSelector {
            workspace: Some("omnia".into()),
            ..Default::default()
        };
        let names: Vec<&str> = select_profiles(&cat, &by_name)
            .unwrap()
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert_eq!(names, vec!["box", "db", "web"]); // el rdp queda fuera
        let by_id = HostSelector {
            workspace: Some("WS-OMNIA".into()),
            ..Default::default()
        };
        assert_eq!(select_profiles(&cat, &by_id).unwrap().len(), 3);
        let by_group = HostSelector {
            group: Some("vps".into()),
            ..Default::default()
        };
        let names: Vec<&str> = select_profiles(&cat, &by_group)
            .unwrap()
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert_eq!(names, vec!["db", "web"]);
        let all = HostSelector {
            all: true,
            ..Default::default()
        };
        assert_eq!(select_profiles(&cat, &all).unwrap().len(), 4);
        let missing = HostSelector {
            workspace: Some("Marte".into()),
            ..Default::default()
        };
        let err = select_profiles(&cat, &missing).unwrap_err();
        assert!(err.contains("Marte") && err.contains("Omnia") && err.contains("Default"), "{err}");
    }

    #[test]
    fn el_workspace_sin_indice_usa_el_id_como_nombre() {
        let cat = Catalog {
            profiles: vec![profile("solo", "ws-x", None, "ssh")],
            workspace_names: HashMap::new(),
        };
        let ws = cat.workspace_ref(&cat.profiles[0]);
        assert_eq!(ws, WorkspaceRef { id: "ws-x".into(), name: "ws-x".into() });
    }

    #[test]
    fn find_profile_busca_dentro_de_los_candidatos() {
        let cat = catalog();
        let all = select_profiles(&cat, &HostSelector { all: true, ..Default::default() }).unwrap();
        assert_eq!(find_profile(&all, "web").unwrap().name, "web");
        assert_eq!(find_profile(&all, "db.example").unwrap().name, "db");
        assert!(find_profile(&all, "example").unwrap_err().contains("varias"));
        assert!(find_profile(&all, "nada").unwrap_err().contains("nada"));
    }

    #[test]
    fn nombre_de_fichero_para_destinos_carpeta() {
        assert_eq!(file_name_of("/srv/a.tgz").as_deref(), Some("a.tgz"));
        assert_eq!(file_name_of("a.tgz").as_deref(), Some("a.tgz"));
        assert_eq!(file_name_of("/srv/"), None);
    }

    /// Integración real contra el `sshd` del fixture: código de salida, stdin
    /// cerrado, script por stdin y captura separada de stdout/stderr.
    #[cfg(target_os = "linux")]
    mod real {
        use super::*;
        use crate::ssh_fixture;

        static CLI_IT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

        async fn fixture_handle(
            server: &ssh_fixture::FakeSshServer,
        ) -> client::Handle<host_keys::KnownHostsClient> {
            let addr = format!("127.0.0.1:{}", server.port);
            let (handler, failure) = host_keys::client_with_known_hosts(
                "127.0.0.1".to_string(),
                server.port,
                server.known_hosts_path(),
            );
            let config = Arc::new(client::Config::default());
            let mut handle = crate::ssh_manager::russh_connect_addr(config, &addr, handler)
                .await
                .unwrap_or_else(|e| panic!("no conecto: {e}. {:?}", host_keys::take_failure(&failure)));
            let key_path = server.user_key.to_string_lossy().into_owned();
            let auth = authenticate_handle(
                &mut handle,
                &AuthType::PublicKey,
                &server.username,
                "127.0.0.1",
                None,
                None,
                Some(&key_path),
            )
            .await
            .expect("autenticacion");
            assert!(matches!(auth, AuthResult::Success), "auth: {auth:?}");
            handle
        }

        async fn exec(
            handle: &mut client::Handle<host_keys::KnownHostsClient>,
            command: &str,
            stdin: StdinMode,
        ) -> ExecOutcome {
            tokio::time::timeout(
                Duration::from_secs(15),
                exec_on_handle(handle, command, false, false, stdin, true),
            )
            .await
            .expect("el exec no debe colgarse")
            .expect("exec")
        }

        #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
        #[tokio::test]
        async fn el_codigo_de_salida_es_el_del_comando_remoto() {
            let _guard = CLI_IT_LOCK.lock().await;
            let Some(server) = ssh_fixture::start().expect("arrancar sshd") else {
                eprintln!("sshd/ssh-keygen no disponibles; test omitido");
                return;
            };
            host_keys::set_strict_first_connect(false);
            let mut handle = fixture_handle(&server).await;

            let ok = exec(&mut handle, "true", StdinMode::Closed).await;
            assert_eq!(ok.exit_code, Some(0));
            let three = exec(&mut handle, "exit 3", StdinMode::Closed).await;
            assert_eq!(three.exit_code, Some(3));
            let split = exec(&mut handle, "echo fuera; echo error >&2; exit 5", StdinMode::Closed).await;
            assert_eq!(split.exit_code, Some(5));
            assert_eq!(String::from_utf8_lossy(&split.stdout), "fuera\n");
            assert_eq!(String::from_utf8_lossy(&split.stderr), "error\n");
        }

        #[ignore = "necesita sshd y ssh-keygen; se corre con --ignored"]
        #[tokio::test]
        async fn un_comando_que_lee_stdin_no_se_cuelga_y_el_script_llega_entero() {
            let _guard = CLI_IT_LOCK.lock().await;
            let Some(server) = ssh_fixture::start().expect("arrancar sshd") else {
                eprintln!("sshd/ssh-keygen no disponibles; test omitido");
                return;
            };
            host_keys::set_strict_first_connect(false);
            let mut handle = fixture_handle(&server).await;

            // `cat` sin stdin cerrado esperaria para siempre: era el caso de
            // `plesk db`. Con Closed termina y sale con 0.
            let cat = exec(&mut handle, "cat", StdinMode::Closed).await;
            assert_eq!(cat.exit_code, Some(0));
            assert!(cat.stdout.is_empty());

            // --script: los bytes van por stdin a `bash -s` y el codigo es el suyo.
            let script = b"echo hola desde el script\nexit 7\n".to_vec();
            let out = exec(&mut handle, "bash -s", StdinMode::Bytes(script)).await;
            assert_eq!(out.exit_code, Some(7));
            assert_eq!(String::from_utf8_lossy(&out.stdout), "hola desde el script\n");
        }
    }
}
