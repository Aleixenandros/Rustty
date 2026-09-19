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
//! - **fish**: `fish --init-command "source <dir>/rustty-fish.fish"`.
//!   `--init-command` se evalúa **después** de `config.fish`, que es lo que
//!   permite envolver la `fish_prompt` que haya quedado definida —la del
//!   usuario o la de fish— sin tocar sus ficheros ni `XDG_DATA_DIRS` (un
//!   snippet en `conf.d` se carga antes y el usuario lo pisaría). `C`/`D` van
//!   por los eventos `fish_preexec`/`fish_postexec`.
//! - **PowerShell**: `-NoExit -Command "try { . '<dir>/rustty.ps1' } catch {}"`,
//!   que se ejecuta tras los perfiles del usuario. El prompt se envuelve
//!   guardando el `$function:prompt` vigente, y la `C` se engancha a
//!   `PSConsoleHostReadLine` (PSReadLine), el único punto entre el Intro y la
//!   ejecución; sin PSReadLine se queda sin `C`. Si la directiva de ejecución
//!   (`Restricted`) impide cargar el fichero, el `catch` deja la consola
//!   arrancar sin marcas en vez de con un error.
//! - **Otros** (cmd, sh): sin integración; el shell arranca como siempre.

use std::path::Path;

/// Familia del shell que se va a lanzar, por el nombre del ejecutable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
    Fish,
    PowerShell,
    Other,
}

impl ShellKind {
    /// `/usr/bin/zsh` → `Zsh`; `bash` → `Bash`; `/bin/fish` → `Fish`;
    /// `pwsh.exe` → `PowerShell`; `/bin/sh` → `Other`.
    pub fn detect(shell: &str) -> Self {
        // El último segmento, partiendo por los DOS separadores: una ruta de
        // Windows (`C:\...\pwsh.exe`) llega entera si se mira con las reglas
        // de Unix, y `Path::file_name` devolvería la ruta completa.
        let name = shell.rsplit(['/', '\\']).next().unwrap_or("");
        // En minúsculas y sin `.exe`: en Windows el nombre del ejecutable no
        // distingue mayúsculas y `COMSPEC`/el registro pueden darlo en
        // cualquier caja.
        let name = name.to_ascii_lowercase();
        let name = name.strip_suffix(".exe").unwrap_or(&name);
        match name {
            "bash" => Self::Bash,
            "zsh" => Self::Zsh,
            "fish" => Self::Fish,
            "pwsh" | "powershell" => Self::PowerShell,
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
const FISH_FILE: &str = "rustty-fish.fish";
const PWSH_FILE: &str = "rustty.ps1";

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

/// Fichero de arranque de fish (`--init-command`).
pub const FISH_CONF: &str = r#"# Integracion de shell de Rustty para fish. Generado por Rustty: los cambios
# se pierden al abrir la siguiente consola. Se carga con --init-command, o sea
# DESPUES de tu config.fish, para poder envolver la fish_prompt que ya haya.
if not set -q __rustty_integrated
    set -g __rustty_integrated 1

    function __rustty_osc
        printf '\033]%s\a' $argv[1]
    end

    # C (empieza la salida) y D (acaba el comando, con su estado).
    function __rustty_preexec --on-event fish_preexec
        set -g __rustty_cmd_ran 1
        __rustty_osc "133;C"
    end
    function __rustty_postexec --on-event fish_postexec
        set -l st $status
        if set -q __rustty_cmd_ran
            __rustty_osc "133;D;$st"
            set -e __rustty_cmd_ran
        end
    end

    # A (prompt nuevo), el cwd y B (fin del prompt) envolviendo la funcion de
    # prompt vigente: la tuya si la has definido, si no la de fish.
    if functions -q fish_prompt
        functions --copy fish_prompt __rustty_user_prompt
    else
        function __rustty_user_prompt
            printf '%s> ' (prompt_pwd)
        end
    end
    function fish_prompt
        __rustty_osc "7;file://$hostname$PWD"
        __rustty_osc "133;A"
        __rustty_user_prompt
        __rustty_osc "133;B"
    end
end
"#;

/// Fichero de arranque de PowerShell (`-NoExit -Command`).
pub const PWSH_PROFILE: &str = r#"# Integracion de shell de Rustty para PowerShell. Generado por Rustty: los
# cambios se pierden al abrir la siguiente consola. Se carga tras tus perfiles,
# asi que el prompt que se envuelve es el que ya estuviera puesto.
if (-not $global:__RusttyIntegrated) {
    $global:__RusttyIntegrated = $true
    $global:__RusttyOriginalPrompt = $function:prompt
    $global:__RusttyCmdRan = $false

    function global:__RusttyOsc([string] $Data) {
        return "$([char]0x1b)]$Data$([char]0x07)"
    }

    function global:prompt {
        # $? del ultimo comando: se lee lo primero, antes de que nada lo pise.
        $ok = $?
        $code = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
        $out = ''
        if ($global:__RusttyCmdRan) {
            $out += __RusttyOsc "133;D;$code"
            $global:__RusttyCmdRan = $false
        }
        $cwd = (Get-Location).Path -replace '\\', '/'
        if (-not $cwd.StartsWith('/')) { $cwd = "/$cwd" }
        $out += __RusttyOsc "7;file://$([System.Net.Dns]::GetHostName())$cwd"
        $out += __RusttyOsc "133;A"
        if ($global:__RusttyOriginalPrompt) {
            $out += & $global:__RusttyOriginalPrompt
        } else {
            $out += "PS $cwd> "
        }
        $out += __RusttyOsc "133;B"
        return $out
    }

    # C (empieza la salida): PSReadLine entrega la linea por
    # PSConsoleHostReadLine, el unico punto entre el Intro y la ejecucion.
    # Sin PSReadLine no hay donde engancharlo y esta consola se queda sin C.
    if (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue) {
        $global:__RusttyOriginalReadLine = $function:PSConsoleHostReadLine
        function global:PSConsoleHostReadLine {
            $line = & $global:__RusttyOriginalReadLine
            $global:__RusttyCmdRan = $true
            [Console]::Write((__RusttyOsc "133;C"))
            return $line
        }
    }
}
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
        ShellKind::Fish => {
            let conf = dir.join(FISH_FILE);
            ensure_file(&conf, FISH_CONF)?;
            Ok(Some(Launch {
                args: vec![
                    "--init-command".to_string(),
                    format!("source {}", fish_quote(&path_string(&conf))),
                ],
                env: Vec::new(),
            }))
        }
        ShellKind::PowerShell => {
            let script = dir.join(PWSH_FILE);
            ensure_file(&script, PWSH_PROFILE)?;
            Ok(Some(Launch {
                args: vec![
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    // El `catch` vacío es deliberado: si la directiva de
                    // ejecución no deja cargar el fichero, la consola abre sin
                    // marcas en vez de recibir al usuario con un error rojo.
                    format!(
                        "try {{ . {} }} catch {{ }}",
                        pwsh_quote(&path_string(&script))
                    ),
                ],
                env: Vec::new(),
            }))
        }
        ShellKind::Other => Ok(None),
    }
}

/// Entrecomilla una ruta para fish. Entre comillas simples fish solo interpreta
/// `\'` y `\\`, así que basta con escapar esos dos.
fn fish_quote(path: &str) -> String {
    format!("'{}'", path.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// Entrecomilla una ruta para PowerShell. Entre comillas simples el único
/// escape es duplicar la comilla.
fn pwsh_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "''"))
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
        assert_eq!(ShellKind::detect("/usr/bin/fish"), ShellKind::Fish);
        assert_eq!(ShellKind::detect("pwsh.exe"), ShellKind::PowerShell);
        assert_eq!(ShellKind::detect("powershell.EXE"), ShellKind::PowerShell);
        assert_eq!(
            ShellKind::detect(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            ShellKind::PowerShell
        );
        assert_eq!(ShellKind::detect("/bin/sh"), ShellKind::Other);
        assert_eq!(ShellKind::detect(""), ShellKind::Other);
    }

    #[test]
    fn los_scripts_llevan_las_cuatro_marcas_y_el_cwd() {
        for script in [BASH_RC, ZSH_RC, FISH_CONF, PWSH_PROFILE] {
            for mark in ["133;A", "133;B", "133;C", "133;D;", "7;file://"] {
                assert!(script.contains(mark), "falta {mark}");
            }
        }
        // Cada uno carga la configuracion del usuario antes de tocar nada.
        assert!(BASH_RC.contains(". \"$HOME/.bashrc\""));
        assert!(ZSH_ENV.contains(". \"$ZDOTDIR/.zshenv\""));
        assert!(ZSH_RC.contains(". \"$RUSTTY_USER_ZDOTDIR/.zshrc\""));
        // fish y PowerShell no cargan nada del usuario: su fichero se evalúa
        // DESPUÉS de la configuración (`--init-command` / `-Command`), que es
        // justo lo que permite envolver el prompt que ya haya.
        assert!(FISH_CONF.contains("functions --copy fish_prompt __rustty_user_prompt"));
        assert!(PWSH_PROFILE.contains("$global:__RusttyOriginalPrompt = $function:prompt"));
    }

    #[test]
    fn fish_y_powershell_reciben_su_fichero_de_arranque() {
        let dir = tempdir("launch-fish-pwsh");
        let base = dir.join(DIR_NAME);

        let fish = prepare(&dir, ShellKind::Fish).unwrap().unwrap();
        let conf = base.join(FISH_FILE);
        assert_eq!(
            fish.args,
            vec![
                "--init-command".to_string(),
                format!("source '{}'", path_string(&conf)),
            ]
        );
        assert!(fish.env.is_empty());
        assert_eq!(std::fs::read_to_string(&conf).unwrap(), FISH_CONF);

        let pwsh = prepare(&dir, ShellKind::PowerShell).unwrap().unwrap();
        let script = base.join(PWSH_FILE);
        assert_eq!(pwsh.args[0], "-NoExit");
        assert_eq!(pwsh.args[1], "-Command");
        assert_eq!(
            pwsh.args[2],
            format!("try {{ . '{}' }} catch {{ }}", path_string(&script))
        );
        assert!(pwsh.env.is_empty());
        assert_eq!(std::fs::read_to_string(&script).unwrap(), PWSH_PROFILE);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Una ruta con comilla o barra invertida no puede romper el `source` de
    /// fish ni el dot-source de PowerShell: un directorio de datos con un
    /// apóstrofo en el nombre del usuario es un caso real, no rebuscado.
    #[test]
    fn las_rutas_con_comillas_van_entrecomilladas() {
        assert_eq!(fish_quote("/home/ana/datos"), "'/home/ana/datos'");
        assert_eq!(fish_quote("/home/o'hara/d"), r"'/home/o\'hara/d'");
        assert_eq!(fish_quote(r"C:\Users\ana"), r"'C:\\Users\\ana'");
        assert_eq!(pwsh_quote(r"C:\Users\ana"), r"'C:\Users\ana'");
        assert_eq!(pwsh_quote("C:\\o'hara"), "'C:\\o''hara'");
    }

    /// Si la máquina tiene fish, que al menos el script **parsee**: un error de
    /// sintaxis en `--init-command` deja la consola sin prompt. Sin fish
    /// instalado (el caso del CI) la prueba no puede decir nada y se salta.
    #[test]
    fn el_script_de_fish_parsea_si_hay_fish() {
        use std::process::Command;
        let dir = tempdir("fish-parse");
        let conf = dir.join(DIR_NAME).join(FISH_FILE);
        let _ = prepare(&dir, ShellKind::Fish).unwrap();
        // `--no-execute` solo comprueba la sintaxis.
        if let Ok(out) = Command::new("fish").arg("--no-execute").arg(&conf).output() {
            assert!(
                out.status.success(),
                "fish -n rechaza el script: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
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
