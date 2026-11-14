use std::fs::File;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use keepass::db::{Entry, EntryId, EntryRef, GroupRef, TOTP};
use keepass::{Database, DatabaseKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::AppError;
use crate::locks::MutexExt;

static UNLOCKED: Mutex<Option<UnlockedDb>> = Mutex::new(None);

struct UnlockedDb {
    db: Database,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntrySummary {
    pub uuid: String,
    pub title: String,
    pub username: String,
    pub url: String,
    pub group: String,
    pub has_password: bool,
    pub has_notes: bool,
    /// La entrada trae algo en el campo `otp` (la semilla TOTP de KeePassXC).
    /// Solo dice que existe: ni la URI ni la semilla salen de este módulo.
    pub has_totp: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeepassStatus {
    pub unlocked: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryProperty {
    Password,
    Username,
    Title,
    Url,
    Notes,
}

impl EntryProperty {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "password" => Some(Self::Password),
            "username" | "user" => Some(Self::Username),
            "title" => Some(Self::Title),
            "url" => Some(Self::Url),
            "notes" | "note" => Some(Self::Notes),
            _ => None,
        }
    }
}

pub fn unlock(
    path: &str,
    password: Option<&str>,
    keyfile_path: Option<&str>,
) -> Result<(), AppError> {
    let mut file = File::open(path)?;

    let mut key = DatabaseKey::new();
    if let Some(pw) = password {
        if !pw.is_empty() {
            key = key.with_password(pw);
        }
    }
    if let Some(kp) = keyfile_path {
        if !kp.is_empty() {
            let mut kf = File::open(kp)?;
            key = key
                .with_keyfile(&mut kf)
                .map_err(|e| AppError::Io(e.to_string()))?;
        }
    }

    let db = Database::open(&mut file, key).map_err(|e| AppError::Auth(e.to_string()))?;

    *UNLOCKED.lock_recover() = Some(UnlockedDb {
        db,
        path: path.to_string(),
    });
    Ok(())
}

pub fn lock() {
    *UNLOCKED.lock_recover() = None;
}

pub fn status() -> KeepassStatus {
    let guard = UNLOCKED.lock_recover();
    match &*guard {
        Some(u) => KeepassStatus {
            unlocked: true,
            path: Some(u.path.clone()),
        },
        None => KeepassStatus {
            unlocked: false,
            path: None,
        },
    }
}

pub fn list_entries() -> Result<Vec<EntrySummary>, AppError> {
    let guard = UNLOCKED.lock_recover();
    let u = guard
        .as_ref()
        .ok_or_else(|| AppError::Auth("KeePass no desbloqueada".into()))?;
    let mut out = Vec::new();
    walk(u.db.root(), "", &mut out);
    out.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    Ok(out)
}

/// Devuelve el valor de la propiedad solicitada para la entrada `entry_uuid`.
/// `None` si no existe la entrada o si la propiedad no tiene valor.
pub fn get_property(entry_uuid: &str, property: EntryProperty) -> Result<Option<String>, AppError> {
    let guard = UNLOCKED.lock_recover();
    let u = guard
        .as_ref()
        .ok_or_else(|| AppError::Auth("KeePass no desbloqueada".into()))?;
    let uuid = match uuid::Uuid::parse_str(entry_uuid) {
        Ok(u) => u,
        Err(_) => return Ok(None),
    };
    Ok(u.db
        .entry(EntryId::from_uuid(uuid))
        .map(|e| read_property(&e, property)))
}

/// Por qué no se pudo calcular un código TOTP. Deliberadamente sin texto: el
/// error de la crate puede citar trozos de la URI `otpauth://` (que lleva la
/// semilla), así que nunca se propaga; quien llama solo sabe el motivo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TotpError {
    /// La base no está desbloqueada.
    Locked,
    /// No hay ninguna entrada con ese UUID en la base abierta.
    NoEntry,
    /// La entrada existe pero su campo `otp` está vacío o no existe.
    NoSeed,
    /// Hay algo en `otp`, pero no es un TOTP estándar que sepamos calcular
    /// (HOTP, Steam, URI rota, periodo o número de dígitos fuera de rango).
    Unsupported,
    /// El reloj del sistema está antes de 1970: no hay con qué calcular.
    Clock,
}

/// Un código TOTP recién calculado. El código se borra de memoria al soltarlo.
pub struct TotpCode {
    pub code: Zeroizing<String>,
    /// Contador del periodo al que pertenece (`tiempo / periodo`). Sirve para
    /// saber si un código ya se entregó sin tener que guardarlo.
    pub step: u64,
    /// Lo que falta para que empiece el periodo siguiente.
    pub until_next: Duration,
}

/// A mano, para que un `{:?}` (un `expect`, un log) no vuelque el código.
impl std::fmt::Debug for TotpCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TotpCode")
            .field("step", &self.step)
            .field("until_next", &self.until_next)
            .finish_non_exhaustive()
    }
}

/// Periodo máximo admitido. KeePassXC deja elegirlo; más de una hora no es un
/// segundo factor, y un `period=0` haría dividir por cero a la crate.
const TOTP_MAX_PERIOD: u64 = 3600;
/// Dígitos admitidos: el RFC 6238 usa de 6 a 8 y KeePassXC llega a 10. Fuera
/// de ahí (los 5 de Steam, que además usa otro alfabeto) no es este algoritmo.
const TOTP_DIGITS: std::ops::RangeInclusive<u32> = 6..=10;
/// Cabecera de una URI TOTP. La crate no mira el tipo: un `otpauth://hotp/…`
/// (por contador) daría un código que el servidor nunca aceptaría.
const TOTP_URI_HEAD: &str = "otpauth://totp/";

/// El valor crudo del campo `otp`, si trae algo.
fn raw_otp(entry: &Entry) -> Option<&str> {
    entry
        .get_raw_otp_value()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
}

/// Código TOTP de `entry` en el instante `unix_secs`. KeePassXC guarda la
/// semilla en el campo `otp` como URI `otpauth://totp/…?secret=…`; el formato
/// nativo de KeePass 2 (`TimeOtp-*`) queda para una segunda fase.
fn entry_totp(entry: &Entry, unix_secs: u64) -> Result<TotpCode, TotpError> {
    let raw = raw_otp(entry).ok_or(TotpError::NoSeed)?;
    let is_totp = raw
        .get(..TOTP_URI_HEAD.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(TOTP_URI_HEAD));
    if !is_totp {
        return Err(TotpError::Unsupported);
    }
    let totp: TOTP = raw.parse().map_err(|_| TotpError::Unsupported)?;
    if !(1..=TOTP_MAX_PERIOD).contains(&totp.period) || !TOTP_DIGITS.contains(&totp.digits) {
        return Err(TotpError::Unsupported);
    }
    if Zeroizing::new(totp.get_secret()).is_empty() {
        return Err(TotpError::NoSeed);
    }
    let value = totp.value_at(unix_secs);
    Ok(TotpCode {
        code: Zeroizing::new(value.code),
        step: unix_secs / totp.period,
        until_next: value.valid_for,
    })
}

/// Código TOTP de la entrada `entry_uuid` en el instante `unix_secs`.
///
/// Es la única puerta por la que sale un segundo factor de la base, y solo la
/// usa `auth_totp` para contestar al servidor SSH: ningún comando IPC devuelve
/// el código ni la semilla al renderer.
pub fn totp_at(entry_uuid: &str, unix_secs: u64) -> Result<TotpCode, TotpError> {
    let guard = UNLOCKED.lock_recover();
    let unlocked = guard.as_ref().ok_or(TotpError::Locked)?;
    let uuid = uuid::Uuid::parse_str(entry_uuid).map_err(|_| TotpError::NoEntry)?;
    let entry = unlocked
        .db
        .entry(EntryId::from_uuid(uuid))
        .ok_or(TotpError::NoEntry)?;
    entry_totp(&entry, unix_secs)
}

/// Segundos desde 1970, o `None` con el reloj del sistema antes de esa fecha.
pub fn unix_now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_secs())
}

fn read_property(e: &EntryRef<'_>, property: EntryProperty) -> String {
    let raw = match property {
        EntryProperty::Password => e.get_password(),
        EntryProperty::Username => e.get_username(),
        EntryProperty::Title => e.get_title(),
        EntryProperty::Url => e.get_url(),
        EntryProperty::Notes => e.get("Notes"),
    };
    raw.unwrap_or("").to_string()
}

fn walk(group: GroupRef<'_>, path: &str, out: &mut Vec<EntrySummary>) {
    for e in group.entries() {
        let notes = e.get("Notes").unwrap_or("");
        out.push(EntrySummary {
            uuid: e.id().uuid().to_string(),
            title: e.get_title().unwrap_or("").to_string(),
            username: e.get_username().unwrap_or("").to_string(),
            url: e.get_url().unwrap_or("").to_string(),
            group: path.to_string(),
            has_password: !e.get_password().unwrap_or("").is_empty(),
            has_notes: !notes.is_empty(),
            has_totp: raw_otp(&e).is_some(),
        });
    }
    for g in group.groups() {
        let next_path = if path.is_empty() {
            g.name.clone()
        } else {
            format!("{}/{}", path, g.name)
        };
        walk(g, &next_path, out);
    }
}

/// Ayudantes de test: la base desbloqueada es estado global del proceso, así
/// que los tests que la tocan se turnan con [`testing::exclusive`].
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Turno exclusivo sobre la base desbloqueada (desde un test `async`).
    pub(crate) async fn exclusive() -> tokio::sync::MutexGuard<'static, ()> {
        GUARD.lock().await
    }

    /// Lo mismo desde un test síncrono.
    pub(crate) fn exclusive_blocking() -> tokio::sync::MutexGuard<'static, ()> {
        GUARD.blocking_lock()
    }

    /// Deja desbloqueada una base en memoria.
    pub(crate) fn install(db: Database) {
        *UNLOCKED.lock_recover() = Some(UnlockedDb {
            db,
            path: "memoria.kdbx".to_string(),
        });
    }

    /// Añade una entrada a `db` con ese campo `otp` (o sin él) y devuelve su
    /// UUID.
    pub(crate) fn add_entry(db: &mut Database, title: &str, otp: Option<&str>) -> String {
        let mut root = db.root_mut();
        let mut entry = root.add_entry();
        entry.set_unprotected("Title", title);
        if let Some(otp) = otp {
            entry.set_protected("otp", otp);
        }
        entry.id().uuid().to_string()
    }

    /// Semilla de los vectores de prueba del RFC 6238 (`12345678901234567890`
    /// en ASCII) en base32. Es pública: sale impresa en el propio RFC.
    pub(crate) const RFC_SEED: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    /// URI `otpauth://` como las que escribe KeePassXC en el campo `otp`.
    pub(crate) fn otp_uri(seed_base32: &str, digits: u32, period: u64) -> String {
        format!(
            "otpauth://totp/Rustty:prueba?secret={seed_base32}&period={period}&digits={digits}&issuer=Rustty"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{add_entry, otp_uri, RFC_SEED};
    use super::*;

    fn code_at(otp: Option<&str>, unix_secs: u64) -> Result<TotpCode, TotpError> {
        let mut db = Database::new();
        let uuid = add_entry(&mut db, "servidor", otp);
        let id = EntryId::from_uuid(uuid::Uuid::parse_str(&uuid).expect("uuid"));
        let entry = db.entry(id).expect("entrada");
        entry_totp(&entry, unix_secs)
    }

    /// Los vectores del apéndice B del RFC 6238 (SHA-1, 8 dígitos, 30 s).
    #[test]
    fn el_codigo_coincide_con_los_vectores_del_rfc_6238() {
        let uri = otp_uri(RFC_SEED, 8, 30);
        for (time, expected) in [
            (59_u64, "94287082"),
            (1_111_111_109, "07081804"),
            (1_234_567_890, "89005924"),
            (20_000_000_000, "65353130"),
        ] {
            let code = code_at(Some(&uri), time).expect("código");
            assert_eq!(code.code.as_str(), expected, "t={time}");
            assert_eq!(code.step, time / 30);
        }
    }

    #[test]
    fn seis_digitos_son_los_ultimos_seis_del_vector() {
        let code = code_at(Some(&otp_uri(RFC_SEED, 6, 30)), 59).expect("código");
        assert_eq!(code.code.as_str(), "287082");
        // En el segundo 59 de un periodo de 30 queda 1 s para el siguiente.
        assert_eq!(code.until_next, Duration::from_secs(1));
    }

    #[test]
    fn sin_campo_otp_o_vacio_no_hay_semilla() {
        assert_eq!(code_at(None, 59).err(), Some(TotpError::NoSeed));
        assert_eq!(code_at(Some("   "), 59).err(), Some(TotpError::NoSeed));
        let sin_semilla = "otpauth://totp/x?secret=&period=30&digits=6";
        assert_eq!(code_at(Some(sin_semilla), 59).err(), Some(TotpError::NoSeed));
    }

    /// Lo que no es un TOTP estándar se rechaza sin calcular nada: un periodo
    /// cero haría dividir por cero a la crate, y un HOTP o un Steam darían un
    /// código que el servidor rechazaría (un intento fallido de regalo).
    #[test]
    fn lo_que_no_es_un_totp_estandar_se_rechaza_sin_panico() {
        for raw in [
            "no es una uri".to_string(),
            format!("otpauth://hotp/x?secret={RFC_SEED}&counter=1&digits=6"),
            format!("https://totp/x?secret={RFC_SEED}&period=30&digits=6"),
            otp_uri(RFC_SEED, 6, 0),
            otp_uri(RFC_SEED, 6, 86_400),
            otp_uri(RFC_SEED, 5, 30),
            otp_uri(RFC_SEED, 40, 30),
            format!("otpauth://totp/x?secret={RFC_SEED}&period=30&digits=6&algorithm=MD5"),
            "otpauth://totp/x?secret=no-es-base32!&period=30&digits=6".to_string(),
            "otpauth://totp/x?period=30&digits=6".to_string(),
        ] {
            assert_eq!(
                code_at(Some(&raw), 59).err(),
                Some(TotpError::Unsupported),
                "{raw}"
            );
        }
    }

    #[test]
    fn el_codigo_no_sale_en_un_volcado_de_depuracion() {
        let code = code_at(Some(&otp_uri(RFC_SEED, 8, 30)), 59).expect("código");
        assert!(!format!("{code:?}").contains("94287082"));
    }

    #[test]
    fn el_listado_dice_que_entradas_tienen_semilla_sin_mostrarla() {
        let _turno = testing::exclusive_blocking();
        let mut db = Database::new();
        let con = add_entry(&mut db, "con", Some(&otp_uri(RFC_SEED, 6, 30)));
        let sin = add_entry(&mut db, "sin", None);
        testing::install(db);
        let entries = list_entries().expect("listado");
        lock();
        assert!(entries.iter().any(|e| e.uuid == con && e.has_totp));
        assert!(entries.iter().any(|e| e.uuid == sin && !e.has_totp));
        let json = serde_json::to_string(&entries).expect("json");
        assert!(!json.contains(RFC_SEED) && !json.contains("otpauth"), "{json}");
    }

    #[test]
    fn el_codigo_por_uuid_distingue_bloqueada_entrada_y_semilla() {
        let _turno = testing::exclusive_blocking();
        lock();
        assert_eq!(totp_at("da-igual", 59).err(), Some(TotpError::Locked));

        let mut db = Database::new();
        let con = add_entry(&mut db, "con", Some(&otp_uri(RFC_SEED, 8, 30)));
        let sin = add_entry(&mut db, "sin", None);
        testing::install(db);
        assert_eq!(totp_at(&con, 59).expect("código").code.as_str(), "94287082");
        assert_eq!(totp_at(&sin, 59).err(), Some(TotpError::NoSeed));
        assert_eq!(totp_at("no-es-un-uuid", 59).err(), Some(TotpError::NoEntry));
        let otra = uuid::Uuid::new_v4().to_string();
        assert_eq!(totp_at(&otra, 59).err(), Some(TotpError::NoEntry));
        lock();
    }

    /// Ejecuta `keepassxc-cli` dándole la contraseña por la entrada estándar
    /// (`repeat` veces: al crear una base la pide dos). `None` si no está
    /// instalado.
    fn keepassxc_cli(args: &[&str], password: &str, repeat: usize) -> Option<String> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("keepassxc-cli")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;
        let mut stdin = child.stdin.take().expect("stdin");
        for _ in 0..repeat {
            writeln!(stdin, "{password}").expect("contraseña");
        }
        drop(stdin);
        let output = child.wait_with_output().expect("keepassxc-cli");
        assert!(
            output.status.success(),
            "keepassxc-cli {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    /// Contra una base de verdad: la crea KeePassXC (importando un XML con el
    /// campo `otp` tal como él lo escribe), la abre `unlock` y el código tiene
    /// que ser el mismo que da `keepassxc-cli show --totp`. Cubre lo que los
    /// vectores no: el cifrado real de la base, el campo protegido y las
    /// variantes de URI (semilla sin relleno `=`, SHA-256, 8 dígitos, 60 s).
    #[test]
    #[ignore = "necesita keepassxc-cli; se corre con --ignored"]
    fn el_totp_coincide_con_el_de_keepassxc() {
        // Clave maestra de la base de usar y tirar.
        const MASTER: &str = "prueba-kp";
        // Semilla del RFC 6238 para SHA-256 (32 bytes), sin el relleno `====`.
        let seed256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
        let entries = [
            ("sha1-6", otp_uri(RFC_SEED, 6, 30)),
            ("sha1-8", otp_uri(RFC_SEED, 8, 30)),
            (
                "sha256-8-60",
                format!("otpauth://totp/Rustty:b?secret={seed256}&period=60&digits=8&algorithm=SHA256"),
            ),
        ];

        let dir = std::env::temp_dir().join(format!("rustty-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("carpeta temporal");
        let xml_path = dir.join("import.xml");
        let db_path = dir.join("totp.kdbx");
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>\n<KeePassFile><Meta>\
             <Generator>Rustty</Generator></Meta><Root><Group>\
             <UUID>AAECAwQFBgcICQoLDA0ODw==</UUID><Name>Root</Name>",
        );
        for (index, (title, uri)) in entries.iter().enumerate() {
            use base64::Engine;
            let uuid = base64::engine::general_purpose::STANDARD.encode([index as u8 + 1; 16]);
            xml.push_str(&format!(
                "<Entry><UUID>{uuid}</UUID>\
                 <String><Key>Title</Key><Value>{title}</Value></String>\
                 <String><Key>otp</Key><Value>{}</Value></String></Entry>",
                uri.replace('&', "&amp;")
            ));
        }
        xml.push_str("</Group></Root></KeePassFile>\n");
        std::fs::write(&xml_path, xml).expect("xml");

        let (xml_arg, db_arg) = (xml_path.display().to_string(), db_path.display().to_string());
        if keepassxc_cli(&["import", "-q", "-p", &xml_arg, &db_arg], MASTER, 2).is_none() {
            eprintln!("keepassxc-cli no está instalado: test omitido");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let _turno = testing::exclusive_blocking();
        unlock(&db_arg, Some(MASTER), None).expect("desbloquear la base de KeePassXC");
        let listed = list_entries().expect("listado");
        for (title, _) in &entries {
            let entry = listed
                .iter()
                .find(|e| e.title == *title)
                .unwrap_or_else(|| panic!("falta la entrada {title}"));
            assert!(entry.has_totp, "{title}: KeePassXC guardó la semilla en `otp`");
            // El de antes o el de después de preguntar a KeePassXC, por si la
            // consulta cae justo en un cambio de periodo.
            let before = totp_at(&entry.uuid, unix_now().expect("reloj")).expect("código");
            let theirs = keepassxc_cli(&["show", "-q", "-t", &db_arg, title], MASTER, 1)
                .expect("keepassxc-cli");
            let after = totp_at(&entry.uuid, unix_now().expect("reloj")).expect("código");
            assert!(
                theirs == before.code.as_str() || theirs == after.code.as_str(),
                "{title}: el código no coincide con el de KeePassXC"
            );
        }
        lock();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
