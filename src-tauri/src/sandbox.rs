//! Escape controlado del sandbox de Flatpak.
//!
//! Rustty es un cliente de acceso remoto: la consola local, el cliente RDP y
//! los visores externos (VNC, telnet) son programas del **sistema del usuario**,
//! no del contenedor. Dentro del sandbox el `sh` que se abriría es el del
//! runtime —sin sus dotfiles, sin sus herramientas— y `xfreerdp` sencillamente
//! no existe. La vía admitida es `flatpak-spawn --host`, que delega en el
//! portal `org.freedesktop.Flatpak.Development` (permiso
//! `--talk-name=org.freedesktop.Flatpak` en el manifest); es la misma que usan
//! los emuladores de terminal publicados en Flathub (Ptyxis, Black Box).
//!
//! Fuera de Flatpak todo este módulo es transparente: devuelve el comando tal
//! cual, sin envoltorio ni coste.

use std::path::Path;
use std::process::Command;

use portable_pty::CommandBuilder;

/// Ruta que Flatpak monta dentro de todo sandbox; su existencia es la
/// comprobación canónica (la usan `flatpak-spawn`, GLib y systemd).
const FLATPAK_INFO: &str = "/.flatpak-info";

/// Opciones del lanzamiento en el host. Todo lo que `flatpak-spawn` necesita
/// saber **antes** del nombre del programa, porque sus banderas van delante.
#[derive(Default)]
pub struct HostSpawn<'a> {
    /// Directorio de trabajo. Dentro del sandbox no basta con `Command::cwd`:
    /// el proceso nace en el host y hay que pasarlo por `--directory`.
    pub cwd: Option<&'a Path>,
    /// Descriptores que el proceso del host debe heredar conservando su
    /// número. Sin esto `flatpak-spawn` solo pasa 0, 1 y 2.
    pub forward_fds: &'a [i32],
}

/// ¿Corremos dentro de un sandbox de Flatpak?
///
/// El resultado se cachea: se consulta en cada spawn y no puede cambiar
/// durante la vida del proceso.
pub fn in_flatpak() -> bool {
    use std::sync::OnceLock;
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| Path::new(FLATPAK_INFO).exists())
}

/// Banderas de `flatpak-spawn` previas al programa, en orden.
///
/// `--watch-bus` ata el proceso del host a la conexión de Rustty: si la app
/// muere, el shell o el cliente RDP no quedan huérfanos.
fn spawn_args(opts: &HostSpawn) -> Vec<String> {
    let mut args = vec!["--host".to_string(), "--watch-bus".to_string()];
    if let Some(dir) = opts.cwd {
        args.push(format!("--directory={}", dir.display()));
    }
    for fd in opts.forward_fds {
        args.push(format!("--forward-fd={fd}"));
    }
    args
}

/// `Command` que ejecuta `program` en el host cuando estamos en Flatpak, y
/// directamente en el sistema cuando no.
///
/// Las variables de entorno puestas con `.env()` sobre el `Command` devuelto
/// llegan al proceso del host: `flatpak-spawn` reenvía su propio entorno salvo
/// que se le pase `--clear-env`.
pub fn host_command(program: &str, opts: HostSpawn) -> Command {
    if !in_flatpak() {
        let mut cmd = Command::new(program);
        if let Some(dir) = opts.cwd {
            cmd.current_dir(dir);
        }
        return cmd;
    }
    let mut cmd = Command::new("flatpak-spawn");
    cmd.args(spawn_args(&opts));
    cmd.arg(program);
    cmd
}

/// Equivalente para `portable_pty`: el shell local necesita un PTY, así que se
/// construye con `CommandBuilder` en vez de `std::process::Command`.
///
/// El PTY lo abre Rustty dentro del sandbox y `flatpak-spawn` hereda sus
/// descriptores estándar, de modo que el shell del host queda conectado al
/// mismo terminal: el redimensionado y las señales de trabajo siguen
/// funcionando.
pub fn host_pty_command(program: &str, cwd: Option<&Path>) -> CommandBuilder {
    if !in_flatpak() {
        let mut cmd = CommandBuilder::new(program);
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        return cmd;
    }
    let mut cmd = CommandBuilder::new("flatpak-spawn");
    for arg in spawn_args(&HostSpawn {
        cwd,
        ..Default::default()
    }) {
        cmd.arg(arg);
    }
    cmd.arg(program);
    cmd
}

/// ¿Existe `program` en el `PATH`? Dentro de Flatpak pregunta por el `PATH`
/// **del host**, que es donde se va a ejecutar de verdad.
pub fn host_which(program: &str) -> bool {
    host_command("which", HostSpawn::default())
        .arg(program)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Login shell real del usuario en el host.
///
/// Fuera del sandbox `$SHELL` ya lo dice. Dentro, `$SHELL` viene del entorno
/// del contenedor y puede apuntar a un binario que en el host no existe, así
/// que se consulta la base de datos de usuarios del sistema anfitrión.
/// Devuelve `None` si la consulta falla, para que quien llame decida el
/// fallback.
pub fn host_login_shell() -> Option<String> {
    if !in_flatpak() {
        return std::env::var("SHELL").ok().filter(|s| !s.is_empty());
    }
    let out = host_command("sh", HostSpawn::default())
        .args(["-c", "getent passwd \"$(id -u)\" | cut -d: -f7"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let shell = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!shell.is_empty()).then_some(shell)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_args_ponen_host_y_watch_bus_primero() {
        let args = spawn_args(&HostSpawn::default());
        assert_eq!(args, vec!["--host", "--watch-bus"]);
    }

    #[test]
    fn spawn_args_incluyen_directorio_y_descriptores() {
        let dir = Path::new("/home/user/proyectos");
        let args = spawn_args(&HostSpawn {
            cwd: Some(dir),
            forward_fds: &[3],
        });
        assert!(args.contains(&"--directory=/home/user/proyectos".to_string()));
        assert!(args.contains(&"--forward-fd=3".to_string()));
        // Las banderas van antes del programa: `--host` sigue siendo la primera.
        assert_eq!(args[0], "--host");
    }

    /// Los módulos que lanzan **programas del sistema del usuario** tienen que
    /// pasar por este módulo. Un `Command::new` directo funciona en `.deb`,
    /// `.rpm` y AppImage, y falla solo dentro de Flatpak: el peor sitio para
    /// que aparezca el fallo es aquel donde nadie lo prueba. La regla se escribe
    /// aquí y no en la documentación porque una regla que solo vive en un
    /// documento se rompe sin que nadie se entere (mismo criterio que
    /// `locks::tests::ningun_modulo_toma_el_lock_con_unwrap`).
    #[test]
    fn los_lanzadores_de_programas_del_host_pasan_por_sandbox() {
        // Ficheros que ejecutan binarios que el usuario tiene instalados:
        // consola local, clientes externos, cliente RDP y el catálogo de
        // comandos locales.
        const LANZADORES: &[&str] = &[
            "local_shell_manager.rs",
            "external_client.rs",
            "rdp_manager.rs",
            "local_command.rs",
        ];

        let src = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();

        for nombre in LANZADORES {
            let path = src.join(nombre);
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("no se puede leer {}: {e}", path.display()));
            // Solo código de producción: en los tests un `Command::new` directo
            // es legítimo (se comprueba el binario, no se lanza al usuario).
            let code = match text.find("#[cfg(test)]") {
                Some(idx) => &text[..idx],
                None => &text[..],
            };
            // Windows y macOS no tienen sandbox de Flatpak, así que sus
            // lanzadores van directos. Se detecta por el `#[cfg(target_os)]`
            // que precede a la función, no por el nombre del binario: el
            // atributo es el que decide de verdad qué se compila dónde.
            let mut fuera_de_linux = false;
            for (n, line) in code.lines().enumerate() {
                let trimmed = line.trim_start();
                if trimmed.starts_with("#[cfg(") {
                    // Formas largas (`target_os = "windows"`) y cortas
                    // (`#[cfg(windows)]`), que es como están escritas hoy.
                    let solo_linux = trimmed.contains("\"linux\"")
                        || trimmed.contains("not(windows)")
                        || trimmed.contains("cfg(unix)");
                    let nunca_linux = trimmed.contains("\"windows\"")
                        || trimmed.contains("\"macos\"")
                        || trimmed.contains("cfg(windows)")
                        || trimmed.contains("not(unix)");
                    if solo_linux || nunca_linux {
                        fuera_de_linux = nunca_linux;
                        continue;
                    }
                }
                // Fin de función a nivel de módulo: vuelve el ámbito neutro.
                if line == "}" {
                    fuera_de_linux = false;
                    continue;
                }
                if trimmed.starts_with("//") || !line.contains("Command::new(") {
                    continue;
                }
                if fuera_de_linux {
                    continue;
                }
                // `pgrep` es la excepción consciente: mira el árbol de procesos
                // del *propio* proceso, no lanza una herramienta del usuario.
                // Bajo Flatpak devuelve vacío y la detección de hijos queda
                // degradada a propósito (ver `local_shell_manager`).
                if line.contains("\"pgrep\"") {
                    continue;
                }
                offenders.push(format!("{}:{}: {}", nombre, n + 1, line.trim()));
            }
        }

        assert!(
            offenders.is_empty(),
            "estos lanzadores no pasan por `sandbox::host_command` y romperán \
             dentro de Flatpak:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn fuera_de_flatpak_el_comando_es_directo() {
        // La suite no corre dentro de un sandbox, así que `host_command`
        // no debe envolver nada en `flatpak-spawn`.
        assert!(!in_flatpak());
        let cmd = host_command("which", HostSpawn::default());
        assert_eq!(cmd.get_program(), "which");
    }
}
