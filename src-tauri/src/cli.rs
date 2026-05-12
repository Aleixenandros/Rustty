use std::env;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use russh::client::{self, AuthResult};
use russh::keys::load_secret_key;
use russh::{ChannelMsg, Preferred};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::host_keys;
use crate::profiles::{AuthType, ConnectionProfile, ProfileManager};
use crate::ssh_manager::{authenticate_handle, legacy_preferred, parse_jump_spec};

const KEYRING_SERVICE: &str = "rustty";

#[derive(Debug)]
enum CliCommand {
    List { json: bool },
    Connect { query: String },
    Help,
}

#[derive(Debug)]
struct CliSecrets {
    password: Option<String>,
    passphrase: Option<String>,
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
    group: Option<&'a str>,
}

pub fn try_run_from_env() -> Option<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = parse_cli_command(&args)?;
    let code = match run_cli(command) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("{err}");
            2
        }
    };
    Some(code)
}

fn parse_cli_command(args: &[String]) -> Option<CliCommand> {
    if args.is_empty() {
        return None;
    }

    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    let first = args.first().copied();
    match first {
        Some("-l") | Some("--list") => Some(CliCommand::List {
            json: args.iter().any(|arg| *arg == "--json"),
        }),
        Some("-c") | Some("--connect") => args.get(1).map(|query| CliCommand::Connect {
            query: (*query).to_string(),
        }),
        Some("-h") | Some("--help") => Some(CliCommand::Help),
        _ => None,
    }
}

fn run_cli(command: CliCommand) -> Result<(), String> {
    match command {
        CliCommand::List { json } => list_profiles(json),
        CliCommand::Connect { query } => connect_by_query(&query),
        CliCommand::Help => {
            print_help();
            Ok(())
        }
    }
}

fn print_help() {
    println!(
        "Rustty CLI (SSH)\n\
         \n\
         Uso:\n\
           rustty -l | --list                 Lista conexiones SSH guardadas\n\
           rustty -l --json                   Lista conexiones SSH en JSON\n\
           rustty -c <nombre|id|ip|host>      Conecta sin abrir la interfaz grafica\n\
         "
    );
}

fn load_profiles() -> Result<Vec<ConnectionProfile>, String> {
    let data_dir = crate::resolve_data_dir();
    ProfileManager::new(data_dir)
        .load_all()
        .map_err(|e| format!("No se pudieron cargar los perfiles: {e}"))
}

fn ssh_profiles(profiles: &[ConnectionProfile]) -> Vec<&ConnectionProfile> {
    let mut items: Vec<&ConnectionProfile> =
        profiles.iter().filter(|p| is_ssh_profile(p)).collect();
    items.sort_by_key(|p| p.name.to_ascii_lowercase());
    items
}

fn is_ssh_profile(profile: &ConnectionProfile) -> bool {
    profile.connection_type.trim().is_empty() || profile.connection_type.eq_ignore_ascii_case("ssh")
}

fn list_profiles(json: bool) -> Result<(), String> {
    let profiles = load_profiles()?;
    let profiles = ssh_profiles(&profiles);
    if json {
        let items: Vec<CliProfile<'_>> = profiles
            .iter()
            .map(|p| CliProfile {
                id: &p.id,
                name: &p.name,
                host: &p.host,
                port: p.port,
                username: &p.username,
                group: p.group.as_deref(),
            })
            .collect();
        let payload = serde_json::to_string_pretty(&items)
            .map_err(|e| format!("No se pudo generar JSON: {e}"))?;
        println!("{payload}");
        return Ok(());
    }

    if profiles.is_empty() {
        println!("No hay conexiones SSH guardadas.");
        return Ok(());
    }

    let name_w = profiles
        .iter()
        .map(|p| p.name.chars().count())
        .max()
        .unwrap_or(6)
        .max(6);
    let host_w = profiles
        .iter()
        .map(|p| p.host.chars().count())
        .max()
        .unwrap_or(4)
        .max(4);
    let user_w = profiles
        .iter()
        .map(|p| p.username.chars().count())
        .max()
        .unwrap_or(7)
        .max(7);

    println!(
        "{:<name_w$}  {:<host_w$}  {:<user_w$}  {:>5}  {}",
        "NOMBRE",
        "HOST/IP",
        "USUARIO",
        "PUERTO",
        "GRUPO",
        name_w = name_w,
        host_w = host_w,
        user_w = user_w
    );
    println!(
        "{:-<name_w$}  {:-<host_w$}  {:-<user_w$}  -----  -----",
        "",
        "",
        "",
        name_w = name_w,
        host_w = host_w,
        user_w = user_w
    );
    for profile in profiles {
        println!(
            "{:<name_w$}  {:<host_w$}  {:<user_w$}  {:>5}  {}",
            profile.name,
            profile.host,
            profile.username,
            profile.port,
            profile.group.as_deref().unwrap_or(""),
            name_w = name_w,
            host_w = host_w,
            user_w = user_w
        );
    }
    Ok(())
}

fn connect_by_query(query: &str) -> Result<(), String> {
    let profiles = load_profiles()?;
    let profile = find_profile(&profiles, query)?.clone();
    let secrets = resolve_secrets(&profile)?;
    eprintln!(
        "Conectando a {} ({}@{}:{})...",
        profile.name, profile.username, profile.host, profile.port
    );

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("No se pudo crear runtime tokio: {e}"))?;
    runtime.block_on(run_ssh_session(profile, secrets))
}

fn find_profile<'a>(
    profiles: &'a [ConnectionProfile],
    query: &str,
) -> Result<&'a ConnectionProfile, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Indica una busqueda para -c.".into());
    }

    let candidates = ssh_profiles(profiles);
    if candidates.is_empty() {
        return Err("No hay conexiones SSH guardadas.".into());
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
        "No se encontro ninguna conexion SSH para '{query}'."
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
                format!("La busqueda '{query}' coincide con varias conexiones SSH:\n");
            for profile in many.iter().take(12) {
                message.push_str(&format!(
                    "  - {}  {}@{}:{}\n",
                    profile.name, profile.username, profile.host, profile.port
                ));
            }
            message.push_str("Afina la busqueda usando el nombre completo, id o host/IP.");
            Err(message)
        }
    }
}

fn resolve_secrets(profile: &ConnectionProfile) -> Result<CliSecrets, String> {
    let password = match profile.auth_type {
        AuthType::Password => {
            let stored = read_keyring_secret(&format!("password:{}", profile.id));
            let prompt = format!("Contrasena para {}@{}: ", profile.username, profile.host);
            Some(
                stored
                    .unwrap_or_else(|| prompt_secret(&prompt))
                    .map_err(|e| {
                        format!("No se pudo obtener la contrasena de {}: {e}", profile.name)
                    })?,
            )
        }
        AuthType::PublicKey | AuthType::Agent => None,
    };

    let passphrase = match profile.auth_type {
        AuthType::PublicKey => resolve_passphrase(profile)?,
        AuthType::Password | AuthType::Agent => None,
    };

    Ok(CliSecrets {
        password,
        passphrase,
    })
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

fn prompt_secret(prompt: &str) -> Result<String, String> {
    rpassword::prompt_password(prompt).map_err(|e| e.to_string())
}

async fn run_ssh_session(profile: ConnectionProfile, secrets: CliSecrets) -> Result<(), String> {
    let keepalive_interval = profile
        .keep_alive_secs
        .filter(|secs| *secs > 0)
        .map(|secs| Duration::from_secs(secs as u64));
    let preferred = if profile.allow_legacy_algorithms {
        legacy_preferred()
    } else {
        Preferred::default()
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        keepalive_interval,
        preferred,
        ..Default::default()
    });

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
        let mut bastion = client::connect(config.clone(), bastion_addr.clone(), bastion_handler)
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
            secrets.password.as_ref(),
            secrets.passphrase.as_ref(),
            profile.key_path.as_deref(),
        )
        .await
        .map_err(|e| format!("Bastion: {e}"))?
        {
            AuthResult::Success => {}
            AuthResult::Failure { remaining_methods } => {
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
        client::connect(config, addr.clone(), client_handler)
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
        secrets.password.as_ref(),
        secrets.passphrase.as_ref(),
        profile.key_path.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?
    {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { remaining_methods } => Err(format!(
            "Autenticacion fallida. Metodos restantes: {:?}",
            remaining_methods
        )),
    }
}
