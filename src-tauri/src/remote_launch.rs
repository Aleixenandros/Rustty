//! Arranque del canal interactivo de un perfil SSH: tipo de terminal (TERM),
//! variables de entorno y comando al conectar.
//!
//! Núcleo **puro**: validación de nombres, topes, precedencia y resolución de
//! los `${...}`. Lo consumen `ssh_manager` (canal principal y pestañas nuevas de
//! la conexión) y la CLI; la E/S con el servidor (`set_env`, `request_pty`,
//! `exec`) vive allí. Espejo de topes y lista de TERM en
//! `src/modules/remote-launch.js`.
//!
//! Los valores resueltos pueden llevar secretos (`${secret:}`/`${master:}`):
//! nunca se escriben en un log. Lo que se anota son nombres de variables y la
//! plantilla del comando tal como está en el perfil; los valores secretos
//! usados se guardan en [`SessionLaunch::secrets`] para que la redacción
//! defensiva de errores (`subst::redact_secrets`) los cubra también.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use zeroize::Zeroizing;

use crate::credentials::{self, AskSpec, CredentialResolver, CredentialStore};
use crate::profiles::ConnectionProfile;
use crate::subst::{InternalVar, Resolver, SubstContext};

/// TERM que se pide cuando el perfil no elige otro.
pub const DEFAULT_TERM: &str = "xterm-256color";

/// Lista cerrada de tipos de terminal ofrecidos en el formulario. Cerrada a
/// propósito: el valor viaja al servidor tal cual y un TERM que su terminfo no
/// conoce deja `less`, `vim` o `top` sin poder pintar.
pub const TERM_TYPES: &[&str] = &[
    "xterm-256color",
    "xterm",
    "screen-256color",
    "tmux-256color",
    "vt220",
    "vt100",
    "linux",
];

/// Tope de variables de entorno por perfil.
pub const MAX_ENV_VARS: usize = 32;
/// Tope de longitud del nombre de una variable.
pub const MAX_ENV_NAME_LEN: usize = 64;
/// Tope de longitud del valor (ya resuelto) de una variable.
pub const MAX_ENV_VALUE_LEN: usize = 4096;
/// Tope de longitud del comando al conectar (ya resuelto).
pub const MAX_REMOTE_COMMAND_LEN: usize = 4096;

/// Nombre de variable de entorno POSIX: `[A-Za-z_][A-Za-z0-9_]*`, con tope.
pub fn is_valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    name.len() <= MAX_ENV_NAME_LEN
        && (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// El TERM elegido en el perfil, si está en la lista cerrada. `None` = el de
/// siempre (vacío, ausente o desconocido).
pub fn term_type(raw: Option<&str>) -> Option<&'static str> {
    let raw = raw?.trim();
    TERM_TYPES.iter().copied().find(|t| *t == raw)
}

/// Qué arranca el canal interactivo de la conexión.
#[derive(Debug, PartialEq, Eq)]
pub enum Launch<'a> {
    /// `tmux -CC`: el canal transporta el protocolo de control, sin PTY.
    TmuxControl,
    /// Reenganche de la sesión persistente (tmux/screen), con este comando.
    Persistent(&'a str),
    /// Comando al conectar del perfil, sobre el PTY.
    Command(&'a str),
    /// Shell de login del usuario.
    Shell,
}

/// Precedencia documentada: modo control de tmux > sesión persistente >
/// comando al conectar > shell. `persist` es el attach ya decidido (solo existe
/// si el multiplexor está en el servidor): si la sesión persistente degrada a
/// shell normal, el comando del perfil vuelve a contar.
pub fn choose_launch<'a>(
    tmux_control: bool,
    persist: Option<&'a str>,
    command: Option<&'a str>,
) -> Launch<'a> {
    if tmux_control {
        Launch::TmuxControl
    } else if let Some(cmd) = persist {
        Launch::Persistent(cmd)
    } else if let Some(cmd) = command {
        Launch::Command(cmd)
    } else {
        Launch::Shell
    }
}

/// Lo que el canal interactivo pide al servidor, ya resuelto. Se resuelve una
/// vez al conectar y lo reutilizan la reconexión automática y las pestañas
/// nuevas de la conexión. Sin `Debug` a propósito: lleva valores resueltos.
#[derive(Clone, Default)]
pub struct SessionLaunch {
    /// TERM elegido en el perfil. `None` = el de siempre (ver [`Self::term`]).
    pub term: Option<&'static str>,
    /// Variables válidas y dentro de los topes, en orden, con su valor resuelto.
    pub env: Vec<(String, String)>,
    /// Comando al conectar resuelto. `None` = shell.
    pub command: Option<String>,
    /// Plantilla del comando tal como está en el perfil: es lo que se anota en
    /// el log de conexión, nunca el valor resuelto.
    pub command_template: Option<String>,
    /// Valores de `${secret:}`/`${master:}` usados al resolver, para redactar.
    pub secrets: Vec<Zeroizing<String>>,
    /// Avisos para el log de conexión (lo descartado y por qué). Solo nombres,
    /// jamás valores.
    pub notices: Vec<String>,
}

impl SessionLaunch {
    /// TERM del PTY en la app: el del perfil o `xterm-256color`.
    pub fn term(&self) -> &'static str {
        self.term.unwrap_or(DEFAULT_TERM)
    }

    /// Nombres de las variables, para el log de conexión.
    pub fn env_names(&self) -> String {
        self.env
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Recorta un texto ajeno (un nombre inválido llegado por sync o import) para
/// citarlo en un aviso sin inundar el log.
fn shorten(text: &str) -> String {
    const MAX: usize = 40;
    if text.chars().count() <= MAX {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(MAX).collect::<String>())
    }
}

/// Resolver que delega en otro y anota los valores de `${secret:}`/`${master:}`
/// que entrega, para poder redactarlos después.
struct SecretRecorder<'a> {
    inner: &'a dyn Resolver,
    recorded: RefCell<Vec<String>>,
}

impl SecretRecorder<'_> {
    fn record(&self, value: Option<String>) -> Option<String> {
        if let Some(v) = value.as_ref().filter(|v| !v.is_empty()) {
            self.recorded.borrow_mut().push(v.clone());
        }
        value
    }
}

impl Resolver for SecretRecorder<'_> {
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
        self.record(self.inner.secret(name))
    }
    fn master(&self, name: &str) -> Option<String> {
        self.record(self.inner.master(name))
    }
    fn ask(&self, label: &str, options: &[String]) -> Option<String> {
        self.inner.ask(label, options)
    }
    fn cmd(&self, command: &str) -> Option<String> {
        self.inner.cmd(command)
    }
}

/// Plantilla del comando del perfil, sin espacios sobrantes. `None` si no hay.
fn command_template(profile: &ConnectionProfile) -> Option<&str> {
    profile
        .remote_command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Textos del perfil que pasan por el motor: el comando y los valores.
fn templates(profile: &ConnectionProfile, with_command: bool) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    if with_command {
        out.extend(command_template(profile));
    }
    out.extend(profile.env_vars.iter().map(|v| v.value.as_str()));
    out
}

/// Resuelve TERM, variables y comando del perfil con `resolver`. Lo inválido o
/// lo que pasa de los topes se descarta con un aviso en `notices`; nada de esto
/// es fatal: la conexión sigue con lo demás.
/// Si el valor es exactamente `${env:NOMBRE}` (lo que deja el importador para un
/// `SendEnv`), el nombre de esa variable local.
fn sole_env_marker(value: &str) -> Option<&str> {
    value
        .trim()
        .strip_prefix("${env:")?
        .strip_suffix('}')
        .filter(|name| is_valid_env_name(name))
}

pub fn resolve(profile: &ConnectionProfile, resolver: &dyn Resolver) -> SessionLaunch {
    let recorder = SecretRecorder {
        inner: resolver,
        recorded: RefCell::new(Vec::new()),
    };
    let mut launch = SessionLaunch::default();

    let raw_term = profile
        .term_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    launch.term = term_type(raw_term);
    if let (Some(raw), None) = (raw_term, launch.term) {
        launch.notices.push(format!(
            "Tipo de terminal «{}» desconocido: se pide {DEFAULT_TERM}",
            shorten(raw)
        ));
    }

    let mut seen: HashSet<&str> = HashSet::new();
    for var in &profile.env_vars {
        let name = var.name.trim();
        if name.is_empty() && var.value.trim().is_empty() {
            continue;
        }
        if !is_valid_env_name(name) {
            launch.notices.push(format!(
                "Variable «{}» ignorada: el nombre solo admite letras, dígitos y «_», y no empieza por dígito",
                shorten(name)
            ));
            continue;
        }
        // Como `SetEnv` de OpenSSH: con un nombre repetido vale el primero.
        if !seen.insert(name) {
            launch
                .notices
                .push(format!("Variable {name} repetida: se usa la primera"));
            continue;
        }
        if launch.env.len() >= MAX_ENV_VARS {
            launch.notices.push(format!(
                "Solo se envían las primeras {MAX_ENV_VARS} variables de entorno"
            ));
            break;
        }
        // Lo que importa `SendEnv VAR` de ~/.ssh/config: si la variable no
        // existe en este equipo (la app no lee el `.bashrc`), OpenSSH no la
        // envía; aquí habría salido el marcador literal.
        if let Some(env_name) = sole_env_marker(&var.value) {
            if recorder.env(env_name).is_none() {
                launch.notices.push(format!(
                    "Variable {name} sin valor en este equipo ({env_name}): no se envía"
                ));
                continue;
            }
        }
        let value = crate::subst::substitute(&var.value, &recorder);
        if value.len() > MAX_ENV_VALUE_LEN || value.contains('\0') {
            launch.notices.push(format!(
                "Variable {name} ignorada: el valor pasa de {MAX_ENV_VALUE_LEN} caracteres o lleva un carácter nulo"
            ));
            continue;
        }
        launch.env.push((name.to_string(), value));
    }

    if let Some(template) = command_template(profile) {
        let resolved = crate::subst::substitute(template, &recorder);
        let resolved = resolved.trim();
        if resolved.len() > MAX_REMOTE_COMMAND_LEN || resolved.contains('\0') {
            launch.notices.push(format!(
                "El comando al conectar pasa de {MAX_REMOTE_COMMAND_LEN} caracteres o lleva un carácter nulo: se abre un shell"
            ));
        } else if !resolved.is_empty() {
            launch.command = Some(resolved.to_string());
            launch.command_template = Some(template.to_string());
        }
    }

    launch.secrets = recorder
        .recorded
        .into_inner()
        .into_iter()
        .map(Zeroizing::new)
        .collect();
    launch
}

/// [`resolve`] con el catálogo de credenciales (`${var:}`, `${secret:}`,
/// `${master:}`) y las respuestas a los `${ask:}` pedidas al conectar. Solo lee
/// el catálogo si algún texto lleva marcadores.
pub fn resolve_with_store(
    profile: &ConnectionProfile,
    store: &CredentialStore,
    ask_answers: HashMap<String, String>,
) -> SessionLaunch {
    let needs_catalog = templates(profile, true)
        .iter()
        .any(|text| text.contains("${"));
    let catalog = if needs_catalog {
        store.load_all().unwrap_or_default()
    } else {
        Vec::new()
    };
    let resolver = CredentialResolver::with_ask_answers(
        SubstContext::from_profile(profile),
        catalog,
        ask_answers,
    );
    resolve(profile, &resolver)
}

/// `${ask:}` del comando (si `with_command`) y de los valores de las variables,
/// en orden de aparición. El frontend los pregunta antes de conectar
/// (`template_asks`); la CLI, por la terminal.
pub fn collect_asks(profile: &ConnectionProfile, with_command: bool) -> Vec<AskSpec> {
    templates(profile, with_command)
        .into_iter()
        .flat_map(credentials::collect_asks)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::ProfileEnvVar;

    /// Resolver de prueba: `var`, `secret` y `ask` desde mapas fijos.
    struct Fake;

    impl Resolver for Fake {
        fn internal(&self, var: InternalVar) -> Option<String> {
            matches!(var, InternalVar::Host).then(|| "web01".to_string())
        }
        fn env(&self, name: &str) -> Option<String> {
            (name == "LOCAL").then(|| "de-aqui".to_string())
        }
        fn var(&self, name: &str) -> Option<String> {
            (name == "app").then(|| "/srv/app".to_string())
        }
        fn secret(&self, name: &str) -> Option<String> {
            (name == "token").then(|| "s3cr3t".to_string())
        }
        fn master(&self, _name: &str) -> Option<String> {
            None
        }
        fn ask(&self, label: &str, _options: &[String]) -> Option<String> {
            (label == "Usuario").then(|| "ana".to_string())
        }
    }

    fn profile() -> ConnectionProfile {
        serde_json::from_str(
            r#"{"id":"p","name":"P","host":"h","port":22,"username":"u","domain":null,
                "auth_type":"password","key_path":null,"group":null,
                "created_at":"2026-10-25T00:00:00Z"}"#,
        )
        .expect("perfil mínimo")
    }

    fn var(name: &str, value: &str) -> ProfileEnvVar {
        ProfileEnvVar {
            name: name.into(),
            value: value.into(),
        }
    }

    #[test]
    fn nombres_de_variable_validos_e_invalidos() {
        for ok in ["LANG", "LC_ALL", "_x", "a1", "RUSTTY_OPERADOR"] {
            assert!(is_valid_env_name(ok), "{ok} debería valer");
        }
        for bad in ["", "1A", "A-B", "A B", "A=B", "Ñ", "LANG ", "$HOME"] {
            assert!(!is_valid_env_name(bad), "{bad:?} no debería valer");
        }
        assert!(is_valid_env_name(&"A".repeat(MAX_ENV_NAME_LEN)));
        assert!(!is_valid_env_name(&"A".repeat(MAX_ENV_NAME_LEN + 1)));
    }

    #[test]
    fn el_tipo_de_terminal_sale_de_la_lista_cerrada() {
        assert_eq!(term_type(Some("vt100")), Some("vt100"));
        assert_eq!(term_type(Some(" linux ")), Some("linux"));
        assert_eq!(term_type(Some("rxvt")), None);
        assert_eq!(term_type(Some("")), None);
        assert_eq!(term_type(None), None);
        assert!(TERM_TYPES.contains(&DEFAULT_TERM));

        let mut p = profile();
        assert_eq!(resolve(&p, &Fake).term(), DEFAULT_TERM);
        p.term_type = Some("vt100".into());
        assert_eq!(resolve(&p, &Fake).term(), "vt100");
        // Uno desconocido (p. ej. de una versión futura por sync) no viaja: se
        // pide el de siempre y se avisa.
        p.term_type = Some("xterm-kitty".into());
        let launch = resolve(&p, &Fake);
        assert_eq!(launch.term(), DEFAULT_TERM);
        assert!(launch.notices[0].contains("xterm-kitty"));
    }

    #[test]
    fn precedencia_control_persistente_comando_shell() {
        assert_eq!(
            choose_launch(true, Some("tmux attach"), Some("sudo -i")),
            Launch::TmuxControl
        );
        assert_eq!(
            choose_launch(false, Some("tmux attach"), Some("sudo -i")),
            Launch::Persistent("tmux attach")
        );
        // La sesión persistente degradó (sin tmux en el servidor): manda el comando.
        assert_eq!(
            choose_launch(false, None, Some("sudo -i")),
            Launch::Command("sudo -i")
        );
        assert_eq!(choose_launch(false, None, None), Launch::Shell);
    }

    #[test]
    fn el_comando_se_resuelve_y_el_log_solo_ve_la_plantilla() {
        let mut p = profile();
        p.remote_command =
            Some("  cd ${var:app} && sudo -u ${ask:Usuario} TOKEN=${secret:token} bash -l ".into());
        let launch = resolve(&p, &Fake);
        assert_eq!(
            launch.command.as_deref(),
            Some("cd /srv/app && sudo -u ana TOKEN=s3cr3t bash -l")
        );
        // Lo anotable es la plantilla, que no lleva el secreto.
        let template = launch.command_template.as_deref().unwrap();
        assert!(!template.contains("s3cr3t"));
        // Y el secreto queda registrado para la redacción defensiva.
        let secrets: Vec<&str> = launch.secrets.iter().map(|s| s.as_str()).collect();
        assert_eq!(secrets, vec!["s3cr3t"]);
        let msg = crate::subst::redact_secrets(
            &format!("fallo al ejecutar {}", launch.command.as_deref().unwrap()),
            &launch.secrets,
        );
        assert!(!msg.contains("s3cr3t"));
    }

    #[test]
    fn un_comando_vacio_o_desmedido_abre_un_shell() {
        let mut p = profile();
        p.remote_command = Some("   ".into());
        assert!(resolve(&p, &Fake).command.is_none());
        p.remote_command = None;
        assert!(resolve(&p, &Fake).command.is_none());
        p.remote_command = Some("x".repeat(MAX_REMOTE_COMMAND_LEN + 1));
        let launch = resolve(&p, &Fake);
        assert!(launch.command.is_none());
        assert_eq!(launch.notices.len(), 1);
        p.remote_command = Some("echo a\0b".into());
        assert!(resolve(&p, &Fake).command.is_none());
    }

    #[test]
    fn variables_validas_con_topes_y_sin_duplicados() {
        let mut p = profile();
        p.env_vars = vec![
            var("LANG", "es_ES.UTF-8"),
            var("DESDE", "${env:LOCAL}@${host}"),
            var("1MAL", "x"),
            var("LANG", "en_US.UTF-8"),
            var("", ""),
            var("LARGA", &"v".repeat(MAX_ENV_VALUE_LEN + 1)),
            var("TOKEN", "${secret:token}"),
        ];
        let launch = resolve(&p, &Fake);
        assert_eq!(
            launch.env,
            vec![
                ("LANG".to_string(), "es_ES.UTF-8".to_string()),
                ("DESDE".to_string(), "de-aqui@web01".to_string()),
                ("TOKEN".to_string(), "s3cr3t".to_string()),
            ]
        );
        assert_eq!(launch.env_names(), "LANG, DESDE, TOKEN");
        // Tres avisos (nombre inválido, repetida, valor largo) y ninguno lleva
        // un valor: solo nombres.
        assert_eq!(launch.notices.len(), 3, "{:?}", launch.notices);
        assert!(launch.notices.iter().all(|n| !n.contains("en_US") && !n.contains("s3cr3t")));

        p.env_vars = (0..MAX_ENV_VARS + 5).map(|i| var(&format!("V{i}"), "1")).collect();
        let launch = resolve(&p, &Fake);
        assert_eq!(launch.env.len(), MAX_ENV_VARS);
        assert_eq!(launch.notices.len(), 1);
    }

    /// Lo que deja el importador para `SendEnv VAR`: si la variable no existe en
    /// este equipo no se envía (como OpenSSH), en vez de mandar el marcador.
    #[test]
    fn un_send_env_sin_valor_local_no_se_envia() {
        let mut p = profile();
        p.env_vars = vec![
            var("GIT_AUTHOR_NAME", "${env:GIT_AUTHOR_NAME}"),
            var("DESDE", "${env:LOCAL}"),
            var("MEZCLA", "x-${env:NO_HAY}"),
        ];
        let launch = resolve(&p, &Fake);
        assert_eq!(launch.env.len(), 2, "{:?}", launch.env);
        assert_eq!(launch.env[0], ("DESDE".to_string(), "de-aqui".to_string()));
        // Un valor compuesto sigue el contrato del motor (no es un SendEnv).
        assert_eq!(launch.env[1].0, "MEZCLA");
        assert!(launch.notices.iter().any(|n| n.contains("GIT_AUTHOR_NAME")), "{:?}", launch.notices);
        assert_eq!(sole_env_marker(" ${env:HOME} "), Some("HOME"));
        assert_eq!(sole_env_marker("${env:1MAL}"), None);
        assert_eq!(sole_env_marker("a${env:HOME}"), None);
    }

    #[test]
    fn las_preguntas_salen_del_comando_y_de_las_variables() {
        let mut p = profile();
        p.remote_command = Some("sudo -u ${ask:Usuario|root|ana} -i".into());
        p.env_vars = vec![var("TICKET", "${ask:Ticket}"), var("LANG", "C")];
        let labels: Vec<String> = collect_asks(&p, true).into_iter().map(|a| a.label).collect();
        assert_eq!(labels, vec!["Usuario", "Ticket"]);
        // Con `--exec` el comando del perfil no se usa: no se pregunta por él.
        let labels: Vec<String> = collect_asks(&p, false).into_iter().map(|a| a.label).collect();
        assert_eq!(labels, vec!["Ticket"]);
    }
}
