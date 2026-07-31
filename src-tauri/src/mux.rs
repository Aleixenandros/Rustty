//! Núcleo **puro** del attach a sesiones persistentes del lado servidor
//! (tmux/screen): normalización de la herramienta, saneado del nombre de
//! sesión y construcción de los comandos remotos. Sin E/S ni SSH — el
//! transporte vive en `ssh_manager` (que ejecuta estos comandos por un canal
//! `exec`), igual que `metrics` es el núcleo puro del monitor.
//!
//! El saneado es la frontera de seguridad: el nombre de sesión es texto del
//! usuario que acaba dentro de un comando de shell remoto. En vez de escapar,
//! se **restringe** a un charset seguro (`[A-Za-z0-9_-]`): no hay comilla ni
//! metacarácter posible que olvidar, y de paso cumple las reglas de tmux (que
//! prohíbe `.` y `:` en nombres de sesión).

/// Herramienta normalizada: solo se soportan `tmux` (default) y `screen`.
/// Cualquier otro valor (perfil editado a mano, versión futura) cae a tmux.
pub fn normalize_tool(raw: Option<&str>) -> &'static str {
    match raw {
        Some("screen") => "screen",
        _ => "tmux",
    }
}

/// Sanea un nombre de sesión al charset `[A-Za-z0-9_-]`: cada secuencia de
/// caracteres fuera del charset colapsa en un único `-`, sin guiones en los
/// extremos. Vacío tras sanear → `rustty`.
pub fn sanitize_session_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
            prev_dash = c == '-';
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "rustty".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Comando de sondeo del binario en el remoto. `command -v` es POSIX (funciona
/// en sh/bash/zsh/dash); exit status 0 = el binario existe.
pub fn probe_command(tool: &str) -> &'static str {
    if tool == "screen" {
        "command -v screen"
    } else {
        "command -v tmux"
    }
}

/// Comando remoto de attach: crea la sesión con ese nombre o se reengancha a
/// ella si ya existe. El `exec` inicial sustituye al shell que lanza el
/// comando, para no dejar un shell intermedio huérfano en el árbol de procesos.
pub fn attach_command(tool: &str, raw_name: &str) -> String {
    let name = sanitize_session_name(raw_name);
    if tool == "screen" {
        // -xRR: reengancha (multi-attach) o crea si no existe; -S da el nombre.
        format!("exec screen -xRR -S {name}")
    } else {
        // new-session -A: attach si existe, crea si no.
        format!("exec tmux new-session -A -s {name}")
    }
}

// ─── Versión de tmux (requisito del modo control, F0.2) ─────────────

/// Versión mínima de tmux para el modo control (`-CC`) tal y como lo vamos a
/// hablar: las suscripciones de formato (`refresh-client -B`) y el flow
/// control por pane (`pause-after`) aparecen en tmux 3.2. El attach normal no
/// tiene mínimo: cualquier tmux vale.
pub const MIN_CONTROL_MODE_VERSION: (u32, u32) = (3, 2);

/// Comando de sondeo de la versión en el remoto. `tmux -V` y no
/// `display-message -p "#{version}"`: no exige un servidor tmux ya arrancado
/// (display-message falla sin servidor) y devuelve la misma versión con el
/// prefijo `tmux `.
pub fn version_probe_command() -> &'static str {
    "tmux -V"
}

/// Extrae `(mayor, menor)` de la salida de `tmux -V` o de `#{version}`:
/// `tmux 3.3a` → (3, 3); `3.2` → (3, 2); `tmux next-3.4` → (3, 4). Sufijos de
/// letra o rc se ignoran. Sin un `mayor.menor` reconocible → `None` (versión
/// desconocida: el llamador degrada con aviso, no adivina).
pub fn parse_tmux_version(output: &str) -> Option<(u32, u32)> {
    let bytes = output.as_bytes();
    let start = bytes.iter().position(u8::is_ascii_digit)?;
    let rest = &output[start..];
    let (major_str, tail) = rest.split_once('.')?;
    let major: u32 = major_str.parse().ok()?;
    let minor_digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    let minor: u32 = minor_digits.parse().ok()?;
    Some((major, minor))
}

/// ¿Esta versión soporta el modo control que necesitamos?
pub fn supports_control_mode(version: (u32, u32)) -> bool {
    version >= MIN_CONTROL_MODE_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_tool_solo_conoce_tmux_y_screen() {
        assert_eq!(normalize_tool(Some("screen")), "screen");
        assert_eq!(normalize_tool(Some("tmux")), "tmux");
        assert_eq!(normalize_tool(Some("mosh")), "tmux");
        assert_eq!(normalize_tool(None), "tmux");
    }

    #[test]
    fn sanitize_respeta_el_charset_seguro() {
        assert_eq!(sanitize_session_name("web-01_prod"), "web-01_prod");
    }

    #[test]
    fn sanitize_colapsa_lo_invalido_en_un_guion() {
        assert_eq!(sanitize_session_name("Servidor de prueba"), "Servidor-de-prueba");
        assert_eq!(sanitize_session_name("a.b:c"), "a-b-c");
        // Metacaracteres de shell: imposible que sobrevivan al saneado. El `-`
        // literal de `-rf` se conserva (es charset válido): puede dar `--`.
        assert_eq!(sanitize_session_name("x'; rm -rf / #"), "x-rm--rf");
        assert_eq!(sanitize_session_name("$(reboot)"), "reboot");
    }

    #[test]
    fn sanitize_no_deja_guiones_en_los_extremos_ni_vacios() {
        assert_eq!(sanitize_session_name("  hola  "), "hola");
        assert_eq!(sanitize_session_name("···"), "rustty");
        assert_eq!(sanitize_session_name(""), "rustty");
    }

    #[test]
    fn attach_command_tmux_y_screen() {
        assert_eq!(
            attach_command("tmux", "mi servidor"),
            "exec tmux new-session -A -s mi-servidor"
        );
        assert_eq!(
            attach_command("screen", "mi servidor"),
            "exec screen -xRR -S mi-servidor"
        );
    }

    #[test]
    fn probe_command_por_herramienta() {
        assert_eq!(probe_command("tmux"), "command -v tmux");
        assert_eq!(probe_command("screen"), "command -v screen");
    }

    #[test]
    fn parse_version_de_tmux_v_y_de_formato() {
        // Salida real de `tmux -V` y de `#{version}` (con y sin sufijo).
        assert_eq!(parse_tmux_version("tmux 3.7b"), Some((3, 7)));
        assert_eq!(parse_tmux_version("3.7b"), Some((3, 7)));
        assert_eq!(parse_tmux_version("tmux 3.2"), Some((3, 2)));
        assert_eq!(parse_tmux_version("tmux 1.9a"), Some((1, 9)));
        assert_eq!(parse_tmux_version("tmux next-3.4"), Some((3, 4)));
        assert_eq!(parse_tmux_version("tmux 3.10"), Some((3, 10)));
    }

    #[test]
    fn parse_version_desconocida_es_none() {
        assert_eq!(parse_tmux_version(""), None);
        assert_eq!(parse_tmux_version("tmux master"), None);
        assert_eq!(parse_tmux_version("tmux 3"), None);
        assert_eq!(parse_tmux_version("bash: tmux: command not found"), None);
    }

    #[test]
    fn minimo_del_modo_control_es_3_2() {
        assert!(supports_control_mode((3, 2)));
        assert!(supports_control_mode((3, 7)));
        // Comparación numérica, no léxica: 3.10 > 3.2.
        assert!(supports_control_mode((3, 10)));
        assert!(supports_control_mode((4, 0)));
        assert!(!supports_control_mode((3, 1)));
        assert!(!supports_control_mode((2, 9)));
    }

    #[test]
    fn version_probe_no_exige_servidor() {
        assert_eq!(version_probe_command(), "tmux -V");
    }
}
