//! Integración de shell para la consola local: marcas OSC 133 (bloques de
//! comando, aviso de fin de comando largo) y OSC 7 (directorio actual) en bash
//! y zsh, **sin tocar los dotfiles del usuario**.
//!
//! El shell arranca con un fichero de inicio propio que primero carga la
//! configuración del usuario, tal como haría el shell a secas, y después
//! instala los hooks. Los ficheros viven en el directorio de datos de Rustty
//! (`shell-integration/`) y se regeneran al abrir una consola si su contenido
//! no es el de esta versión. Es opt-in (Preferencias → Terminal): cambia cómo
//! se lanza el shell.
//!
//! - **bash**: `bash --rcfile <dir>/rustty-bash.sh`. `--rcfile` sustituye a
//!   `~/.bashrc`, así que el fichero lo carga él mismo. El fin de comando
//!   (`D;exit`) va al **principio** de `PROMPT_COMMAND`, para leer `$?` antes
//!   de que otro hook lo pise; el prompt nuevo (`A`), el cwd (OSC 7) y la marca
//!   de fin de prompt (`B`, sufijo de `PS1`) van al **final**, detrás de los
//!   temas que reescriben `PS1` en cada prompt; y el inicio de la salida (`C`)
//!   va en `PS0` (bash ≥ 4.4), que se expande tras leer el comando y antes de
//!   ejecutarlo.
//! - **zsh**: `ZDOTDIR` apunta a `<dir>/zsh`, cuyos `.zshenv` y `.zshrc` cargan
//!   los del usuario (`RUSTTY_USER_ZDOTDIR`, que sigue a un `.zshenv` que mueva
//!   `ZDOTDIR` a `~/.config/zsh`) y devuelven `ZDOTDIR` a su valor, para que un
//!   zsh anidado no vuelva a pasar por aquí. Los hooks van por
//!   `precmd`/`preexec`.
//! - **Otros** (fish, PowerShell, cmd, sh): sin integración; el shell arranca
//!   como siempre.

use std::path::Path;

/// Familia del shell que se va a lanzar, por el nombre del ejecutable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
    Other,
}

impl ShellKind {
    /// `/usr/bin/zsh` → `Zsh`; `bash` → `Bash`; `pwsh.exe`, `/bin/fish` → `Other`.
    pub fn detect(shell: &str) -> Self {
        let name = Path::new(shell)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let name = name.strip_suffix(".exe").unwrap_or(name);
        match name {
            "bash" => Self::Bash,
            "zsh" => Self::Zsh,
            _ => Self::Other,
        }
    }
}

/// Lo que hay que añadir al lanzamiento del shell para que arranque integrado.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Launch {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Subdirectorio del directorio de datos con los ficheros de arranque.
pub const DIR_NAME: &str = "shell-integration";
const BASH_FILE: &str = "rustty-bash.sh";
const ZSH_DIR: &str = "zsh";

/// Fichero de inicio de bash (`--rcfile`).
pub const BASH_RC: &str = r#"# Integracion de shell de Rustty para bash. Generado por Rustty: los cambios
# se pierden al abrir la siguiente consola. Primero carga tu configuracion,
# como haria bash sin --rcfile; despues instala las marcas OSC 133 y OSC 7.
if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
elif [ -f /etc/bashrc ]; then
  . /etc/bashrc
elif [ -f /etc/bash.bashrc ]; then
  . /etc/bash.bashrc
fi

if [ -z "$__rustty_integrated" ] && [ -n "$BASH_VERSION" ]; then
  __rustty_integrated=1
  __rustty_osc() { printf '\033]%s\033\\' "$1"; }
  # Al principio de PROMPT_COMMAND: lee $? antes de que otro hook lo pise.
  __rustty_precmd_first() {
    local st=$?
    if [ -n "$__rustty_cmd_ran" ]; then
      __rustty_osc "133;D;$st"
      __rustty_cmd_ran=
    fi
  }
  # Al final: cwd, prompt nuevo y la marca de fin de prompt como sufijo de PS1,
  # detras de los temas que reescriben PS1 en cada prompt.
  __rustty_ps1_mark='\[\e]133;B\e\\\]'
  __rustty_precmd_last() {
    __rustty_osc "7;file://${HOSTNAME}${PWD}"
    __rustty_osc "133;A"
    case "$PS1" in
      *"$__rustty_ps1_mark") ;;
      *) PS1="${PS1}${__rustty_ps1_mark}" ;;
    esac
  }
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__rustty_precmd_first "${PROMPT_COMMAND[@]}" __rustty_precmd_last)
  else
    PROMPT_COMMAND="__rustty_precmd_first${PROMPT_COMMAND:+;$PROMPT_COMMAND};__rustty_precmd_last"
  fi
  # PS0 se expande tras leer el comando y antes de ejecutarlo: inicio de la
  # salida. La expansion ${...:=1} anota que hubo comando (para el D) sin
  # imprimir nada fuera de la secuencia.
  PS0="${PS0}"'\e]133;C;${__rustty_cmd_ran:=1}\e\\'
fi
"#;

/// `.zshenv` del `ZDOTDIR` propio: carga el del usuario y deja `ZDOTDIR`
/// apuntando aquí para que zsh lea a continuación nuestro `.zshrc`.
pub const ZSH_ENV: &str = r#"# Integracion de shell de Rustty para zsh (generado por Rustty). Carga tu
# .zshenv y deja ZDOTDIR apuntando aqui hasta que .zshrc lo devuelva.
__rustty_zdotdir="$ZDOTDIR"
ZDOTDIR="$RUSTTY_USER_ZDOTDIR"
if [[ -f "$ZDOTDIR/.zshenv" ]]; then
  . "$ZDOTDIR/.zshenv"
fi
# Si tu .zshenv movio ZDOTDIR (p. ej. a ~/.config/zsh), .zshrc se busca alli.
export RUSTTY_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
ZDOTDIR="$__rustty_zdotdir"
unset __rustty_zdotdir
"#;

/// `.zshrc` del `ZDOTDIR` propio: carga el del usuario, restaura `ZDOTDIR` e
/// instala los hooks.
pub const ZSH_RC: &str = r#"# Integracion de shell de Rustty para zsh (generado por Rustty). Carga tu
# .zshrc, devuelve ZDOTDIR a su sitio e instala las marcas OSC 133 y OSC 7.
if [[ -f "$RUSTTY_USER_ZDOTDIR/.zshrc" ]]; then
  ZDOTDIR="$RUSTTY_USER_ZDOTDIR"
  . "$RUSTTY_USER_ZDOTDIR/.zshrc"
fi
if [[ "$RUSTTY_USER_ZDOTDIR" == "$HOME" ]]; then
  unset ZDOTDIR
else
  ZDOTDIR="$RUSTTY_USER_ZDOTDIR"
fi

if [[ -z "$__rustty_integrated" ]]; then
  __rustty_integrated=1
  __rustty_osc() { printf '\033]%s\033\\' "$1"; }
  __rustty_precmd() {
    local st=$?
    if [[ -n "$__rustty_cmd_ran" ]]; then
      __rustty_osc "133;D;$st"
      __rustty_cmd_ran=
    fi
    __rustty_osc "7;file://${HOST}${PWD}"
    __rustty_osc "133;A"
  }
  __rustty_preexec() {
    __rustty_cmd_ran=1
    __rustty_osc "133;C"
  }
  __rustty_ps1_mark=$'%{\e]133;B\e\\%}'
  __rustty_mark_prompt() {
    [[ "$PROMPT" == *"$__rustty_ps1_mark" ]] || PROMPT="${PROMPT}${__rustty_ps1_mark}"
  }
  autoload -Uz add-zsh-hook
  # El de $? va el primero, antes de que otro hook lo pise; el del prompt, el
  # ultimo, detras de los temas que reescriben PROMPT en cada prompt.
  typeset -ga precmd_functions
  precmd_functions=(__rustty_precmd "${precmd_functions[@]}")
  add-zsh-hook precmd __rustty_mark_prompt
  add-zsh-hook preexec __rustty_preexec
fi
"#;

/// Deja escritos los ficheros de arranque de `kind` bajo `data_dir` y devuelve
/// lo que hay que añadir al lanzamiento. `Ok(None)` = shell sin integración.
///
/// Los ficheros se escriben de forma atómica y solo si su contenido no es ya
/// el de esta versión: un shell que los esté leyendo nunca ve un fichero a
/// medias, y abrir una consola no cuesta un `fsync` cada vez.
pub fn prepare(data_dir: &Path, kind: ShellKind) -> std::io::Result<Option<Launch>> {
    let dir = data_dir.join(DIR_NAME);
    match kind {
        ShellKind::Bash => {
            let rc = dir.join(BASH_FILE);
            ensure_file(&rc, BASH_RC)?;
            Ok(Some(Launch {
                args: vec!["--rcfile".to_string(), path_string(&rc)],
                env: Vec::new(),
            }))
        }
        ShellKind::Zsh => {
            let zdir = dir.join(ZSH_DIR);
            ensure_file(&zdir.join(".zshenv"), ZSH_ENV)?;
            ensure_file(&zdir.join(".zshrc"), ZSH_RC)?;
            Ok(Some(Launch {
                args: Vec::new(),
                env: vec![
                    ("ZDOTDIR".to_string(), path_string(&zdir)),
                    ("RUSTTY_USER_ZDOTDIR".to_string(), user_zdotdir()),
                ],
            }))
        }
        ShellKind::Other => Ok(None),
    }
}

/// `ZDOTDIR` del usuario si lo tiene en el entorno; si no, su carpeta personal.
fn user_zdotdir() -> String {
    std::env::var("ZDOTDIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|h| path_string(&h)))
        .unwrap_or_default()
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Escribe `content` en `path` salvo que ya esté ahí tal cual. Devuelve si
/// ha escrito.
fn ensure_file(path: &Path, content: &str) -> std::io::Result<bool> {
    if std::fs::read(path)
        .map(|current| current == content.as_bytes())
        .unwrap_or(false)
    {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::atomic_file::write(path, content.as_bytes(), false)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tempdir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "rustty-shell-integration-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detecta_el_shell_por_el_nombre_del_ejecutable() {
        assert_eq!(ShellKind::detect("/usr/bin/bash"), ShellKind::Bash);
        assert_eq!(ShellKind::detect("bash"), ShellKind::Bash);
        assert_eq!(ShellKind::detect("/bin/zsh"), ShellKind::Zsh);
        assert_eq!(ShellKind::detect("/usr/local/bin/zsh"), ShellKind::Zsh);
        assert_eq!(ShellKind::detect("/usr/bin/fish"), ShellKind::Other);
        assert_eq!(ShellKind::detect("pwsh.exe"), ShellKind::Other);
        assert_eq!(ShellKind::detect("/bin/sh"), ShellKind::Other);
        assert_eq!(ShellKind::detect(""), ShellKind::Other);
    }

    #[test]
    fn los_scripts_llevan_las_cuatro_marcas_y_el_cwd() {
        for script in [BASH_RC, ZSH_RC] {
            for mark in ["133;A", "133;B", "133;C", "133;D;", "7;file://"] {
                assert!(script.contains(mark), "falta {mark}");
            }
        }
        // Cada uno carga la configuracion del usuario antes de tocar nada.
        assert!(BASH_RC.contains(". \"$HOME/.bashrc\""));
        assert!(ZSH_ENV.contains(". \"$ZDOTDIR/.zshenv\""));
        assert!(ZSH_RC.contains(". \"$RUSTTY_USER_ZDOTDIR/.zshrc\""));
    }

    #[test]
    fn bash_recibe_rcfile_y_zsh_su_zdotdir() {
        let dir = tempdir("launch");
        let bash = prepare(&dir, ShellKind::Bash).unwrap().unwrap();
        let rc = dir.join(DIR_NAME).join(BASH_FILE);
        assert_eq!(bash.args, vec!["--rcfile".to_string(), path_string(&rc)]);
        assert!(bash.env.is_empty());
        assert_eq!(std::fs::read_to_string(&rc).unwrap(), BASH_RC);

        let zsh = prepare(&dir, ShellKind::Zsh).unwrap().unwrap();
        let zdir = dir.join(DIR_NAME).join(ZSH_DIR);
        assert!(zsh.args.is_empty());
        assert_eq!(zsh.env[0], ("ZDOTDIR".to_string(), path_string(&zdir)));
        assert_eq!(zsh.env[1].0, "RUSTTY_USER_ZDOTDIR");
        assert!(!zsh.env[1].1.is_empty());
        assert_eq!(std::fs::read_to_string(zdir.join(".zshenv")).unwrap(), ZSH_ENV);
        assert_eq!(std::fs::read_to_string(zdir.join(".zshrc")).unwrap(), ZSH_RC);

        assert_eq!(prepare(&dir, ShellKind::Other).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn los_ficheros_solo_se_reescriben_si_cambian() {
        let dir = tempdir("rewrite");
        let rc = dir.join("rc.sh");
        assert!(ensure_file(&rc, "uno").unwrap());
        assert!(!ensure_file(&rc, "uno").unwrap());
        assert!(ensure_file(&rc, "dos").unwrap());
        assert_eq!(std::fs::read_to_string(&rc).unwrap(), "dos");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Camino real: un bash interactivo con el rcfile generado emite las
    /// marcas. Solo Linux: el bash de macOS es 3.2 (sin `PS0`) y en Windows no
    /// hay bash.
    #[cfg(target_os = "linux")]
    #[test]
    fn bash_real_emite_las_marcas_osc_con_el_rcfile() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let dir = tempdir("bash-real");
        let launch = prepare(&dir, ShellKind::Bash).unwrap().unwrap();
        // HOME vacio: sin el .bashrc del usuario, la prueba solo mide el rcfile.
        let mut child = Command::new("bash")
            .args(&launch.args)
            .arg("-i")
            .env("HOME", &dir)
            .env("PS1", "$ ")
            .env_remove("PROMPT_COMMAND")
            .env_remove("PS0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("bash disponible");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"echo rustty-ok\nfalse\nexit\n")
            .unwrap();
        let out = child.wait_with_output().unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(text.contains("rustty-ok"), "{text:?}");
        assert!(text.contains("\x1b]133;A\x1b\\"), "sin A: {text:?}");
        assert!(text.contains("\x1b]133;B\x1b\\"), "sin B: {text:?}");
        assert!(text.contains("\x1b]133;C;1\x1b\\"), "sin C: {text:?}");
        assert!(text.contains("\x1b]133;D;0\x1b\\"), "sin D del echo: {text:?}");
        assert!(text.contains("\x1b]133;D;1\x1b\\"), "sin D del false: {text:?}");
        assert!(text.contains("\x1b]7;file://"), "sin OSC 7: {text:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
