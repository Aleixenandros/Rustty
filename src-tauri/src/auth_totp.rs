//! Segundo factor TOTP desde KeePass para la autenticación
//! `keyboard-interactive`.
//!
//! Quien guarda la semilla TOTP de un servidor en su `.kdbx` (KeePassXC la
//! deja en el campo `otp`) puede pedir, **por perfil y apagado por defecto**,
//! que Rustty conteste con ella a la pregunta del código de verificación. Hay
//! dos grados, los dos opt-in:
//!
//! - **Ofrecer** (`totp_keepass`): el diálogo de MFA enseña «Usar código de
//!   KeePass» cuando la pregunta casa con la regex del perfil.
//! - **Automático** (`totp_keepass_auto`): se contesta sin diálogo, también en
//!   las reconexiones y al abrir el panel SFTP.
//!
//! Tres reglas que no se pueden relajar:
//!
//! 1. **El código y la semilla no salen del backend.** Se calculan aquí
//!    (`keepass_manager::totp_at`) y van directos al intercambio SSH. La
//!    interfaz solo dice «contesta con el TOTP de KeePass» y recibe un motivo
//!    ([`crate::auth_prompt::TotpReply`]); nada de esto se escribe en el log.
//! 2. **Un código rechazado no se reintenta solo.** El automático contesta
//!    como mucho una vez por intercambio, y si el servidor lo rechaza (o
//!    vuelve a preguntar, o la autenticación no llega a buen puerto) el perfil
//!    queda marcado: las siguientes veces se pregunta, hasta que un código de
//!    KeePass —pedido a mano con el botón del diálogo— vuelva a acertar. Sin
//!    eso, un servidor que rechaza y una reconexión automática sumarían
//!    intentos fallidos hasta bloquear la cuenta.
//! 3. **La pregunta es entrada hostil.** La escribe el servidor: la regex solo
//!    mira sus primeros [`MAX_PROMPT_SCAN`] bytes, y una regex del usuario que
//!    no compila no rompe la conexión, simplemente no ofrece nada.
//!
//! El perfil de la conexión en curso viaja en una variable de tarea
//! ([`with_policy`]) y no en la firma de `authenticate_handle`: esa función la
//! llaman quince sitios (SSH, SFTP, scripts, CLI, cada salto) y la cadena hasta
//! `keyboard_interactive_auth` tiene cuatro eslabones. Es el mismo criterio de
//! las políticas de host key, que tampoco viajan por la firma de `client()`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use regex::{Regex, RegexBuilder};
use zeroize::Zeroizing;

use crate::auth_prompt::AuthPromptField;
use crate::keepass_manager::{self, TotpError};
use crate::locks::MutexExt;
use crate::profiles::ConnectionProfile;

/// Regex por defecto de la pregunta del código: «Verification code:» (Google
/// Authenticator), «One-time password (OATH)» (pam_oath), «OTP:», «Token:»,
/// «Código de verificación:»… No casa con «Password:». Espejo en
/// `src/modules/auth-totp.js` (`DEFAULT_TOTP_PROMPT_PATTERN`), que la enseña
/// en el formulario; un test exige que coincidan.
pub(crate) const DEFAULT_PROMPT_PATTERN: &str =
    r"(?i)(verification|one[- ]?time|\botp\b|\btotp\b|token|authenticator|2fa|c[oó]digo|\bcode\b)";

/// Largo máximo de la regex del perfil (espejo `MAX_TOTP_PROMPT_PATTERN_LEN`).
pub(crate) const MAX_PATTERN_LEN: usize = 256;

/// Bytes de la pregunta que mira la regex. Una pregunta real cabe de sobra; el
/// resto de un texto desmesurado no merece análisis.
const MAX_PROMPT_SCAN: usize = 512;

/// Tope del programa compilado de la regex: una del usuario con repeticiones
/// enormes (`a{1000}{1000}`) falla al compilar en vez de ocupar memoria.
const REGEX_SIZE_LIMIT: usize = 1 << 20;

/// Espera máxima al periodo siguiente cuando el código vigente ya se entregó.
/// Con un periodo más largo se envía el mismo: esperar más sería colgar la
/// conexión.
const MAX_STEP_WAIT: Duration = Duration::from_secs(60);

/// Lo que el perfil ha elegido para su segundo factor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    /// Id del perfil: la clave de la memoria de rechazos.
    pub key: String,
    /// Entrada KeePass con la semilla.
    pub entry_uuid: String,
    /// Contestar sin preguntar.
    pub auto: bool,
    /// Regex propia de la pregunta; `None` = la de por defecto.
    pub pattern: Option<String>,
}

impl Policy {
    /// La política del perfil, o `None` si no ha activado el TOTP de KeePass o
    /// no hay entrada de la que sacarlo (ni propia ni la de la contraseña).
    pub(crate) fn from_profile(profile: &ConnectionProfile) -> Option<Self> {
        if !profile.totp_keepass {
            return None;
        }
        let entry_uuid = [
            profile.totp_keepass_entry_uuid.as_deref(),
            profile.keepass_entry_uuid.as_deref(),
        ]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|uuid| !uuid.is_empty())?
        .to_string();
        Some(Policy {
            key: profile.id.clone(),
            entry_uuid,
            auto: profile.totp_keepass_auto,
            pattern: profile
                .totp_keepass_prompt_regex
                .as_deref()
                .map(str::trim)
                .filter(|pattern| !pattern.is_empty())
                .map(str::to_string),
        })
    }
}

tokio::task_local! {
    /// Política de la autenticación que corre en esta tarea.
    static POLICY: Option<Policy>;
}

/// Ejecuta `auth` (una llamada a `authenticate_handle` o a
/// `keyboard_interactive_auth`) con la política de **ese** perfil a la vista.
/// Se envuelve solo la autenticación del destino o del salto en cuestión: cada
/// salto entra con su propio perfil y no hereda la del destino.
pub(crate) fn with_policy<F: Future>(
    policy: Option<Policy>,
    auth: F,
) -> impl Future<Output = F::Output> {
    POLICY.scope(policy, auth)
}

fn current_policy() -> Option<Policy> {
    POLICY.try_with(Clone::clone).ok().flatten()
}

/// Compila la regex de la pregunta (`None`/vacía = la de por defecto).
/// `None` si no compila, es demasiado larga o casa con el texto vacío: esa
/// última casaría también con «Password:» y entregaría el código donde no es.
pub(crate) fn compile_pattern(pattern: Option<&str>) -> Option<Regex> {
    let source = pattern
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .unwrap_or(DEFAULT_PROMPT_PATTERN);
    if source.len() > MAX_PATTERN_LEN {
        return None;
    }
    RegexBuilder::new(source)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .ok()
        .filter(|regex| !regex.is_match(""))
}

/// ¿Sirve `pattern` como regex de la pregunta? Lo consulta el formulario del
/// perfil antes de guardar (el motor es el de Rust, no el de JavaScript).
pub(crate) fn pattern_is_valid(pattern: &str) -> bool {
    compile_pattern(Some(pattern)).is_some()
}

/// El principio de la pregunta del servidor: lo único que se mira de ella.
fn prompt_head(prompt: &str) -> &str {
    let mut end = prompt.len().min(MAX_PROMPT_SCAN);
    while !prompt.is_char_boundary(end) {
        end -= 1;
    }
    &prompt[..end]
}

/// ¿Casa la pregunta del servidor? Solo se miran sus primeros bytes.
fn prompt_matches(regex: &Regex, prompt: &str) -> bool {
    regex.is_match(prompt_head(prompt))
}

// ─── Memoria de rechazos ────────────────────────────────────────────────────

/// Perfiles cuyo último código automático fue rechazado. Mientras estén aquí
/// no se contesta solo. Solo los saca la prueba de que KeePass vuelve a dar
/// códigos buenos: una autenticación que acierta con un código suyo (el del
/// botón del diálogo). Que el usuario acierte tecleando el de su móvil no dice
/// nada de la semilla de KeePass, así que no los saca.
/// Vive en memoria: reiniciar la aplicación es una decisión del usuario.
static AUTO_REJECTED: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn is_rejected(key: &str) -> bool {
    AUTO_REJECTED.lock_recover().contains(key)
}

fn mark_rejected(key: &str) {
    AUTO_REJECTED.lock_recover().insert(key.to_string());
}

fn clear_rejected(key: &str) {
    AUTO_REJECTED.lock_recover().remove(key);
}

// ─── Entrega de códigos ─────────────────────────────────────────────────────

/// Último periodo entregado por entrada y servidor. Los servidores no aceptan
/// dos veces el mismo código (Google Authenticator lo rechaza por defecto), y
/// abrir el panel SFTP justo después de conectar pediría el mismo: en vez de
/// gastar un intento que se sabe fallido, se espera al periodo siguiente. Solo
/// se guarda el contador del periodo, nunca el código.
static USED_STEPS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Un código listo, o cuánto falta para poder dar uno nuevo.
pub(crate) enum Issued {
    Now(Zeroizing<String>),
    After(Duration),
}

fn issue_at(entry_uuid: &str, host: &str, unix_secs: u64) -> Result<Issued, TotpError> {
    let code = keepass_manager::totp_at(entry_uuid, unix_secs)?;
    let key = format!("{entry_uuid}\n{host}");
    let mut used = USED_STEPS.lock_recover();
    if used.get(&key) == Some(&code.step) && code.until_next <= MAX_STEP_WAIT {
        return Ok(Issued::After(code.until_next));
    }
    used.insert(key, code.step);
    Ok(Issued::Now(code.code))
}

/// El código vigente de `entry_uuid` para `host`, o la espera hasta el
/// siguiente si el vigente ya se entregó a ese servidor.
pub(crate) fn issue(entry_uuid: &str, host: &str) -> Result<Issued, TotpError> {
    let now = keepass_manager::unix_now().ok_or(TotpError::Clock)?;
    issue_at(entry_uuid, host, now)
}

/// Periodos que se espera, como mucho, a que haya un código sin entregar.
/// Más de uno porque varias conexiones al mismo servidor pueden hacer cola a la
/// vez (la sesión, el panel SFTP, una segunda pestaña); más de dos ya roza el
/// plazo de inicio de sesión del servidor (`LoginGraceTime`, 120 s).
const MAX_STEP_WAITS: usize = 2;

/// Espera `first_wait` y entrega el código del periodo siguiente. `None` si la
/// base se bloqueó entre tanto o si, tras [`MAX_STEP_WAITS`] periodos, otros
/// se llevaron cada código nuevo.
pub(crate) async fn wait_and_issue(
    entry_uuid: &str,
    host: &str,
    first_wait: Duration,
) -> Option<Zeroizing<String>> {
    let mut wait = first_wait;
    for _ in 0..MAX_STEP_WAITS {
        tokio::time::sleep(wait).await;
        match issue(entry_uuid, host) {
            Ok(Issued::Now(code)) => return Some(code),
            Ok(Issued::After(next)) => wait = next,
            Err(_) => return None,
        }
    }
    None
}

// ─── Un intercambio keyboard-interactive ────────────────────────────────────

/// Qué hacer con una ronda de preguntas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Round {
    /// No es la pregunta del código (o el perfil no usa el TOTP de KeePass):
    /// el diálogo de siempre.
    Manual,
    /// Es la pregunta del código: el diálogo, con «Usar código de KeePass».
    Offer,
    /// Es la pregunta del código y se contesta sin preguntar.
    Auto,
}

/// Lo que el diálogo necesita para poder contestar con el TOTP. Se queda en el
/// backend, junto a la pregunta en vuelo: a la interfaz solo le llega que la
/// opción existe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Offer {
    pub entry_uuid: String,
    pub host: String,
    /// El último código automático de este perfil fue rechazado: el diálogo
    /// lo dice, para que quien lo ve sepa por qué se le pregunta.
    pub auto_rejected: bool,
}

/// Estado del TOTP a lo largo de **un** intercambio `keyboard-interactive`
/// (una llamada a `keyboard_interactive_auth`).
pub(crate) struct Exchange {
    policy: Option<Policy>,
    regex: Option<Regex>,
    /// La pregunta que se contestó sola en este intercambio (como mucho una).
    auto_prompt: Option<String>,
    /// La última ronda del código la contestó KeePass —sola o desde el botón
    /// del diálogo— y no el teclado.
    last_code_by_keepass: bool,
}

impl Exchange {
    /// El intercambio de la autenticación en curso (ver [`with_policy`]).
    pub(crate) fn for_current_task() -> Self {
        Self::new(current_policy())
    }

    pub(crate) fn new(policy: Option<Policy>) -> Self {
        let regex = policy
            .as_ref()
            .and_then(|policy| compile_pattern(policy.pattern.as_deref()));
        Exchange {
            policy,
            regex,
            auto_prompt: None,
            last_code_by_keepass: false,
        }
    }

    /// Decide qué hacer con la ronda `prompts`. Solo cuenta como «la pregunta
    /// del código» una ronda de **una** pregunta que case con la regex: en una
    /// ronda con varias no se sabe a cuál contestar.
    pub(crate) fn plan(&mut self, prompts: &[AuthPromptField]) -> Round {
        let (Some(policy), Some(regex), [single]) = (&self.policy, &self.regex, prompts) else {
            return Round::Manual;
        };
        if !prompt_matches(regex, &single.prompt) {
            return Round::Manual;
        }
        if let Some(answered) = &self.auto_prompt {
            // Ya se contestó sola una ronda: no hay segundo intento automático
            // en este intercambio. Y si el servidor repite la misma pregunta,
            // es que rechazó el código. (Otra pregunta distinta que también
            // case —un segundo sistema de códigos— no es un rechazo.)
            if answered == prompt_head(&single.prompt) {
                mark_rejected(&policy.key);
            }
            return Round::Offer;
        }
        if policy.auto && !is_rejected(&policy.key) {
            Round::Auto
        } else {
            Round::Offer
        }
    }

    /// Apunta que la ronda `prompt` se contestó sola con un código de KeePass.
    fn record_auto(&mut self, prompt: &str) {
        self.auto_prompt = Some(prompt_head(prompt).to_string());
        self.last_code_by_keepass = true;
    }

    /// Apunta quién contestó una ronda que fue al diálogo: KeePass (el botón)
    /// o el teclado. Las rondas que no son la del código no cuentan.
    pub(crate) fn answered(&mut self, plan: Round, from_keepass: bool) {
        if plan != Round::Manual {
            self.last_code_by_keepass = from_keepass;
        }
    }

    /// Lo que se adjunta a la pregunta para que el diálogo pueda ofrecer el
    /// TOTP. `None` si la ronda no es la del código.
    pub(crate) fn offer(&self, plan: Round, host: &str) -> Option<Offer> {
        let policy = self.policy.as_ref().filter(|_| plan != Round::Manual)?;
        Some(Offer {
            entry_uuid: policy.entry_uuid.clone(),
            host: host.to_string(),
            auto_rejected: is_rejected(&policy.key),
        })
    }

    /// Contesta sola la ronda del código (solo con `plan == Round::Auto`).
    /// `None` = no se pudo —la base está bloqueada, la entrada no tiene
    /// semilla— y hay que preguntar. Como mucho una vez por intercambio.
    pub(crate) async fn auto_answer(
        &mut self,
        plan: Round,
        host: &str,
        prompts: &[AuthPromptField],
    ) -> Option<Vec<String>> {
        let [single] = prompts else {
            return None;
        };
        if plan != Round::Auto || self.auto_prompt.is_some() {
            return None;
        }
        let entry_uuid = self.policy.as_ref()?.entry_uuid.clone();
        let code = match issue(&entry_uuid, host) {
            Ok(Issued::Now(code)) => code,
            Ok(Issued::After(wait)) => {
                log::info!(
                    "TOTP de KeePass: el código de este periodo ya se entregó a {host}; se espera {} s al siguiente",
                    wait.as_secs()
                );
                // Sin diálogo a la vista, la espera parecería un cuelgue.
                crate::auth_prompt::notify_totp_wait(host, wait);
                wait_and_issue(&entry_uuid, host, wait).await?
            }
            Err(reason) => {
                log::info!("TOTP de KeePass: no se contesta solo a {host} ({reason:?}); se pregunta");
                return None;
            }
        };
        self.record_auto(&single.prompt);
        Some(vec![code.to_string()])
    }

    /// Cierra el intercambio. `accepted` = el servidor dio por bueno lo
    /// contestado (acceso concedido, o `partial_success`: pide otro método).
    ///
    /// - Sin acierto tras un código automático —rechazo, corte, diálogo
    ///   cancelado, plazo agotado—, el perfil queda marcado: el automático no
    ///   vuelve a probar hasta que KeePass demuestre que sus códigos valen.
    /// - Un acierto cuyo último código fue de KeePass (automático o del botón)
    ///   es esa demostración, y quita la marca.
    /// - Un acierto con el código tecleado, o un intercambio sin ronda de
    ///   código (la contraseña por PAM, antes del segundo factor), no toca
    ///   nada: si quitaran la marca, cada reconexión volvería a mandar un
    ///   código que el servidor ya rechazó.
    pub(crate) fn finished(&self, accepted: bool) {
        let Some(policy) = &self.policy else {
            return;
        };
        if accepted {
            if self.last_code_by_keepass {
                clear_rejected(&policy.key);
            }
        } else if self.auto_prompt.is_some() {
            mark_rejected(&policy.key);
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    /// Olvida que el código automático de `key` fue rechazado.
    pub(crate) fn forget_rejection(key: &str) {
        super::clear_rejected(key);
    }

    /// Deja `key` como si su último código automático hubiera sido rechazado.
    pub(crate) fn mark_rejection(key: &str) {
        super::mark_rejected(key);
    }

    pub(crate) fn was_rejected(key: &str) -> bool {
        super::is_rejected(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keepass_manager::testing::{add_entry, otp_uri, RFC_SEED};

    fn field(prompt: &str) -> AuthPromptField {
        AuthPromptField {
            prompt: prompt.to_string(),
            echo: false,
        }
    }

    fn policy(key: &str, auto: bool, pattern: Option<&str>) -> Policy {
        Policy {
            key: key.to_string(),
            entry_uuid: uuid::Uuid::new_v4().to_string(),
            auto,
            pattern: pattern.map(str::to_string),
        }
    }

    fn matches_default(prompt: &str) -> bool {
        let regex = compile_pattern(None).expect("la regex por defecto compila");
        prompt_matches(&regex, prompt)
    }

    #[test]
    fn la_regex_por_defecto_reconoce_las_preguntas_de_codigo() {
        for prompt in [
            "Verification code: ",
            "verification code:",
            "One-time password (OATH) for `ana': ",
            "OTP: ",
            "Enter TOTP:",
            "Token: ",
            "Authenticator code",
            "2FA code:",
            "Código de verificación: ",
            "CÓDIGO: ",
            "Codigo: ",
            "(ana@srv) Verification code: ",
        ] {
            assert!(matches_default(prompt), "debería casar: {prompt:?}");
        }
    }

    #[test]
    fn la_regex_por_defecto_no_toma_una_contrasena_por_un_codigo() {
        for prompt in [
            "Password: ",
            "Password for ana@srv: ",
            "(ana@srv) Password: ",
            "Contraseña: ",
            "Passphrase: ",
            "Username: ",
            "decode this",
            "",
        ] {
            assert!(!matches_default(prompt), "no debería casar: {prompt:?}");
        }
    }

    /// El espejo del frontend enseña la regex por defecto en el formulario:
    /// si se cambia aquí y no allí, el usuario vería una que ya no se usa.
    #[test]
    fn la_regex_por_defecto_y_el_tope_coinciden_con_el_espejo_del_frontend() {
        let js = include_str!("../../src/modules/auth-totp.js");
        assert!(
            js.contains(&format!("String.raw`{DEFAULT_PROMPT_PATTERN}`")),
            "DEFAULT_TOTP_PROMPT_PATTERN no coincide con DEFAULT_PROMPT_PATTERN"
        );
        assert!(
            js.contains(&format!("MAX_TOTP_PROMPT_PATTERN_LEN = {MAX_PATTERN_LEN};")),
            "MAX_TOTP_PROMPT_PATTERN_LEN no coincide con MAX_PATTERN_LEN"
        );
    }

    #[test]
    fn una_regex_del_usuario_invalida_no_ofrece_nada_en_vez_de_fallar() {
        for bad in [
            "(sin cerrar",
            "[a-",
            "(?=lookahead)x",
            r"(a)\1",
            "a{1000}{1000}{1000}",
            // Casa con el texto vacío: casaría también con «Password:».
            ".*",
            "x?",
        ] {
            assert!(!pattern_is_valid(bad), "debería rechazarse: {bad:?}");
            let mut exchange = Exchange::new(Some(policy("p-bad", true, Some(bad))));
            assert_eq!(
                exchange.plan(&[field("Verification code: ")]),
                Round::Manual,
                "{bad:?}"
            );
        }
        let larga = "a".repeat(MAX_PATTERN_LEN + 1);
        assert!(!pattern_is_valid(&larga));
        assert!(pattern_is_valid(&"a".repeat(MAX_PATTERN_LEN)));
        assert!(pattern_is_valid("(?i)passcode"));
    }

    #[test]
    fn la_regex_propia_sustituye_a_la_de_por_defecto() {
        let mut exchange = Exchange::new(Some(policy("p-own", false, Some("(?i)passcode"))));
        assert_eq!(exchange.plan(&[field("Enter PASSCODE: ")]), Round::Offer);
        assert_eq!(exchange.plan(&[field("Verification code: ")]), Round::Manual);
    }

    /// La pregunta la escribe el servidor: de una desmesurada solo se mira el
    /// principio, y cortar en mitad de un carácter multibyte no entra en pánico.
    #[test]
    fn de_una_pregunta_desmesurada_solo_se_mira_el_principio() {
        let regex = compile_pattern(None).expect("regex");
        let lejos = format!("{}Verification code: ", "x".repeat(MAX_PROMPT_SCAN));
        assert!(!prompt_matches(&regex, &lejos));
        let cerca = format!("Verification code: {}", "x".repeat(4 * MAX_PROMPT_SCAN));
        assert!(prompt_matches(&regex, &cerca));
        // Con la «x» delante, el corte cae en mitad de una «ñ» (2 bytes).
        let multibyte = format!("x{}", "ñ".repeat(MAX_PROMPT_SCAN));
        assert!(!multibyte.is_char_boundary(MAX_PROMPT_SCAN));
        assert!(!prompt_matches(&regex, &multibyte));
        let enorme = "código ".repeat(200_000);
        assert!(prompt_matches(&regex, &enorme));
    }

    #[test]
    fn solo_una_ronda_de_una_pregunta_es_la_del_codigo() {
        let mut exchange = Exchange::new(Some(policy("p-shape", true, None)));
        let dos = [field("Verification code: "), field("Password: ")];
        assert_eq!(exchange.plan(&dos), Round::Manual);
        assert_eq!(exchange.plan(&[]), Round::Manual);
        assert_eq!(exchange.plan(&[field("Password: ")]), Round::Manual);
        assert_eq!(exchange.offer(Round::Manual, "srv"), None);
    }

    #[test]
    fn sin_politica_todo_va_al_dialogo_de_siempre() {
        let mut exchange = Exchange::new(None);
        assert_eq!(exchange.plan(&[field("Verification code: ")]), Round::Manual);
        assert_eq!(exchange.offer(Round::Offer, "srv"), None);
        // Y cerrar el intercambio no toca la memoria de nadie.
        exchange.finished(false);
    }

    #[test]
    fn sin_modo_automatico_se_ofrece_pero_no_se_contesta_solo() {
        let policy = policy("p-offer", false, None);
        let mut exchange = Exchange::new(Some(policy.clone()));
        let plan = exchange.plan(&[field("Verification code: ")]);
        assert_eq!(plan, Round::Offer);
        let offer = exchange.offer(plan, "srv.example").expect("se ofrece");
        assert_eq!(offer.entry_uuid, policy.entry_uuid);
        assert_eq!(offer.host, "srv.example");
        assert!(!offer.auto_rejected);
    }

    /// El corazón de «un fallo no reintenta»: tras contestar solo una vez, la
    /// misma pregunta otra vez en el intercambio es un rechazo y va al usuario;
    /// y el perfil queda marcado para los intercambios siguientes.
    #[test]
    fn un_codigo_automatico_rechazado_no_se_reintenta() {
        let policy = policy("p-reject", true, None);
        let code = [field("Verification code: ")];

        let mut first = Exchange::new(Some(policy.clone()));
        assert_eq!(first.plan(&code), Round::Auto);
        first.record_auto(&code[0].prompt); // lo que deja `auto_answer` al contestar
        // El servidor vuelve a preguntar lo mismo: ya no es automático…
        assert_eq!(first.plan(&code), Round::Offer);
        assert!(is_rejected(&policy.key));
        // …y el diálogo sabe por qué se le pregunta.
        assert!(first.offer(Round::Offer, "srv").expect("oferta").auto_rejected);
        first.finished(false);

        // La reconexión (otro intercambio del mismo perfil) tampoco lo prueba.
        let mut second = Exchange::new(Some(policy.clone()));
        assert_eq!(second.plan(&code), Round::Offer);
        // Ni aunque el intercambio de la contraseña, que va antes, salga bien.
        let mut password_only = Exchange::new(Some(policy.clone()));
        assert_eq!(password_only.plan(&[field("Password: ")]), Round::Manual);
        password_only.answered(Round::Manual, false);
        password_only.finished(true);
        assert!(is_rejected(&policy.key));

        // Que el usuario acierte tecleando el código de su móvil no dice nada
        // de la semilla de KeePass: el automático sigue apagado.
        second.answered(Round::Offer, false);
        second.finished(true);
        assert!(is_rejected(&policy.key));
        let mut third = Exchange::new(Some(policy.clone()));
        assert_eq!(third.plan(&code), Round::Offer);

        // Un acierto con un código de KeePass (el botón del diálogo) sí lo
        // devuelve: la semilla vale.
        third.answered(Round::Offer, true);
        third.finished(true);
        assert!(!is_rejected(&policy.key));
        let mut fourth = Exchange::new(Some(policy));
        assert_eq!(fourth.plan(&code), Round::Auto);
    }

    /// Sin acierto tras un código automático —rechazo en seco, corte, diálogo
    /// cancelado—, el perfil queda marcado aunque el servidor no repregunte.
    #[test]
    fn un_intercambio_fallido_tras_el_automatico_marca_el_perfil() {
        let policy = policy("p-reject-end", true, None);
        let code = [field("Verification code: ")];
        let mut exchange = Exchange::new(Some(policy.clone()));
        assert_eq!(exchange.plan(&code), Round::Auto);
        exchange.record_auto(&code[0].prompt);
        exchange.finished(false);
        assert!(is_rejected(&policy.key));
        clear_rejected(&policy.key);

        // Sin código automático de por medio, un rechazo no marca nada: lo
        // tecleó el usuario y el siguiente intento es cosa suya.
        let mut manual = Exchange::new(Some(policy.clone()));
        assert_eq!(manual.plan(&code), Round::Auto);
        manual.answered(Round::Auto, false);
        manual.finished(false);
        assert!(!is_rejected(&policy.key));

        // Y un automático que acierta no deja marca (ni la tenía).
        let mut good = Exchange::new(Some(policy.clone()));
        assert_eq!(good.plan(&code), Round::Auto);
        good.record_auto(&code[0].prompt);
        good.finished(true);
        assert!(!is_rejected(&policy.key));
    }

    /// Una segunda pregunta de código *distinta* (otro sistema de códigos en la
    /// misma pila PAM) no es un rechazo del primero: se pregunta, sin marcar.
    #[test]
    fn otra_pregunta_de_codigo_distinta_no_cuenta_como_rechazo() {
        let policy = policy("p-two-codes", true, None);
        let mut exchange = Exchange::new(Some(policy.clone()));
        let first = [field("Verification code: ")];
        assert_eq!(exchange.plan(&first), Round::Auto);
        exchange.record_auto(&first[0].prompt);

        // No hay segundo automático en el intercambio, pero tampoco marca.
        assert_eq!(exchange.plan(&[field("Token: ")]), Round::Offer);
        assert!(!is_rejected(&policy.key));
        assert!(!exchange.offer(Round::Offer, "srv").expect("oferta").auto_rejected);
        // El usuario teclea el segundo y entra: el automático sigue valiendo.
        exchange.answered(Round::Offer, false);
        exchange.finished(true);
        assert!(!is_rejected(&policy.key));
    }

    #[tokio::test]
    async fn sin_base_desbloqueada_el_automatico_cae_al_dialogo() {
        let _turno = keepass_manager::testing::exclusive().await;
        keepass_manager::lock();
        let mut exchange = Exchange::new(Some(policy("p-locked", true, None)));
        let code = [field("Verification code: ")];
        let plan = exchange.plan(&code);
        assert_eq!(plan, Round::Auto);
        assert_eq!(exchange.auto_answer(plan, "srv", &code).await, None);
        // No se mandó nada: no hay rechazo que recordar y se sigue ofreciendo.
        assert!(exchange.auto_prompt.is_none());
        exchange.finished(false);
        assert!(!is_rejected("p-locked"));
        assert!(exchange.offer(plan, "srv").is_some());
        // Y esperar al periodo siguiente tampoco inventa un código.
        let entry = uuid::Uuid::new_v4().to_string();
        assert!(wait_and_issue(&entry, "srv", Duration::ZERO).await.is_none());
    }

    #[tokio::test]
    async fn el_automatico_contesta_una_sola_vez_por_intercambio() {
        let _turno = keepass_manager::testing::exclusive().await;
        let mut db = keepass::Database::new();
        let entry = add_entry(&mut db, "srv", Some(&otp_uri(RFC_SEED, 6, 30)));
        keepass_manager::testing::install(db);
        let mut policy = policy("p-once", true, None);
        policy.entry_uuid = entry;
        let mut exchange = Exchange::new(Some(policy.clone()));
        let code = [field("Verification code: ")];

        let plan = exchange.plan(&code);
        let answers = exchange
            .auto_answer(plan, "once.example", &code)
            .await
            .expect("contesta");
        assert_eq!(answers.len(), 1);
        assert!(answers[0].len() == 6 && answers[0].bytes().all(|b| b.is_ascii_digit()));
        // Segunda vez en el mismo intercambio: ni con el plan viejo.
        assert_eq!(exchange.auto_answer(Round::Auto, "once.example", &code).await, None);
        let again = exchange.plan(&code);
        assert_eq!(again, Round::Offer);
        assert_eq!(exchange.auto_answer(again, "once.example", &code).await, None);
        // Otro servidor aún no ha visto este código: tras una espera (aquí
        // nula) se le entrega sin más.
        let fresh = wait_and_issue(&policy.entry_uuid, "otro.example", Duration::ZERO).await;
        assert!(fresh.is_some_and(|code| code.len() == 6));
        keepass_manager::lock();
        clear_rejected(&policy.key);
    }

    /// El mismo código no se entrega dos veces al mismo servidor: la segunda
    /// petición dentro del periodo dice cuánto falta para el siguiente.
    #[test]
    fn el_codigo_de_un_periodo_no_se_entrega_dos_veces_al_mismo_servidor() {
        let _turno = keepass_manager::testing::exclusive_blocking();
        let mut db = keepass::Database::new();
        let entry = add_entry(&mut db, "srv", Some(&otp_uri(RFC_SEED, 8, 30)));
        let larga = add_entry(&mut db, "larga", Some(&otp_uri(RFC_SEED, 8, 300)));
        keepass_manager::testing::install(db);

        let first = issue_at(&entry, "a.example", 59).expect("código");
        assert!(matches!(first, Issued::Now(ref code) if code.as_str() == "94287082"));
        // Mismo periodo, mismo servidor: falta 1 s para el siguiente.
        let repeat = issue_at(&entry, "a.example", 59).expect("espera");
        assert!(matches!(repeat, Issued::After(wait) if wait == Duration::from_secs(1)));
        // Otro servidor no ha visto ese código: se le da.
        assert!(matches!(issue_at(&entry, "b.example", 59), Ok(Issued::Now(_))));
        // Periodo siguiente: código nuevo.
        let next = issue_at(&entry, "a.example", 60).expect("código");
        assert!(matches!(next, Issued::Now(ref code) if code.as_str() != "94287082"));
        // Con un periodo más largo que la espera máxima se repite el código.
        assert!(matches!(issue_at(&larga, "a.example", 10), Ok(Issued::Now(_))));
        assert!(matches!(issue_at(&larga, "a.example", 11), Ok(Issued::Now(_))));

        // Y con la base bloqueada no hay código ni espera.
        keepass_manager::lock();
        assert_eq!(issue_at(&entry, "a.example", 90).err(), Some(TotpError::Locked));
    }

    #[test]
    fn la_politica_sale_del_perfil_solo_si_esta_activada_y_hay_entrada() {
        let mut profile: ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "perfil-1", "name": "srv", "host": "srv.example", "port": 22,
            "username": "ana", "domain": null, "auth_type": "password",
            "key_path": null, "group": null, "created_at": "2026-11-14T00:00:00Z"
        }))
        .expect("perfil");
        assert_eq!(Policy::from_profile(&profile), None, "apagado por defecto");

        profile.totp_keepass = true;
        assert_eq!(Policy::from_profile(&profile), None, "sin entrada no hay de dónde");

        profile.keepass_entry_uuid = Some("entrada-pass".into());
        let policy = Policy::from_profile(&profile).expect("política");
        assert_eq!(policy.key, "perfil-1");
        assert_eq!(policy.entry_uuid, "entrada-pass");
        assert!(!policy.auto, "el automático es otra casilla, apagada");
        assert_eq!(policy.pattern, None);

        profile.totp_keepass_entry_uuid = Some("  entrada-otp ".into());
        profile.totp_keepass_auto = true;
        profile.totp_keepass_prompt_regex = Some("  ".into());
        let policy = Policy::from_profile(&profile).expect("política");
        assert_eq!(policy.entry_uuid, "entrada-otp", "manda la entrada propia");
        assert!(policy.auto);
        assert_eq!(policy.pattern, None, "una regex en blanco es la de por defecto");

        profile.totp_keepass_prompt_regex = Some("(?i)token".into());
        let policy = Policy::from_profile(&profile).expect("política");
        assert_eq!(policy.pattern.as_deref(), Some("(?i)token"));
    }

    #[tokio::test]
    async fn la_politica_solo_se_ve_dentro_de_su_autenticacion() {
        assert_eq!(current_policy(), None);
        let outer = policy("p-outer", false, None);
        let inner = policy("p-inner", true, None);
        let seen = with_policy(Some(outer.clone()), async {
            let before = current_policy();
            // El salto entra con la suya y no ve la del destino.
            let hop = with_policy(Some(inner.clone()), async { current_policy() }).await;
            let none = with_policy(None, async { current_policy() }).await;
            (before, hop, none, current_policy())
        })
        .await;
        assert_eq!(seen.0, Some(outer.clone()));
        assert_eq!(seen.1, Some(inner));
        assert_eq!(seen.2, None);
        assert_eq!(seen.3, Some(outer));
        assert_eq!(current_policy(), None);
    }
}
