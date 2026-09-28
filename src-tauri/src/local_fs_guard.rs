//! Límites del panel de archivos local y de las transferencias (v2.15.0).
//!
//! El panel de ficheros es, por naturaleza, un gestor de ficheros: lista, crea,
//! borra y transfiere en las carpetas por las que navega el usuario, así que sus
//! comandos siguen aceptando rutas del renderer (no pasan por el permiso de un
//! solo uso de [`crate::file_grants`]). Dos límites acotan lo que un renderer
//! comprometido podría hacer con ellos sin estorbar el uso normal:
//!
//! 1. **La carpeta de datos de Rustty es intocable desde el panel.** Ni crear,
//!    ni escribir (descargas incluidas), ni borrar, ni renombrar, ni cambiar
//!    permisos dentro de ella —ni borrar o renombrar una carpeta que la
//!    contenga—. Ahí viven los perfiles y `trusted_local_commands.json`:
//!    sobrescribirlo desde una descarga anularía la autorización de los comandos
//!    locales sin que el usuario viera ningún diálogo. No hay ningún motivo
//!    legítimo para que el panel escriba ahí.
//! 2. **Subir algo sensible pide confirmación nativa**: un fichero que por su
//!    contenido parece una clave privada (esté donde esté: también las que se
//!    renombran a `.pub`), cualquier otro de `~/.ssh` salvo los públicos, y lo
//!    que salga de la carpeta de datos (registros de sesión). Una carpeta que
//!    contenga alguno de ellos también pregunta.
//!
//! Las rutas se juzgan **resueltas**: se canonicaliza el ancestro existente más
//! profundo (así `..` y los enlaces simbólicos no sirven para colarse) y, si la
//! ruta existe, también lo que resulta de seguir su último enlace.

use std::path::{Component, Path, PathBuf};

use crate::file_grants::looks_like_private_key;

/// Prefijo de los errores con código (`local-fs:<código>|<detalle>`) que el
/// frontend traduce.
pub const ERROR_MARKER: &str = "local-fs:";

/// Solo se inspecciona el contenido de ficheros de hasta este tamaño: una clave
/// privada ocupa unos pocos KiB, y leer ficheros grandes para buscarla sería
/// pagar por nada.
const KEY_SCAN_MAX_BYTES: u64 = 64 * 1024;
/// Topes del recorrido de una carpeta antes de subirla.
const TREE_SCAN_MAX_FILES: usize = 20_000;
const TREE_SCAN_MAX_DEPTH: usize = 64;

/// Nombres de `~/.ssh` que no son secretos.
const SSH_PUBLIC_NAMES: &[&str] = &[
    "known_hosts",
    "known_hosts.old",
    "config",
    "authorized_keys",
];

fn error(code: &str, detail: &str) -> String {
    format!("{ERROR_MARKER}{code}|{detail}")
}

/// Por qué una subida necesita confirmación.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadConcern {
    /// El fichero parece una clave privada.
    PrivateKey,
    /// Está en `~/.ssh` y no es público.
    SshDir,
    /// Está en la carpeta de datos de Rustty.
    DataDir,
    /// La carpeta es (o contiene, o está dentro de) `~/.ssh` o la de datos.
    TreeSensitive,
    /// La carpeta contiene un fichero que parece una clave privada; va su ruta
    /// relativa, para enseñarla.
    TreeKey(String),
}

/// Guardián de las rutas locales, gestionado por Tauri como estado global.
#[derive(Clone)]
pub struct LocalFsGuard {
    data_dir: PathBuf,
    ssh_dir: Option<PathBuf>,
}

/// Forma canónica de una ruta que puede no existir: se canonicaliza el ancestro
/// existente más profundo y se le añade el resto, que no puede contener `..`.
pub fn canonical_lenient(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(error("invalid", &path.display().to_string()));
    }
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(canonical) => {
                let mut out = canonical;
                for part in rest.iter().rev() {
                    out.push(part);
                }
                return Ok(out);
            }
            Err(_) => {
                let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
                    return Err(error("invalid", &path.display().to_string()));
                };
                rest.push(name);
                if !existing.pop() {
                    return Err(error("invalid", &path.display().to_string()));
                }
            }
        }
        // Un `..` en la parte que aún no existe no se puede resolver contra el
        // disco: se rechaza en vez de interpretarlo a mano.
        if existing
            .components()
            .next_back()
            .is_some_and(|c| matches!(c, Component::ParentDir))
        {
            return Err(error("invalid", &path.display().to_string()));
        }
    }
}

/// Las formas en que el sistema puede interpretar `path`: la entrada en sí
/// (carpeta canonicalizada + nombre, sin seguir un enlace final) y, si existe,
/// lo que resulta de seguir ese enlace.
fn resolved_forms(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut forms = Vec::with_capacity(2);
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => forms.push(canonical_lenient(parent)?.join(name)),
        _ => forms.push(canonical_lenient(path)?),
    }
    if let Ok(followed) = std::fs::canonicalize(path) {
        if !forms.contains(&followed) {
            forms.push(followed);
        }
    }
    Ok(forms)
}

impl LocalFsGuard {
    pub fn new(data_dir: &Path, home: Option<&Path>) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            ssh_dir: home.map(|h| h.join(".ssh")),
        }
    }

    fn data_dir(&self) -> Option<PathBuf> {
        std::fs::canonicalize(&self.data_dir).ok()
    }

    fn ssh_dir(&self) -> Option<PathBuf> {
        self.ssh_dir
            .as_ref()
            .and_then(|d| std::fs::canonicalize(d).ok())
    }

    /// ¿Puede el panel crear o escribir en `path` (crear, descargar, cambiar
    /// permisos, destino de un renombrado)?
    pub fn check_write(&self, path: &Path) -> Result<(), String> {
        let forms = resolved_forms(path)?;
        if let Some(data) = self.data_dir() {
            if forms.iter().any(|f| f.starts_with(&data)) {
                return Err(error("protected", &path.display().to_string()));
            }
        }
        Ok(())
    }

    /// ¿Puede el panel borrar o mover `path`? Además de lo de [`check_write`],
    /// no puede ser una carpeta que **contenga** la de datos. Vale también para
    /// la raíz local de una descarga de carpeta, cuyo árbol podría acabar
    /// escribiendo dentro.
    pub fn check_remove(&self, path: &Path) -> Result<(), String> {
        self.check_write(path)?;
        if let Some(data) = self.data_dir() {
            if resolved_forms(path)?.iter().any(|f| data.starts_with(f)) {
                return Err(error("protected", &path.display().to_string()));
            }
        }
        Ok(())
    }

    fn file_concern(
        &self,
        canonical: &Path,
        data: Option<&Path>,
        ssh: Option<&Path>,
    ) -> Option<UploadConcern> {
        if data.is_some_and(|d| canonical.starts_with(d)) {
            return Some(UploadConcern::DataDir);
        }
        if file_looks_like_key(canonical) {
            return Some(UploadConcern::PrivateKey);
        }
        if ssh.is_some_and(|s| canonical.starts_with(s)) {
            let name = canonical
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let public = name.ends_with(".pub") || SSH_PUBLIC_NAMES.contains(&name.as_str());
            if !public {
                return Some(UploadConcern::SshDir);
            }
        }
        None
    }

    /// ¿Pide confirmación subir el fichero `path`?
    pub fn upload_concern(&self, path: &Path) -> Result<Option<UploadConcern>, String> {
        let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        let data = self.data_dir();
        let ssh = self.ssh_dir();
        Ok(self.file_concern(&canonical, data.as_deref(), ssh.as_deref()))
    }

    /// ¿Pide confirmación subir la carpeta `root` entera? Los enlaces simbólicos
    /// no se siguen, igual que en la subida.
    pub fn upload_dir_concern(&self, root: &Path) -> Result<Option<UploadConcern>, String> {
        let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        let data = self.data_dir();
        let ssh = self.ssh_dir();
        for sensitive in [data.as_deref(), ssh.as_deref()].into_iter().flatten() {
            if root.starts_with(sensitive) || sensitive.starts_with(&root) {
                return Ok(Some(UploadConcern::TreeSensitive));
            }
        }
        let mut stack = vec![(root.clone(), 0usize)];
        let mut seen = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in read.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                let path = entry.path();
                if ft.is_dir() && depth < TREE_SCAN_MAX_DEPTH {
                    stack.push((path, depth + 1));
                } else if ft.is_file() {
                    seen += 1;
                    if seen > TREE_SCAN_MAX_FILES {
                        return Ok(None);
                    }
                    if file_looks_like_key(&path) {
                        let rel = path
                            .strip_prefix(&root)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .replace('\\', "/");
                        return Ok(Some(UploadConcern::TreeKey(rel)));
                    }
                }
            }
        }
        Ok(None)
    }
}

/// ¿El fichero (pequeño) parece una clave privada? Los grandes no se leen.
fn file_looks_like_key(path: &Path) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > KEY_SCAN_MAX_BYTES {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = Vec::with_capacity(meta.len() as usize);
    if file.take(KEY_SCAN_MAX_BYTES).read_to_end(&mut buf).is_err() {
        return false;
    }
    looks_like_private_key(&String::from_utf8_lossy(&buf))
}

/// Textos del diálogo de subida sensible. Viven en el backend por la misma
/// razón que los de los comandos locales: el renderer solo elige el idioma.
pub struct UploadTexts {
    pub title: &'static str,
    /// Con `{name}` y `{dest}`.
    pub intro_file: &'static str,
    /// Con `{name}` y `{dest}`.
    pub intro_dir: &'static str,
    pub key: &'static str,
    pub ssh: &'static str,
    pub data: &'static str,
    pub tree_sensitive: &'static str,
    /// Con `{example}`.
    pub tree_key: &'static str,
    pub question: &'static str,
    pub accept: &'static str,
    pub cancel: &'static str,
}

pub fn upload_texts(lang: &str) -> UploadTexts {
    match lang {
        "en" => UploadTexts {
            title: "Upload a sensitive file",
            intro_file: "You are about to upload “{name}” to the server, to {dest}.",
            intro_dir: "You are about to upload the folder “{name}” to the server, to {dest}.",
            key: "It looks like a private key: whoever has it can log in wherever it logs you in.",
            ssh: "It is in your SSH keys folder (~/.ssh).",
            data: "It is in Rustty's data folder, with your connections and session logs.",
            tree_sensitive: "The folder holds your SSH keys or Rustty's data folder.",
            tree_key: "The folder contains at least one file that looks like a private key: “{example}”.",
            question: "Upload it anyway?",
            accept: "Upload anyway",
            cancel: "Cancel",
        },
        "fr" => UploadTexts {
            title: "Envoyer un fichier sensible",
            intro_file: "Vous allez envoyer « {name} » sur le serveur, dans {dest}.",
            intro_dir: "Vous allez envoyer le dossier « {name} » sur le serveur, dans {dest}.",
            key: "Il ressemble à une clé privée : qui la détient peut se connecter partout où elle vous connecte.",
            ssh: "Il se trouve dans votre dossier de clés SSH (~/.ssh).",
            data: "Il se trouve dans le dossier de données de Rustty, avec vos connexions et les journaux de session.",
            tree_sensitive: "Le dossier contient vos clés SSH ou le dossier de données de Rustty.",
            tree_key: "Le dossier contient au moins un fichier qui ressemble à une clé privée : « {example} ».",
            question: "L'envoyer quand même ?",
            accept: "Envoyer quand même",
            cancel: "Annuler",
        },
        "pt" => UploadTexts {
            title: "Enviar um ficheiro sensível",
            intro_file: "Vai enviar «{name}» para o servidor, para {dest}.",
            intro_dir: "Vai enviar a pasta «{name}» para o servidor, para {dest}.",
            key: "Parece uma chave privada: quem a tiver pode entrar onde ela lhe dá entrada.",
            ssh: "Está na sua pasta de chaves SSH (~/.ssh).",
            data: "Está na pasta de dados do Rustty, com as suas ligações e os registos de sessão.",
            tree_sensitive: "A pasta contém as suas chaves SSH ou a pasta de dados do Rustty.",
            tree_key: "A pasta contém pelo menos um ficheiro que parece uma chave privada: «{example}».",
            question: "Enviar mesmo assim?",
            accept: "Enviar mesmo assim",
            cancel: "Cancelar",
        },
        "de" => UploadTexts {
            title: "Sensible Datei hochladen",
            intro_file: "Du lädst „{name}“ auf den Server hoch, nach {dest}.",
            intro_dir: "Du lädst den Ordner „{name}“ auf den Server hoch, nach {dest}.",
            key: "Die Datei sieht wie ein privater Schlüssel aus: Wer ihn hat, kommt überall hinein, wo er dich hineinlässt.",
            ssh: "Sie liegt in deinem SSH-Schlüsselordner (~/.ssh).",
            data: "Sie liegt im Datenordner von Rustty, bei deinen Verbindungen und Sitzungsprotokollen.",
            tree_sensitive: "Der Ordner enthält deine SSH-Schlüssel oder den Datenordner von Rustty.",
            tree_key: "Der Ordner enthält mindestens eine Datei, die wie ein privater Schlüssel aussieht: „{example}“.",
            question: "Trotzdem hochladen?",
            accept: "Trotzdem hochladen",
            cancel: "Abbrechen",
        },
        _ => UploadTexts {
            title: "Subir un fichero sensible",
            intro_file: "Vas a subir «{name}» al servidor, a {dest}.",
            intro_dir: "Vas a subir la carpeta «{name}» al servidor, a {dest}.",
            key: "Parece una clave privada: quien la tenga puede entrar donde ella te deja entrar a ti.",
            ssh: "Está en tu carpeta de claves SSH (~/.ssh).",
            data: "Está en la carpeta de datos de Rustty, con tus conexiones y los registros de sesión.",
            tree_sensitive: "La carpeta contiene tus claves SSH o la carpeta de datos de Rustty.",
            tree_key: "La carpeta contiene al menos un fichero que parece una clave privada: «{example}».",
            question: "¿Subirlo igualmente?",
            accept: "Subir igualmente",
            cancel: "Cancelar",
        },
    }
}

/// Mensaje completo del diálogo para una subida con `concern`.
pub fn upload_message(
    lang: &str,
    concern: &UploadConcern,
    name: &str,
    dest: &str,
    is_dir: bool,
) -> String {
    let t = upload_texts(lang);
    let fill = |template: &str| {
        let (head, rest) = template.split_once("{name}").unwrap_or((template, ""));
        let (middle, tail) = rest.split_once("{dest}").unwrap_or((rest, ""));
        format!("{head}{name}{middle}{dest}{tail}")
    };
    let intro = fill(if is_dir { t.intro_dir } else { t.intro_file });
    let reason = match concern {
        UploadConcern::PrivateKey => t.key.to_string(),
        UploadConcern::SshDir => t.ssh.to_string(),
        UploadConcern::DataDir => t.data.to_string(),
        UploadConcern::TreeSensitive => t.tree_sensitive.to_string(),
        UploadConcern::TreeKey(example) => t.tree_key.replacen("{example}", example, 1),
    };
    format!("{intro}\n\n{reason}\n\n{}", t.question)
}

/// Error de subida rechazada por el usuario.
pub fn rejected_error(name: &str) -> String {
    error("rejected", name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rustty-fsguard-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    /// Clave de mentira montada en ejecución (ver `file_grants::tests`: escrita
    /// tal cual, gitleaks la toma por una filtrada).
    fn fake_key() -> String {
        let edge = |e: &str| format!("-----{e} OPENSSH {}-----", "PRIVATE KEY");
        format!("{}\nb3Blbn\n{}\n", edge("BEGIN"), edge("END"))
    }

    struct Fixture {
        home: PathBuf,
        data: PathBuf,
        guard: LocalFsGuard,
    }

    fn fixture(tag: &str) -> Fixture {
        let home = test_dir(tag);
        let data = home.join(".local/share/com.rustty.app");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("trusted_local_commands.json"), "{}").unwrap();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let guard = LocalFsGuard::new(&data, Some(&home));
        Fixture { home, data, guard }
    }

    #[test]
    fn la_carpeta_de_datos_no_se_toca_desde_el_panel() {
        let f = fixture("write");
        let target = f.data.join("trusted_local_commands.json");
        let err = f.guard.check_write(&target).unwrap_err();
        assert!(err.starts_with("local-fs:protected|"), "{err}");
        assert!(f.guard.check_write(&f.data.join("nuevo/fichero")).is_err());
        assert!(f.guard.check_remove(&target).is_err());
        // Fuera de ella, todo normal.
        assert!(f.guard.check_write(&f.home.join("descarga.txt")).is_ok());
        assert!(f.guard.check_remove(&f.home.join("descarga.txt")).is_ok());
    }

    #[test]
    fn no_se_borra_ni_se_mueve_una_carpeta_que_la_contenga() {
        let f = fixture("ancestor");
        assert!(f.guard.check_remove(&f.home.join(".local")).is_err());
        assert!(f.guard.check_remove(&f.home).is_err());
        // Escribir dentro de un ancestro, en otro sitio, sí.
        assert!(f.guard.check_write(&f.home.join(".local/otra.txt")).is_ok());
    }

    #[test]
    fn dotdot_no_sirve_para_colarse() {
        let f = fixture("dotdot");
        std::fs::create_dir_all(f.home.join("a")).unwrap();
        let sneaky = f.home.join("a/../.local/share/com.rustty.app/x.json");
        assert!(f.guard.check_write(&sneaky).is_err());
        // Un `..` en la parte que no existe se rechaza.
        let unresolvable = f
            .home
            .join("noexiste/../.local/share/com.rustty.app/x.json");
        let err = f.guard.check_write(&unresolvable).unwrap_err();
        assert!(err.starts_with("local-fs:"), "{err}");
        assert!(f.guard.check_write(Path::new("relativa.txt")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn un_enlace_hacia_la_carpeta_de_datos_no_sirve_de_atajo() {
        let f = fixture("symlink");
        let link = f.home.join("atajo");
        std::os::unix::fs::symlink(&f.data, &link).unwrap();
        assert!(f
            .guard
            .check_write(&link.join("trusted_local_commands.json"))
            .is_err());
        let file_link = f.home.join("inofensivo.json");
        std::os::unix::fs::symlink(f.data.join("trusted_local_commands.json"), &file_link).unwrap();
        assert!(f.guard.check_write(&file_link).is_err());
    }

    #[test]
    fn subir_una_clave_pregunta_este_donde_este() {
        let f = fixture("key");
        let key = f.home.join("proyectos/prod.pem");
        std::fs::create_dir_all(key.parent().unwrap()).unwrap();
        std::fs::write(&key, fake_key()).unwrap();
        assert_eq!(
            f.guard.upload_concern(&key).unwrap(),
            Some(UploadConcern::PrivateKey)
        );
        // Renombrada a `.pub` dentro de ~/.ssh sigue siendo una clave.
        let disguised = f.home.join(".ssh/id_ed25519.pub");
        std::fs::write(&disguised, fake_key()).unwrap();
        assert_eq!(
            f.guard.upload_concern(&disguised).unwrap(),
            Some(UploadConcern::PrivateKey)
        );
        let normal = f.home.join("notas.txt");
        std::fs::write(&normal, "hola").unwrap();
        assert_eq!(f.guard.upload_concern(&normal).unwrap(), None);
    }

    #[test]
    fn en_ssh_pregunta_salvo_lo_publico() {
        let f = fixture("ssh");
        let ssh = f.home.join(".ssh");
        for (name, expected) in [
            ("id_ed25519.pub", None),
            ("known_hosts", None),
            ("config", None),
            ("authorized_keys", None),
            ("mi_token", Some(UploadConcern::SshDir)),
        ] {
            std::fs::write(ssh.join(name), "ssh-ed25519 AAAA usuario@equipo\n").unwrap();
            assert_eq!(
                f.guard.upload_concern(&ssh.join(name)).unwrap(),
                expected,
                "{name}"
            );
        }
    }

    #[test]
    fn lo_que_sale_de_la_carpeta_de_datos_pregunta() {
        let f = fixture("data-upload");
        let log = f.data.join("session_logs/servidor.log");
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        std::fs::write(&log, "salida").unwrap();
        assert_eq!(
            f.guard.upload_concern(&log).unwrap(),
            Some(UploadConcern::DataDir)
        );
    }

    #[test]
    fn subir_una_carpeta_pregunta_si_contiene_algo_sensible() {
        let f = fixture("tree");
        // El HOME entero contiene ~/.ssh y la carpeta de datos.
        assert_eq!(
            f.guard.upload_dir_concern(&f.home).unwrap(),
            Some(UploadConcern::TreeSensitive)
        );
        assert_eq!(
            f.guard.upload_dir_concern(&f.home.join(".ssh")).unwrap(),
            Some(UploadConcern::TreeSensitive)
        );
        let web = f.home.join("web");
        std::fs::create_dir_all(web.join("certs")).unwrap();
        std::fs::write(web.join("index.html"), "<html></html>").unwrap();
        assert_eq!(f.guard.upload_dir_concern(&web).unwrap(), None);
        std::fs::write(web.join("certs/tls.key"), fake_key()).unwrap();
        assert_eq!(
            f.guard.upload_dir_concern(&web).unwrap(),
            Some(UploadConcern::TreeKey("certs/tls.key".into()))
        );
    }

    #[test]
    fn el_mensaje_nombra_el_fichero_el_destino_y_el_motivo() {
        let msg = upload_message(
            "es",
            &UploadConcern::PrivateKey,
            "prod.pem",
            "/root/prod.pem",
            false,
        );
        assert!(
            msg.contains("«prod.pem»") && msg.contains("/root/prod.pem"),
            "{msg}"
        );
        assert!(msg.contains("clave privada"));
        let msg = upload_message(
            "en",
            &UploadConcern::TreeKey("a/b.key".into()),
            "web",
            "/srv",
            true,
        );
        assert!(
            msg.contains("folder “web”") && msg.contains("“a/b.key”"),
            "{msg}"
        );
    }
}
