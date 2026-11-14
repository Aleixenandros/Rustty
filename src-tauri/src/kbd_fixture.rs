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
#[derive(Clone, Default)]
pub struct Rounds {
    /// Contraseña que acepta en la ronda «Password:».
    pub password: String,
    /// Si hay, tras la contraseña pide «Verification code:» y exige este valor.
    pub otp: Option<String>,
    /// La primera ronda pregunta «Username:» (con eco) y «Password:», en vez
    /// de solo la contraseña: la forma que NO debe contestarse sola.
    pub double_prompt: bool,
    /// Si hay, pide «Verification code:» y exige el **TOTP vigente** de esta
    /// URI `otpauth://` (o el del periodo anterior, como los servidores
    /// reales, para que un cambio de periodo a mitad de test no lo tumbe).
    pub totp_uri: Option<String>,
    /// Pide el código ANTES que la contraseña: la pila PAM con
    /// `pam_google_authenticator` por delante.
    pub code_first: bool,
    /// Ante un código equivocado vuelve a preguntarlo (hasta tres veces) en
    /// vez de rechazar: el servidor que tienta a un cliente a reintentar.
    pub reask_code: bool,
}

/// Servidor en marcha. Al soltarlo se para.
pub struct KbdServer {
    pub port: u16,
    /// Huella SHA256 de la host key, para fijarla con `expect_fingerprint`
    /// (así el test no toca ningún `known_hosts`).
    pub fingerprint: String,
    password_attempts: Arc<AtomicUsize>,
    code_attempts: Arc<AtomicUsize>,
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
        let code_attempts = Arc::new(AtomicUsize::new(0));
        let codes = Arc::clone(&code_attempts);
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let handler = Handler {
                    rounds: rounds.clone(),
                    stage: Stage::Fresh,
                    password_attempts: Arc::clone(&attempts),
                    code_attempts: Arc::clone(&codes),
                    code_asked: 0,
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
            code_attempts,
            task,
        }
    }

    /// Cuántas veces intentó el cliente el método `password` (que aquí
    /// siempre se rechaza, como en un sshd sin él).
    pub fn password_attempts(&self) -> usize {
        self.password_attempts.load(Ordering::SeqCst)
    }

    /// Cuántos códigos de verificación ha recibido el servidor, buenos o
    /// malos, sumando todas las conexiones: lo que contaría un `fail2ban`.
    pub fn code_attempts(&self) -> usize {
        self.code_attempts.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Copy)]
enum Stage {
    Fresh,
    AskedPassword,
    AskedCode,
}

/// Veces que el servidor pregunta el código en una conexión con `reask_code`.
const MAX_CODE_ASKS: usize = 3;

struct Handler {
    rounds: Rounds,
    stage: Stage,
    password_attempts: Arc<AtomicUsize>,
    code_attempts: Arc<AtomicUsize>,
    /// Veces que se ha preguntado el código en esta conexión.
    code_asked: usize,
}

impl Handler {
    fn wants_code(&self) -> bool {
        self.rounds.otp.is_some() || self.rounds.totp_uri.is_some()
    }

    fn ask_code(&mut self) -> Auth {
        self.stage = Stage::AskedCode;
        self.code_asked += 1;
        partial(&[("Verification code: ", false)])
    }

    fn ask_password(&mut self) -> Auth {
        self.stage = Stage::AskedPassword;
        if self.rounds.double_prompt {
            partial(&[("Username: ", true), ("Password: ", false)])
        } else {
            partial(&[("Password: ", false)])
        }
    }

    fn code_is_right(&self, answer: Option<&String>) -> bool {
        let Some(answer) = answer else {
            return false;
        };
        if let Some(uri) = &self.rounds.totp_uri {
            let totp: keepass::db::TOTP = uri.parse().expect("URI otpauth del test");
            let now = crate::keepass_manager::unix_now().expect("reloj");
            return [now, now.saturating_sub(totp.period)]
                .iter()
                .any(|time| &totp.value_at(*time).code == answer);
        }
        self.rounds.otp.as_ref() == Some(answer)
    }
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
            Stage::Fresh => Ok(if self.rounds.code_first && self.wants_code() {
                self.ask_code()
            } else {
                self.ask_password()
            }),
            Stage::AskedPassword => {
                let expected_len = if self.rounds.double_prompt { 2 } else { 1 };
                if answers.len() != expected_len || answers.last() != Some(&self.rounds.password) {
                    self.stage = Stage::Fresh;
                    return Ok(Auth::reject());
                }
                Ok(if self.wants_code() && !self.rounds.code_first {
                    self.ask_code()
                } else {
                    Auth::Accept
                })
            }
            Stage::AskedCode => {
                self.code_attempts.fetch_add(1, Ordering::SeqCst);
                if self.code_is_right(answers.first()) {
                    return Ok(if self.rounds.code_first {
                        self.ask_password()
                    } else {
                        Auth::Accept
                    });
                }
                if self.rounds.reask_code && self.code_asked < MAX_CODE_ASKS {
                    return Ok(self.ask_code());
                }
                self.stage = Stage::Fresh;
                Ok(Auth::reject())
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
            ..Rounds::default()
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
            ..Rounds::default()
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
            double_prompt: true,
            ..Rounds::default()
        })
        .await;
        let mut handle = connect(&server).await;
        let err = auth_with_password(&mut handle, "secreta")
            .await
            .expect_err("dos preguntas van al usuario");
        assert!(err.to_string().contains("terminal"), "{err}");
    }

    // ─── Segundo factor con el TOTP de KeePass ──────────────────────────────
    //
    // El servidor exige el TOTP vigente de una semilla conocida y el cliente lo
    // saca de una base KeePass en memoria. Aquí no hay interfaz ni terminal:
    // todo lo que «va al usuario» acaba en el error que nombra la terminal, y
    // eso es justo lo que permite comprobar que NO se contestó solo.

    use crate::auth_totp::{self, Policy};
    use crate::keepass_manager::{self, testing as kp};

    /// Otra semilla válida, para el servidor que no acepta el código del
    /// cliente (el ejemplo de la documentación de KeePassXC; es pública).
    const OTHER_SEED: &str = "JBSWY3DPEHPK3PXP";

    /// Deja desbloqueada una base con una entrada y devuelve su política.
    /// `otp`: el campo `otp` de la entrada (`None` = no tiene).
    fn unlocked_policy(otp: Option<&str>, auto: bool) -> Policy {
        let mut db = keepass::Database::new();
        let entry_uuid = kp::add_entry(&mut db, "servidor", otp);
        kp::install(db);
        Policy {
            // Un perfil distinto por test: la memoria de rechazos es global.
            key: uuid::Uuid::new_v4().to_string(),
            entry_uuid,
            auto,
            pattern: None,
        }
    }

    /// Servidor que tras la contraseña exige el TOTP de `seed`.
    fn totp_rounds(seed: &str) -> Rounds {
        Rounds {
            password: "secreta".into(),
            totp_uri: Some(kp::otp_uri(seed, 6, 30)),
            ..Rounds::default()
        }
    }

    /// Como `auth_with_password`, con la política de TOTP de un perfil a la
    /// vista: lo que hacen `run_session`, el panel SFTP y cada salto.
    async fn auth_with_totp(
        server: &KbdServer,
        policy: &Policy,
    ) -> Result<AuthResult, crate::error::AppError> {
        let mut handle = connect(server).await;
        auth_totp::with_policy(
            Some(policy.clone()),
            auth_with_password(&mut handle, "secreta"),
        )
        .await
    }

    /// El caso de la tarea: contraseña y código de verificación, los dos sin
    /// que nadie teclee nada. El servidor exige el TOTP correcto de la semilla.
    #[tokio::test]
    async fn el_totp_de_keepass_contesta_solo_el_segundo_factor() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(totp_rounds(kp::RFC_SEED)).await;
        let policy = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), true);

        let auth = auth_with_totp(&server, &policy).await.expect("auth");
        keepass_manager::lock();

        assert!(matches!(auth, AuthResult::Success), "{auth:?}");
        assert_eq!(server.code_attempts(), 1, "un solo código, y el bueno");
        assert!(!auth_totp::testing::was_rejected(&policy.key));
    }

    /// `pam_google_authenticator` por delante de la contraseña: el servidor
    /// pide primero el código. Sin esta regla, la contraseña del perfil se
    /// entregaba a esa primera pregunta.
    #[tokio::test]
    async fn con_el_codigo_por_delante_la_contrasena_espera_su_ronda() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(Rounds {
            code_first: true,
            ..totp_rounds(kp::RFC_SEED)
        })
        .await;
        let policy = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), true);

        let auth = auth_with_totp(&server, &policy).await.expect("auth");
        keepass_manager::lock();

        assert!(matches!(auth, AuthResult::Success), "{auth:?}");
        assert_eq!(server.code_attempts(), 1);
    }

    /// Apagado por defecto en sus dos grados: sin política no se manda nada, y
    /// con «ofrecer» pero sin «automático» tampoco — se pregunta.
    #[tokio::test]
    async fn sin_modo_automatico_el_codigo_no_se_envia_solo() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(totp_rounds(kp::RFC_SEED)).await;
        let policy = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), false);

        let err = auth_with_totp(&server, &policy)
            .await
            .expect_err("sin automático, el código lo pone el usuario");
        assert!(err.to_string().contains("terminal"), "{err}");

        let mut handle = connect(&server).await;
        let err = auth_with_password(&mut handle, "secreta")
            .await
            .expect_err("sin política no hay TOTP de KeePass");
        keepass_manager::lock();
        assert!(err.to_string().contains("terminal"), "{err}");
        assert_eq!(server.code_attempts(), 0, "el servidor no vio ningún código");
    }

    /// Un servidor que rechaza el código y vuelve a preguntarlo no consigue un
    /// segundo intento automático: ni en ese intercambio ni en la reconexión.
    /// Es lo que separa una comodidad de un bloqueo de cuenta.
    #[tokio::test]
    async fn un_codigo_rechazado_no_se_reintenta_ni_al_reconectar() {
        let _turno = kp::exclusive().await;
        // El servidor espera el TOTP de OTRA semilla: el del cliente es malo.
        let server = KbdServer::start(Rounds {
            reask_code: true,
            ..totp_rounds(OTHER_SEED)
        })
        .await;
        let policy = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), true);

        let err = auth_with_totp(&server, &policy)
            .await
            .expect_err("la segunda pregunta va al usuario");
        assert!(err.to_string().contains("terminal"), "{err}");
        assert_eq!(server.code_attempts(), 1, "un solo intento automático");
        assert!(auth_totp::testing::was_rejected(&policy.key));

        // Reconexión (otra conexión del mismo perfil): se pregunta de entrada.
        for _ in 0..2 {
            let err = auth_with_totp(&server, &policy)
                .await
                .expect_err("tras un rechazo, el código lo pone el usuario");
            assert!(err.to_string().contains("terminal"), "{err}");
        }
        keepass_manager::lock();
        assert_eq!(server.code_attempts(), 1, "las reconexiones no suman intentos");
        auth_totp::testing::forget_rejection(&policy.key);
    }

    /// Lo mismo cuando el servidor rechaza en seco, sin volver a preguntar.
    #[tokio::test]
    async fn un_rechazo_en_seco_tambien_apaga_el_automatico() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(totp_rounds(OTHER_SEED)).await;
        let policy = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), true);

        let auth = auth_with_totp(&server, &policy).await.expect("sin error de protocolo");
        assert!(
            matches!(auth, AuthResult::Failure { partial_success: false, .. }),
            "{auth:?}"
        );
        assert_eq!(server.code_attempts(), 1);

        let err = auth_with_totp(&server, &policy)
            .await
            .expect_err("tras un rechazo, el código lo pone el usuario");
        keepass_manager::lock();
        assert!(err.to_string().contains("terminal"), "{err}");
        assert_eq!(server.code_attempts(), 1);
        auth_totp::testing::forget_rejection(&policy.key);
    }

    /// Con la base bloqueada, o con una entrada sin semilla, el automático no
    /// tiene con qué contestar: se pregunta, y al servidor no le llega nada.
    #[tokio::test]
    async fn sin_base_o_sin_semilla_se_pregunta_en_vez_de_inventar() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(totp_rounds(kp::RFC_SEED)).await;

        let sin_semilla = unlocked_policy(None, true);
        let err = auth_with_totp(&server, &sin_semilla)
            .await
            .expect_err("sin semilla no hay código");
        assert!(err.to_string().contains("terminal"), "{err}");

        let bloqueada = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), true);
        keepass_manager::lock();
        let err = auth_with_totp(&server, &bloqueada)
            .await
            .expect_err("con la base bloqueada no hay código");
        assert!(err.to_string().contains("terminal"), "{err}");

        assert_eq!(server.code_attempts(), 0);
        // No se mandó nada: no hay rechazo que recordar.
        assert!(!auth_totp::testing::was_rejected(&sin_semilla.key));
        assert!(!auth_totp::testing::was_rejected(&bloqueada.key));
    }

    // ─── El diálogo, con una interfaz de pega ───────────────────────────────
    //
    // `auth_prompt::testing::with_ui` pone en el sitio de la ventana una función
    // que recibe el evento `ssh-auth-prompt` tal como lo recibe el renderer y
    // contesta por sus mismos caminos: teclear (`resolve_prompt`) o el botón
    // «Usar código de KeePass» (`answer_with_totp`).

    use crate::auth_prompt::{self, testing::FakeUi, TotpReply};
    use crate::locks::MutexExt;
    use std::sync::Mutex;

    async fn auth_with_ui(
        server: &KbdServer,
        policy: &Policy,
        ui: FakeUi,
    ) -> Result<AuthResult, crate::error::AppError> {
        let mut handle = connect(server).await;
        auth_prompt::testing::with_ui(
            ui,
            auth_totp::with_policy(
                Some(policy.clone()),
                auth_with_password(&mut handle, "secreta"),
            ),
        )
        .await
    }

    fn prompt_id(event: &serde_json::Value) -> String {
        event["promptId"].as_str().expect("promptId").to_string()
    }

    /// El camino del botón, de punta a punta: el servidor pregunta el código,
    /// el diálogo lo ofrece, el «usuario» pulsa y el backend contesta. Por la
    /// frontera con la interfaz solo cruzan la oferta y un «enviado».
    #[tokio::test]
    async fn el_boton_del_dialogo_contesta_con_el_codigo_de_keepass() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(totp_rounds(kp::RFC_SEED)).await;
        let policy = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), false);

        let seen: Arc<Mutex<Vec<(serde_json::Value, TotpReply)>>> = Arc::default();
        let record = Arc::clone(&seen);
        let ui: FakeUi = Arc::new(move |event| {
            let reply = auth_prompt::answer_with_totp(&prompt_id(&event));
            record.lock_recover().push((event, reply));
        });

        let auth = auth_with_ui(&server, &policy, ui).await.expect("auth");
        // El código que se entregó: el de antes o el de después, por si acaso.
        let now = keepass_manager::unix_now().expect("reloj");
        let codes: Vec<String> = [now, now.saturating_sub(30)]
            .iter()
            .map(|time| keepass_manager::totp_at(&policy.entry_uuid, *time).expect("código"))
            .map(|code| code.code.to_string())
            .collect();
        keepass_manager::lock();

        assert!(matches!(auth, AuthResult::Success), "{auth:?}");
        assert_eq!(server.code_attempts(), 1);
        let seen = seen.lock_recover();
        assert_eq!(seen.len(), 1, "solo la pregunta del código llega al diálogo");
        let (event, reply) = &seen[0];
        assert_eq!(event["prompts"][0]["prompt"], "Verification code: ");
        assert_eq!(
            event["totpKeepass"],
            serde_json::json!({ "autoRejected": false, "locked": false })
        );
        assert_eq!(*reply, TotpReply::Sent);
        // Nada de lo que ve el renderer sirve para sacar el código.
        let wire = format!("{event} {}", serde_json::to_string(reply).expect("json"));
        assert!(!wire.contains(&policy.entry_uuid), "{wire}");
        assert!(!wire.contains(kp::RFC_SEED) && !wire.contains("otpauth"), "{wire}");
        assert!(codes.iter().all(|code| !wire.contains(code.as_str())), "{wire}");
    }

    /// Sin la opción del perfil, el mismo diálogo no ofrece nada y el botón,
    /// aunque alguien lo invocara, no contesta.
    #[tokio::test]
    async fn sin_la_opcion_del_perfil_el_dialogo_no_ofrece_keepass() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(totp_rounds(kp::RFC_SEED)).await;
        // La base está abierta y la entrada tiene semilla: no basta.
        let unused = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), true);

        let seen: Arc<Mutex<Vec<(serde_json::Value, TotpReply)>>> = Arc::default();
        let record = Arc::clone(&seen);
        let ui: FakeUi = Arc::new(move |event| {
            let id = prompt_id(&event);
            let reply = auth_prompt::answer_with_totp(&id);
            // Y el usuario cancela.
            assert!(auth_prompt::resolve_prompt(&id, None));
            record.lock_recover().push((event, reply));
        });

        let mut handle = connect(&server).await;
        let result =
            auth_prompt::testing::with_ui(ui, auth_with_password(&mut handle, "secreta")).await;
        keepass_manager::lock();

        assert!(result.is_err(), "cancelado: no hay autenticación");
        assert_eq!(server.code_attempts(), 0);
        let seen = seen.lock_recover();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].0["totpKeepass"].is_null());
        assert_eq!(seen[0].1, TotpReply::NotOffered);
        assert!(!auth_totp::testing::was_rejected(&unused.key));
    }

    /// Tras un rechazo del automático, que el usuario acierte tecleando el
    /// código de su móvil no lo reanuda (no dice nada de la semilla de
    /// KeePass); que acierte un código de KeePass pedido con el botón, sí.
    #[tokio::test]
    async fn tras_un_rechazo_solo_un_codigo_de_keepass_reanuda_el_automatico() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(totp_rounds(kp::RFC_SEED)).await;
        let policy = unlocked_policy(Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)), true);
        auth_totp::testing::mark_rejection(&policy.key);

        // 1. Marcado: se pregunta (avisando del rechazo) y el usuario teclea.
        let warned: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let record = Arc::clone(&warned);
        let entry = policy.entry_uuid.clone();
        let typing: FakeUi = Arc::new(move |event| {
            let now = keepass_manager::unix_now().expect("reloj");
            let code = keepass_manager::totp_at(&entry, now).expect("código");
            assert!(auth_prompt::resolve_prompt(
                &prompt_id(&event),
                Some(vec![code.code.to_string()])
            ));
            record.lock_recover().push(event);
        });
        let auth = auth_with_ui(&server, &policy, typing).await.expect("auth");
        assert!(matches!(auth, AuthResult::Success), "{auth:?}");
        assert_eq!(
            warned.lock_recover()[0]["totpKeepass"],
            serde_json::json!({ "autoRejected": true, "locked": false })
        );
        assert!(
            auth_totp::testing::was_rejected(&policy.key),
            "teclear el código no reanuda el automático"
        );

        // 2. Sigue preguntando; ahora se pulsa el botón y el servidor acepta.
        let button: FakeUi = Arc::new(|event| {
            assert_eq!(
                auth_prompt::answer_with_totp(&prompt_id(&event)),
                TotpReply::Sent
            );
        });
        let auth = auth_with_ui(&server, &policy, button).await.expect("auth");
        keepass_manager::lock();
        assert!(matches!(auth, AuthResult::Success), "{auth:?}");
        assert_eq!(server.code_attempts(), 2);
        assert!(
            !auth_totp::testing::was_rejected(&policy.key),
            "un código de KeePass aceptado reanuda el automático"
        );
    }

    /// Con la base bloqueada el modo automático no puede contestar: se
    /// pregunta diciendo por qué, el botón responde «bloqueada» sin gastar la
    /// pregunta y, desbloqueada la base, el mismo botón ya contesta.
    #[tokio::test]
    async fn con_la_base_bloqueada_el_dialogo_lo_dice_y_espera_al_desbloqueo() {
        let _turno = kp::exclusive().await;
        let server = KbdServer::start(totp_rounds(kp::RFC_SEED)).await;
        let mut db = keepass::Database::new();
        let entry_uuid = kp::add_entry(&mut db, "servidor", Some(&kp::otp_uri(kp::RFC_SEED, 6, 30)));
        let policy = Policy {
            key: uuid::Uuid::new_v4().to_string(),
            entry_uuid,
            auto: true,
            pattern: None,
        };
        keepass_manager::lock();

        let seen: Arc<Mutex<Vec<(serde_json::Value, TotpReply, TotpReply)>>> = Arc::default();
        let record = Arc::clone(&seen);
        let ui: FakeUi = Arc::new(move |event| {
            let id = prompt_id(&event);
            let while_locked = auth_prompt::answer_with_totp(&id);
            // El usuario desbloquea la base desde el diálogo y vuelve a pulsar.
            kp::install(db.clone());
            let once_unlocked = auth_prompt::answer_with_totp(&id);
            record.lock_recover().push((event, while_locked, once_unlocked));
        });

        let auth = auth_with_ui(&server, &policy, ui).await.expect("auth");
        keepass_manager::lock();

        assert!(matches!(auth, AuthResult::Success), "{auth:?}");
        assert_eq!(server.code_attempts(), 1, "bloqueada no se mandó nada");
        let seen = seen.lock_recover();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].0["totpKeepass"],
            serde_json::json!({ "autoRejected": false, "locked": true })
        );
        assert_eq!(seen[0].1, TotpReply::Locked);
        assert_eq!(seen[0].2, TotpReply::Sent);
        assert!(!auth_totp::testing::was_rejected(&policy.key));
    }
}
