//! Reanudación de subidas SFTP interrumpidas.
//!
//! La hermana de [`crate::transfer_resume`] (descargas), bajo la **misma
//! preferencia** y con el mismo principio: ante la menor duda se empieza de
//! cero. Lo que cambia es dónde vive cada cosa, y eso obliga a otro diseño.
//!
//! **El temporal está en el servidor y la ficha en este equipo.** Con la
//! reanudación activada, una subida grande no escribe sobre el destino: va a un
//! temporal hermano `<nombre>.<token>.rustty-part` y solo ocupa el nombre
//! definitivo con un `rename` al terminar, igual que una descarga. En el servidor
//! no se deja ninguna ficha (no hay dónde ponerla sin ensuciar su carpeta ni
//! garantía de poder escribirla), así que la señal de que ese temporal es
//! **nuestro** se guarda aquí, en la carpeta de datos de la app
//! (`upload-resume/`, una ficha privada por destino, escrita con
//! [`crate::atomic_file`]). La ficha asocia perfil + servidor + ruta de destino +
//! identidad del fichero local (ruta, tamaño y fecha) con el `token` aleatorio
//! que lleva el nombre del temporal. Un fichero del servidor que no salga de una
//! ficha no se toca jamás: ni para continuarlo ni para borrarlo. El temporal se
//! crea con `EXCLUDE`, así que tampoco se pisa nada al empezar.
//!
//! **Lo que vale es lo confirmado, no lo que mide el temporal.** La subida va en
//! paralelo por varios handles y russh-sftp no espera el acuse de cada
//! escritura: tras un corte, el temporal puede medir más de lo que de verdad
//! tiene, con **huecos** por debajo de su tamaño (un trozo que no llegó entre
//! dos que sí). Continuar desde el tamaño del temporal —lo que hacen los
//! clientes de un solo flujo— dejaría ceros a mitad del fichero, y la
//! verificación de los últimos bytes no lo vería. Por eso la ficha apunta
//! `confirmed`: el punto hasta el que el servidor **ha confirmado** todas las
//! escrituras. Se actualiza en puntos de control ([`Checkpoint`]): cada
//! [`CHECKPOINT_EVERY`], al pausar y al cancelar, la subida deja vaciarse lo que
//! tiene en vuelo, cierra los handles con `shutdown()` (que recoge todos los
//! acuses) y los reabre. Un corte repite como mucho lo enviado desde el último.
//!
//! **Antes de continuar se comprueba el temporal.** Tiene que existir, medir al
//! menos lo confirmado y no más que el fichero local, y sus primeros y sus
//! últimos [`PROBE_LEN`] bytes por debajo de lo confirmado tienen que coincidir
//! con los del fichero local en el mismo desplazamiento. Si algo no cuadra se
//! empieza de cero, y lo único que se borra es el temporal de la ficha.
//!
//! La decisión son funciones puras ([`candidate`], [`probe_windows`],
//! [`settle`]) que no tocan ni el disco ni la red.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::locks::MutexExt;

/// Carpeta de las fichas, dentro de la carpeta de datos de la app.
pub const DIR_NAME: &str = "upload-resume";

/// Sufijo del temporal de una subida en el servidor (el mismo que el de las
/// descargas en local: quien lo vea sabe qué es).
const TEMP_SUFFIX: &str = ".rustty-part";

/// Sufijo con el que se aparta un momento el destino que se va a sustituir, en
/// servidores cuyo `rename` no pisa un fichero existente (OpenSSH).
const BACKUP_SUFFIX: &str = ".rustty-old";

/// Longitud del token aleatorio del nombre del temporal (hexadecimal).
const TOKEN_LEN: usize = 16;

/// Tope de un nombre de fichero en casi cualquier sistema de ficheros (bytes).
const NAME_MAX: usize = 255;

/// Bytes que se comparan en cada extremo de lo confirmado antes de continuar.
pub const PROBE_LEN: u64 = 64 * 1024;

/// Cada cuánto se apunta lo confirmado durante una subida. Es lo que, como
/// mucho, se vuelve a subir tras un corte de red.
pub const CHECKPOINT_EVERY: Duration = Duration::from_secs(15);

/// Una ficha sin tocar en este tiempo se retira: su subida no se va a retomar.
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

/// Fichas que se conservan como mucho (las más recientes).
const MAX_FICHAS: usize = 200;

/// El barrido de fichas viejas se hace como mucho una vez por este intervalo.
const SWEEP_EVERY_SECS: u64 = 3600;

/// Versión del formato de la ficha. Una que no se entiende se trata como si no
/// hubiera ficha (y por tanto no se toca su temporal).
const META_VERSION: u32 = 1;

/// Dónde guarda las fichas una sesión SFTP y de quién son: el perfil y el
/// servidor al que está conectada.
#[derive(Debug, Clone)]
pub struct Scope {
    /// Carpeta de las fichas (`<datos>/upload-resume`).
    pub dir: PathBuf,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Cada cuánto se apunta lo confirmado ([`CHECKPOINT_EVERY`]; los tests lo
    /// bajan para cortar una subida pequeña con varios puntos de control).
    pub checkpoint_every: Duration,
}

/// Lo que identifica una subida concreta: de quién, a dónde y qué fichero local.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Ruta remota de destino.
    pub remote: String,
    /// Ruta local de origen (canonicalizada si se pudo).
    pub local: String,
    pub local_size: u64,
    /// Fecha de modificación local en nanosegundos desde epoch, si el sistema la
    /// da.
    pub local_mtime_ns: Option<u64>,
}

impl Identity {
    #[must_use]
    pub fn new(
        scope: &Scope,
        remote: &str,
        local: String,
        local_size: u64,
        local_mtime_ns: Option<u64>,
    ) -> Self {
        Self {
            profile_id: scope.profile_id.clone(),
            host: scope.host.clone(),
            port: scope.port,
            user: scope.user.clone(),
            remote: remote.to_string(),
            local,
            local_size,
            local_mtime_ns,
        }
    }
}

/// Ficha de una subida a medias.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadMeta {
    pub version: u32,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub remote: String,
    pub local: String,
    pub local_size: u64,
    pub local_mtime_ns: Option<u64>,
    /// Token aleatorio del nombre del temporal (ver [`temp_path`]).
    pub token: String,
    /// Bytes desde el principio que el servidor ha confirmado.
    pub confirmed: u64,
}

impl UploadMeta {
    /// Ficha nueva, sin nada confirmado todavía.
    #[must_use]
    pub fn new(id: &Identity, token: String) -> Self {
        Self {
            version: META_VERSION,
            profile_id: id.profile_id.clone(),
            host: id.host.clone(),
            port: id.port,
            user: id.user.clone(),
            remote: id.remote.clone(),
            local: id.local.clone(),
            local_size: id.local_size,
            local_mtime_ns: id.local_mtime_ns,
            token,
            confirmed: 0,
        }
    }

    /// ¿Habla del mismo sitio (perfil, servidor y destino)?
    fn same_place(&self, id: &Identity) -> bool {
        self.profile_id == id.profile_id
            && self.host == id.host
            && self.port == id.port
            && self.user == id.user
            && self.remote == id.remote
    }

    /// ¿Habla del mismo fichero local, sin cambios?
    fn same_source(&self, id: &Identity) -> bool {
        self.local == id.local
            && self.local_size == id.local_size
            && self.local_mtime_ns == id.local_mtime_ns
    }

    /// Ruta del temporal de esta ficha.
    #[must_use]
    pub fn temp_path(&self) -> String {
        temp_path(&self.remote, &self.token)
    }
}

/// Primera decisión, solo con la ficha: ¿merece la pena mirar el temporal?
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Candidate {
    /// Empezar de cero. `stale` es el temporal **nuestro** que sobra (de una
    /// ficha de este mismo destino), para retirarlo; `None` si no hay ninguno
    /// del que fiarse.
    Fresh { stale: Option<String> },
    /// Comprobar el temporal `temp` antes de continuar desde `confirmed`.
    Probe { temp: String, confirmed: u64 },
}

/// Qué hacer con la subida, ya comprobado el temporal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadPlan {
    /// Temporal nuevo, subida entera.
    Fresh,
    /// Continuar desde este desplazamiento.
    Continue(u64),
    /// El temporal ya tiene el fichero entero: solo falta publicarlo.
    Complete,
}

/// Decide, con la ficha guardada y la subida que se pide, si hay un temporal que
/// comprobar. Pura.
#[must_use]
pub fn candidate(meta: Option<&UploadMeta>, id: &Identity) -> Candidate {
    let Some(meta) = meta else {
        return Candidate::Fresh { stale: None };
    };
    // Una ficha que no entendemos, con un token que no es nuestro o de otro
    // sitio no dice qué temporal es: no se continúa ni se borra nada.
    if meta.version != META_VERSION || !valid_token(&meta.token) || !meta.same_place(id) {
        return Candidate::Fresh { stale: None };
    }
    let temp = meta.temp_path();
    // Mismo destino pero otro fichero local (o el mismo, cambiado): el temporal
    // es nuestro y ya no sirve.
    if !meta.same_source(id) || meta.confirmed == 0 || meta.confirmed > id.local_size {
        return Candidate::Fresh { stale: Some(temp) };
    }
    Candidate::Probe {
        temp,
        confirmed: meta.confirmed,
    }
}

/// Tramos `(desplazamiento, longitud)` que hay que comparar entre el temporal y
/// el fichero local antes de continuar desde `confirmed`: el principio y el
/// final de lo confirmado, o todo si es corto. Pura.
#[must_use]
pub fn probe_windows(confirmed: u64) -> Vec<(u64, u64)> {
    if confirmed == 0 {
        return Vec::new();
    }
    if confirmed <= 2 * PROBE_LEN {
        return vec![(0, confirmed)];
    }
    vec![(0, PROBE_LEN), (confirmed - PROBE_LEN, PROBE_LEN)]
}

/// Decisión final, con lo que se ha visto del temporal: su tamaño (`None` = no
/// existe o no es un fichero) y si los tramos de [`probe_windows`] coinciden con
/// el fichero local. Pura.
#[must_use]
pub fn settle(
    confirmed: u64,
    local_size: u64,
    temp_size: Option<u64>,
    windows_match: bool,
) -> UploadPlan {
    let Some(temp_size) = temp_size else {
        return UploadPlan::Fresh;
    };
    // Más corto que lo confirmado: alguien lo ha truncado. Más largo que el
    // local: no puede ser un trozo suyo.
    if temp_size < confirmed || temp_size > local_size || !windows_match {
        return UploadPlan::Fresh;
    }
    if confirmed == local_size {
        UploadPlan::Complete
    } else {
        UploadPlan::Continue(confirmed)
    }
}

/// Token nuevo para el nombre de un temporal.
#[must_use]
pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..TOKEN_LEN].to_string()
}

fn valid_token(token: &str) -> bool {
    token.len() == TOKEN_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Ruta hermana de `remote` con el token y el sufijo dados. El nombre se acorta
/// (sin partir un carácter) si con el añadido pasaría de [`NAME_MAX`].
fn sibling(remote: &str, token: &str, suffix: &str) -> String {
    let (prefix, name) = match remote.rsplit_once('/') {
        Some((prefix, name)) => (Some(prefix), name),
        None => (None, remote),
    };
    let budget = NAME_MAX - 1 - TOKEN_LEN - TEMP_SUFFIX.len().max(BACKUP_SUFFIX.len());
    let mut cut = name.len().min(budget);
    while !name.is_char_boundary(cut) {
        cut -= 1;
    }
    let file = format!("{}.{token}{suffix}", &name[..cut]);
    match prefix {
        Some(prefix) => format!("{prefix}/{file}"),
        None => file,
    }
}

/// Ruta del temporal de una subida a `remote`: en la misma carpeta (el `rename`
/// final no cruza sistemas de ficheros) y con el token de su ficha.
#[must_use]
pub fn temp_path(remote: &str, token: &str) -> String {
    sibling(remote, token, TEMP_SUFFIX)
}

/// Nombre con el que se aparta el destino anterior mientras se publica.
#[must_use]
pub fn backup_path(remote: &str, token: &str) -> String {
    sibling(remote, token, BACKUP_SUFFIX)
}

/// Fichero de la ficha de una subida de `profile_id` a `remote`. El nombre es
/// un hash: la ruta remota no llega al sistema de ficheros local.
#[must_use]
pub fn meta_file(dir: &Path, profile_id: &str, remote: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(profile_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(remote.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{hex}.json"))
}

/// Fecha de modificación de un fichero local en nanosegundos desde epoch.
#[must_use]
pub fn mtime_ns(meta: &std::fs::Metadata) -> Option<u64> {
    let since = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since.as_nanos()).ok()
}

/// Qué fichas sobran de las de `entries` (nombre y fecha de modificación): las
/// de más de [`MAX_AGE`] y, de las demás, las que pasen de [`MAX_FICHAS`]
/// empezando por las más viejas. Pura.
#[must_use]
pub fn stale_fichas(mut entries: Vec<(String, SystemTime)>, now: SystemTime) -> Vec<String> {
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    let mut out = Vec::new();
    let mut kept = 0usize;
    for (name, modified) in entries {
        let old = now.duration_since(modified).is_ok_and(|age| age > MAX_AGE);
        if old || kept >= MAX_FICHAS {
            out.push(name);
        } else {
            kept += 1;
        }
    }
    out
}

// ─── Disco ───────────────────────────────────────────────────────────────────

/// Lee una ficha. `None` si no existe o no se entiende.
pub async fn read_meta(file: &Path) -> Option<UploadMeta> {
    let raw = tokio::fs::read(file).await.ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Escribe una ficha de forma atómica y privada (0600).
pub async fn write_meta(file: &Path, meta: &UploadMeta) -> std::io::Result<()> {
    let raw = serde_json::to_vec(meta).map_err(std::io::Error::other)?;
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::atomic_file::write(&file, &raw, true)
    })
    .await
    .map_err(std::io::Error::other)?
}

/// Borra una ficha (al publicar la subida o al empezar de cero).
pub async fn remove_meta(file: &Path) {
    let _ = tokio::fs::remove_file(file).await;
}

/// Último barrido, en segundos desde epoch (0 = ninguno en este proceso).
static LAST_SWEEP: AtomicU64 = AtomicU64::new(0);

/// Retira las fichas viejas de `dir` (ver [`stale_fichas`]) y los temporales que
/// dejara a medias una escritura de ficha, como mucho una vez por
/// [`SWEEP_EVERY_SECS`]. El temporal remoto de una ficha retirada se queda en
/// su servidor: sin conexión no se puede borrar, y ya sin ficha no se tocará.
pub async fn sweep_if_due(dir: &Path) {
    let now = SystemTime::now();
    let now_secs = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let last = LAST_SWEEP.load(Ordering::Relaxed);
    if last != 0 && now_secs.saturating_sub(last) < SWEEP_EVERY_SECS {
        return;
    }
    if LAST_SWEEP
        .compare_exchange(last, now_secs.max(1), Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let dir = dir.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || sweep_dir(&dir, now)).await;
}

fn sweep_dir(dir: &Path, now: SystemTime) {
    crate::atomic_file::sweep_orphan_temps(dir, Duration::from_secs(3600));
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let entries = read
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
            name.ends_with(".json").then_some((name, modified))
        })
        .collect();
    for name in stale_fichas(entries, now) {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

// ─── Subidas en marcha ───────────────────────────────────────────────────────

/// Fichas que tiene abiertas ahora mismo una subida de este proceso.
static ACTIVE: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Reserva de una ficha mientras dura su subida. Se suelta al soltarla.
#[derive(Debug)]
pub struct ActiveUpload(PathBuf);

impl Drop for ActiveUpload {
    fn drop(&mut self) {
        if let Some(set) = ACTIVE.lock_recover().as_mut() {
            set.remove(&self.0);
        }
    }
}

/// Reserva la ficha `file` para una subida. `None` si otra subida a ese mismo
/// destino está en marcha: su ficha y su temporal son suyos, y esta tiene que
/// ir por el camino de siempre sin tocarlos.
#[must_use]
pub fn claim(file: &Path) -> Option<ActiveUpload> {
    let mut active = ACTIVE.lock_recover();
    let set = active.get_or_insert_with(HashSet::new);
    set.insert(file.to_path_buf())
        .then(|| ActiveUpload(file.to_path_buf()))
}

// ─── Puntos de control ───────────────────────────────────────────────────────

/// Lo confirmado de una subida en curso y cuándo se apuntó por última vez.
#[derive(Debug)]
pub struct Checkpoint {
    file: PathBuf,
    meta: UploadMeta,
    every: Duration,
    last: Instant,
}

impl Checkpoint {
    #[must_use]
    pub fn new(file: PathBuf, meta: UploadMeta, every: Duration) -> Self {
        Self {
            file,
            meta,
            every,
            last: Instant::now(),
        }
    }

    #[must_use]
    pub fn confirmed(&self) -> u64 {
        self.meta.confirmed
    }

    /// ¿Toca apuntar lo enviado (`sent`)? Solo si hay algo nuevo y ha pasado el
    /// intervalo.
    #[must_use]
    pub fn due(&self, sent: u64, now: Instant) -> bool {
        sent > self.meta.confirmed && now.duration_since(self.last) >= self.every
    }

    /// Apunta que el servidor ha confirmado hasta `confirmed`. Un fallo al
    /// escribir la ficha no rompe la subida: la ficha anterior sigue siendo
    /// cierta (lo confirmado solo crece), solo que repetirá más bytes.
    pub async fn save(&mut self, confirmed: u64) {
        self.meta.confirmed = self.meta.confirmed.max(confirmed);
        self.last = Instant::now();
        let _ = write_meta(&self.file, &self.meta).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> Scope {
        Scope {
            dir: PathBuf::from("/tmp/no-se-usa"),
            profile_id: "perfil-1".to_string(),
            host: "srv.example".to_string(),
            port: 22,
            user: "ana".to_string(),
            checkpoint_every: CHECKPOINT_EVERY,
        }
    }

    fn identity() -> Identity {
        Identity::new(
            &scope(),
            "/srv/datos/iso.img",
            "/home/ana/iso.img".to_string(),
            10_000_000,
            Some(1_700_000_000_123_456_789),
        )
    }

    fn meta(confirmed: u64) -> UploadMeta {
        UploadMeta {
            confirmed,
            ..UploadMeta::new(&identity(), "0123456789abcdef".to_string())
        }
    }

    #[test]
    fn sin_ficha_se_empieza_de_cero_sin_borrar_nada() {
        assert_eq!(
            candidate(None, &identity()),
            Candidate::Fresh { stale: None }
        );
    }

    #[test]
    fn una_ficha_del_mismo_destino_y_origen_manda_comprobar_el_temporal() {
        assert_eq!(
            candidate(Some(&meta(4_000_000)), &identity()),
            Candidate::Probe {
                temp: "/srv/datos/iso.img.0123456789abcdef.rustty-part".to_string(),
                confirmed: 4_000_000,
            }
        );
    }

    #[test]
    fn si_el_fichero_local_cambio_se_retira_nuestro_temporal() {
        // Tamaño, fecha o ruta local distintos: mismo destino, otro origen. El
        // temporal es nuestro (sale de la ficha de ese destino) y ya no sirve.
        let temp = Some("/srv/datos/iso.img.0123456789abcdef.rustty-part".to_string());
        for id in [
            Identity {
                local_size: 10_000_001,
                ..identity()
            },
            Identity {
                local_mtime_ns: Some(1),
                ..identity()
            },
            Identity {
                local_mtime_ns: None,
                ..identity()
            },
            Identity {
                local: "/home/ana/otra.img".to_string(),
                ..identity()
            },
        ] {
            assert_eq!(
                candidate(Some(&meta(4_000_000)), &id),
                Candidate::Fresh {
                    stale: temp.clone()
                },
                "{id:?}"
            );
        }
    }

    #[test]
    fn una_ficha_de_otro_sitio_no_autoriza_a_tocar_nada() {
        // Otro perfil, servidor, usuario o destino: el temporal que nombra no
        // está aquí (o no es de este destino). Ni continuar ni borrar.
        for id in [
            Identity {
                profile_id: "otro".to_string(),
                ..identity()
            },
            Identity {
                host: "otro.example".to_string(),
                ..identity()
            },
            Identity {
                port: 2222,
                ..identity()
            },
            Identity {
                user: "root".to_string(),
                ..identity()
            },
            Identity {
                remote: "/srv/otro/iso.img".to_string(),
                ..identity()
            },
        ] {
            assert_eq!(
                candidate(Some(&meta(4_000_000)), &id),
                Candidate::Fresh { stale: None },
                "{id:?}"
            );
        }
    }

    #[test]
    fn una_ficha_rara_no_autoriza_a_tocar_nada() {
        // Un token que no es nuestro (podría nombrar cualquier fichero) o un
        // formato futuro.
        for bad in [
            UploadMeta {
                token: "../../etc/passwd".to_string(),
                ..meta(4_000_000)
            },
            // Hexadecimal en mayúsculas (el nuestro va en minúsculas). Se
            // construye sin literal: escrito tal cual, el escáner de secretos
            // del CI (gitleaks) lo toma por una clave.
            UploadMeta {
                token: format!("{:016X}", 0x0123_4567_89AB_CDEF_u64),
                ..meta(4_000_000)
            },
            UploadMeta {
                token: String::new(),
                ..meta(4_000_000)
            },
            UploadMeta {
                version: 99,
                ..meta(4_000_000)
            },
        ] {
            assert_eq!(
                candidate(Some(&bad), &identity()),
                Candidate::Fresh { stale: None },
                "{bad:?}"
            );
        }
    }

    #[test]
    fn sin_nada_confirmado_o_con_mas_de_lo_que_hay_se_empieza_de_cero() {
        let temp = Some("/srv/datos/iso.img.0123456789abcdef.rustty-part".to_string());
        assert_eq!(
            candidate(Some(&meta(0)), &identity()),
            Candidate::Fresh {
                stale: temp.clone()
            }
        );
        assert_eq!(
            candidate(Some(&meta(10_000_001)), &identity()),
            Candidate::Fresh { stale: temp }
        );
    }

    #[test]
    fn se_comparan_el_principio_y_el_final_de_lo_confirmado() {
        assert!(probe_windows(0).is_empty());
        assert_eq!(probe_windows(1_000), vec![(0, 1_000)]);
        assert_eq!(probe_windows(2 * PROBE_LEN), vec![(0, 2 * PROBE_LEN)]);
        assert_eq!(
            probe_windows(4_000_000),
            vec![(0, PROBE_LEN), (4_000_000 - PROBE_LEN, PROBE_LEN)]
        );
    }

    #[test]
    fn un_temporal_sano_continua_desde_lo_confirmado_no_desde_su_tamano() {
        // Un temporal más largo que lo confirmado es lo normal tras un corte
        // (escrituras en vuelo que sí llegaron), pero por debajo de su tamaño
        // puede haber huecos: se sigue desde lo confirmado.
        assert_eq!(
            settle(4_000_000, 10_000_000, Some(6_000_000), true),
            UploadPlan::Continue(4_000_000)
        );
        assert_eq!(
            settle(4_000_000, 10_000_000, Some(4_000_000), true),
            UploadPlan::Continue(4_000_000)
        );
    }

    #[test]
    fn un_temporal_entero_solo_hay_que_publicarlo() {
        assert_eq!(
            settle(10_000_000, 10_000_000, Some(10_000_000), true),
            UploadPlan::Complete
        );
    }

    #[test]
    fn un_temporal_que_no_cuadra_obliga_a_empezar_de_cero() {
        // Sin temporal, truncado por debajo de lo confirmado, más largo que el
        // local o con bytes distintos.
        assert_eq!(settle(4_000_000, 10_000_000, None, true), UploadPlan::Fresh);
        assert_eq!(
            settle(4_000_000, 10_000_000, Some(3_999_999), true),
            UploadPlan::Fresh
        );
        assert_eq!(
            settle(4_000_000, 10_000_000, Some(10_000_001), true),
            UploadPlan::Fresh
        );
        assert_eq!(
            settle(4_000_000, 10_000_000, Some(6_000_000), false),
            UploadPlan::Fresh
        );
    }

    #[test]
    fn el_temporal_vive_junto_al_destino_con_el_token() {
        assert_eq!(
            temp_path("/srv/datos/iso.img", "0123456789abcdef"),
            "/srv/datos/iso.img.0123456789abcdef.rustty-part"
        );
        assert_eq!(
            temp_path("/iso.img", "0123456789abcdef"),
            "/iso.img.0123456789abcdef.rustty-part"
        );
        assert_eq!(
            temp_path("iso.img", "0123456789abcdef"),
            "iso.img.0123456789abcdef.rustty-part"
        );
        assert_eq!(
            backup_path("/srv/datos/iso.img", "0123456789abcdef"),
            "/srv/datos/iso.img.0123456789abcdef.rustty-old"
        );
    }

    #[test]
    fn un_nombre_largo_se_acorta_sin_partir_caracteres() {
        let long = "ñ".repeat(200); // 400 bytes
        let temp = temp_path(&format!("/srv/{long}"), "0123456789abcdef");
        let name = temp.rsplit_once('/').unwrap().1;
        assert!(name.len() <= NAME_MAX, "{} bytes", name.len());
        assert!(name.ends_with(".0123456789abcdef.rustty-part"));
        assert!(name.starts_with("ññ"));
        let backup = backup_path(&format!("/srv/{long}"), "0123456789abcdef");
        assert!(backup.rsplit_once('/').unwrap().1.len() <= NAME_MAX);
    }

    #[test]
    fn el_token_es_valido_y_distinto_cada_vez() {
        let a = new_token();
        let b = new_token();
        assert!(valid_token(&a), "{a}");
        assert_ne!(a, b);
    }

    #[test]
    fn la_ficha_depende_del_perfil_y_del_destino() {
        let dir = Path::new("/datos/upload-resume");
        let a = meta_file(dir, "perfil-1", "/srv/a");
        assert_eq!(a, meta_file(dir, "perfil-1", "/srv/a"));
        assert_ne!(a, meta_file(dir, "perfil-2", "/srv/a"));
        assert_ne!(a, meta_file(dir, "perfil-1", "/srv/b"));
        // El separador evita que «perfil-1» + «x/srv» choque con «perfil-1x» + «/srv».
        assert_ne!(
            meta_file(dir, "perfil-1", "x/srv"),
            meta_file(dir, "perfil-1x", "/srv")
        );
        assert_eq!(a.parent(), Some(dir));
        assert!(a.extension().is_some_and(|e| e == "json"));
    }

    #[test]
    fn las_fichas_viejas_y_las_que_sobran_se_retiran() {
        let now = SystemTime::now();
        let day = Duration::from_secs(24 * 3600);
        let mut entries = vec![
            ("vieja.json".to_string(), now - 31 * day),
            ("reciente.json".to_string(), now - day),
        ];
        assert_eq!(stale_fichas(entries.clone(), now), vec!["vieja.json"]);

        // Por encima del tope se retiran las más viejas.
        for i in 0..MAX_FICHAS {
            entries.push((
                format!("f{i}.json"),
                now - Duration::from_secs(i as u64 + 10),
            ));
        }
        let stale = stale_fichas(entries, now);
        assert!(stale.contains(&"vieja.json".to_string()));
        assert!(stale.contains(&"reciente.json".to_string()));
        assert_eq!(stale.len(), 2);
    }

    #[test]
    fn una_ficha_solo_la_usa_una_subida_a_la_vez() {
        let file = PathBuf::from("/datos/upload-resume/prueba-reserva.json");
        let first = claim(&file).expect("libre");
        assert!(claim(&file).is_none(), "ya reservada");
        drop(first);
        assert!(claim(&file).is_some(), "liberada al soltarla");
    }

    #[test]
    fn el_punto_de_control_toca_con_algo_nuevo_y_pasado_el_intervalo() {
        let cp = Checkpoint::new(PathBuf::new(), meta(1_000), Duration::from_secs(15));
        let now = cp.last;
        assert!(!cp.due(1_000, now + Duration::from_secs(60)), "nada nuevo");
        assert!(
            !cp.due(2_000, now + Duration::from_secs(1)),
            "demasiado pronto"
        );
        assert!(cp.due(2_000, now + Duration::from_secs(15)));
        assert_eq!(cp.confirmed(), 1_000);
    }

    #[tokio::test]
    async fn la_ficha_se_escribe_privada_se_lee_y_se_borra() {
        let dir = std::env::temp_dir().join(format!("rustty-upr-{}", uuid::Uuid::new_v4()));
        let file = meta_file(&dir, "perfil-1", "/srv/datos/iso.img");
        // La carpeta se crea al escribir la primera ficha.
        write_meta(&file, &meta(4_000_000)).await.expect("escribir");
        assert_eq!(read_meta(&file).await, Some(meta(4_000_000)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // El punto de control solo hace crecer lo confirmado.
        let mut cp = Checkpoint::new(file.clone(), meta(4_000_000), CHECKPOINT_EVERY);
        cp.save(6_000_000).await;
        assert_eq!(read_meta(&file).await.map(|m| m.confirmed), Some(6_000_000));
        cp.save(5_000_000).await;
        assert_eq!(read_meta(&file).await.map(|m| m.confirmed), Some(6_000_000));

        // Una ficha ilegible es como no tenerla.
        std::fs::write(&file, b"{ no es json").unwrap();
        assert_eq!(read_meta(&file).await, None);

        remove_meta(&file).await;
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_barrido_retira_las_fichas_viejas_y_deja_las_recientes() {
        let dir = std::env::temp_dir().join(format!("rustty-upr-sweep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("vieja.json");
        let fresh = dir.join("reciente.json");
        let other = dir.join("no-es-ficha.txt");
        for f in [&old, &fresh, &other] {
            std::fs::write(f, b"{}").unwrap();
        }
        // Se juzga con un «ahora» 31 días por delante: todas parecen viejas
        // menos la que se toca justo antes.
        let later = SystemTime::now() + MAX_AGE + Duration::from_secs(24 * 3600);
        std::fs::File::options()
            .write(true)
            .open(&fresh)
            .unwrap()
            .set_modified(later)
            .unwrap();
        sweep_dir(&dir, later);
        assert!(!old.exists(), "la vieja se retira");
        assert!(fresh.exists(), "la reciente se queda");
        assert!(other.exists(), "lo que no es una ficha no se toca");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
