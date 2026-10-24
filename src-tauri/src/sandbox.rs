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
#[cfg(unix)]
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
    /// Variables de entorno del programa. Van aquí y **no** con `.env()` sobre
    /// el comando: bajo Flatpak, `.env()` se queda en el proceso
    /// `flatpak-spawn` del sandbox, que solo transmite al host lo que recibe
    /// con `--env=`/`--env-fd` (el proceso del host parte del entorno de
    /// `flatpak-session-helper`, sin `TERM`, por ejemplo). Fuera de Flatpak
    /// se aplican al comando tal cual.
    pub env: &'a [(String, String)],
    /// Descriptor del que `flatpak-spawn` lee más variables en formato
    /// `env -0` (ver [`env0_block`]), para valores que no deben quedar a la
    /// vista en su línea de órdenes (`ps`) como pasaría con `--env=`. Quien
    /// llama se encarga de que el hijo lo herede con ese número. Solo cuenta
    /// dentro de Flatpak.
    pub env_fd: Option<i32>,
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
    if let Some(fd) = opts.env_fd {
        args.push(format!("--env-fd={fd}"));
    }
    for (key, value) in opts.env {
        args.push(format!("--env={key}={value}"));
    }
    args
}

/// Variables en el formato `env -0` (`CLAVE=valor\0…`) que lee
/// `flatpak-spawn --env-fd`. Los valores con NUL se rechazan antes de llegar
/// aquí (`local_command_policy`).
#[cfg(any(target_os = "linux", test))]
pub fn env0_block(env: &[(String, String)]) -> Vec<u8> {
    let mut block = Vec::new();
    for (key, value) in env {
        block.extend_from_slice(key.as_bytes());
        block.push(b'=');
        block.extend_from_slice(value.as_bytes());
        block.push(0);
    }
    block
}

/// `memfd` con `env` en formato `env -0`, rebobinado para que
/// `flatpak-spawn --env-fd` lo lea desde el principio. Con `MFD_CLOEXEC`: es
/// [`inherit_fd`] quien lo coloca a propósito en el hijo.
#[cfg(target_os = "linux")]
pub fn env_memfd(env: &[(String, String)]) -> std::io::Result<std::fs::File> {
    use std::io::{Seek, Write};
    use std::os::fd::FromRawFd;

    let fd = unsafe { libc::memfd_create(c"rustty-env".as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `memfd_create` acaba de devolver este descriptor y nadie más lo
    // posee, así que `File` puede adueñarse de él.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    file.write_all(&env0_block(env))?;
    file.rewind()?;
    Ok(file)
}

/// Programa el `dup2` que deja `file` en el descriptor `target` del hijo. El
/// `File` tiene que seguir abierto hasta que vuelva el `spawn`.
#[cfg(target_os = "linux")]
pub fn inherit_fd(cmd: &mut Command, file: &std::fs::File, target: i32) {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;

    let raw = file.as_raw_fd();
    // SAFETY: entre `fork` y `exec` el closure solo llama a `dup2`/`fcntl`,
    // ambas async-signal-safe, sin asignar memoria ni tomar cerrojos.
    unsafe {
        cmd.pre_exec(move || {
            if raw == target {
                // Ya está en su sitio; solo hay que quitarle el FD_CLOEXEC.
                if libc::fcntl(target, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(raw, target) < 0 {
                // `dup2` deja el destino sin FD_CLOEXEC: sobrevive al exec.
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// `Command` que ejecuta `program` en el host cuando estamos en Flatpak, y
/// directamente en el sistema cuando no.
///
/// El entorno del programa va en `opts.env` (o `opts.env_fd`), nunca con
/// `.env()` sobre el `Command` devuelto: dentro de Flatpak eso solo cambiaría
/// el entorno de `flatpak-spawn`, que no lo reenvía al host.
///
/// Solo existe en Unix: en Windows no hay Flatpak y los lanzadores de allí
/// (`cmd`, `mstsc`) van directos.
#[cfg(unix)]
pub fn host_command(program: &str, opts: HostSpawn) -> Command {
    if !in_flatpak() {
        let mut cmd = Command::new(program);
        if let Some(dir) = opts.cwd {
            cmd.current_dir(dir);
        }
        cmd.envs(opts.env.iter().map(|(k, v)| (k, v)));
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
///
/// El entorno va por `env` por lo mismo que en [`host_command`]. Aquí no cabe
/// `--env-fd`: `portable-pty` cierra en el hijo todo descriptor por encima de
/// 2, así que solo hay `--env=` (son valores de terminal, no secretos).
pub fn host_pty_command(
    program: &str,
    cwd: Option<&Path>,
    env: &[(String, String)],
) -> CommandBuilder {
    if !in_flatpak() {
        let mut cmd = CommandBuilder::new(program);
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        for (key, value) in env {
            cmd.env(key, value);
        }
        return cmd;
    }
    let mut cmd = CommandBuilder::new("flatpak-spawn");
    for arg in spawn_args(&HostSpawn {
        cwd,
        env,
        ..Default::default()
    }) {
        cmd.arg(arg);
    }
    cmd.arg(program);
    cmd
}

/// ¿Existe `program` en el `PATH`? Dentro de Flatpak pregunta por el `PATH`
/// **del host**, que es donde se va a ejecutar de verdad. Solo lo usan los
/// lanzadores de Linux (RDP, VNC, telnet).
#[cfg(target_os = "linux")]
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
/// fallback. En Windows la consola local no tiene login shell que buscar.
#[cfg(unix)]
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
            ..Default::default()
        });
        assert!(args.contains(&"--directory=/home/user/proyectos".to_string()));
        assert!(args.contains(&"--forward-fd=3".to_string()));
        // Las banderas van antes del programa: `--host` sigue siendo la primera.
        assert_eq!(args[0], "--host");
    }

    /// `flatpak-spawn --host` no reenvía su propio entorno: solo lo que recibe
    /// con `--env=`/`--env-fd`. Sin estas banderas la consola local nacía sin
    /// `TERM`, FreeRDP 3 sin `FREERDP_ASKPASS` y los comandos locales con los
    /// `RUSTTY_ARG_n` vacíos.
    #[test]
    fn spawn_args_pasan_el_entorno_con_env_y_env_fd() {
        let env = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            (
                "FREERDP_ASKPASS".to_string(),
                "/bin/sh -c \"cat /proc/self/fd/3\"".to_string(),
            ),
            // El valor viaja entero: flatpak-spawn parte por el primer `=` y el
            // helper lo aplica sin ningún shell que lo reinterprete.
            ("RUSTTY_ARG_0".to_string(), "a; echo x=y".to_string()),
        ];
        let args = spawn_args(&HostSpawn {
            env: &env,
            env_fd: Some(3),
            ..Default::default()
        });
        assert_eq!(args[0], "--host");
        assert!(args.contains(&"--env=TERM=xterm-256color".to_string()));
        assert!(args.contains(&"--env=FREERDP_ASKPASS=/bin/sh -c \"cat /proc/self/fd/3\"".to_string()));
        assert!(args.contains(&"--env=RUSTTY_ARG_0=a; echo x=y".to_string()));
        assert!(args.contains(&"--env-fd=3".to_string()));
        // Sin entorno no se añade nada.
        assert_eq!(spawn_args(&HostSpawn::default()), vec!["--host", "--watch-bus"]);
    }

    #[test]
    fn el_bloque_de_env_fd_tiene_el_formato_de_env_0() {
        let env = vec![
            ("RUSTTY_ARG_0".to_string(), "con espacios; y =".to_string()),
            ("RUSTTY_ARG_1".to_string(), String::new()),
        ];
        assert_eq!(
            env0_block(&env),
            b"RUSTTY_ARG_0=con espacios; y =\0RUSTTY_ARG_1=\0".to_vec()
        );
        assert!(env0_block(&[]).is_empty());
    }

    /// El `memfd` que lee `--env-fd` sale rebobinado: `flatpak-spawn` lo lee
    /// desde su posición actual.
    #[cfg(target_os = "linux")]
    #[test]
    fn el_memfd_del_entorno_se_lee_desde_el_principio() {
        use std::io::Read;
        let env = vec![("RUSTTY_ARG_0".to_string(), "valor".to_string())];
        let mut file = env_memfd(&env).unwrap();
        let mut leido = Vec::new();
        file.read_to_end(&mut leido).unwrap();
        assert_eq!(leido, b"RUSTTY_ARG_0=valor\0");
    }

    #[cfg(unix)]
    #[test]
    fn fuera_de_flatpak_el_entorno_va_al_comando() {
        assert!(!in_flatpak());
        let env = vec![("RUSTTY_ARG_0".to_string(), "h".to_string())];
        let cmd = host_command(
            "sh",
            HostSpawn {
                env: &env,
                ..Default::default()
            },
        );
        let envs: Vec<_> = cmd.get_envs().collect();
        assert_eq!(
            envs,
            vec![(std::ffi::OsStr::new("RUSTTY_ARG_0"), Some(std::ffi::OsStr::new("h")))]
        );
        let pty = host_pty_command("sh", None, &env);
        assert_eq!(pty.get_env("RUSTTY_ARG_0").and_then(|v| v.to_str()), Some("h"));
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
                if trimmed.starts_with("//") || fuera_de_linux {
                    continue;
                }
                // El entorno de un programa del host va en `HostSpawn::env`
                // (o `env_fd`): un `.env()` sobre el comando no sale del
                // sandbox.
                if line.contains(".env(") || line.contains(".envs(") {
                    offenders.push(format!("{}:{}: {}", nombre, n + 1, line.trim()));
                    continue;
                }
                if !line.contains("Command::new(") {
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
            "estos lanzadores no pasan por `sandbox::host_command` (o ponen su \
             entorno fuera de `HostSpawn`) y romperán dentro de Flatpak:\n{}",
            offenders.join("\n")
        );
    }

    #[cfg(unix)]
    #[test]
    fn fuera_de_flatpak_el_comando_es_directo() {
        // La suite no corre dentro de un sandbox, así que `host_command`
        // no debe envolver nada en `flatpak-spawn`.
        assert!(!in_flatpak());
        let cmd = host_command("which", HostSpawn::default());
        assert_eq!(cmd.get_program(), "which");
    }
}
