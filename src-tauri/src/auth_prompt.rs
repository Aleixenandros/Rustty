//! Preguntas de autenticación `keyboard-interactive` (MFA/2FA/OTP).
//!
//! El método `keyboard-interactive` (RFC 4256) no es un intercambio de un solo
//! paso como la contraseña: el servidor manda **rondas** de preguntas
//! («Password:», «Verification code:», «Duo passcode or option:») y el cliente
//! contesta a cada una. Es el camino por el que pasan Google Authenticator,
//! Duo, los tokens por SMS y las pilas PAM encadenadas.
//!
//! Esas preguntas las decide el servidor en tiempo de conexión, así que no se
//! pueden pedir por adelantado en el formulario del perfil: hay que
//! **interrumpir la conexión**, preguntar al usuario y seguir. El patrón es el
//! mismo que ya usan las host keys desconocidas (`host_keys`) y los
//! certificados FTPS (`ftps_certs`): se emite un evento global con un
//! `promptId`, el backend espera en un `oneshot` con plazo, y el frontend
//! devuelve la respuesta por el comando `ssh_auth_prompt_response`.
//!
//! **Las respuestas no se guardan en ningún sitio.** Un código de un solo uso
//! caduca en 30 segundos: persistirlo no tendría utilidad y sí un coste. Viven
//! en memoria el tiempo que dura el intercambio y se van con él.
//!
//! **El TOTP de KeePass contesta por este mismo canal, sin pasar por la
//! interfaz.** Si el perfil lo ha activado (`auth_totp`), la pregunta en vuelo
//! guarda de qué entrada sacar el código y el evento solo dice que la opción
//! existe. Con «Usar código de KeePass» el frontend invoca
//! `ssh_auth_prompt_totp` con el `promptId`; el backend calcula el código y lo
//! entrega por el mismo `oneshot`. Al renderer vuelve un [`TotpReply`]: un
//! motivo, nunca el código ni la semilla.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::auth_totp::{self, Issued};
use crate::cli_lang::tr;
use crate::ipc::{SSH_AUTH_PROMPT, SSH_AUTH_TOTP_WAIT};
use crate::keepass_manager::TotpError;
use crate::locks::MutexExt;

/// Handle de la app para emitir el evento. Ausente en la CLI, que cae a stdin.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Las respuestas a una ronda de preguntas.
pub struct Answers {
    /// Una respuesta por pregunta, en el mismo orden.
    pub values: Vec<String>,
    /// La contestó el TOTP de KeePass (el botón del diálogo), no el teclado.
    /// Lo necesita `auth_totp` para saber si un acierto es de KeePass.
    pub from_keepass: bool,
}

/// A mano: llevan contraseñas y códigos, y un `{:?}` (un `expect`, un log) no
/// debe volcarlos. Solo dice cuántas son y de dónde vienen.
impl std::fmt::Debug for Answers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Answers")
            .field("count", &self.values.len())
            .field("from_keepass", &self.from_keepass)
            .finish_non_exhaustive()
    }
}

impl Answers {
    fn typed(values: Vec<String>) -> Self {
        Answers {
            values,
            from_keepass: false,
        }
    }
}

/// Una pregunta en vuelo: el canal por el que llega la respuesta (`None` = el
/// usuario canceló) y, si el perfil lo ofrece, de dónde sacar el TOTP.
struct PendingPrompt {
    tx: oneshot::Sender<Option<Answers>>,
    totp: Option<auth_totp::Offer>,
}

/// Preguntas en vuelo, por `promptId`.
type Pending = Mutex<HashMap<String, PendingPrompt>>;
static PENDING: LazyLock<Pending> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Plazo para contestar. Generoso a propósito: sacar el móvil, abrir la app del
/// segundo factor y teclear el código lleva más que confirmar una huella.
const AUTH_PROMPT_TIMEOUT: Duration = Duration::from_secs(180);

/// Tope de preguntas por ronda. El servidor las elige, y un servidor hostil
/// podría anunciar miles para inundar la interfaz. `russh` ya acota el número
/// de prompts que acepta; esto es la segunda red, del lado de la UI.
const MAX_PROMPTS: usize = 16;

/// Registra el `AppHandle` (lo llama `lib.rs` en el `setup`).
pub fn set_app_handle(app: AppHandle) {
    let _ = APP.set(app);
}

/// Una pregunta del servidor. `echo` = el texto tecleado puede mostrarse en
/// claro (típico de «Username:»); con `echo: false` la interfaz debe ocultarlo,
/// que es el caso de contraseñas y códigos de un solo uso.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptField {
    pub prompt: String,
    pub echo: bool,
}

/// Payload de `ssh-auth-prompt` (espejo de `SshAuthPromptEvent` en events.js).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthPromptEvent {
    prompt_id: String,
    /// Nombre que el servidor da al intercambio (a menudo vacío).
    name: String,
    /// Instrucciones del servidor (a menudo vacías).
    instructions: String,
    /// Host al que se está conectando, para que el diálogo diga a quién le
    /// estamos entregando el código.
    host: String,
    username: String,
    prompts: Vec<AuthPromptField>,
    /// Presente si la ronda puede contestarse con el TOTP de KeePass del
    /// perfil (`ssh_auth_prompt_totp`). No lleva la entrada ni nada con lo que
    /// calcular el código: eso se queda en la pregunta en vuelo.
    totp_keepass: Option<AuthPromptTotp>,
}

/// Lo único que la interfaz sabe del TOTP de KeePass de una pregunta.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthPromptTotp {
    /// El último código enviado automáticamente para este perfil fue
    /// rechazado: por eso se pregunta en vez de contestar solo.
    auto_rejected: bool,
    /// La base KeePass está bloqueada ahora mismo: el botón llevará a
    /// desbloquearla, y con el modo automático explica por qué se pregunta.
    locked: bool,
}

/// Resultado de «Usar código de KeePass» (`ssh_auth_prompt_totp`). Es todo lo
/// que el renderer llega a saber: si el código se entregó o por qué no. Espejo
/// en `src/modules/auth-totp.js` (`TOTP_REPLY`); un test exige la paridad.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum TotpReply {
    /// El código se entregó al intercambio SSH.
    Sent,
    /// El código de este periodo ya se usó con ese servidor: se entregará el
    /// siguiente dentro de `wait_secs` segundos, sin más intervención.
    Scheduled { wait_secs: u64 },
    /// La base KeePass está bloqueada. La pregunta sigue en vuelo.
    Locked,
    /// La entrada del perfil no está en la base abierta.
    NoEntry,
    /// La entrada no tiene semilla TOTP (campo `otp`).
    NoSeed,
    /// El campo `otp` no es un TOTP estándar que sepamos calcular.
    Unsupported,
    /// El reloj del sistema no sirve para calcular un código.
    Clock,
    /// La pregunta ya no está en vuelo (caducó o se contestó).
    Expired,
    /// Esta pregunta no ofrecía el TOTP de KeePass.
    NotOffered,
}

impl From<TotpError> for TotpReply {
    fn from(error: TotpError) -> Self {
        match error {
            TotpError::Locked => TotpReply::Locked,
            TotpError::NoEntry => TotpReply::NoEntry,
            TotpError::NoSeed => TotpReply::NoSeed,
            TotpError::Unsupported => TotpReply::Unsupported,
            TotpError::Clock => TotpReply::Clock,
        }
    }
}

/// Entrega la respuesta del usuario a una pregunta en vuelo. `None` = cancelar.
/// Devuelve `false` si el `promptId` ya no existe (plazo agotado o respuesta
/// duplicada).
pub fn resolve_prompt(prompt_id: &str, responses: Option<Vec<String>>) -> bool {
    resolve_with(prompt_id, responses.map(Answers::typed))
}

fn resolve_with(prompt_id: &str, answers: Option<Answers>) -> bool {
    let pending = PENDING.lock_recover().remove(prompt_id);
    match pending {
        Some(prompt) => prompt.tx.send(answers).is_ok(),
        None => false,
    }
}

/// Contesta una pregunta en vuelo con el TOTP de KeePass de su perfil. El
/// código va del cálculo al `oneshot` sin salir de aquí; quien llama (el
/// comando IPC) solo recibe el [`TotpReply`].
///
/// Si no se puede calcular (base bloqueada, entrada sin semilla), la pregunta
/// **sigue en vuelo**: la interfaz ofrece desbloquear o deja teclear el código.
pub fn answer_with_totp(prompt_id: &str) -> TotpReply {
    let offer = match PENDING.lock_recover().get(prompt_id) {
        None => return TotpReply::Expired,
        Some(prompt) => match &prompt.totp {
            None => return TotpReply::NotOffered,
            Some(offer) => offer.clone(),
        },
    };
    match auth_totp::issue(&offer.entry_uuid, &offer.host) {
        Ok(Issued::Now(code)) => deliver_totp(prompt_id, &code),
        Ok(Issued::After(wait)) => {
            // El código vigente ya se entregó a ese servidor y no lo aceptaría
            // otra vez: se manda el siguiente en cuanto exista.
            let prompt_id = prompt_id.to_string();
            tauri::async_runtime::spawn(async move {
                match auth_totp::wait_and_issue(&offer.entry_uuid, &offer.host, wait).await {
                    Some(code) => {
                        deliver_totp(&prompt_id, &code);
                    }
                    // La base se bloqueó mientras se esperaba (o hay demasiadas
                    // conexiones en cola para el mismo código): sin diálogo a
                    // la vista, lo honesto es cancelar la autenticación.
                    None => {
                        resolve_with(&prompt_id, None);
                    }
                }
            });
            TotpReply::Scheduled {
                wait_secs: wait.as_secs().max(1),
            }
        }
        Err(reason) => reason.into(),
    }
}

/// Payload de `ssh-auth-totp-wait` (espejo de `SshAuthTotpWaitEvent` en events.js).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TotpWaitEvent {
    host: String,
    wait_secs: u64,
}

/// Avisa a la interfaz de que el modo automático espera `wait` al código
/// siguiente antes de contestar a `host`. Sin interfaz (CLI, tests) no hace
/// nada; si el aviso no llega, la conexión sigue igual.
pub fn notify_totp_wait(host: &str, wait: Duration) {
    if let Some(app) = APP.get() {
        let _ = app.emit(
            SSH_AUTH_TOTP_WAIT,
            TotpWaitEvent {
                host: host.to_string(),
                wait_secs: wait.as_secs().max(1),
            },
        );
    }
}

fn deliver_totp(prompt_id: &str, code: &Zeroizing<String>) -> TotpReply {
    let answers = Answers {
        values: vec![code.to_string()],
        from_keepass: true,
    };
    if resolve_with(prompt_id, Some(answers)) {
        TotpReply::Sent
    } else {
        TotpReply::Expired
    }
}

/// Cancela todas las preguntas en vuelo. La llama el cierre de la aplicación
/// para que ninguna conexión se quede colgada esperando un plazo de 3 minutos.
pub fn cancel_all() {
    let pending: Vec<_> = PENDING
        .lock_recover()
        .drain()
        .map(|(_, prompt)| prompt.tx)
        .collect();
    for tx in pending {
        let _ = tx.send(None);
    }
}

/// A quién se le enseña una pregunta: la ventana de la aplicación o, en un
/// test, una interfaz de pega (ver [`testing`]).
enum Ui {
    App(&'static AppHandle),
    #[cfg(test)]
    Fake(testing::FakeUi),
}

impl Ui {
    /// La interfaz a la vista, si la hay.
    fn current() -> Option<Ui> {
        #[cfg(test)]
        if let Ok(fake) = testing::UI.try_with(Clone::clone) {
            return Some(Ui::Fake(fake));
        }
        APP.get().map(Ui::App)
    }

    fn show(&self, payload: AuthPromptEvent) -> Result<(), String> {
        match self {
            Ui::App(app) => app.emit(SSH_AUTH_PROMPT, payload).map_err(|e| e.to_string()),
            #[cfg(test)]
            Ui::Fake(fake) => {
                // Lo mismo que vería el renderer: el payload ya serializado.
                fake(serde_json::to_value(&payload).map_err(|e| e.to_string())?);
                Ok(())
            }
        }
    }
}

/// Una interfaz de pega para los tests: recibe el evento `ssh-auth-prompt` tal
/// como lo recibiría el renderer (JSON) y contesta por los mismos caminos que
/// él (`resolve_prompt`, `answer_with_totp`). Vive en la tarea del test, así
/// que no la ven los demás, que siguen sin interfaz ni terminal.
#[cfg(test)]
pub(crate) mod testing {
    use std::future::Future;
    use std::sync::Arc;

    pub(crate) type FakeUi = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

    tokio::task_local! {
        pub(super) static UI: FakeUi;
    }

    /// Ejecuta `auth` con `ui` contestando a sus preguntas.
    pub(crate) fn with_ui<F: Future>(ui: FakeUi, auth: F) -> impl Future<Output = F::Output> {
        UI.scope(ui, auth)
    }
}

/// Pide al usuario las respuestas a una ronda de preguntas del servidor.
///
/// `Ok(Some(respuestas))` = el usuario contestó (una respuesta por pregunta, en
/// el mismo orden); `Ok(None)` = canceló; `Err` = no había a quién preguntar o
/// se agotó el plazo.
///
/// `totp`: si la ronda es la del código y el perfil ofrece el TOTP de KeePass,
/// de dónde sacarlo. Se guarda con la pregunta en vuelo (ver
/// [`answer_with_totp`]); en la terminal de la CLI no se usa.
pub async fn ask(
    host: &str,
    username: &str,
    name: &str,
    instructions: &str,
    prompts: &[AuthPromptField],
    totp: Option<auth_totp::Offer>,
) -> Result<Option<Answers>, String> {
    if prompts.len() > MAX_PROMPTS {
        return Err(tr!(
            "el servidor pide {} respuestas de una vez; se rechaza por seguridad",
            "the server asks for {} answers at once; rejected for safety",
            prompts.len()
        ));
    }

    // Ronda vacía: el servidor solo informa (algunos mandan un `AuthInfoRequest`
    // sin prompts para enseñar un banner). Se contesta con la lista vacía sin
    // molestar al usuario, que es lo que dice el RFC 4256 §3.3.
    if prompts.is_empty() {
        return Ok(Some(Answers::typed(Vec::new())));
    }

    let Some(ui) = Ui::current() else {
        // Sin interfaz (CLI): si hay una terminal, se pregunta por ella; si
        // no (script, cron, tubería), no hay a quién preguntar.
        return ask_on_terminal(host, username, name, instructions, prompts)
            .map(|answers| answers.map(Answers::typed));
    };

    let prompt_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    let totp_keepass = totp.as_ref().map(|offer| AuthPromptTotp {
        auto_rejected: offer.auto_rejected,
        locked: !crate::keepass_manager::status().unlocked,
    });
    PENDING
        .lock_recover()
        .insert(prompt_id.clone(), PendingPrompt { tx, totp });

    let payload = AuthPromptEvent {
        prompt_id: prompt_id.clone(),
        name: name.to_string(),
        instructions: instructions.to_string(),
        host: host.to_string(),
        username: username.to_string(),
        prompts: prompts.to_vec(),
        totp_keepass,
    };
    if let Err(err) = ui.show(payload) {
        PENDING.lock_recover().remove(&prompt_id);
        return Err(format!("no se pudo pedir el código de verificación: {err}"));
    }

    match tokio::time::timeout(AUTH_PROMPT_TIMEOUT, rx).await {
        Ok(Ok(Some(answers))) => {
            // El servidor espera exactamente una respuesta por pregunta: si la
            // interfaz devolviera otra cosa, `russh` mandaría un paquete mal
            // formado y el servidor cortaría la conexión sin explicación.
            if answers.values.len() != prompts.len() {
                return Err(format!(
                    "se esperaban {} respuestas y llegaron {}",
                    prompts.len(),
                    answers.values.len()
                ));
            }
            Ok(Some(answers))
        }
        Ok(Ok(None)) => Ok(None),
        // El canal se cerró sin respuesta (la ventana se fue, p. ej.).
        Ok(Err(_)) => Ok(None),
        Err(_) => {
            PENDING.lock_recover().remove(&prompt_id);
            Err(format!(
                "nadie contestó a la autenticación interactiva de {username}@{host} en {} s",
                AUTH_PROMPT_TIMEOUT.as_secs()
            ))
        }
    }
}

/// Las preguntas por la terminal, para la CLI (`rustty -c` desde una consola
/// real). Van por stderr, como el resto de avisos de la CLI, para que stdout
/// siga llevando solo la salida del comando; las de `echo: false` se leen sin
/// eco, como una contraseña. Sin terminal no hay a quién preguntar, y la
/// conexión falla con un motivo que lo dice.
fn ask_on_terminal(
    host: &str,
    username: &str,
    name: &str,
    instructions: &str,
    prompts: &[AuthPromptField],
) -> Result<Option<Vec<String>>, String> {
    use std::io::{BufRead, IsTerminal, Write};

    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        return Err(tr!(
            "{username}@{host} pide autenticación interactiva por teclado (un código de \
             verificación o una contraseña que el servidor pregunta) y no hay terminal ni \
             interfaz gráfica donde contestar",
            "{username}@{host} asks for keyboard-interactive authentication (a verification \
             code or a password the server asks for) and there is no terminal or graphical \
             interface to answer on"
        ));
    }
    for line in [name, instructions] {
        if !line.trim().is_empty() {
            eprintln!("{}", line.trim());
        }
    }
    let mut answers = Vec::with_capacity(prompts.len());
    for field in prompts {
        eprint!("{}", field.prompt);
        let _ = std::io::stderr().flush();
        let answer = if field.echo {
            let mut line = String::new();
            stdin
                .lock()
                .read_line(&mut line)
                .map_err(|e| tr!("no se pudo leer la respuesta: {e}", "could not read the answer: {e}"))?;
            line.trim_end_matches(['\r', '\n']).to_string()
        } else {
            rpassword::read_password()
                .map_err(|e| tr!("no se pudo leer la respuesta: {e}", "could not read the answer: {e}"))?
        };
        answers.push(answer);
    }
    Ok(Some(answers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keepass_manager;

    #[test]
    fn responder_a_una_pregunta_inexistente_no_entra_en_panico() {
        // Una respuesta tardía (el plazo ya venció) o duplicada devuelve false
        // en vez de romper.
        assert!(!resolve_prompt("no-existe", Some(vec!["123456".into()])));
        assert!(!resolve_prompt("no-existe", None));
    }

    #[tokio::test]
    async fn una_ronda_sin_preguntas_se_contesta_sola() {
        // Sin `AppHandle` registrado: si intentara preguntar, fallaría. Que
        // devuelva la lista vacía demuestra que ni lo intenta.
        let r = ask("host", "user", "", "Banner informativo", &[], None).await;
        assert!(matches!(r, Ok(Some(ref a)) if a.values.is_empty() && !a.from_keepass));
    }

    #[tokio::test]
    async fn sin_app_ni_terminal_una_pregunta_falla_diciendo_a_quien() {
        // En la CLI dentro de un script (stdin no es un terminal, como aquí)
        // no hay dónde contestar: el error nombra al usuario y al host.
        let prompts = [AuthPromptField {
            prompt: "Verification code: ".into(),
            echo: false,
        }];
        let err = ask("srv.example", "ana", "", "", &prompts, None)
            .await
            .expect_err("sin terminal debe fallar");
        assert!(err.contains("ana@srv.example"), "{err}");
        assert!(err.contains("terminal"), "{err}");
    }

    #[tokio::test]
    async fn una_ronda_desmesurada_se_rechaza_sin_preguntar() {
        let prompts: Vec<_> = (0..MAX_PROMPTS + 1)
            .map(|i| AuthPromptField {
                prompt: format!("p{i}"),
                echo: false,
            })
            .collect();
        assert!(ask("host", "user", "", "", &prompts, None).await.is_err());
    }

    /// Deja una pregunta en vuelo como la dejaría `ask`, sin interfaz.
    fn pending(
        prompt_id: &str,
        totp: Option<auth_totp::Offer>,
    ) -> oneshot::Receiver<Option<Answers>> {
        let (tx, rx) = oneshot::channel();
        PENDING
            .lock_recover()
            .insert(prompt_id.to_string(), PendingPrompt { tx, totp });
        rx
    }

    fn offer(entry_uuid: &str, host: &str) -> auth_totp::Offer {
        auth_totp::Offer {
            entry_uuid: entry_uuid.to_string(),
            host: host.to_string(),
            auto_rejected: false,
        }
    }

    // Los tests que siguen comparten el turno de la base KeePass: además de
    // tocarla, `cancel_all` vacía las preguntas en vuelo de cualquier otro.

    #[test]
    fn cancelar_todo_vacia_las_preguntas_en_vuelo() {
        let _turno = keepass_manager::testing::exclusive_blocking();
        let rx = pending("p-cancel", None);
        cancel_all();
        assert!(PENDING.lock_recover().is_empty());
        assert!(rx.blocking_recv().ok().flatten().is_none());
        // Y una respuesta posterior ya no encuentra a nadie.
        assert!(!resolve_prompt("p-cancel", Some(vec![])));
    }

    /// El camino de «Usar código de KeePass»: el código llega al intercambio
    /// por el `oneshot` y lo que vuelve a la interfaz no lo contiene.
    #[test]
    fn el_totp_de_keepass_contesta_la_pregunta_sin_devolver_el_codigo() {
        use keepass_manager::testing::{add_entry, install, otp_uri, RFC_SEED};
        let _turno = keepass_manager::testing::exclusive_blocking();
        let mut db = keepass::Database::new();
        let entry = add_entry(&mut db, "srv", Some(&otp_uri(RFC_SEED, 6, 30)));
        install(db);
        let rx = pending("p-totp", Some(offer(&entry, "boton.example")));

        // El código depende del reloj: vale el del instante anterior o el del
        // posterior a la llamada (por si cae justo un cambio de periodo).
        let now = || keepass_manager::unix_now().expect("reloj");
        let before = keepass_manager::totp_at(&entry, now()).expect("código");
        let reply = answer_with_totp("p-totp");
        let after = keepass_manager::totp_at(&entry, now()).expect("código");
        keepass_manager::lock();

        assert_eq!(reply, TotpReply::Sent);
        let answers = rx.blocking_recv().expect("canal").expect("respuesta");
        assert!(answers.from_keepass, "la respuesta se sabe de KeePass");
        assert_eq!(answers.values.len(), 1);
        assert!(
            answers.values[0] == before.code.as_str() || answers.values[0] == after.code.as_str(),
            "el código entregado no es el vigente"
        );
        let json = serde_json::to_string(&reply).expect("json");
        assert_eq!(json, r#"{"status":"sent"}"#);
        // Entregada, la pregunta ya no está: un segundo clic no manda otro.
        assert_eq!(answer_with_totp("p-totp"), TotpReply::Expired);
    }

    #[test]
    fn si_no_se_puede_calcular_el_totp_la_pregunta_sigue_en_vuelo() {
        use keepass_manager::testing::{add_entry, install};
        let _turno = keepass_manager::testing::exclusive_blocking();

        // Base bloqueada: se podrá desbloquear y volver a pulsar, o teclear.
        keepass_manager::lock();
        let entry = uuid::Uuid::new_v4().to_string();
        let rx = pending("p-locked", Some(offer(&entry, "bloqueada.example")));
        assert_eq!(answer_with_totp("p-locked"), TotpReply::Locked);
        assert!(PENDING.lock_recover().contains_key("p-locked"));

        // Desbloqueada, pero la entrada no existe o no trae semilla.
        let mut db = keepass::Database::new();
        let sin_semilla = add_entry(&mut db, "sin", None);
        install(db);
        assert_eq!(answer_with_totp("p-locked"), TotpReply::NoEntry);
        let rx_sin = pending("p-noseed", Some(offer(&sin_semilla, "sin.example")));
        assert_eq!(answer_with_totp("p-noseed"), TotpReply::NoSeed);
        keepass_manager::lock();

        // Las dos siguen esperando al usuario, que teclea el código.
        assert!(resolve_prompt("p-locked", Some(vec!["123456".into()])));
        let typed = rx.blocking_recv().expect("canal").expect("respuesta");
        assert_eq!(typed.values, vec!["123456".to_string()]);
        assert!(!typed.from_keepass, "lo tecleado no cuenta como de KeePass");
        assert!(resolve_prompt("p-noseed", None));
        assert!(rx_sin.blocking_recv().expect("canal").is_none());
    }

    #[test]
    fn una_pregunta_sin_oferta_o_inexistente_no_acepta_el_totp() {
        let _turno = keepass_manager::testing::exclusive_blocking();
        let _rx = pending("p-sin-oferta", None);
        assert_eq!(answer_with_totp("p-sin-oferta"), TotpReply::NotOffered);
        assert!(PENDING.lock_recover().contains_key("p-sin-oferta"));
        assert_eq!(answer_with_totp("p-no-existe"), TotpReply::Expired);
        assert!(resolve_prompt("p-sin-oferta", None));
    }

    /// Dos preguntas seguidas del mismo servidor (la sesión SSH y, acto
    /// seguido, el panel SFTP): la segunda no repite el código, que el servidor
    /// rechazaría; queda programada para el periodo siguiente.
    #[test]
    fn el_segundo_totp_del_mismo_periodo_se_programa_en_vez_de_repetirse() {
        use keepass_manager::testing::{add_entry, install, otp_uri, RFC_SEED};
        let _turno = keepass_manager::testing::exclusive_blocking();
        let mut db = keepass::Database::new();
        let entry = add_entry(&mut db, "srv", Some(&otp_uri(RFC_SEED, 6, 30)));
        install(db);
        let _first = pending("p-ssh", Some(offer(&entry, "seguidas.example")));
        let _second = pending("p-sftp", Some(offer(&entry, "seguidas.example")));

        assert_eq!(answer_with_totp("p-ssh"), TotpReply::Sent);
        match answer_with_totp("p-sftp") {
            TotpReply::Scheduled { wait_secs } => {
                assert!((1..=30).contains(&wait_secs), "{wait_secs}");
                // Sigue en vuelo hasta que llegue su turno; aquí se cancela
                // para que la tarea programada no encuentre a quién entregar.
                assert!(resolve_prompt("p-sftp", None));
            }
            // Entre las dos llamadas cambió el periodo: código nuevo, sin espera.
            TotpReply::Sent => {}
            other => panic!("respuesta inesperada: {other:?}"),
        }
        keepass_manager::lock();
    }

    /// El evento que llega al renderer solo dice que la opción existe.
    #[test]
    fn el_evento_no_lleva_la_entrada_ni_nada_con_que_calcular_el_codigo() {
        let event = |totp_keepass| AuthPromptEvent {
            prompt_id: "p1".into(),
            name: String::new(),
            instructions: String::new(),
            host: "srv.example".into(),
            username: "ana".into(),
            prompts: vec![AuthPromptField {
                prompt: "Verification code: ".into(),
                echo: false,
            }],
            totp_keepass,
        };
        let sin = serde_json::to_value(event(None)).expect("json");
        assert!(sin["totpKeepass"].is_null());
        let con = serde_json::to_value(event(Some(AuthPromptTotp {
            auto_rejected: true,
            locked: true,
        })))
        .expect("json");
        assert_eq!(
            con["totpKeepass"],
            serde_json::json!({ "autoRejected": true, "locked": true })
        );
    }

    /// `TOTP_REPLY` (frontend) y `TotpReply` nombran los mismos estados.
    #[test]
    fn los_estados_del_totp_coinciden_con_el_espejo_del_frontend() {
        let js = include_str!("../../src/modules/auth-totp.js");
        let all = [
            TotpReply::Sent,
            TotpReply::Scheduled { wait_secs: 7 },
            TotpReply::Locked,
            TotpReply::NoEntry,
            TotpReply::NoSeed,
            TotpReply::Unsupported,
            TotpReply::Clock,
            TotpReply::Expired,
            TotpReply::NotOffered,
        ];
        for reply in &all {
            let value = serde_json::to_value(reply).expect("json");
            let status = value["status"].as_str().expect("status");
            assert!(
                js.contains(&format!("\"{status}\"")),
                "falta el estado {status} en TOTP_REPLY (auth-totp.js)"
            );
        }
        let declared = js
            .split("export const TOTP_REPLY")
            .nth(1)
            .and_then(|rest| rest.split("});").next())
            .expect("bloque TOTP_REPLY");
        assert_eq!(
            declared.matches(": \"").count(),
            all.len(),
            "TOTP_REPLY declara estados que el backend no emite (o al revés)"
        );
        let scheduled = serde_json::to_string(&TotpReply::Scheduled { wait_secs: 7 }).expect("json");
        assert_eq!(scheduled, r#"{"status":"scheduled","waitSecs":7}"#);
    }
}
