use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::atomic_file::Recovery;
use crate::error::AppError;
use crate::locks::MutexExt;
use crate::store_file;

/// Tipo de autenticación SSH soportado
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    /// Autenticación por contraseña
    Password,
    /// Autenticación por clave pública/privada
    PublicKey,
    /// Autenticación delegada al agente SSH del sistema
    Agent,
}

/// Origen de la contraseña del perfil. Reemplaza la inferencia implícita
/// histórica (que miraba solo `keepass_entry_uuid`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PasswordSource {
    /// Contraseña propia del perfil (keyring `password:<id>` o introducida en
    /// el formulario). Comportamiento histórico por defecto.
    #[default]
    Own,
    /// La contraseña se resuelve desde una credencial maestra del catálogo.
    Master,
    /// La contraseña se resuelve desde una entrada KeePass (vía
    /// `keepass_entry_uuid` / `keepass_property`).
    Keepass,
}

fn default_conn_type() -> String {
    "ssh".to_string()
}

fn default_auth_password() -> AuthType {
    AuthType::Password
}

fn default_true() -> bool {
    true
}

fn default_workspace_id() -> String {
    "default".to_string()
}

/// Tipo de túnel SSH persistido en un perfil.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SshTunnelType {
    /// Equivalente a `ssh -L local_port:remote_host:remote_port`.
    Local,
    /// Equivalente a `ssh -R remote_port:local_host:local_port`.
    Remote,
    /// Equivalente a `ssh -D local_port` (SOCKS5 local).
    Dynamic,
}

/// Configuración de redirección de puertos asociada a un perfil.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnelProfile {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub tunnel_type: SshTunnelType,
    #[serde(default)]
    pub bind_host: Option<String>,
    pub local_port: u16,
    #[serde(default)]
    pub remote_host: Option<String>,
    #[serde(default)]
    pub remote_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
}

/// Identidad adicional (usuario + contraseña) de un perfil. La identidad
/// principal sigue siendo `ConnectionProfile.username` + su contraseña; estas
/// son alternativas que el usuario puede elegir con «Conectar con otro usuario».
/// La contraseña nunca se guarda aquí: vive en el keyring bajo la clave
/// `password:<profile_id>:<credential_id>` (origen `own`), o se resuelve desde
/// una credencial maestra cuando `password_source == Master`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileCredential {
    /// UUID estable. Deriva las claves de keyring
    /// `password:<profile_id>:<id>` y `passphrase:<profile_id>:<id>`.
    pub id: String,
    /// Nombre de usuario de esta identidad.
    pub username: String,
    /// Etiqueta opcional para el menú; si falta se muestra el `username`.
    #[serde(default)]
    pub label: Option<String>,
    /// Método de autenticación de esta identidad. Default `password`.
    #[serde(default = "default_auth_password")]
    pub auth_type: AuthType,
    /// Ruta a la clave privada cuando `auth_type == PublicKey`.
    #[serde(default)]
    pub key_path: Option<String>,
    /// Origen de la contraseña de esta identidad. Default `own`.
    #[serde(default)]
    pub password_source: PasswordSource,
    /// Id de la credencial maestra cuando `password_source == Master`.
    #[serde(default)]
    pub master_credential_id: Option<String>,
}

/// Perfil de conexión guardado por el usuario.
/// Soporta SSH, RDP y transferencia FTP/FTPS. No almacena contraseñas en texto
/// plano; usa keyring.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    /// UUID único del perfil
    pub id: String,
    /// Nombre descriptivo visible en la UI
    pub name: String,
    /// Hostname o IP del servidor remoto
    pub host: String,
    /// Puerto (SSH: 22, RDP: 3389, FTP/FTPS explícito: 21 por defecto)
    pub port: u16,
    /// Nombre de usuario
    pub username: String,
    /// Tipo de conexión: "ssh" | "rdp" | "ftp" | "ftps"
    #[serde(default = "default_conn_type")]
    pub connection_type: String,
    /// Dominio Windows (solo RDP)
    pub domain: Option<String>,
    /// Método de autenticación (SSH)
    pub auth_type: AuthType,
    /// Ruta al archivo de clave privada (solo para AuthType::PublicKey)
    pub key_path: Option<String>,
    /// Grupo o etiqueta para organizar conexiones
    pub group: Option<String>,
    /// Notas libres del usuario sobre el perfil (comandos frecuentes,
    /// responsables, rutas, recordatorios). No debe contener secretos.
    #[serde(default)]
    pub notes: Option<String>,
    /// Identificador del perfil-contenedor (workspace) al que pertenece.
    /// Por defecto "default" para no romper perfiles previos a la feature.
    #[serde(default = "default_workspace_id")]
    pub workspace_id: String,
    /// UUID de la entrada KeePass cuya contraseña se usará en vez del keyring.
    /// Solo aplica cuando `auth_type == Password` y la DB está desbloqueada.
    #[serde(default)]
    pub keepass_entry_uuid: Option<String>,
    /// Propiedad de la entrada KeePass a resolver (`password` por defecto).
    /// Permite usar `username`/`title`/`url`/`notes` como valor del campo.
    #[serde(default)]
    pub keepass_property: Option<String>,
    /// Origen de la contraseña. Default `own` para compatibilidad. Ver la
    /// migración en `load_all` para perfiles KeePass antiguos.
    #[serde(default)]
    pub password_source: PasswordSource,
    /// Id de la credencial maestra a usar cuando `password_source == Master`.
    /// Referencia `CredentialMeta.id` del catálogo `credentials.json`.
    #[serde(default)]
    pub master_credential_id: Option<String>,
    /// Identidades adicionales (usuario + contraseña) seleccionables al conectar
    /// con «Conectar con otro usuario». La principal es `username`. Vacío por
    /// defecto para no romper perfiles previos a la feature.
    #[serde(default)]
    pub extra_credentials: Vec<ProfileCredential>,
    /// Si true, inyecta el hook OSC 7 tras conectar para que el panel SFTP
    /// pueda seguir el cwd del terminal. Solo aplica a conexiones SSH.
    #[serde(default = "default_true")]
    pub follow_cwd: bool,
    /// Intervalo en segundos para enviar keepalives al servidor SSH.
    /// `None` o `0` deshabilita el keepalive. Útil contra caídas por NAT.
    #[serde(default)]
    pub keep_alive_secs: Option<u32>,
    /// Umbral en segundos, propio de este perfil, del aviso de fin de comando
    /// largo (OSC 133). `None` = usar el umbral global de Preferencias.
    #[serde(default)]
    pub cmd_notify_secs: Option<u32>,
    /// Si true, extiende las listas de algoritmos preferidos con variantes
    /// legacy (aes-cbc, 3des-cbc, dh-sha1, hmac-sha1, ssh-rsa) para poder
    /// conectar con servidores antiguos. Reduce la seguridad. Actúa como
    /// interruptor maestro: si está desactivado, `legacy_algorithms` se ignora.
    #[serde(default)]
    pub allow_legacy_algorithms: bool,
    /// Selección granular de algoritmos legacy a ofrecer cuando
    /// `allow_legacy_algorithms` está activo. Cada entrada es el nombre wire de
    /// un algoritmo del catálogo (p. ej. `hmac-sha1`, `aes256-cbc`, `ssh-rsa`).
    /// `None` = todos los del catálogo (compat con perfiles antiguos y cubre
    /// algoritmos que se añadan en el futuro); `Some(lista)` = exactamente esos.
    #[serde(default)]
    pub legacy_algorithms: Option<Vec<String>>,
    /// Si true, permite reenviar el agente SSH local hacia la sesión remota.
    #[serde(default)]
    pub agent_forwarding: bool,
    /// Si true, solicita X11 forwarding al servidor. Requiere un X server
    /// local escuchando en `localhost:6000` (DISPLAY=:0).
    #[serde(default)]
    pub x11_forwarding: bool,
    /// Si > 0, intenta reconectar automáticamente al caer la conexión SSH.
    /// El backend reintenta hasta `auto_reconnect` veces con backoff
    /// exponencial (2s, 4s, 8s, …). 0 / None = desactivado.
    #[serde(default)]
    pub auto_reconnect: Option<u32>,
    /// Bastion / jump host (ProxyJump). Formato `[user@]host[:port]`.
    /// Si está presente, primero se conecta al bastion vía SSH, se abre un
    /// canal `direct-tcpip` al host destino y la sesión SSH del target se
    /// realiza sobre ese stream tunelizado. Para autenticar el bastion se
    /// reutilizan las credenciales del perfil (mismo `auth_type`,
    /// `key_path`, `password`, `passphrase`) — la mayoría de despliegues
    /// usan la misma clave en bastion y destino.
    #[serde(default)]
    pub proxy_jump: Option<String>,
    /// Wake On LAN opcional: MAC destino y parámetros UDP.
    #[serde(default)]
    pub mac_address: Option<String>,
    #[serde(default)]
    pub wol_broadcast: Option<String>,
    #[serde(default)]
    pub wol_port: Option<u16>,
    /// Si true, vuelca toda la salida del shell SSH a un fichero de log
    /// dentro de `session_log_dir` (o, si no se indica, en
    /// `<data_dir>/session_logs/`). Útil para auditoría y depuración.
    #[serde(default)]
    pub session_log: bool,
    /// Carpeta personalizada para los logs de sesión. Si está vacía se usa
    /// `<data_dir>/session_logs/<perfil>/<timestamp>.log`.
    #[serde(default)]
    pub session_log_dir: Option<String>,
    /// Si true, este perfil omite la confirmación de pegado peligroso
    /// (multilínea / muy largo / caracteres de control) aunque la preferencia
    /// global `confirmRiskyPaste` esté activa. Excepción explícita por perfil.
    #[serde(default)]
    pub disable_paste_confirm: bool,
    /// Túneles SSH guardados para este perfil. Si `auto_start` está activo,
    /// el frontend los levanta al establecer la sesión interactiva.
    #[serde(default)]
    pub ssh_tunnels: Vec<SshTunnelProfile>,
    /// Cómo abre la ventana el cliente RDP de este perfil. `None` = usar la
    /// preferencia global; ver `rdp_manager::RdpDisplay` para los valores.
    #[serde(default)]
    pub rdp_display: Option<String>,
    /// Timestamp ISO 8601 de creación
    pub created_at: String,
    /// Timestamp ISO 8601 de la última modificación. Usado por la
    /// sincronización en la nube para resolver conflictos last-write-wins.
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Nombre del store en el envelope versionado (`store_file`).
const KIND: &str = "profiles";

/// Gestor de perfiles de conexión.
/// Persiste los perfiles en un archivo JSON en el directorio de datos de la app.
pub struct ProfileManager {
    profiles_path: PathBuf,
    /// Resultado de la última carga: si el store estaba dañado, el frontend lo
    /// consulta al arrancar (`profiles_recovery`) para avisar al usuario.
    recovery: Mutex<Recovery>,
    /// Lock de transacción del store. Toda mutación es un ciclo
    /// leer→modificar→reescribir el fichero **entero**, y los comandos Tauri
    /// corren en un pool de hilos: sin este lock, dos borrados concurrentes leen
    /// la misma lista y el último en escribir **resucita** lo que borró el otro
    /// (el borrado múltiple de la UI lanzaba justo eso, un `Promise.all` de N
    /// `delete_profile`). No lo toma `load_all`: los lectores no necesitan
    /// exclusión, porque la escritura es atómica y ven o el antes o el después.
    tx: Mutex<()>,
}

impl ProfileManager {
    pub fn new(data_dir: PathBuf) -> Self {
        ProfileManager {
            profiles_path: data_dir.join("profiles.json"),
            recovery: Mutex::new(Recovery::Missing),
            tx: Mutex::new(()),
        }
    }

    /// Qué hizo falta para leer el store en la última carga (ver [`Recovery`]).
    pub fn last_recovery(&self) -> Recovery {
        self.recovery.lock_recover().clone()
    }

    /// Carga todos los perfiles del disco, **recuperando** el store si está
    /// dañado (ver [`crate::atomic_file::read_or_recover`]): un `profiles.json`
    /// que no parsea se pone en cuarentena y se restaura la última copia válida,
    /// en vez de abortar la carga o presentar un catálogo vacío.
    ///
    /// El estado de la recuperación se consulta con [`Self::last_recovery`]: el
    /// frontend lo lee al arrancar para avisar al usuario. Un `Lost` **no** se
    /// puede callar: el siguiente guardado escribiría encima de la nada.
    pub fn load_all(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        let (mut profiles, recovery) =
            store_file::read::<ConnectionProfile>(&self.profiles_path, KIND, true)?;
        *self.recovery.lock_recover() = recovery;

        // Migración idempotente (en memoria; se persiste al primer save): un
        // perfil KeePass antiguo trae `keepass_entry_uuid` pero `password_source`
        // por defecto `Own`. Lo reinterpretamos como `Keepass`. No tocamos los
        // perfiles que ya declaren un `password_source` explícito.
        for profile in &mut profiles {
            if profile.password_source == PasswordSource::Own
                && profile
                    .keepass_entry_uuid
                    .as_deref()
                    .is_some_and(|s| !s.is_empty())
            {
                profile.password_source = PasswordSource::Keepass;
            }
        }
        Ok(profiles)
    }

    /// Guarda o actualiza un perfil (upsert por id).
    pub fn save(&self, profile: ConnectionProfile) -> Result<(), AppError> {
        self.save_many(vec![profile])
    }

    /// Guarda o actualiza **varios** perfiles en una sola transacción: una lectura,
    /// una escritura, un único cambio observable. Es lo que necesitan el import de
    /// otros clientes y la sincronización, que antes hacían N `save` sueltos —N
    /// reescrituras del fichero entero, y una interrupción a mitad dejaba el
    /// catálogo con media importación aplicada.
    pub fn save_many(&self, incoming: Vec<ConnectionProfile>) -> Result<(), AppError> {
        if incoming.is_empty() {
            return Ok(());
        }
        let _tx = self.tx.lock_recover();
        let mut profiles = self.load_all()?;
        for profile in incoming {
            match profiles.iter().position(|p| p.id == profile.id) {
                Some(idx) => profiles[idx] = profile,
                None => profiles.push(profile),
            }
        }
        self.write_all(&profiles)
    }

    /// Elimina perfiles en una sola transacción y devuelve los que existían de
    /// verdad. Es el **único** camino de borrado (el comando de perfil único
    /// delega aquí con una lista de uno).
    ///
    /// Devolverlos no es un extra: el llamador necesita sus datos para limpiar las
    /// claves de keyring derivadas, y leerlos *fuera* de la transacción sería
    /// volver a abrir la carrera que este método cierra.
    pub fn delete_many(&self, ids: &[String]) -> Result<Vec<ConnectionProfile>, AppError> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let _tx = self.tx.lock_recover();
        let profiles = self.load_all()?;
        let (removed, kept): (Vec<_>, Vec<_>) =
            profiles.into_iter().partition(|p| ids.contains(&p.id));
        if removed.is_empty() {
            return Ok(vec![]);
        }
        self.write_all(&kept)?;
        Ok(removed)
    }

    fn write_all(&self, profiles: &[ConnectionProfile]) -> Result<(), AppError> {
        // Escritura atómica + 0600 y envelope versionado: el almacén de conexiones
        // nunca queda a medias ante un crash, ni legible por otros usuarios, ni sin
        // declarar en qué formato está.
        store_file::write(&self.profiles_path, KIND, profiles, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // JSON mínimo de un perfil SSH SIN el campo `workspace_id` (como los
    // perfiles previos a la feature de workspaces). El resto de campos con
    // `#[serde(default)]` deben rellenarse solos.
    const JSON_SIN_WORKSPACE: &str = r#"{
        "id": "abc-123",
        "name": "Servidor de prueba",
        "host": "example.com",
        "port": 22,
        "username": "root",
        "domain": null,
        "auth_type": "password",
        "key_path": null,
        "group": null,
        "created_at": "2026-05-08T12:00:00Z"
    }"#;

    #[test]
    fn deserializar_sin_workspace_id_usa_el_valor_por_defecto() {
        let perfil: ConnectionProfile =
            serde_json::from_str(JSON_SIN_WORKSPACE).expect("JSON válido");
        assert_eq!(perfil.workspace_id, "default");
        // Otros defaults comprobados de paso.
        assert_eq!(perfil.connection_type, "ssh");
        assert!(perfil.follow_cwd);
        assert_eq!(perfil.auth_type, AuthType::Password);
    }

    #[test]
    fn round_trip_conserva_los_campos() {
        let perfil: ConnectionProfile =
            serde_json::from_str(JSON_SIN_WORKSPACE).expect("JSON válido");

        let serializado = serde_json::to_string(&perfil).expect("serializa");
        let de_vuelta: ConnectionProfile = serde_json::from_str(&serializado).expect("deserializa");

        assert_eq!(de_vuelta.id, perfil.id);
        assert_eq!(de_vuelta.name, perfil.name);
        assert_eq!(de_vuelta.host, perfil.host);
        assert_eq!(de_vuelta.port, perfil.port);
        assert_eq!(de_vuelta.username, perfil.username);
        assert_eq!(de_vuelta.workspace_id, perfil.workspace_id);
        assert_eq!(de_vuelta.auth_type, perfil.auth_type);
        assert_eq!(de_vuelta.created_at, perfil.created_at);
    }

    #[test]
    fn password_source_por_defecto_es_own() {
        let perfil: ConnectionProfile =
            serde_json::from_str(JSON_SIN_WORKSPACE).expect("JSON válido");
        assert_eq!(perfil.password_source, PasswordSource::Own);
        assert!(perfil.master_credential_id.is_none());
    }

    #[test]
    fn migracion_keepass_antiguo_a_keepass() {
        // Perfil KeePass antiguo: tiene keepass_entry_uuid pero sin
        // password_source → load_all debe reinterpretarlo como Keepass.
        let dir = std::env::temp_dir().join(format!("rustty-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("profiles.json");
        let json = r#"[{
            "id": "kp-1",
            "name": "KeePass viejo",
            "host": "h",
            "port": 22,
            "username": "u",
            "domain": null,
            "auth_type": "password",
            "key_path": null,
            "group": null,
            "keepass_entry_uuid": "ABCDEF",
            "created_at": "2026-05-08T12:00:00Z"
        }]"#;
        std::fs::write(&path, json).unwrap();
        let mgr = ProfileManager::new(dir.clone());
        let perfiles = mgr.load_all().expect("carga");
        assert_eq!(perfiles[0].password_source, PasswordSource::Keepass);

        // Idempotente: un perfil que ya declara own y sin keepass se queda own.
        let json2 = json.replace("\"keepass_entry_uuid\": \"ABCDEF\",", "");
        std::fs::write(&path, json2).unwrap();
        let perfiles = mgr.load_all().expect("carga");
        assert_eq!(perfiles[0].password_source, PasswordSource::Own);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn perfil(id: &str) -> ConnectionProfile {
        let json = JSON_SIN_WORKSPACE.replace("abc-123", id);
        serde_json::from_str(&json).expect("JSON válido")
    }

    fn manager() -> (ProfileManager, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("rustty-pm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (ProfileManager::new(dir.clone()), dir)
    }

    #[test]
    fn el_borrado_en_lote_no_resucita_perfiles() {
        // El bug que cierra el lock: la UI borraba N perfiles con N comandos
        // concurrentes; cada uno leía la lista completa y la reescribía, así que
        // el último en escribir devolvía a la vida lo que los otros habían
        // borrado. En una sola transacción eso no puede pasar.
        let (mgr, dir) = manager();
        for id in ["a", "b", "c", "d"] {
            mgr.save(perfil(id)).expect("guarda");
        }
        assert_eq!(mgr.load_all().unwrap().len(), 4);

        let borrados = mgr
            .delete_many(&["a".to_string(), "c".to_string()])
            .expect("borra en lote");
        assert_eq!(borrados.len(), 2, "devuelve los que existían de verdad");

        let quedan: Vec<String> = mgr.load_all().unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(quedan, vec!["b".to_string(), "d".to_string()]);

        // Borrar ids inexistentes no falla ni toca el store (idempotente).
        assert!(mgr.delete_many(&["zz".to_string()]).unwrap().is_empty());
        assert_eq!(mgr.load_all().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_guardado_en_lote_es_una_sola_transaccion() {
        let (mgr, dir) = manager();
        mgr.save(perfil("a")).expect("guarda");

        // Un lote con un perfil existente (update) y dos nuevos (insert).
        let mut actualizado = perfil("a");
        actualizado.name = "Renombrado".into();
        mgr.save_many(vec![actualizado, perfil("b"), perfil("c")])
            .expect("guarda el lote");

        let perfiles = mgr.load_all().unwrap();
        assert_eq!(perfiles.len(), 3, "no duplica el que ya existía");
        assert_eq!(perfiles[0].name, "Renombrado");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn las_escrituras_concurrentes_no_se_pisan() {
        // Diez hilos guardando a la vez sobre el mismo store: sin el lock de
        // transacción, unos cuantos se perderían (todos leen la misma lista y el
        // último gana). Con él, los diez sobreviven.
        let (mgr, dir) = manager();
        let mgr = std::sync::Arc::new(mgr);
        let hilos: Vec<_> = (0..10)
            .map(|i| {
                let mgr = std::sync::Arc::clone(&mgr);
                std::thread::spawn(move || mgr.save(perfil(&format!("p{i}"))).expect("guarda"))
            })
            .collect();
        for h in hilos {
            h.join().expect("hilo sin pánico");
        }
        assert_eq!(mgr.load_all().unwrap().len(), 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_store_se_escribe_con_envelope_versionado() {
        let (mgr, dir) = manager();
        mgr.save(perfil("a")).expect("guarda");
        let texto = std::fs::read_to_string(dir.join("profiles.json")).unwrap();
        assert_eq!(
            crate::store_file::shape_of(&texto),
            Some(crate::store_file::Shape::Versioned(
                crate::store_file::CURRENT_VERSION
            ))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_id_explicito_se_respeta() {
        // Si el JSON sí trae workspace_id, no debe sobrescribirse con el default.
        let json = JSON_SIN_WORKSPACE.replace(
            "\"created_at\": \"2026-05-08T12:00:00Z\"",
            "\"workspace_id\": \"trabajo\",\n        \"created_at\": \"2026-05-08T12:00:00Z\"",
        );
        let perfil: ConnectionProfile = serde_json::from_str(&json).expect("JSON válido");
        assert_eq!(perfil.workspace_id, "trabajo");
    }
}
