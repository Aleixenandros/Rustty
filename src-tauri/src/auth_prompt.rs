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

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::ipc::SSH_AUTH_PROMPT;
use crate::locks::MutexExt;

/// Handle de la app para emitir el evento. Ausente en la CLI, que cae a stdin.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Preguntas en vuelo: `promptId` → canal por el que llega la respuesta.
/// `None` = el usuario canceló.
type Pending = Mutex<HashMap<String, oneshot::Sender<Option<Vec<String>>>>>;
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
}

/// Entrega la respuesta del usuario a una pregunta en vuelo. `None` = cancelar.
/// Devuelve `false` si el `promptId` ya no existe (plazo agotado o respuesta
/// duplicada).
pub fn resolve_prompt(prompt_id: &str, responses: Option<Vec<String>>) -> bool {
    let sender = PENDING.lock_recover().remove(prompt_id);
    match sender {
        Some(tx) => tx.send(responses).is_ok(),
        None => false,
    }
}

/// Cancela todas las preguntas en vuelo. La llama el cierre de la aplicación
/// para que ninguna conexión se quede colgada esperando un plazo de 3 minutos.
pub fn cancel_all() {
    let pending: Vec<_> = PENDING.lock_recover().drain().map(|(_, tx)| tx).collect();
    for tx in pending {
        let _ = tx.send(None);
    }
}

/// Pide al usuario las respuestas a una ronda de preguntas del servidor.
///
/// `Ok(Some(respuestas))` = el usuario contestó (una respuesta por pregunta, en
/// el mismo orden); `Ok(None)` = canceló; `Err` = no había a quién preguntar o
/// se agotó el plazo.
pub async fn ask(
    host: &str,
    username: &str,
    name: &str,
    instructions: &str,
    prompts: &[AuthPromptField],
) -> Result<Option<Vec<String>>, String> {
    if prompts.len() > MAX_PROMPTS {
        return Err(format!(
            "el servidor pide {} respuestas de una vez; se rechaza por seguridad",
            prompts.len()
        ));
    }

    // Ronda vacía: el servidor solo informa (algunos mandan un `AuthInfoRequest`
    // sin prompts para enseñar un banner). Se contesta con la lista vacía sin
    // molestar al usuario, que es lo que dice el RFC 4256 §3.3.
    if prompts.is_empty() {
        return Ok(Some(Vec::new()));
    }

    let Some(app) = APP.get() else {
        // Sin interfaz (CLI): si hay una terminal, se pregunta por ella; si
        // no (script, cron, tubería), no hay a quién preguntar.
        return ask_on_terminal(host, username, name, instructions, prompts);
    };

    let prompt_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock_recover().insert(prompt_id.clone(), tx);

    let payload = AuthPromptEvent {
        prompt_id: prompt_id.clone(),
        name: name.to_string(),
        instructions: instructions.to_string(),
        host: host.to_string(),
        username: username.to_string(),
        prompts: prompts.to_vec(),
    };
    if let Err(err) = app.emit(SSH_AUTH_PROMPT, payload) {
        PENDING.lock_recover().remove(&prompt_id);
        return Err(format!("no se pudo pedir el código de verificación: {err}"));
    }

    match tokio::time::timeout(AUTH_PROMPT_TIMEOUT, rx).await {
        Ok(Ok(Some(responses))) => {
            // El servidor espera exactamente una respuesta por pregunta: si la
            // interfaz devolviera otra cosa, `russh` mandaría un paquete mal
            // formado y el servidor cortaría la conexión sin explicación.
            if responses.len() != prompts.len() {
                return Err(format!(
                    "se esperaban {} respuestas y llegaron {}",
                    prompts.len(),
                    responses.len()
                ));
            }
            Ok(Some(responses))
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
        return Err(format!(
            "{username}@{host} pide autenticación interactiva por teclado (un código de \
             verificación o una contraseña que el servidor pregunta) y no hay terminal ni \
             interfaz gráfica donde contestar"
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
                .map_err(|e| format!("no se pudo leer la respuesta: {e}"))?;
            line.trim_end_matches(['\r', '\n']).to_string()
        } else {
            rpassword::read_password().map_err(|e| format!("no se pudo leer la respuesta: {e}"))?
        };
        answers.push(answer);
    }
    Ok(Some(answers))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let r = ask("host", "user", "", "Banner informativo", &[]).await;
        assert!(matches!(r, Ok(Some(ref v)) if v.is_empty()));
    }

    #[tokio::test]
    async fn sin_app_ni_terminal_una_pregunta_falla_diciendo_a_quien() {
        // En la CLI dentro de un script (stdin no es un terminal, como aquí)
        // no hay dónde contestar: el error nombra al usuario y al host.
        let prompts = [AuthPromptField {
            prompt: "Verification code: ".into(),
            echo: false,
        }];
        let err = ask("srv.example", "ana", "", "", &prompts)
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
        assert!(ask("host", "user", "", "", &prompts).await.is_err());
    }

    #[test]
    fn cancelar_todo_vacia_las_preguntas_en_vuelo() {
        let (tx, rx) = oneshot::channel();
        PENDING.lock_recover().insert("p-cancel".into(), tx);
        cancel_all();
        assert!(PENDING.lock_recover().is_empty());
        assert_eq!(rx.blocking_recv().ok().flatten(), None);
        // Y una respuesta posterior ya no encuentra a nadie.
        assert!(!resolve_prompt("p-cancel", Some(vec![])));
    }
}
