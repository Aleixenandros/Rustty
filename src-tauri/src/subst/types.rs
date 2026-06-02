//! Tipos del motor de sustitución de plantillas (`${...}`).
//!
//! Aquí viven los tipos parseados por el motor (`Marker`, `InternalVar`), el
//! contexto con los datos internos del perfil (`SubstContext`) y el trait
//! `Resolver` que abstrae cómo se resuelve cada namespace. Las fases futuras
//! implementarán `Resolver` para `var`/`secret`/`master`/`ask`; en la Fase 1
//! solo se resuelven los internos y `${env:...}`.

use chrono::Local;
use serde::{Deserialize, Serialize};

use crate::profiles::ConnectionProfile;

/// Variable interna derivada del perfil/contexto de ejecución.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InternalVar {
    /// `${host}` → `profile.host`.
    Host,
    /// `${port}` → `profile.port`.
    Port,
    /// `${user}` → `profile.username`.
    User,
    /// `${profileName}` → `profile.name`.
    ProfileName,
    /// `${workspace}` → `profile.workspace_id`.
    Workspace,
    /// `${date}` → fecha local `YYYY-MM-DD` en el instante de resolver.
    Date,
    /// `${time}` → hora local `HH:MM:SS` en el instante de resolver.
    Time,
}

impl InternalVar {
    /// Traduce el nombre del cuerpo del marcador al interno correspondiente.
    /// Devuelve `None` si el nombre no es un interno conocido.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "host" => Some(InternalVar::Host),
            "port" => Some(InternalVar::Port),
            "user" => Some(InternalVar::User),
            "profileName" => Some(InternalVar::ProfileName),
            "workspace" => Some(InternalVar::Workspace),
            "date" => Some(InternalVar::Date),
            "time" => Some(InternalVar::Time),
            _ => None,
        }
    }
}

/// Un fragmento de plantilla ya parseado.
///
/// `Literal` cubre el texto plano, los escapes `$${...}` (ya desescapados) y
/// cualquier marcador desconocido o mal formado, que se conserva tal cual.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Marker {
    /// Texto literal (incluye escapes resueltos y marcadores desconocidos).
    Literal(String),
    /// Variable interna `${host}`, `${date}`, etc.
    Internal(InternalVar),
    /// `${env:VAR}`.
    Env(String),
    /// `${var:nombre}` (resuelto en Fase 2).
    Var(String),
    /// `${secret:nombre}` (resuelto en Fase 4).
    Secret(String),
    /// `${master:nombre}` (resuelto en Fase 3).
    Master(String),
    /// `${ask:etiqueta|op1|op2}` (resuelto en Fase 5).
    Ask {
        /// Texto que se mostrará al usuario.
        label: String,
        /// Opciones de selección (vacío = entrada de texto libre).
        options: Vec<String>,
    },
    /// `${cmd:comando}` (reservado, fuera de alcance).
    Cmd(String),
}

/// Datos internos de la sustitución, derivados de un perfil.
///
/// `date`/`time` no se guardan: se calculan al resolver. Es serializable para
/// que el comando Tauri `substitute_preview` (fases futuras) pueda recibirlo
/// desde el frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubstContext {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub profile_name: String,
    pub workspace: String,
}

impl SubstContext {
    /// Construye el contexto a partir de un perfil de conexión.
    pub fn from_profile(profile: &ConnectionProfile) -> Self {
        SubstContext {
            host: profile.host.clone(),
            port: profile.port,
            user: profile.username.clone(),
            profile_name: profile.name.clone(),
            workspace: profile.workspace_id.clone(),
        }
    }
}

/// Abstrae la resolución de cada namespace de marcadores.
///
/// El motor (`engine::substitute`) consulta este trait para cada marcador.
/// Un método que devuelva `None` deja el marcador **literal** en el resultado,
/// conforme al contrato. Las fases futuras implementan `var`/`secret`/`master`/
/// `ask`; en Fase 1 el resolver por defecto (`DefaultResolver`) solo resuelve
/// internos y `env`.
pub trait Resolver {
    /// Resuelve una variable interna (host/port/user/...).
    fn internal(&self, var: InternalVar) -> Option<String>;
    /// Resuelve `${env:name}` (variable de entorno del proceso backend).
    fn env(&self, name: &str) -> Option<String>;
    /// Resuelve `${var:name}` (Fase 2).
    fn var(&self, name: &str) -> Option<String>;
    /// Resuelve `${secret:name}` (Fase 4).
    fn secret(&self, name: &str) -> Option<String>;
    /// Resuelve `${master:name}` (Fase 3).
    fn master(&self, name: &str) -> Option<String>;
    /// Resuelve `${ask:label|opciones}` (Fase 5).
    fn ask(&self, label: &str, options: &[String]) -> Option<String>;
    /// Resuelve `${cmd:comando}` (reservado, fuera de alcance).
    fn cmd(&self, _command: &str) -> Option<String> {
        None
    }
}

/// Resolver por defecto de la Fase 1.
///
/// Resuelve internos desde un `SubstContext` y `env` desde `std::env::var`.
/// Para `var`/`secret`/`master`/`ask`/`cmd` devuelve `None`, de modo que el
/// motor deja esos marcadores literales hasta que las fases siguientes
/// aporten su propio `Resolver`.
pub struct DefaultResolver {
    ctx: SubstContext,
}

impl DefaultResolver {
    /// Crea el resolver por defecto con el contexto de internos dado.
    pub fn new(ctx: SubstContext) -> Self {
        DefaultResolver { ctx }
    }
}

impl Resolver for DefaultResolver {
    fn internal(&self, var: InternalVar) -> Option<String> {
        let value = match var {
            InternalVar::Host => self.ctx.host.clone(),
            InternalVar::Port => self.ctx.port.to_string(),
            InternalVar::User => self.ctx.user.clone(),
            InternalVar::ProfileName => self.ctx.profile_name.clone(),
            InternalVar::Workspace => self.ctx.workspace.clone(),
            InternalVar::Date => Local::now().format("%Y-%m-%d").to_string(),
            InternalVar::Time => Local::now().format("%H:%M:%S").to_string(),
        };
        Some(value)
    }

    fn env(&self, name: &str) -> Option<String> {
        // Conforme al contrato: si la variable no existe, el namespace `env`
        // resuelve a cadena vacía (no error, no literal).
        Some(std::env::var(name).unwrap_or_default())
    }

    fn var(&self, _name: &str) -> Option<String> {
        None
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
