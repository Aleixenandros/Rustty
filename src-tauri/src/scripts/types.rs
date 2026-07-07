//! Modelos serde del motor de scripts (recetas interactivas por host).
//!
//! Todos los nombres viajan en **camelCase estricto** para cuadrar con el
//! frontend. Ningún tipo guarda secretos: los pasos de contraseña llevan solo
//! **referencias** (`profileId` del keyring o `uuid` de KeePass), nunca el valor.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Tope de pasos por receta. Espejo de `MAX_STEPS` en
/// `src/modules/scripts/model.js`; la línea roja del producto son recetas
/// pequeñas, no orquestación tipo Ansible.
pub const MAX_STEPS: usize = 50;

/// Tope de ejecuciones guardadas en el historial `script_runs.json`. El resto
/// se descarta al guardar una nueva (las más recientes primero).
pub const MAX_RUN_HISTORY: usize = 30;

/// Un script guardado: nombre, descripción (Markdown), objetivo y la lista
/// ordenada de pasos. `createdAt`/`updatedAt` son ISO 8601.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub id: String,
    pub name: String,
    /// Descripción libre en Markdown (opcional).
    #[serde(default)]
    pub description: Option<String>,
    /// Objetivo por defecto del script (el frontend puede resolverlo a ids).
    pub target: TargetSpec,
    /// Pasos en orden de ejecución.
    #[serde(default)]
    pub steps: Vec<Step>,
    pub created_at: String,
    pub updated_at: String,
}

/// Objetivo de un script. `tag = "kind"`: `profile` | `folder` | `adhoc`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TargetSpec {
    /// Un único perfil por id.
    Profile { profile_id: String },
    /// Todos los perfiles de una carpeta (`group`) dentro de un workspace.
    Folder {
        workspace_id: String,
        folder_path: String,
        recursive: bool,
    },
    /// Lista explícita de ids de perfil.
    Adhoc { profile_ids: Vec<String> },
}

/// Un paso del script. `tag = "type"`, variantes y campos en camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Step {
    /// Envía `text` (resolviendo `${...}`) + salto de línea por el canal.
    Send { text: String },
    /// Espera el fin del último comando (marcador único) y captura su exit code.
    WaitPrompt,
    /// Lee hasta que la salida acumulada casa `pattern` o vence `timeoutMs`.
    WaitRegex { pattern: String, timeout_ms: u64 },
    /// Comprueba el exit code capturado por el último `waitPrompt`.
    ExpectExit { code: i32 },
    /// Envía la contraseña del keyring (`password:<profileId>`; `null` = la del
    /// host). Nunca se registra ni se emite en eventos.
    SendPasswordFromKeyring { profile_id: Option<String> },
    /// Envía la contraseña de una entrada KeePass (requiere DB desbloqueada).
    SendPasswordFromKeepass { uuid: String },
    /// Pausa `ms` milisegundos.
    Sleep { ms: u64 },
    /// Cierra el canal/conexión de este host.
    Disconnect,
}

/// Modo de fan-out del run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunMode {
    /// Todos los hosts a la vez (con `concurrency` máximo en vuelo).
    Parallel,
    /// Primero un host solo; si termina OK, sigue con el resto.
    Canary,
}

/// Credenciales alternativas de un run: en lugar de las de cada perfil, todas
/// las conexiones del fan-out se autentican con este usuario/contraseña.
/// **Nunca se persiste en `scripts.json`**: viaja solo en las opciones del run
/// (la variante `manual` vive únicamente en memoria durante la ejecución).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunCredentials {
    /// Credencial maestra del catálogo (por id); el valor vive en el keyring.
    Master {
        id: String,
        username: Option<String>,
    },
    /// Entrada KeePass (requiere DB desbloqueada). Si `username` viene vacío se
    /// usa el usuario de la propia entrada.
    Keepass {
        uuid: String,
        username: Option<String>,
    },
    /// Usuario/contraseña introducidos al lanzar el run.
    Manual {
        username: Option<String>,
        password: String,
    },
}

/// Opciones de una ejecución. `params` alimenta el motor de sustitución de los
/// `send` (se inyectan como respuestas a `${ask:nombre}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
    pub concurrency: u32,
    pub mode: RunMode,
    pub stop_on_error: bool,
    #[serde(default)]
    pub params: HashMap<String, String>,
    /// Credenciales alternativas para todos los hosts del run (opcional).
    #[serde(default)]
    pub credentials: Option<RunCredentials>,
}

/// Previsualización de un host: qué comandos se ejecutarían (con los secretos
/// redactados). No envía nada.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPreview {
    pub profile_id: String,
    pub host: String,
    pub name: String,
    pub commands: Vec<String>,
}

/// Registro persistido de una ejecución pasada (historial «Ejecuciones
/// recientes»). Lo construye el frontend con datos **ya redactados** (toda la
/// salida emitida pasó por `subst::redact_secrets`) y lo persiste el backend en
/// `script_runs.json`. No contiene contraseñas: solo referencias y salida ya
/// redactada. El fichero se escribe en privado (0600) porque la salida de los
/// comandos puede ser sensible aunque no lleve secretos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub script_id: String,
    pub script_name: String,
    pub started_at: String,
    pub finished_at: String,
    pub mode: String,
    pub ok_count: u32,
    pub error_count: u32,
    pub total: u32,
    #[serde(default)]
    pub hosts: Vec<RunHostRecord>,
}

/// Estado final de un host en una ejecución guardada.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHostRecord {
    pub profile_id: String,
    pub name: String,
    /// `ok` | `error` | `pending` | `running`… (el mismo del estado de la UI).
    pub status: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub log: Vec<RunLogEntry>,
    /// Salida ya saneada y redactada (acotada por el frontend).
    #[serde(default)]
    pub output: String,
}

/// Una línea del registro de ejecución de un host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogEntry {
    pub kind: String,
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_script_completo() {
        let json = r#"{
            "id": "s1",
            "name": "Reinicio nginx",
            "description": "Reinicia **nginx**",
            "target": { "kind": "adhoc", "profileIds": ["p1", "p2"] },
            "steps": [
                { "type": "send", "text": "sudo systemctl restart nginx" },
                { "type": "sendPasswordFromKeyring", "profileId": null },
                { "type": "waitPrompt" },
                { "type": "expectExit", "code": 0 },
                { "type": "waitRegex", "pattern": "active \\(running\\)", "timeoutMs": 5000 },
                { "type": "sleep", "ms": 250 },
                { "type": "disconnect" }
            ],
            "createdAt": "2026-07-04T10:00:00Z",
            "updatedAt": "2026-07-04T10:00:00Z"
        }"#;

        let script: Script = serde_json::from_str(json).expect("parsea");
        assert_eq!(script.id, "s1");
        assert_eq!(script.steps.len(), 7);
        assert_eq!(
            script.target,
            TargetSpec::Adhoc {
                profile_ids: vec!["p1".into(), "p2".into()]
            }
        );
        assert_eq!(
            script.steps[0],
            Step::Send {
                text: "sudo systemctl restart nginx".into()
            }
        );
        assert_eq!(
            script.steps[1],
            Step::SendPasswordFromKeyring { profile_id: None }
        );
        assert_eq!(script.steps[2], Step::WaitPrompt);
        assert_eq!(script.steps[3], Step::ExpectExit { code: 0 });
        assert_eq!(
            script.steps[4],
            Step::WaitRegex {
                pattern: "active \\(running\\)".into(),
                timeout_ms: 5000
            }
        );
        assert_eq!(script.steps[5], Step::Sleep { ms: 250 });
        assert_eq!(script.steps[6], Step::Disconnect);

        // Round-trip: re-serializar y volver a parsear conserva todo.
        let back = serde_json::to_string(&script).expect("serializa");
        let again: Script = serde_json::from_str(&back).expect("reparsea");
        assert_eq!(script, again);
    }

    #[test]
    fn target_spec_serializa_en_camelcase() {
        let folder = TargetSpec::Folder {
            workspace_id: "ws1".into(),
            folder_path: "prod/web".into(),
            recursive: true,
        };
        let v = serde_json::to_value(&folder).unwrap();
        assert_eq!(v["kind"], "folder");
        assert_eq!(v["workspaceId"], "ws1");
        assert_eq!(v["folderPath"], "prod/web");
        assert_eq!(v["recursive"], true);

        let profile = TargetSpec::Profile {
            profile_id: "p9".into(),
        };
        let v = serde_json::to_value(&profile).unwrap();
        assert_eq!(v["kind"], "profile");
        assert_eq!(v["profileId"], "p9");
    }

    #[test]
    fn step_password_keyring_serializa_referencia_no_valor() {
        // El paso de contraseña SOLO lleva la referencia; nunca un valor.
        let step = Step::SendPasswordFromKeyring {
            profile_id: Some("p1".into()),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["type"], "sendPasswordFromKeyring");
        assert_eq!(v["profileId"], "p1");
        assert!(v.get("password").is_none());
        assert!(v.get("secret").is_none());

        let step = Step::SendPasswordFromKeepass {
            uuid: "ABCD".into(),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["type"], "sendPasswordFromKeepass");
        assert_eq!(v["uuid"], "ABCD");
    }

    #[test]
    fn run_options_camelcase() {
        let json = r#"{ "concurrency": 4, "mode": "canary", "stopOnError": true,
                        "params": { "svc": "nginx" } }"#;
        let opts: RunOptions = serde_json::from_str(json).expect("parsea");
        assert_eq!(opts.concurrency, 4);
        assert_eq!(opts.mode, RunMode::Canary);
        assert!(opts.stop_on_error);
        assert_eq!(opts.params.get("svc").map(String::as_str), Some("nginx"));
        // Sin el campo `credentials`, el run usa las credenciales del perfil.
        assert!(opts.credentials.is_none());
    }

    #[test]
    fn run_credentials_camelcase() {
        let json = r#"{ "concurrency": 1, "mode": "parallel", "stopOnError": false,
                        "credentials": { "kind": "master", "id": "c1", "username": "root" } }"#;
        let opts: RunOptions = serde_json::from_str(json).expect("parsea");
        assert!(matches!(
            opts.credentials,
            Some(RunCredentials::Master { ref id, ref username })
                if id == "c1" && username.as_deref() == Some("root")
        ));

        let json = r#"{ "kind": "keepass", "uuid": "AB12", "username": null }"#;
        let c: RunCredentials = serde_json::from_str(json).expect("parsea");
        assert!(matches!(
            c,
            RunCredentials::Keepass { ref uuid, ref username }
                if uuid == "AB12" && username.is_none()
        ));

        let c = RunCredentials::Manual {
            username: Some("ops".into()),
            password: "s3cr3t".into(),
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["kind"], "manual");
        assert_eq!(v["username"], "ops");
    }

    #[test]
    fn waitprompt_y_disconnect_son_variantes_unit() {
        assert_eq!(
            serde_json::to_value(Step::WaitPrompt).unwrap(),
            serde_json::json!({ "type": "waitPrompt" })
        );
        assert_eq!(
            serde_json::to_value(Step::Disconnect).unwrap(),
            serde_json::json!({ "type": "disconnect" })
        );
    }
}
