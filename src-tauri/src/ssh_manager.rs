//! Gestor SSH interactivo basado en `russh`.
//!
//! Misma arquitectura que `sftp_manager`: un hilo dedicado por sesión con
//! un runtime tokio single-threaded. El hilo principal de Tauri se comunica
//! con él mediante un `tokio::sync::mpsc::UnboundedSender` (cuyo `send` es
//! síncrono), lo que nos permite exponer la misma API que antes sin obligar
//! al resto del backend a ser asíncrono.
//!
//! Soporta las tres formas de autenticación del perfil: contraseña, clave
//! pública (con passphrase opcional) y agente SSH del sistema.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use russh::client::{self, AuthResult};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::profiles::{AuthType, ConnectionProfile};

// ─── Mensajes del frontend al hilo SSH ──────────────────────────────────────

pub enum SessionCommand {
    /// Bytes de entrada del usuario (teclas)
    Input(Vec<u8>),
    /// Solicitud de redimensionado del terminal
    Resize { cols: u32, rows: u32 },
    /// Cierre limpio de la sesión
    Disconnect,
}

// ─── Handle de sesión ────────────────────────────────────────────────────────

struct SessionHandle {
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
}

// ─── Estado global gestionado por Tauri ─────────────────────────────────────

pub struct SshManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl SshManager {
    pub fn new() -> Self {
        SshManager {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Inicia una conexión SSH en un hilo dedicado con runtime tokio.
    /// Emite eventos Tauri para notificar al frontend:
    ///   - `ssh-connected-{id}` : conexión establecida
    ///   - `ssh-data-{id}`      : bytes recibidos del servidor (stdout + stderr)
    ///   - `ssh-error-{id}`     : error de conexión/autenticación
    ///   - `ssh-closed-{id}`    : sesión terminada
    pub fn connect(
        &self,
        session_id: String,
        profile: ConnectionProfile,
        password: Option<String>,
        passphrase: Option<String>,
        app_handle: AppHandle,
    ) -> Result<(), AppError> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();

        let sid = session_id.clone();
        let ah = app_handle.clone();

        thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ah.emit(
                        &format!("ssh-error-{}", sid),
                        format!("No se pudo crear runtime tokio: {e}"),
                    );
                    let _ = ah.emit(&format!("ssh-closed-{}", sid), "");
                    return;
                }
            };
            let res = rt.block_on(run_session(
                sid.clone(),
                profile,
                password,
                passphrase,
                cmd_rx,
                ah.clone(),
            ));
            if let Err(e) = res {
                let _ = ah.emit(&format!("ssh-error-{}", sid), e.to_string());
            }
            let _ = ah.emit(&format!("ssh-closed-{}", sid), "");
        });

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id, SessionHandle { cmd_tx });

        Ok(())
    }

    /// Envía bytes de entrada (teclas del usuario) a la sesión activa
    pub fn send_input(&self, session_id: &str, data: Vec<u8>) -> Result<(), AppError> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        handle
            .cmd_tx
            .send(SessionCommand::Input(data))
            .map_err(|_| AppError::SessionNotFound(session_id.to_string()))
    }

    /// Solicita al servidor SSH un cambio de tamaño del PTY
    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), AppError> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        handle
            .cmd_tx
            .send(SessionCommand::Resize { cols, rows })
            .map_err(|_| AppError::SessionNotFound(session_id.to_string()))
    }

    /// Cierra y elimina una sesión del mapa de estado
    pub fn disconnect(&self, session_id: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(handle) = sessions.remove(session_id) {
            let _ = handle.cmd_tx.send(SessionCommand::Disconnect);
        }
        Ok(())
    }
}

// ─── Handler russh ───────────────────────────────────────────────────────────

/// Handler mínimo: aceptamos la host key sin verificar (igual que hacía el
/// backend ssh2). TODO pendiente: integrar `known_hosts` de verdad.
struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

// ─── Worker asíncrono ───────────────────────────────────────────────────────

async fn run_session(
    session_id: String,
    profile: ConnectionProfile,
    password: Option<String>,
    passphrase: Option<String>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    app_handle: AppHandle,
) -> Result<(), AppError> {
    // 1. TCP + handshake SSH
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });
    let addr = format!("{}:{}", profile.host, profile.port);
    let mut handle = client::connect(config, addr.clone(), Client)
        .await
        .map_err(|e| AppError::Io(format!("No se puede conectar a {addr}: {e}")))?;

    // 2. Autenticación
    let auth = match &profile.auth_type {
        AuthType::Password => {
            let pass = password.ok_or_else(|| AppError::Auth("Se requiere contraseña".into()))?;
            handle
                .authenticate_password(profile.username.clone(), pass)
                .await
                .map_err(|e| AppError::Auth(format!("Autenticación por contraseña fallida: {e}")))?
        }
        AuthType::PublicKey => {
            let key_path = profile
                .key_path
                .as_ref()
                .ok_or_else(|| AppError::Auth("Se requiere ruta de clave privada".into()))?;
            let key = load_secret_key(Path::new(key_path), passphrase.as_deref())
                .map_err(|e| AppError::Auth(format!("Clave inválida: {e}")))?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            handle
                .authenticate_publickey(
                    profile.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| AppError::Auth(format!("Autenticación por clave fallida: {e}")))?
        }
        AuthType::Agent => authenticate_with_agent(&mut handle, &profile.username).await?,
    };

    match auth {
        AuthResult::Success => {}
        AuthResult::Failure { remaining_methods } => {
            return Err(AppError::Auth(format!(
                "Autenticación fallida. Métodos restantes: {:?}",
                remaining_methods
            )));
        }
    }

    // 3. Canal + PTY + shell
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("No se pudo abrir canal: {e}")))?;

    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| AppError::Ssh(format!("No se pudo solicitar PTY: {e}")))?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::Ssh(format!("No se pudo abrir shell: {e}")))?;

    let _ = app_handle.emit(&format!("ssh-connected-{}", session_id), &profile.name);

    // 4. Bucle de E/S: multiplexa datos del servidor y comandos del frontend
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = app_handle
                            .emit(&format!("ssh-data-{}", session_id), data.to_vec());
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        // stderr → lo mezclamos con stdout, como hacía ssh2.
                        let _ = app_handle
                            .emit(&format!("ssh-data-{}", session_id), data.to_vec());
                    }
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => break,
                    Some(_) => {}
                    None => break,
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCommand::Input(data)) => {
                        let _ = channel.data(&data[..]).await;
                    }
                    Some(SessionCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SessionCommand::Disconnect) | None => break,
                }
            }
        }
    }

    // 5. Cierre limpio
    let _ = channel.eof().await;
    let _ = channel.close().await;
    Ok(())
}

/// Autenticación vía agente SSH. Probamos cada identidad hasta que una
/// funcione o se acaben.
#[cfg(unix)]
async fn authenticate_with_agent(
    handle: &mut client::Handle<Client>,
    username: &str,
) -> Result<AuthResult, AppError> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| AppError::Auth(format!("No se pudo contactar con el agente SSH: {e}")))?
        .dynamic();
    let identities = agent.request_identities().await.map_err(|e| {
        AppError::Auth(format!("No se pudieron listar identidades del agente: {e}"))
    })?;

    if identities.is_empty() {
        return Err(AppError::Auth(
            "El agente SSH no tiene claves cargadas".into(),
        ));
    }

    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let mut last_failure = None;
    for key in identities {
        let res = handle
            .authenticate_publickey_with(username, key, hash_alg, &mut agent)
            .await;
        match res {
            Ok(AuthResult::Success) => return Ok(AuthResult::Success),
            Ok(other) => last_failure = Some(other),
            Err(e) => return Err(AppError::Auth(format!("Error al firmar con agente: {e}"))),
        }
    }
    Ok(last_failure.unwrap_or(AuthResult::Failure {
        remaining_methods: russh::MethodSet::empty(),
    }))
}

#[cfg(not(unix))]
async fn authenticate_with_agent(
    _handle: &mut client::Handle<Client>,
    _username: &str,
) -> Result<AuthResult, AppError> {
    Err(AppError::Auth(
        "Autenticación vía agente SSH no soportada en esta plataforma".into(),
    ))
}
