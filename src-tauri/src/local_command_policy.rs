//! Política de los comandos locales del catálogo del usuario.
//!
//! Hasta v2.13.0, `run_local_command` ejecutaba con `sh -c` el texto **ya
//! resuelto** que le mandara el renderer: una XSS o un renderer comprometido
//! tenía un intérprete de órdenes a un `invoke` de distancia. Ahora el renderer
//! manda la **plantilla** del catálogo y los valores de sus marcadores, y aquí se
//! decide qué se ejecuta:
//!
//! 1. **Autorización por equipo.** Una plantilla se ejecuta solo si el usuario la
//!    ha autorizado **en este equipo** en un diálogo nativo que abre el backend
//!    (el renderer no puede pulsarlo). Se guarda el SHA-256 de la plantilla en
//!    `trusted_local_commands.json`, junto a los datos de la app: un comando
//!    nuevo, uno editado —o uno que se invente un renderer comprometido— vuelve
//!    a preguntar. Los que ya existían antes de esta versión preguntan una vez.
//! 2. **Los valores nunca se interpretan como shell.** Cada `${host}`,
//!    `${ask:…}` o `${var:…}` se sustituye por una **referencia a una variable de
//!    entorno** (`"${RUSTTY_ARG_0}"`) y el valor viaja en el entorno del proceso.
//!    El resultado de expandir una variable no se vuelve a analizar en busca de
//!    `;`, `|` o `$(…)`, así que un valor malicioso no puede inyectar órdenes
//!    aunque el análisis de comillas de [`QuoteLexer`] se equivocara de contexto
//!    (lo peor sería partir el valor en palabras). En `cmd` la expansión de `%…%`
//!    sí se reanaliza, por eso allí la referencia va entre comillas y un valor con
//!    comillas o saltos de línea se rechaza.
//!
//! Consecuencia visible: cada valor sustituido entra como **un único argumento**
//! (`ping ${host}` sigue igual; un `${ask:opciones}` que antes se partía en varias
//! palabras ahora llega entero).
//!
//! Límite honesto: lo que se garantiza es que **el shell local** no reinterpreta
//! los valores. Si la propia plantilla los entrega a otro intérprete
//! (`sh -c '… ${ask:x}'`, `ssh host "… ${host}"`, `eval`), ese intérprete sí los
//! analiza: es la orden que el usuario escribió y autorizó.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::locks::MutexExt;
use crate::subst::{self, InternalVar, Marker};

/// Tope de longitud de una plantilla: el diálogo de autorización la enseña
/// **entera**, y una orden más larga que esto escondería lo que hace.
pub const MAX_TEMPLATE_CHARS: usize = 4000;

/// Prefijo de los errores con código estable (`local-command:<código>|<detalle>`)
/// que el frontend traduce.
pub const ERROR_MARKER: &str = "local-command:";

/// Nombre del fichero de autorizaciones dentro del directorio de datos.
pub const TRUST_FILE: &str = "trusted_local_commands.json";
const TRUST_KIND: &str = "trusted_local_commands";
/// Autorizaciones recordadas como mucho: al pasar, se olvidan las más antiguas
/// (volverían a preguntar, que es el lado seguro).
const MAX_TRUSTED: usize = 500;

/// Shell con el que se ejecuta la orden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// `sh -c` (Linux, macOS, BSD).
    Posix,
    /// `cmd /C` (Windows).
    Cmd,
}

impl Dialect {
    /// El del sistema en el que corre Rustty.
    pub fn native() -> Self {
        if cfg!(windows) {
            Dialect::Cmd
        } else {
            Dialect::Posix
        }
    }
}

/// Orden lista para lanzar: el texto para el shell y el entorno con los valores.
#[derive(Debug, PartialEq, Eq)]
pub struct Rendered {
    pub command: String,
    pub env: Vec<(String, String)>,
}

/// Por qué una plantilla no se puede ejecutar tal cual.
#[derive(Debug, PartialEq, Eq)]
pub enum RenderError {
    /// Plantilla vacía.
    Empty,
    /// Supera [`MAX_TEMPLATE_CHARS`].
    TooLong,
    /// Un marcador justo detrás de un carácter de escape (`\` o `^`): el escape
    /// se comería la comilla de apertura de la referencia.
    EscapedMarker(String),
    /// Un marcador dentro de `$'…'`, donde las barras se interpretan.
    MarkerInAnsiQuote(String),
    /// Un valor con caracteres que el shell no puede recibir con seguridad.
    UnsafeValue(String),
    /// Un `${host}`, `${user}` o `${port}` que empieza por `-`: se tomaría por
    /// una opción del programa (`ssh -oProxyCommand=…`).
    OptionLikeValue(String),
}

impl RenderError {
    /// Código estable para el frontend.
    pub fn code(&self) -> &'static str {
        match self {
            RenderError::Empty => "empty",
            RenderError::TooLong => "too_long",
            RenderError::EscapedMarker(_) => "escaped_marker",
            RenderError::MarkerInAnsiQuote(_) => "ansi_marker",
            RenderError::UnsafeValue(_) => "unsafe_value",
            RenderError::OptionLikeValue(_) => "option_value",
        }
    }

    /// El marcador afectado (o el tope, para `TooLong`).
    pub fn detail(&self) -> String {
        match self {
            RenderError::Empty => String::new(),
            RenderError::TooLong => MAX_TEMPLATE_CHARS.to_string(),
            RenderError::EscapedMarker(m)
            | RenderError::MarkerInAnsiQuote(m)
            | RenderError::UnsafeValue(m)
            | RenderError::OptionLikeValue(m) => m.clone(),
        }
    }

    /// `local-command:<código>|<detalle>`.
    pub fn to_ipc(&self) -> String {
        format!("{ERROR_MARKER}{}|{}", self.code(), self.detail())
    }
}

/// Valida la forma de una plantilla antes de enseñarla o ejecutarla.
pub fn check_template(template: &str) -> Result<(), RenderError> {
    if template.trim().is_empty() {
        return Err(RenderError::Empty);
    }
    if template.chars().count() > MAX_TEMPLATE_CHARS {
        return Err(RenderError::TooLong);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QState {
    None,
    Single,
    Double,
    /// `$'…'` de bash/zsh.
    Ansi,
}

/// Seguimiento mínimo del estado de comillas del texto literal de la plantilla,
/// para saber cómo escribir la referencia a la variable en cada punto.
struct QuoteLexer {
    dialect: Dialect,
    state: QState,
    escape: bool,
    prev_dollar: bool,
}

impl QuoteLexer {
    fn new(dialect: Dialect) -> Self {
        Self {
            dialect,
            state: QState::None,
            escape: false,
            prev_dollar: false,
        }
    }

    fn feed(&mut self, text: &str) {
        for ch in text.chars() {
            if self.escape {
                self.escape = false;
                self.prev_dollar = false;
                continue;
            }
            match self.dialect {
                Dialect::Posix => match self.state {
                    QState::None => match ch {
                        '\\' => self.escape = true,
                        '\'' => {
                            self.state = if self.prev_dollar {
                                QState::Ansi
                            } else {
                                QState::Single
                            }
                        }
                        '"' => self.state = QState::Double,
                        _ => {}
                    },
                    QState::Single => {
                        if ch == '\'' {
                            self.state = QState::None;
                        }
                    }
                    QState::Double | QState::Ansi => match ch {
                        '\\' => self.escape = true,
                        '"' if self.state == QState::Double => self.state = QState::None,
                        '\'' if self.state == QState::Ansi => self.state = QState::None,
                        _ => {}
                    },
                },
                Dialect::Cmd => match self.state {
                    QState::None => match ch {
                        '^' => self.escape = true,
                        '"' => self.state = QState::Double,
                        _ => {}
                    },
                    _ => {
                        if ch == '"' {
                            self.state = QState::None;
                        }
                    }
                },
            }
            self.prev_dollar =
                self.dialect == Dialect::Posix && self.state == QState::None && ch == '$';
        }
    }

    /// Referencia a la variable `name` escrita para el contexto actual.
    fn reference(&mut self, name: &str, shown: &str) -> Result<String, RenderError> {
        if self.escape {
            return Err(RenderError::EscapedMarker(shown.to_string()));
        }
        self.prev_dollar = false;
        Ok(match (self.dialect, self.state) {
            (Dialect::Posix, QState::None) => format!("\"${{{name}}}\""),
            (Dialect::Posix, QState::Double) => format!("${{{name}}}"),
            // Se cierra la comilla simple, se expande entre dobles y se reabre.
            (Dialect::Posix, QState::Single) => format!("'\"${{{name}}}\"'"),
            (Dialect::Posix, QState::Ansi) => {
                return Err(RenderError::MarkerInAnsiQuote(shown.to_string()))
            }
            (Dialect::Cmd, QState::None) => format!("\"%{name}%\""),
            (Dialect::Cmd, _) => format!("%{name}%"),
        })
    }
}

fn check_value(marker: &Marker, value: &str, dialect: Dialect) -> Result<(), RenderError> {
    let shown = || subst::render_literal(marker);
    if value.contains('\0') {
        return Err(RenderError::UnsafeValue(shown()));
    }
    if dialect == Dialect::Cmd && value.contains(['"', '\r', '\n']) {
        return Err(RenderError::UnsafeValue(shown()));
    }
    if matches!(
        marker,
        Marker::Internal(InternalVar::Host | InternalVar::User | InternalVar::Port)
    ) && value.starts_with('-')
    {
        return Err(RenderError::OptionLikeValue(shown()));
    }
    Ok(())
}

/// Convierte la plantilla en la orden final. `resolve` da el valor de cada
/// marcador; los que devuelven `None` se quedan literales, como en el resto de
/// la app.
pub fn render(
    template: &str,
    dialect: Dialect,
    resolve: &dyn Fn(&Marker) -> Option<String>,
) -> Result<Rendered, RenderError> {
    check_template(template)?;
    let mut lexer = QuoteLexer::new(dialect);
    let mut command = String::with_capacity(template.len() + 32);
    let mut env = Vec::new();
    for marker in subst::parse(template) {
        if let Marker::Literal(text) = &marker {
            lexer.feed(text);
            command.push_str(text);
            continue;
        }
        let shown = subst::render_literal(&marker);
        let Some(value) = resolve(&marker) else {
            lexer.feed(&shown);
            command.push_str(&shown);
            continue;
        };
        check_value(&marker, &value, dialect)?;
        let name = format!("RUSTTY_ARG_{}", env.len());
        command.push_str(&lexer.reference(&name, &shown)?);
        env.push((name, value));
    }
    Ok(Rendered { command, env })
}

/// Huella de una plantilla: SHA-256 en hex del texto sin espacios de los bordes.
pub fn template_hash(template: &str) -> String {
    Sha256::digest(template.trim().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Textos del diálogo de autorización. Viven en el backend a propósito: el
/// renderer solo elige el idioma, no puede reescribir la advertencia.
pub struct PromptTexts {
    pub title: &'static str,
    /// Con `{name}` y `{command}`.
    pub message: &'static str,
    pub accept: &'static str,
    pub cancel: &'static str,
}

pub fn prompt_texts(lang: &str) -> PromptTexts {
    match lang {
        "en" => PromptTexts {
            title: "Authorize local command",
            message: "“{name}” is about to run for the first time on this computer, or it has changed since the last time. Review the command before authorizing it:\n\n{command}\n\nYou will only be asked again if the command changes.",
            accept: "Authorize and run",
            cancel: "Cancel",
        },
        "fr" => PromptTexts {
            title: "Autoriser la commande locale",
            message: "« {name} » va s’exécuter pour la première fois sur cet ordinateur, ou a changé depuis la dernière fois. Vérifiez la commande avant de l’autoriser :\n\n{command}\n\nLa question ne vous sera reposée que si la commande change.",
            accept: "Autoriser et exécuter",
            cancel: "Annuler",
        },
        "pt" => PromptTexts {
            title: "Autorizar comando local",
            message: "«{name}» vai ser executado pela primeira vez neste computador, ou mudou desde a última vez. Reveja o comando antes de o autorizar:\n\n{command}\n\nSó lhe será perguntado de novo se o comando mudar.",
            accept: "Autorizar e executar",
            cancel: "Cancelar",
        },
        "de" => PromptTexts {
            title: "Lokalen Befehl erlauben",
            message: "„{name}“ wird zum ersten Mal auf diesem Computer ausgeführt oder hat sich seit dem letzten Mal geändert. Prüfe den Befehl, bevor du ihn erlaubst:\n\n{command}\n\nDu wirst nur erneut gefragt, wenn sich der Befehl ändert.",
            accept: "Erlauben und ausführen",
            cancel: "Abbrechen",
        },
        _ => PromptTexts {
            title: "Autorizar comando local",
            message: "«{name}» va a ejecutarse por primera vez en este equipo, o ha cambiado desde la última vez. Revisa la orden antes de autorizarla:\n\n{command}\n\nSolo se te volverá a preguntar si la orden cambia.",
            accept: "Autorizar y ejecutar",
            cancel: "Cancelar",
        },
    }
}

/// Texto seguro para enseñarlo en el diálogo: sin caracteres de control ni de
/// dirección de escritura (un U+202E puede disfrazar lo que se ve de lo que se
/// ejecuta). Conserva saltos de línea y tabuladores.
pub fn displayable(text: &str) -> String {
    text.chars()
        .map(|c| {
            let bidi = matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
            if bidi || (c.is_control() && c != '\n' && c != '\t') {
                '\u{FFFD}'
            } else {
                c
            }
        })
        .collect()
}

/// Nombre del comando para el diálogo: una línea, acotado. Lo manda el renderer,
/// así que no se le deja ocupar el sitio de la orden.
pub fn display_name(name: &str) -> String {
    let one_line: String = displayable(name)
        .chars()
        .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
        .collect();
    let trimmed = one_line.trim();
    if trimmed.chars().count() > 80 {
        let cut: String = trimmed.chars().take(80).collect();
        format!("{cut}…")
    } else {
        trimmed.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrustedCommand {
    hash: String,
    /// Segundos Unix de la autorización.
    approved: u64,
}

/// Autorizaciones de este equipo, persistidas en privado (0600).
pub struct LocalCommandTrust {
    path: PathBuf,
    lock: Mutex<()>,
}

impl LocalCommandTrust {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(TRUST_FILE),
            lock: Mutex::new(()),
        }
    }

    fn load(&self) -> Vec<TrustedCommand> {
        match crate::store_file::read::<TrustedCommand>(&self.path, TRUST_KIND, true) {
            Ok((items, _)) => items,
            Err(err) => {
                // Ilegible o de una versión futura: nada está autorizado (se
                // vuelve a preguntar), que es el lado seguro.
                log::warn!("autorizaciones de comandos locales ilegibles: {err}");
                Vec::new()
            }
        }
    }

    /// ¿Está autorizada esta plantilla en este equipo?
    pub fn is_trusted(&self, template: &str) -> bool {
        let _guard = self.lock.lock_recover();
        let hash = template_hash(template);
        self.load().iter().any(|t| t.hash == hash)
    }

    /// Recuerda la autorización de esta plantilla.
    pub fn trust(&self, template: &str) -> Result<(), String> {
        let _guard = self.lock.lock_recover();
        let hash = template_hash(template);
        let mut items = self.load();
        if items.iter().any(|t| t.hash == hash) {
            return Ok(());
        }
        let approved = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        items.push(TrustedCommand { hash, approved });
        if items.len() > MAX_TRUSTED {
            items.sort_by_key(|t| t.approved);
            let excess = items.len() - MAX_TRUSTED;
            items.drain(..excess);
        }
        crate::store_file::write(&self.path, TRUST_KIND, &items, true).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(pairs: &[(&str, &str)]) -> impl Fn(&Marker) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |m: &Marker| map.get(&subst::render_literal(m)).cloned()
    }

    fn posix(template: &str, pairs: &[(&str, &str)]) -> Result<Rendered, RenderError> {
        render(template, Dialect::Posix, &values(pairs))
    }

    /// Ejecuta la orden renderizada con el `sh` real y devuelve su salida.
    #[cfg(unix)]
    fn run_sh(r: &Rendered) -> String {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&r.command)
            .envs(r.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .output()
            .expect("sh");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn sustituye_por_referencias_segun_el_contexto_de_comillas() {
        let r = posix("ping -c 3 ${host}", &[("${host}", "10.0.0.1")]).unwrap();
        assert_eq!(r.command, "ping -c 3 \"${RUSTTY_ARG_0}\"");
        assert_eq!(r.env, vec![("RUSTTY_ARG_0".into(), "10.0.0.1".into())]);

        let r = posix("echo \"host=${host}\"", &[("${host}", "h")]).unwrap();
        assert_eq!(r.command, "echo \"host=${RUSTTY_ARG_0}\"");

        let r = posix("echo 'host=${host}'", &[("${host}", "h")]).unwrap();
        assert_eq!(r.command, "echo 'host='\"${RUSTTY_ARG_0}\"''");
    }

    #[test]
    fn los_marcadores_sin_valor_quedan_literales() {
        let r = posix("echo ${secret:clave} ${host}", &[("${host}", "h")]).unwrap();
        assert_eq!(r.command, "echo ${secret:clave} \"${RUSTTY_ARG_0}\"");
        assert_eq!(r.env.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn un_valor_malicioso_no_inyecta_ordenes_en_ningun_contexto() {
        let dir = std::env::temp_dir().join(format!("rustty-inj-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let canary = dir.join("pwned");
        let payloads = [
            format!("x; touch {}", canary.display()),
            format!("x' ; touch {} ; '", canary.display()),
            format!("x\" ; touch {} ; \"", canary.display()),
            format!("$(touch {})", canary.display()),
            format!("`touch {}`", canary.display()),
            format!("x\ntouch {}", canary.display()),
        ];
        let templates = [
            "echo ${ask:v}",
            "echo \"${ask:v}\"",
            "echo '${ask:v}'",
            "echo \"$(printf %s ${ask:v})\"",
            "echo `echo ${ask:v}`",
        ];
        for template in templates {
            for payload in &payloads {
                let r = posix(template, &[("${ask:v}", payload)]).unwrap();
                run_sh(&r);
                assert!(
                    !canary.exists(),
                    "inyección con la plantilla {template:?} y el valor {payload:?}"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn el_valor_llega_entero_como_un_solo_argumento() {
        let r = posix(
            "printf '[%s]' ${ask:v} \"${ask:v}\" 'a${ask:v}b'",
            &[("${ask:v}", "dos palabras")],
        )
        .unwrap();
        assert_eq!(run_sh(&r), "[dos palabras][dos palabras][ados palabrasb]");
    }

    #[test]
    fn rechaza_un_marcador_escapado_o_dentro_de_ansi() {
        assert_eq!(
            posix("echo \\${host}", &[("${host}", "h")])
                .unwrap_err()
                .code(),
            "escaped_marker"
        );
        assert_eq!(
            posix("echo $'a${host}'", &[("${host}", "h")])
                .unwrap_err()
                .code(),
            "ansi_marker"
        );
        // Sin valor que sustituir no hay nada que proteger: se deja literal.
        assert!(posix("echo \\${host}", &[]).is_ok());
    }

    #[test]
    fn host_user_y_puerto_no_pueden_parecer_una_opcion() {
        let err = posix("ssh ${host}", &[("${host}", "-oProxyCommand=evil")]).unwrap_err();
        assert_eq!(err, RenderError::OptionLikeValue("${host}".into()));
        // Un `${ask:}` sí puede: pedir «-la» para un `ls` es legítimo.
        assert!(posix("ls ${ask:flags}", &[("${ask:flags}", "-la")]).is_ok());
    }

    #[test]
    fn los_valores_con_nul_se_rechazan() {
        let err = posix("echo ${ask:v}", &[("${ask:v}", "a\0b")]).unwrap_err();
        assert_eq!(err.code(), "unsafe_value");
    }

    #[test]
    fn cmd_entrecomilla_y_rechaza_comillas_y_saltos() {
        let r = render(
            "ping ${host}",
            Dialect::Cmd,
            &values(&[("${host}", "srv & calc")]),
        )
        .unwrap();
        assert_eq!(r.command, "ping \"%RUSTTY_ARG_0%\"");
        let r = render(
            "echo \"a ${host}\"",
            Dialect::Cmd,
            &values(&[("${host}", "h")]),
        )
        .unwrap();
        assert_eq!(r.command, "echo \"a %RUSTTY_ARG_0%\"");
        for bad in ["a\"b", "a\nb", "a\rb"] {
            let err =
                render("ping ${host}", Dialect::Cmd, &values(&[("${host}", bad)])).unwrap_err();
            assert_eq!(err.code(), "unsafe_value", "{bad:?}");
        }
        let err = render("ping ^${host}", Dialect::Cmd, &values(&[("${host}", "h")])).unwrap_err();
        assert_eq!(err.code(), "escaped_marker");
    }

    #[test]
    fn plantillas_vacias_o_demasiado_largas() {
        assert_eq!(posix("   ", &[]).unwrap_err(), RenderError::Empty);
        let long = "x".repeat(MAX_TEMPLATE_CHARS + 1);
        assert_eq!(posix(&long, &[]).unwrap_err(), RenderError::TooLong);
        assert_eq!(
            RenderError::TooLong.to_ipc(),
            format!("local-command:too_long|{MAX_TEMPLATE_CHARS}")
        );
    }

    #[test]
    fn la_huella_ignora_los_bordes_y_distingue_el_contenido() {
        assert_eq!(template_hash("ls -la"), template_hash("  ls -la\n"));
        assert_ne!(template_hash("ls -la"), template_hash("ls -l"));
        assert_eq!(template_hash("x").len(), 64);
    }

    #[test]
    fn el_texto_del_dialogo_no_admite_disfraces() {
        assert_eq!(displayable("rm\u{202E}fdp.exe"), "rm\u{FFFD}fdp.exe");
        assert_eq!(displayable("a\nb\tc\u{1b}[2J"), "a\nb\tc\u{FFFD}[2J");
        assert_eq!(display_name("uno\ndos"), "uno dos");
        assert_eq!(display_name(&"n".repeat(100)).chars().count(), 81);
    }

    #[test]
    fn las_autorizaciones_persisten_y_distinguen_plantillas() {
        let dir = std::env::temp_dir().join(format!("rustty-trust-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let trust = LocalCommandTrust::new(&dir);
        assert!(!trust.is_trusted("ping ${host}"));
        trust.trust("ping ${host}").unwrap();
        assert!(trust.is_trusted("ping ${host}"));
        assert!(!trust.is_trusted("ping -c 1 ${host}"));
        // Otra instancia sobre el mismo directorio (un reinicio) lo recuerda.
        let again = LocalCommandTrust::new(&dir);
        assert!(again.is_trusted("ping ${host}"));
        // Un fichero dañado no autoriza nada.
        std::fs::write(dir.join(TRUST_FILE), "{basura").unwrap();
        std::fs::remove_file(dir.join(format!("{TRUST_FILE}.bak"))).ok();
        assert!(!LocalCommandTrust::new(&dir).is_trusted("ping ${host}"));
    }

    #[cfg(unix)]
    #[test]
    fn el_fichero_de_autorizaciones_es_privado() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("rustty-trust-perm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        LocalCommandTrust::new(&dir).trust("uptime").unwrap();
        let mode = std::fs::metadata(dir.join(TRUST_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
