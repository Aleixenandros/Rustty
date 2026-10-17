//! Servidor SSH **en proceso** (el lado servidor de `russh`) que solo admite
//! `keyboard-interactive`, para probar el camino de PAM sin `sshd` ni
//! privilegios.
//!
//! Un `sshd` con `PasswordAuthentication no` y `KbdInteractiveAuthentication
//! yes` —lo habitual con PAM— no ofrece el método `password`: pide la
//! contraseña como primera pregunta de un intercambio `keyboard-interactive`.
//! PAM exige root, así que el `sshd` del fixture real (`ssh_fixture`) no puede
//! ejercitarlo. Aquí el servidor anuncia `publickey,keyboard-interactive`,
//! rechaza `password` (como sshd, sin mirarla) y contesta a
//! `keyboard-interactive` con las rondas que se le programen: una «Password:»
//! sin eco y, opcionalmente, un código de verificación después (MFA) o una
//! primera ronda con otra forma (usuario + contraseña).
//!
//! A diferencia de los fixtures que levantan un servicio externo, este es puro
//! Rust y corre en el `cargo test` normal, en todas las plataformas.

use std::borrow::Cow;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::keys::ssh_key::Algorithm;
use russh::keys::PrivateKey;
use russh::server::{self, Auth, Response};
use russh::{MethodKind, MethodSet};
use tokio::net::TcpListener;

/// Lo que el servidor pregunta y lo que acepta.
#[derive(Clone)]
pub struct Rounds {
    /// Contraseña que acepta en la ronda «Password:».
    pub password: String,
    /// Si hay, tras la contraseña pide «Verification code:» y exige este valor.
    pub otp: Option<String>,
    /// La primera ronda pregunta «Username:» (con eco) y «Password:», en vez
    /// de solo la contraseña: la forma que NO debe contestarse sola.
    pub double_prompt: bool,
}

/// Servidor en marcha. Al soltarlo se para.
pub struct KbdServer {
    pub port: u16,
    /// Huella SHA256 de la host key, para fijarla con `expect_fingerprint`
    /// (así el test no toca ningún `known_hosts`).
    pub fingerprint: String,
    password_attempts: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for KbdServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl KbdServer {
    /// Arranca en un puerto efímero de localhost y acepta conexiones hasta que
    /// se suelte.
    pub async fn start(rounds: Rounds) -> KbdServer {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("host key");
        let fingerprint = crate::host_keys::fingerprint_sha256(key.public_key());

        let mut config = server::Config::default();
        config.keys.push(key);
        // Como un sshd con `PasswordAuthentication no`: `password` no está
        // entre los métodos y una petición de ese tipo vuelve rechazada con
        // la lista `publickey,keyboard-interactive`.
        config.methods = MethodSet::from(&[MethodKind::PublicKey, MethodKind::KeyboardInteractive][..]);
        config.auth_rejection_time = Duration::from_millis(5);
        config.auth_rejection_time_initial = Some(Duration::ZERO);
        config.inactivity_timeout = Some(Duration::from_secs(30));
        let config = Arc::new(config);

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let password_attempts = Arc::new(AtomicUsize::new(0));
        let attempts = Arc::clone(&password_attempts);
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let handler = Handler {
                    rounds: rounds.clone(),
                    stage: Stage::Fresh,
                    password_attempts: Arc::clone(&attempts),
                };
                let config = Arc::clone(&config);
                tokio::spawn(async move {
                    if let Ok(session) = server::run_stream(config, socket, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        KbdServer {
            port,
            fingerprint,
            password_attempts,
            task,
        }
    }

    /// Cuántas veces intentó el cliente el método `password` (que aquí
    /// siempre se rechaza, como en un sshd sin él).
    pub fn password_attempts(&self) -> usize {
        self.password_attempts.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Copy)]
enum Stage {
    Fresh,
    AskedPassword,
    AskedOtp,
}

struct Handler {
    rounds: Rounds,
    stage: Stage,
    password_attempts: Arc<AtomicUsize>,
}

fn prompts(items: &[(&'static str, bool)]) -> Cow<'static, [(Cow<'static, str>, bool)]> {
    Cow::Owned(
        items
            .iter()
            .map(|(text, echo)| (Cow::Borrowed(*text), *echo))
            .collect(),
    )
}

fn partial(items: &[(&'static str, bool)]) -> Auth {
    Auth::Partial {
        name: Cow::Borrowed(""),
        instructions: Cow::Borrowed(""),
        prompts: prompts(items),
    }
}

impl server::Handler for Handler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        self.password_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(Auth::reject())
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        let answers: Vec<String> = response
            .map(|r| r.map(|b| String::from_utf8_lossy(&b).into_owned()).collect())
            .unwrap_or_default();
        match self.stage {
            Stage::Fresh => {
                self.stage = Stage::AskedPassword;
                Ok(if self.rounds.double_prompt {
                    partial(&[("Username: ", true), ("Password: ", false)])
                } else {
                    partial(&[("Password: ", false)])
                })
            }
            Stage::AskedPassword => {
                let expected_len = if self.rounds.double_prompt { 2 } else { 1 };
                if answers.len() != expected_len || answers.last() != Some(&self.rounds.password) {
                    self.stage = Stage::Fresh;
                    return Ok(Auth::reject());
                }
                match self.rounds.otp {
                    None => Ok(Auth::Accept),
                    Some(_) => {
                        self.stage = Stage::AskedOtp;
                        Ok(partial(&[("Verification code: ", false)]))
                    }
                }
            }
            Stage::AskedOtp => {
                self.stage = Stage::Fresh;
                Ok(if answers.first() == self.rounds.otp.as_ref() {
                    Auth::Accept
                } else {
                    Auth::reject()
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_keys;
    use crate::profiles::AuthType;
    use crate::ssh_manager::{authenticate_handle, russh_connect_addr};
    use russh::client::{self, AuthResult};

    /// Conecta fijando la huella del servidor: ni lee ni escribe known_hosts
    /// y no toca la política global de primera conexión.
    async fn connect(server: &KbdServer) -> client::Handle<host_keys::KnownHostsClient> {
        let (mut handler, failure) =
            host_keys::client("127.0.0.1".to_string(), server.port, false, false);
        handler.expect_fingerprint(Some(server.fingerprint.clone()));
        let addr = format!("127.0.0.1:{}", server.port);
        russh_connect_addr(Arc::new(client::Config::default()), &addr, handler)
            .await
            .unwrap_or_else(|e| panic!("no conectó: {e}. {:?}", host_keys::take_failure(&failure)))
    }

    async fn auth_with_password(
        handle: &mut client::Handle<host_keys::KnownHostsClient>,
        password: &str,
    ) -> Result<AuthResult, crate::error::AppError> {
        tokio::time::timeout(
            Duration::from_secs(15),
            authenticate_handle(
                handle,
                &AuthType::Password,
                "ana",
                "127.0.0.1",
                Some(&password.to_string()),
                None,
                None,
            ),
        )
        .await
        .expect("la autenticación no debe colgarse")
    }

    fn rounds(password: &str) -> Rounds {
        Rounds {
            password: password.to_string(),
            otp: None,
            double_prompt: false,
        }
    }

    /// El caso de PAM: `password` se rechaza por configuración y la misma
    /// contraseña entra por la primera pregunta de `keyboard-interactive`,
    /// sin que haya nadie que la teclee (aquí no hay interfaz ni terminal).
    #[tokio::test]
    async fn la_contrasena_del_perfil_entra_por_keyboard_interactive() {
        let server = KbdServer::start(rounds("secreta")).await;
        let mut handle = connect(&server).await;
        let auth = auth_with_password(&mut handle, "secreta").await.expect("auth");
        assert!(matches!(auth, AuthResult::Success), "{auth:?}");
        assert_eq!(server.password_attempts(), 1, "primero se intenta `password`");
    }

    /// Una contraseña mala sigue siendo un rechazo limpio: `Failure`, sin
    /// error ni cuelgue, y el servidor no la acepta por ningún camino.
    #[tokio::test]
    async fn una_contrasena_incorrecta_sigue_siendo_un_rechazo() {
        let server = KbdServer::start(rounds("secreta")).await;
        let mut handle = connect(&server).await;
        let auth = auth_with_password(&mut handle, "otra").await.expect("sin error de protocolo");
        assert!(
            matches!(auth, AuthResult::Failure { partial_success: false, .. }),
            "{auth:?}"
        );
    }

    /// Tras la contraseña, el servidor pide un segundo factor: eso ya va al
    /// usuario y, sin interfaz ni terminal (como en un script), la conexión
    /// falla diciéndolo en vez de reenviar la contraseña a ciegas.
    #[tokio::test]
    async fn un_segundo_factor_sin_terminal_falla_diciendolo() {
        let server = KbdServer::start(Rounds {
            password: "secreta".into(),
            otp: Some("123456".into()),
            double_prompt: false,
        })
        .await;
        let mut handle = connect(&server).await;
        let err = auth_with_password(&mut handle, "secreta")
            .await
            .expect_err("el código no se puede inventar");
        let msg = err.to_string();
        assert!(msg.contains("terminal") && msg.contains("ana@127.0.0.1"), "{msg}");
    }

    /// Una primera ronda con otra forma (usuario + contraseña) no es la
    /// petición de contraseña de PAM: no se contesta sola.
    #[tokio::test]
    async fn una_ronda_con_dos_preguntas_no_recibe_la_contrasena_sola() {
        let server = KbdServer::start(Rounds {
            password: "secreta".into(),
            otp: None,
            double_prompt: true,
        })
        .await;
        let mut handle = connect(&server).await;
        let err = auth_with_password(&mut handle, "secreta")
            .await
            .expect_err("dos preguntas van al usuario");
        assert!(err.to_string().contains("terminal"), "{err}");
    }
}
