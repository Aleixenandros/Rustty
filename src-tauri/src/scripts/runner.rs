//! Runner de una sesión (máquina de estados sobre los pasos) y orquestador de
//! fan-out por host.
//!
//! Cada host abre su **propia** conexión russh reutilizando la lógica de
//! auth/host-key de `ssh_manager` (respeta el TOFU); NO reutiliza las sesiones
//! interactivas de `SshManager`. Sobre un canal de shell con PTY se ejecutan los
//! pasos.
//!
//! ## Detección del fin de comando y del exit code (shells POSIX)
//!
//! `waitPrompt` es shell-agnóstico para POSIX sh/bash/zsh (NO PowerShell
//! remoto). Tras el último `send`, inyecta un MARCADOR único por paso:
//!
//! ```text
//! printf '\n__RUSTTY_END_<run_id>_<step>_%d__\n' "$?"
//! ```
//!
//! y lee la salida hasta que aparece la línea del marcador **con el exit code ya
//! expandido** (`..._0__`). El eco del propio comando contiene `%d` literal (no
//! dígitos), por lo que nunca se confunde con la salida real. El exit code se
//! extrae de esa línea; el marcador (y su eco) se recortan de la salida
//! capturada y jamás se emiten como `ScriptOutput`.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::stream::{FuturesUnordered, StreamExt};
use russh::client::{self, AuthResult, Msg};
use russh::{Channel, ChannelMsg, Preferred};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::credentials::{CredentialMeta, CredentialResolver};
use crate::host_keys;
use crate::ipc::{event_name, EventKind};
use crate::profiles::ConnectionProfile;
use crate::ssh_manager::{
    authenticate_handle, legacy_preferred, parse_jump_spec, russh_connect_addr,
    DEFAULT_SSH_KEEPALIVE_MAX, DEFAULT_SSH_KEEPALIVE_SECS,
};
use crate::subst::{redact_secrets, substitute, InternalVar, Resolver, SubstContext, REDACTED};

use super::types::{RunMode, RunOptions, Step};
use super::{RunHandle, RunRegistry};

/// Intervalo de sondeo del canal: acota la latencia de respuesta a la
/// cancelación y a los timeouts mientras se lee la salida.
const POLL_INTERVAL: Duration = Duration::from_millis(150);
/// Techo de seguridad de `waitPrompt` (sin `timeoutMs` en el esquema): evita que
/// un comando colgado bloquee el host indefinidamente.
const DEFAULT_WAIT_PROMPT: Duration = Duration::from_secs(1800);

/// Un host ya resuelto para ejecutar: perfil + credenciales de conexión (ya
/// resueltas por el comando Tauri; nunca se recalculan aquí).
pub struct ResolvedHost {
    pub profile: ConnectionProfile,
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

// ─── Payloads de evento (camelCase estricto) ─────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    profile_id: &'a str,
    host: &'a str,
    phase: &'a str,
    step_index: u32,
    total_steps: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent<'a> {
    profile_id: &'a str,
    host: &'a str,
    chunk: &'a str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostDoneEvent<'a> {
    profile_id: &'a str,
    host: &'a str,
    exit_code: Option<i32>,
    duration_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostErrorEvent<'a> {
    profile_id: &'a str,
    host: &'a str,
    message: &'a str,
    step_index: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    ok_count: u32,
    error_count: u32,
    total: u32,
}

// ─── Marcador de fin de comando ──────────────────────────────────────────────

/// Reduce una cadena a caracteres ASCII alfanuméricos: hace del `run_id` un
/// token seguro para incrustar en el marcador y en el `printf`.
fn sanitize_token(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// Prefijo del marcador de un paso (incluye el `_` previo al exit code):
/// `__RUSTTY_END_<run>_<step>_`. Es único por (run, step).
fn marker_prefix(run_id: &str, step_index: usize) -> String {
    format!("__RUSTTY_END_{}_{}_", sanitize_token(run_id), step_index)
}

/// Extrae el exit code del ÚLTIMO marcador válido presente en `buf` (prefijo +
/// dígitos + `__`). Ignora el eco del comando, que trae `%d` en vez de dígitos.
fn parse_marker_exit(buf: &str, prefix: &str) -> Option<i32> {
    let mut result = None;
    let mut from = 0usize;
    while let Some(rel) = buf[from..].find(prefix) {
        let start = from + rel + prefix.len();
        let digits: String = buf[start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let after = &buf[start + digits.len()..];
        if !digits.is_empty() && after.starts_with("__") {
            if let Ok(code) = digits.parse::<i32>() {
                result = Some(code);
            }
        }
        from = from + rel + prefix.len();
    }
    result
}

// ─── Conexión propia por host ────────────────────────────────────────────────

type ClientHandle = client::Handle<host_keys::KnownHostsClient>;

/// Abre una conexión russh al host reutilizando la auth/host-key de
/// `ssh_manager` (incluye ProxyJump) y devuelve el handle + un canal de shell
/// con PTY listo para bombear comandos.
async fn connect_shell(
    profile: &ConnectionProfile,
    password: Option<&str>,
    passphrase: Option<&str>,
) -> Result<(ClientHandle, Channel<Msg>), String> {
    let preferred = if profile.allow_legacy_algorithms {
        legacy_preferred(profile.legacy_algorithms.as_deref())
    } else {
        Preferred::default()
    };
    let keepalive = profile
        .keep_alive_secs
        .filter(|s| *s > 0)
        .map(|s| Duration::from_secs(s as u64))
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_SSH_KEEPALIVE_SECS));
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        keepalive_interval: Some(keepalive),
        keepalive_max: DEFAULT_SSH_KEEPALIVE_MAX,
        preferred,
        ..Default::default()
    });
    let addr = format!("{}:{}", profile.host, profile.port);
    let proxy_spec = profile
        .proxy_jump
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let pw = password.map(str::to_string);
    let pp = passphrase.map(str::to_string);

    let mut handle = if let Some(spec) = proxy_spec {
        // ── ProxyJump: bastion → direct-tcpip → handshake del destino.
        let (b_user, b_host, b_port) = parse_jump_spec(spec, &profile.username);
        let bastion_addr = format!("{b_host}:{b_port}");
        let (bastion_handler, bastion_failure) =
            host_keys::client(b_host.clone(), b_port, false, false);
        let mut bastion = russh_connect_addr(config.clone(), &bastion_addr, bastion_handler)
            .await
            .map_err(|err| {
                host_keys::take_failure(&bastion_failure).unwrap_or_else(|| {
                    format!("No se pudo conectar al bastion {bastion_addr}: {err}")
                })
            })?;
        match authenticate_handle(
            &mut bastion,
            &profile.auth_type,
            &b_user,
            pw.as_ref(),
            pp.as_ref(),
            profile.key_path.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?
        {
            AuthResult::Success => {}
            AuthResult::Failure { .. } => {
                return Err("Autenticación contra el bastion fallida".into())
            }
        }
        let chan = bastion
            .channel_open_direct_tcpip(
                profile.host.clone(),
                profile.port as u32,
                "127.0.0.1".to_string(),
                0,
            )
            .await
            .map_err(|e| {
                format!("No se pudo abrir canal direct-tcpip a través del bastion: {e}")
            })?;
        let stream = chan.into_stream();
        let (target_handler, target_failure) = host_keys::client(
            profile.host.clone(),
            profile.port,
            profile.agent_forwarding,
            profile.x11_forwarding,
        );
        client::connect_stream(config, stream, target_handler)
            .await
            .map_err(|err| {
                host_keys::take_failure(&target_failure).unwrap_or_else(|| {
                    format!("No se pudo establecer SSH con {addr} a través del bastion: {err}")
                })
            })?
    } else {
        let (handler, failure) = host_keys::client(
            profile.host.clone(),
            profile.port,
            profile.agent_forwarding,
            profile.x11_forwarding,
        );
        russh_connect_addr(config, &addr, handler)
            .await
            .map_err(|err| {
                host_keys::take_failure(&failure)
                    .unwrap_or_else(|| format!("No se pudo conectar a {addr}: {err}"))
            })?
    };

    match authenticate_handle(
        &mut handle,
        &profile.auth_type,
        &profile.username,
        pw.as_ref(),
        pp.as_ref(),
        profile.key_path.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?
    {
        AuthResult::Success => {}
        AuthResult::Failure { .. } => return Err("Autenticación fallida".into()),
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("No se pudo abrir canal: {e}"))?;
    // PTY ancho: minimiza el ajuste de línea del eco, que podría partir el
    // marcador. La línea del marcador es corta (< 80 col) y nunca se ajusta.
    channel
        .request_pty(true, "xterm-256color", 200, 50, 0, 0, &[])
        .await
        .map_err(|e| format!("No se pudo solicitar PTY: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("No se pudo abrir shell: {e}"))?;
    Ok((handle, channel))
}

// ─── Resolución de `${...}` en los `send` ────────────────────────────────────

/// Resolver que registra los valores de `${secret:}`/`${master:}` que resuelve,
/// para poder redactarlos de la salida (echo del comando enviado) después.
struct RecordingResolver {
    inner: CredentialResolver,
    recorded: RefCell<Vec<String>>,
}

impl Resolver for RecordingResolver {
    fn internal(&self, var: InternalVar) -> Option<String> {
        self.inner.internal(var)
    }
    fn env(&self, name: &str) -> Option<String> {
        self.inner.env(name)
    }
    fn var(&self, name: &str) -> Option<String> {
        self.inner.var(name)
    }
    fn secret(&self, name: &str) -> Option<String> {
        let value = self.inner.secret(name);
        if let Some(v) = value.as_ref() {
            if !v.is_empty() {
                self.recorded.borrow_mut().push(v.clone());
            }
        }
        value
    }
    fn master(&self, name: &str) -> Option<String> {
        let value = self.inner.master(name);
        if let Some(v) = value.as_ref() {
            if !v.is_empty() {
                self.recorded.borrow_mut().push(v.clone());
            }
        }
        value
    }
    fn ask(&self, label: &str, options: &[String]) -> Option<String> {
        self.inner.ask(label, options)
    }
    fn cmd(&self, command: &str) -> Option<String> {
        self.inner.cmd(command)
    }
}

/// Resolver de PREVIEW: resuelve internos/env/var/ask (params) pero REDACTA
/// `${secret:}`/`${master:}` a `••••`, para no revelar secretos en la vista
/// previa (mismo criterio que el motor en preview).
struct PreviewResolver {
    inner: CredentialResolver,
}

impl Resolver for PreviewResolver {
    fn internal(&self, var: InternalVar) -> Option<String> {
        self.inner.internal(var)
    }
    fn env(&self, name: &str) -> Option<String> {
        self.inner.env(name)
    }
    fn var(&self, name: &str) -> Option<String> {
        self.inner.var(name)
    }
    fn secret(&self, _name: &str) -> Option<String> {
        Some(REDACTED.to_string())
    }
    fn master(&self, _name: &str) -> Option<String> {
        Some(REDACTED.to_string())
    }
    fn ask(&self, label: &str, options: &[String]) -> Option<String> {
        self.inner.ask(label, options)
    }
    fn cmd(&self, _command: &str) -> Option<String> {
        None
    }
}

/// Contexto de resolución de los `send` de un host (params de `RunOptions` +
/// `SubstContext` + catálogo de credenciales).
struct ResolveCtx {
    ctx: SubstContext,
    catalog: Vec<CredentialMeta>,
    params: HashMap<String, String>,
}

impl ResolveCtx {
    /// Resuelve el texto de un `send` y devuelve `(texto_resuelto, secretos)`,
    /// donde `secretos` son los valores de secret/master inyectados (para
    /// redactarlos de la salida).
    fn resolve_send(&self, text: &str) -> (String, Vec<String>) {
        let inner = CredentialResolver::with_ask_answers(
            self.ctx.clone(),
            self.catalog.clone(),
            self.params.clone(),
        );
        let resolver = RecordingResolver {
            inner,
            recorded: RefCell::new(Vec::new()),
        };
        let resolved = substitute(text, &resolver);
        (resolved, resolver.recorded.into_inner())
    }
}

/// Resuelve los comandos (`send`) de un host para la vista previa, redactando
/// los secretos. No envía nada.
pub fn preview_commands(
    profile: &ConnectionProfile,
    steps: &[Step],
    catalog: Vec<CredentialMeta>,
    params: HashMap<String, String>,
) -> Vec<String> {
    let inner =
        CredentialResolver::with_ask_answers(SubstContext::from_profile(profile), catalog, params);
    let resolver = PreviewResolver { inner };
    steps
        .iter()
        .filter_map(|step| match step {
            Step::Send { text } => Some(substitute(text, &resolver)),
            _ => None,
        })
        .collect()
}

// ─── Estado de un host durante la ejecución ──────────────────────────────────

struct HostState<'a> {
    channel: Channel<Msg>,
    app: &'a AppHandle,
    run_id: &'a str,
    profile_id: String,
    host: String,
    /// Valores secretos usados en este host (contraseña de conexión + los
    /// enviados por los pasos), para redactar la salida antes de emitirla.
    secrets: Vec<String>,
    /// Exit code capturado por el último `waitPrompt`.
    last_exit: Option<i32>,
}

impl HostState<'_> {
    /// Emite un fragmento de salida como `ScriptOutput`, redactando secretos.
    fn emit_output(&self, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        let redacted = redact_secrets(chunk, &self.secrets);
        let _ = self.app.emit(
            &event_name(EventKind::ScriptOutput, self.run_id),
            OutputEvent {
                profile_id: &self.profile_id,
                host: &self.host,
                chunk: &redacted,
            },
        );
    }

    /// Envía un comando visible (`texto + "\n"`).
    async fn send_line(&mut self, text: &str) -> Result<(), String> {
        let mut line = text.to_string();
        line.push('\n');
        self.channel
            .data(line.as_bytes())
            .await
            .map_err(|e| format!("No se pudo enviar el comando: {e}"))
    }

    /// Envía un secreto (`secreto + "\n"`) SIN registrarlo ni emitirlo. Lo añade
    /// a la lista de redacción para que cualquier eco posterior quede oculto.
    async fn send_secret(&mut self, secret: String) -> Result<(), String> {
        let mut line = secret.clone();
        line.push('\n');
        let res = self
            .channel
            .data(line.as_bytes())
            .await
            .map_err(|_| "No se pudo enviar la contraseña".to_string());
        if !secret.is_empty() && !self.secrets.contains(&secret) {
            self.secrets.push(secret);
        }
        res
    }
}

/// Resultado de un ciclo de lectura del canal.
enum PumpOutcome {
    Matched,
    Eof,
    Timeout,
    Cancelled,
}

/// Lee la salida del canal emitiendo líneas completas (redactadas y sin las
/// líneas que contienen `sentinel`) como `ScriptOutput`, hasta que `matcher`
/// casa el buffer acumulado, se cierra el canal, vence `deadline` o se cancela.
#[allow(clippy::too_many_arguments)]
async fn pump_until<F>(
    state: &mut HostState<'_>,
    accumulated: &mut String,
    emitted: &mut usize,
    sentinel: Option<&str>,
    deadline: Instant,
    run_cancel: &AtomicBool,
    host_cancel: &AtomicBool,
    mut matcher: F,
) -> PumpOutcome
where
    F: FnMut(&str) -> bool,
{
    loop {
        if run_cancel.load(Ordering::Relaxed) || host_cancel.load(Ordering::Relaxed) {
            return PumpOutcome::Cancelled;
        }
        let now = Instant::now();
        if now >= deadline {
            return PumpOutcome::Timeout;
        }
        let wait_for = deadline.saturating_duration_since(now).min(POLL_INTERVAL);
        match tokio::time::timeout(wait_for, state.channel.wait()).await {
            // Sin datos en esta ventana: reevaluar cancelación/timeout.
            Err(_) => continue,
            Ok(None) => return PumpOutcome::Eof,
            Ok(Some(msg)) => match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    accumulated.push_str(&String::from_utf8_lossy(&data));
                    emit_new_lines(state, accumulated, emitted, sentinel);
                    if matcher(accumulated) {
                        return PumpOutcome::Matched;
                    }
                }
                ChannelMsg::Eof
                | ChannelMsg::Close
                | ChannelMsg::ExitStatus { .. }
                | ChannelMsg::ExitSignal { .. } => return PumpOutcome::Eof,
                _ => {}
            },
        }
    }
}

/// Emite las líneas completas (terminadas en `\n`) del buffer más allá de
/// `*emitted`, saltando las que contengan `sentinel` (marcador y su eco).
fn emit_new_lines(state: &HostState, acc: &str, emitted: &mut usize, sentinel: Option<&str>) {
    while let Some(rel_nl) = acc[*emitted..].find('\n') {
        let line_end = *emitted + rel_nl + 1;
        let line = &acc[*emitted..line_end];
        let hidden = sentinel.is_some_and(|s| line.contains(s));
        if !hidden {
            state.emit_output(line);
        }
        *emitted = line_end;
    }
}

// ─── Ejecución de un paso ────────────────────────────────────────────────────

enum StepFlow {
    Continue,
    Disconnected,
}

async fn execute_step(
    state: &mut HostState<'_>,
    step: &Step,
    step_index: usize,
    resolve: &ResolveCtx,
    run_cancel: &AtomicBool,
    host_cancel: &AtomicBool,
) -> Result<StepFlow, String> {
    match step {
        Step::Send { text } => {
            let (resolved, secrets) = resolve.resolve_send(text);
            for s in secrets {
                if !state.secrets.contains(&s) {
                    state.secrets.push(s);
                }
            }
            state.send_line(&resolved).await?;
            Ok(StepFlow::Continue)
        }
        Step::WaitPrompt => {
            let code = wait_prompt(state, step_index, run_cancel, host_cancel).await?;
            state.last_exit = Some(code);
            Ok(StepFlow::Continue)
        }
        Step::WaitRegex {
            pattern,
            timeout_ms,
        } => {
            wait_regex(state, pattern, *timeout_ms, run_cancel, host_cancel).await?;
            Ok(StepFlow::Continue)
        }
        Step::ExpectExit { code } => match state.last_exit {
            Some(actual) if actual == *code => Ok(StepFlow::Continue),
            Some(actual) => Err(format!("Se esperaba exit code {code} pero fue {actual}")),
            None => Err("expectExit sin un waitPrompt previo que capturara el exit code".into()),
        },
        Step::SendPasswordFromKeyring { profile_id } => {
            let pid = profile_id
                .clone()
                .unwrap_or_else(|| state.profile_id.clone());
            let pw = read_keyring_password(&pid)?;
            state.send_secret(pw).await?;
            Ok(StepFlow::Continue)
        }
        Step::SendPasswordFromKeepass { uuid } => {
            let pw = read_keepass_password(uuid)?;
            state.send_secret(pw).await?;
            Ok(StepFlow::Continue)
        }
        Step::Sleep { ms } => {
            sleep_cancellable(*ms, run_cancel, host_cancel).await?;
            Ok(StepFlow::Continue)
        }
        Step::Disconnect => {
            let _ = state.channel.eof().await;
            let _ = state.channel.close().await;
            Ok(StepFlow::Disconnected)
        }
    }
}

/// `true` si la receta termina con envíos cuya salida nadie leería: hay un
/// `send`/`sendPassword*` sin `waitPrompt`/`waitRegex` posterior. En ese caso
/// el runner añade un drenaje final implícito; sin él, el canal se cerraba nada
/// más enviar el último comando (podía ni ejecutarse) y no se emitía NINGUNA
/// salida — el caso natural de un script recién creado con un único `send`.
/// Un `disconnect` corta la ejecución, así que anula el drenaje.
fn needs_final_drain(steps: &[Step]) -> bool {
    let mut pending = false;
    for step in steps {
        match step {
            Step::Send { .. }
            | Step::SendPasswordFromKeyring { .. }
            | Step::SendPasswordFromKeepass { .. } => pending = true,
            Step::WaitPrompt | Step::WaitRegex { .. } => pending = false,
            Step::Disconnect => return false,
            Step::ExpectExit { .. } | Step::Sleep { .. } => {}
        }
    }
    pending
}

/// Drenaje final implícito (ver `needs_final_drain`): un `waitPrompt` con el
/// marcador `$?` que espera a que el último comando termine y emite su salida.
/// A diferencia del `waitPrompt` explícito, un EOF no es error (p. ej. la
/// receta terminó con `send: exit`): se emite la cola pendiente y se sigue.
async fn final_drain(
    state: &mut HostState<'_>,
    step_index: usize,
    run_cancel: &AtomicBool,
    host_cancel: &AtomicBool,
) -> Result<Option<i32>, String> {
    let prefix = marker_prefix(state.run_id, step_index);
    let cmd = format!("printf '\\n{prefix}%d__\\n' \"$?\"");
    state.send_line(&cmd).await?;

    let mut acc = String::new();
    let mut emitted = 0usize;
    let deadline = Instant::now() + DEFAULT_WAIT_PROMPT;
    let match_prefix = prefix.clone();
    let outcome = pump_until(
        state,
        &mut acc,
        &mut emitted,
        Some(&prefix),
        deadline,
        run_cancel,
        host_cancel,
        |buf| parse_marker_exit(buf, &match_prefix).is_some(),
    )
    .await;

    match outcome {
        PumpOutcome::Matched => Ok(parse_marker_exit(&acc, &prefix)),
        PumpOutcome::Eof => {
            // Conexión terminada: emitir la última línea parcial (sin `\n`)
            // que `emit_new_lines` no llegó a emitir, si no es el marcador.
            let tail = &acc[emitted..];
            if !tail.trim().is_empty() && !tail.contains(&prefix) {
                state.emit_output(tail);
            }
            Ok(None)
        }
        PumpOutcome::Timeout => {
            Err("Tiempo de espera agotado esperando el fin del último comando".into())
        }
        PumpOutcome::Cancelled => Err("Ejecución cancelada".into()),
    }
}

async fn wait_prompt(
    state: &mut HostState<'_>,
    step_index: usize,
    run_cancel: &AtomicBool,
    host_cancel: &AtomicBool,
) -> Result<i32, String> {
    let prefix = marker_prefix(state.run_id, step_index);
    // `printf` con `$?`: la línea del marcador trae el exit code ya expandido.
    let cmd = format!("printf '\\n{prefix}%d__\\n' \"$?\"");
    state.send_line(&cmd).await?;

    let mut acc = String::new();
    let mut emitted = 0usize;
    let deadline = Instant::now() + DEFAULT_WAIT_PROMPT;
    let match_prefix = prefix.clone();
    let outcome = pump_until(
        state,
        &mut acc,
        &mut emitted,
        Some(&prefix),
        deadline,
        run_cancel,
        host_cancel,
        |buf| parse_marker_exit(buf, &match_prefix).is_some(),
    )
    .await;

    match outcome {
        PumpOutcome::Matched => parse_marker_exit(&acc, &prefix)
            .ok_or_else(|| "No se pudo leer el exit code del marcador".to_string()),
        PumpOutcome::Eof => Err("La conexión se cerró antes de completar el comando".into()),
        PumpOutcome::Timeout => Err("Tiempo de espera agotado esperando el fin del comando".into()),
        PumpOutcome::Cancelled => Err("Ejecución cancelada".into()),
    }
}

async fn wait_regex(
    state: &mut HostState<'_>,
    pattern: &str,
    timeout_ms: u64,
    run_cancel: &AtomicBool,
    host_cancel: &AtomicBool,
) -> Result<(), String> {
    let re = regex::Regex::new(pattern).map_err(|e| format!("Patrón regex inválido: {e}"))?;
    let mut acc = String::new();
    let mut emitted = 0usize;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
    let outcome = pump_until(
        state,
        &mut acc,
        &mut emitted,
        None,
        deadline,
        run_cancel,
        host_cancel,
        |buf| re.is_match(buf),
    )
    .await;

    match outcome {
        PumpOutcome::Matched => Ok(()),
        PumpOutcome::Eof => {
            Err("La conexión se cerró antes de que la salida casara el patrón".into())
        }
        PumpOutcome::Timeout => Err(format!(
            "Tiempo de espera agotado ({timeout_ms} ms) esperando el patrón regex"
        )),
        PumpOutcome::Cancelled => Err("Ejecución cancelada".into()),
    }
}

/// Duerme `ms` milisegundos permaneciendo receptivo a la cancelación.
async fn sleep_cancellable(
    ms: u64,
    run_cancel: &AtomicBool,
    host_cancel: &AtomicBool,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(ms);
    loop {
        if run_cancel.load(Ordering::Relaxed) || host_cancel.load(Ordering::Relaxed) {
            return Err("Ejecución cancelada".into());
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(());
        }
        let chunk = deadline.saturating_duration_since(now).min(POLL_INTERVAL);
        tokio::time::sleep(chunk).await;
    }
}

/// Lee `password:<profile_id>` del keyring del SO (servicio `rustty`).
fn read_keyring_password(profile_id: &str) -> Result<String, String> {
    let key = format!("password:{profile_id}");
    let entry = keyring::Entry::new("rustty", &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pw) => Ok(pw),
        Err(keyring::Error::NoEntry) => Err(format!(
            "No hay contraseña guardada en el keyring para el perfil {profile_id}"
        )),
        Err(e) => Err(e.to_string()),
    }
}

/// Lee la contraseña de una entrada KeePass (requiere la DB desbloqueada).
fn read_keepass_password(uuid: &str) -> Result<String, String> {
    if !crate::keepass_manager::status().unlocked {
        return Err("KeePass está bloqueada; desbloquéala en Preferencias".into());
    }
    match crate::keepass_manager::get_property(
        uuid,
        crate::keepass_manager::EntryProperty::Password,
    )
    .map_err(|e| e.to_string())?
    {
        Some(pw) if !pw.is_empty() => Ok(pw),
        Some(_) => Err(format!("La entrada KeePass {uuid} no tiene contraseña")),
        None => Err(format!("Entrada KeePass {uuid} no encontrada")),
    }
}

// ─── Emisión de eventos ──────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    run_id: &str,
    profile_id: &str,
    host: &str,
    phase: &str,
    step_index: u32,
    total_steps: u32,
) {
    let _ = app.emit(
        &event_name(EventKind::ScriptProgress, run_id),
        ProgressEvent {
            profile_id,
            host,
            phase,
            step_index,
            total_steps,
        },
    );
}

fn emit_host_error(
    app: &AppHandle,
    run_id: &str,
    profile_id: &str,
    host: &str,
    message: &str,
    step_index: Option<u32>,
) {
    let _ = app.emit(
        &event_name(EventKind::ScriptHostError, run_id),
        HostErrorEvent {
            profile_id,
            host,
            message,
            step_index,
        },
    );
}

fn emit_host_done(
    app: &AppHandle,
    run_id: &str,
    profile_id: &str,
    host: &str,
    exit_code: Option<i32>,
    duration_ms: u64,
) {
    let _ = app.emit(
        &event_name(EventKind::ScriptHostDone, run_id),
        HostDoneEvent {
            profile_id,
            host,
            exit_code,
            duration_ms,
        },
    );
}

fn step_phase(step: &Step) -> &'static str {
    match step {
        Step::WaitPrompt | Step::WaitRegex { .. } | Step::Sleep { .. } => "waiting",
        _ => "running",
    }
}

// ─── Runner de un host ───────────────────────────────────────────────────────

/// Ejecuta el script en un host. Emite eventos de progreso/salida y, al final,
/// `ScriptHostDone` (ok) o `ScriptHostError` (fallo). Devuelve `true` si el host
/// terminó correctamente. Un fallo NUNCA tumba a los demás hosts.
#[allow(clippy::too_many_arguments)]
async fn run_host(
    app: &AppHandle,
    run_id: &str,
    host: ResolvedHost,
    steps: &[Step],
    catalog: &[CredentialMeta],
    params: &HashMap<String, String>,
    run_cancel: &AtomicBool,
    host_cancel: Arc<AtomicBool>,
) -> bool {
    let profile = host.profile;
    let profile_id = profile.id.clone();
    let host_addr = profile.host.clone();
    let total_steps = steps.len() as u32;
    let started = Instant::now();

    emit_progress(
        app,
        run_id,
        &profile_id,
        &host_addr,
        "connecting",
        0,
        total_steps,
    );

    // La contraseña de conexión también se redacta defensivamente de la salida.
    let mut secrets = Vec::new();
    if let Some(p) = host.password.as_ref() {
        if !p.is_empty() {
            secrets.push(p.clone());
        }
    }

    let (handle, channel) = match connect_shell(
        &profile,
        host.password.as_deref(),
        host.passphrase.as_deref(),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            emit_host_error(
                app,
                run_id,
                &profile_id,
                &host_addr,
                &redact_secrets(&e, &secrets),
                None,
            );
            return false;
        }
    };

    emit_progress(
        app,
        run_id,
        &profile_id,
        &host_addr,
        "connected",
        0,
        total_steps,
    );

    let mut state = HostState {
        channel,
        app,
        run_id,
        profile_id: profile_id.clone(),
        host: host_addr.clone(),
        secrets,
        last_exit: None,
    };
    let resolve = ResolveCtx {
        ctx: SubstContext::from_profile(&profile),
        catalog: catalog.to_vec(),
        params: params.clone(),
    };

    let mut ok = true;
    for (i, step) in steps.iter().enumerate() {
        if run_cancel.load(Ordering::Relaxed) || host_cancel.load(Ordering::Relaxed) {
            emit_host_error(
                app,
                run_id,
                &profile_id,
                &host_addr,
                "Ejecución cancelada",
                Some(i as u32),
            );
            ok = false;
            break;
        }
        emit_progress(
            app,
            run_id,
            &profile_id,
            &host_addr,
            step_phase(step),
            i as u32,
            total_steps,
        );
        match execute_step(&mut state, step, i, &resolve, run_cancel, &host_cancel).await {
            Ok(StepFlow::Continue) => {}
            Ok(StepFlow::Disconnected) => break,
            Err(e) => {
                let msg = redact_secrets(&e, &state.secrets);
                emit_host_error(app, run_id, &profile_id, &host_addr, &msg, Some(i as u32));
                ok = false;
                break;
            }
        }
    }

    // Drenaje final implícito: sin él, una receta que termina en `send` cerraba
    // el canal al instante y no se emitía nada de salida (ni terminaba el comando).
    if ok && needs_final_drain(steps) {
        emit_progress(
            app,
            run_id,
            &profile_id,
            &host_addr,
            "draining",
            total_steps.saturating_sub(1),
            total_steps,
        );
        match final_drain(&mut state, steps.len(), run_cancel, &host_cancel).await {
            Ok(code) => {
                if code.is_some() {
                    state.last_exit = code;
                }
            }
            Err(e) => {
                let msg = redact_secrets(&e, &state.secrets);
                emit_host_error(app, run_id, &profile_id, &host_addr, &msg, None);
                ok = false;
            }
        }
    }

    // Cierre limpio del canal y de la conexión.
    let _ = state.channel.eof().await;
    let _ = state.channel.close().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    if ok {
        emit_progress(
            app,
            run_id,
            &profile_id,
            &host_addr,
            "done",
            total_steps,
            total_steps,
        );
        emit_host_done(
            app,
            run_id,
            &profile_id,
            &host_addr,
            state.last_exit,
            started.elapsed().as_millis() as u64,
        );
    }
    ok
}

// ─── Orquestador de fan-out ──────────────────────────────────────────────────

/// Lanza el fan-out en un hilo propio con runtime tokio y devuelve enseguida.
#[allow(clippy::too_many_arguments)]
pub fn spawn_run(
    app: AppHandle,
    run_id: String,
    hosts: Vec<ResolvedHost>,
    steps: Vec<Step>,
    options: RunOptions,
    catalog: Vec<CredentialMeta>,
    handle: RunHandle,
    registry: RunRegistry,
) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("scripts: no se pudo crear runtime tokio: {e}");
                let total = hosts.len() as u32;
                let _ = app.emit(
                    &event_name(EventKind::ScriptDone, &run_id),
                    DoneEvent {
                        ok_count: 0,
                        error_count: total,
                        total,
                    },
                );
                if let Ok(mut runs) = registry.lock() {
                    runs.remove(&run_id);
                }
                return;
            }
        };
        rt.block_on(run_fanout(
            app, run_id, hosts, steps, options, catalog, handle, registry,
        ));
    });
}

/// Orquesta la ejecución por host con concurrencia acotada y modo
/// `parallel`/`canary`, respetando `stopOnError` y la cancelación.
#[allow(clippy::too_many_arguments)]
async fn run_fanout(
    app: AppHandle,
    run_id: String,
    hosts: Vec<ResolvedHost>,
    steps: Vec<Step>,
    options: RunOptions,
    catalog: Vec<CredentialMeta>,
    handle: RunHandle,
    registry: RunRegistry,
) {
    let total = hosts.len() as u32;
    let params = options.params;
    let concurrency = (options.concurrency.max(1)) as usize;
    let stop_on_error = options.stop_on_error;
    let run_cancel = handle.cancel_run.clone();

    // Flag de cancelación de un host (preinstalado en `register_run`).
    let host_flag = |pid: &str| -> Arc<AtomicBool> {
        handle
            .host_cancels
            .lock()
            .ok()
            .and_then(|m| m.get(pid).cloned())
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)))
    };

    let mut queue: VecDeque<ResolvedHost> = hosts.into_iter().collect();
    let mut ok_count = 0u32;
    let mut err_count = 0u32;
    let mut stopped = false;

    // Canary: el primer host en solitario; si falla (o se cancela), no sigue.
    if options.mode == RunMode::Canary {
        if let Some(first) = queue.pop_front() {
            if run_cancel.load(Ordering::Relaxed) {
                stopped = true;
            } else {
                let hc = host_flag(&first.profile.id);
                let ok = run_host(
                    &app,
                    &run_id,
                    first,
                    &steps,
                    &catalog,
                    &params,
                    &run_cancel,
                    hc,
                )
                .await;
                if ok {
                    ok_count += 1;
                } else {
                    err_count += 1;
                    stopped = true;
                }
                if run_cancel.load(Ordering::Relaxed) {
                    stopped = true;
                }
            }
        }
    }

    // Resto con concurrencia acotada (FuturesUnordered en el runtime single-thread).
    let mut in_flight = FuturesUnordered::new();
    loop {
        while in_flight.len() < concurrency && !stopped && !run_cancel.load(Ordering::Relaxed) {
            match queue.pop_front() {
                Some(h) => {
                    let hc = host_flag(&h.profile.id);
                    in_flight.push(run_host(
                        &app,
                        &run_id,
                        h,
                        &steps,
                        &catalog,
                        &params,
                        &run_cancel,
                        hc,
                    ));
                }
                None => break,
            }
        }
        if in_flight.is_empty() {
            break;
        }
        if let Some(ok) = in_flight.next().await {
            if ok {
                ok_count += 1;
            } else {
                err_count += 1;
                if stop_on_error {
                    stopped = true;
                }
            }
        }
        if run_cancel.load(Ordering::Relaxed) {
            stopped = true;
        }
    }

    let _ = app.emit(
        &event_name(EventKind::ScriptDone, &run_id),
        DoneEvent {
            ok_count,
            error_count: err_count,
            total,
        },
    );

    if let Ok(mut runs) = registry.lock() {
        runs.remove(&run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::AuthType;

    /// Fija los nombres de campo JSON de los cinco payloads de evento. Son el
    /// contrato con los typedefs de `src/modules/ipc/events.js` y con los
    /// destructurados de `main.js`: una divergencia aquí no rompe nada en
    /// compilación y deja campos `undefined` en la UI (pasó con
    /// `error`/`message` y `stepTotal`/`totalSteps`).
    #[test]
    fn payloads_de_evento_espejan_el_contrato_js() {
        let v = serde_json::to_value(ProgressEvent {
            profile_id: "p1",
            host: "h",
            phase: "running",
            step_index: 2,
            total_steps: 5,
        })
        .unwrap();
        assert_eq!(v["profileId"], "p1");
        assert_eq!(v["host"], "h");
        assert_eq!(v["phase"], "running");
        assert_eq!(v["stepIndex"], 2);
        assert_eq!(v["totalSteps"], 5);

        let v = serde_json::to_value(OutputEvent {
            profile_id: "p1",
            host: "h",
            chunk: "salida",
        })
        .unwrap();
        assert_eq!(v["profileId"], "p1");
        assert_eq!(v["chunk"], "salida");

        let v = serde_json::to_value(HostDoneEvent {
            profile_id: "p1",
            host: "h",
            exit_code: Some(0),
            duration_ms: 1200,
        })
        .unwrap();
        assert_eq!(v["profileId"], "p1");
        assert_eq!(v["exitCode"], 0);
        assert_eq!(v["durationMs"], 1200);

        let v = serde_json::to_value(HostErrorEvent {
            profile_id: "p1",
            host: "h",
            message: "fallo",
            step_index: Some(1),
        })
        .unwrap();
        assert_eq!(v["profileId"], "p1");
        assert_eq!(v["message"], "fallo");
        assert_eq!(v["stepIndex"], 1);

        let v = serde_json::to_value(DoneEvent {
            ok_count: 3,
            error_count: 1,
            total: 4,
        })
        .unwrap();
        assert_eq!(v["okCount"], 3);
        assert_eq!(v["errorCount"], 1);
        assert_eq!(v["total"], 4);
    }

    #[test]
    fn needs_final_drain_detecta_envios_sin_lectura() {
        let send = || Step::Send { text: "ls".into() };
        // El caso del bug: receta de un único `send` → hay que drenar.
        assert!(needs_final_drain(&[send()]));
        // Contraseñas enviadas también dejan salida pendiente.
        assert!(needs_final_drain(&[
            send(),
            Step::SendPasswordFromKeyring { profile_id: None },
        ]));
        // Un wait posterior ya lee la salida: no hay drenaje extra.
        assert!(!needs_final_drain(&[send(), Step::WaitPrompt]));
        assert!(!needs_final_drain(&[
            send(),
            Step::WaitRegex {
                pattern: "listo".into(),
                timeout_ms: 1000,
            },
        ]));
        // Pero un `send` tras el último wait vuelve a dejar salida pendiente.
        assert!(needs_final_drain(&[send(), Step::WaitPrompt, send()]));
        // `expectExit`/`sleep` no leen ni envían: no cambian la decisión.
        assert!(needs_final_drain(&[send(), Step::Sleep { ms: 5 }]));
        assert!(!needs_final_drain(&[
            send(),
            Step::WaitPrompt,
            Step::ExpectExit { code: 0 },
        ]));
        // `disconnect` corta la ejecución: nunca se drena.
        assert!(!needs_final_drain(&[send(), Step::Disconnect]));
        assert!(!needs_final_drain(&[send(), Step::Disconnect, send()]));
        // Receta vacía o sin envíos.
        assert!(!needs_final_drain(&[]));
        assert!(!needs_final_drain(&[Step::Sleep { ms: 5 }]));
    }

    #[test]
    fn marker_prefix_es_seguro_y_unico_por_paso() {
        // El run_id se sanea (solo alfanumérico) y el índice de paso lo distingue.
        assert_eq!(marker_prefix("abc-123", 0), "__RUSTTY_END_abc123_0_");
        assert_ne!(marker_prefix("abc-123", 0), marker_prefix("abc-123", 1));
    }

    #[test]
    fn parse_marker_extrae_exit_code_y_evita_el_eco() {
        let prefix = marker_prefix("run-9", 2);
        // Simula PTY: eco del comando (con %d) + prompt + salida real del marcador.
        let buffer =
            format!("$ printf '\\n{prefix}%d__\\n' \"$?\"\nalgo de salida\n{prefix}0__\n$ ",);
        assert_eq!(parse_marker_exit(&buffer, &prefix), Some(0));

        // Exit code distinto de cero, multi-dígito.
        let buffer = format!("salida previa\n{prefix}127__\n");
        assert_eq!(parse_marker_exit(&buffer, &prefix), Some(127));

        // Solo el eco (sin la línea expandida) → no hay match todavía.
        let solo_eco = format!("$ printf '\\n{prefix}%d__\\n' \"$?\"\n");
        assert_eq!(parse_marker_exit(&solo_eco, &prefix), None);

        // Marcador parcial (aún sin el cierre `__`) → no hay match.
        let parcial = format!("{prefix}12");
        assert_eq!(parse_marker_exit(&parcial, &prefix), None);
    }

    #[test]
    fn parse_marker_toma_el_ultimo_valido() {
        let prefix = marker_prefix("r", 0);
        // Dos marcadores: debe quedarse con el último.
        let buffer = format!("{prefix}0__\nmas cosas\n{prefix}3__\n");
        assert_eq!(parse_marker_exit(&buffer, &prefix), Some(3));
    }

    /// Contexto de sustitución de prueba.
    fn resolve_ctx(params: &[(&str, &str)]) -> ResolveCtx {
        let ctx = SubstContext {
            host: "10.0.0.9".into(),
            port: 22,
            user: "ada".into(),
            profile_name: "Demo".into(),
            workspace: "default".into(),
        };
        ResolveCtx {
            ctx,
            catalog: vec![],
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn resolve_send_sustituye_internos_y_params() {
        // Internos del host + params (inyectados como respuestas de `${ask:}`).
        let rc = resolve_ctx(&[("servicio", "nginx"), ("accion", "restart")]);
        let (out, secrets) =
            rc.resolve_send("ssh ${user}@${host}: sudo systemctl ${ask:accion} ${ask:servicio}");
        assert_eq!(out, "ssh ada@10.0.0.9: sudo systemctl restart nginx");
        assert!(secrets.is_empty(), "sin secretos no se registra nada");
    }

    #[test]
    fn resolve_send_param_ausente_queda_literal() {
        let rc = resolve_ctx(&[]);
        let (out, _) = rc.resolve_send("echo ${ask:noexiste}");
        assert_eq!(out, "echo ${ask:noexiste}");
    }

    #[test]
    fn preview_solo_incluye_los_send_y_redacta_secretos() {
        let profile = sample_profile();
        let steps = vec![
            Step::Send {
                text: "whoami".into(),
            },
            Step::WaitPrompt,
            Step::Send {
                text: "echo pwd=${secret:token}".into(),
            },
            Step::Sleep { ms: 10 },
        ];
        let cmds = preview_commands(&profile, &steps, vec![], HashMap::new());
        // Solo los `send`; el `${secret:}` aparece redactado, nunca su valor.
        assert_eq!(
            cmds,
            vec!["whoami".to_string(), format!("echo pwd={REDACTED}")]
        );
    }

    fn sample_profile() -> ConnectionProfile {
        ConnectionProfile {
            id: "p1".into(),
            name: "Demo".into(),
            host: "10.0.0.9".into(),
            port: 22,
            username: "ada".into(),
            connection_type: "ssh".into(),
            domain: None,
            auth_type: AuthType::Password,
            key_path: None,
            group: None,
            notes: None,
            workspace_id: "default".into(),
            keepass_entry_uuid: None,
            keepass_property: None,
            password_source: Default::default(),
            master_credential_id: None,
            extra_credentials: vec![],
            follow_cwd: true,
            keep_alive_secs: None,
            allow_legacy_algorithms: false,
            legacy_algorithms: None,
            agent_forwarding: false,
            x11_forwarding: false,
            auto_reconnect: None,
            proxy_jump: None,
            mac_address: None,
            wol_broadcast: None,
            wol_port: None,
            session_log: false,
            session_log_dir: None,
            disable_paste_confirm: false,
            ssh_tunnels: vec![],
            created_at: "2026-07-04T10:00:00Z".into(),
            updated_at: None,
        }
    }
}
