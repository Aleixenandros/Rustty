//! Nombre del usuario local del SO, sin ejecutar ningún proceso (nada de
//! `whoami`): lo usa la conexión rápida como usuario por defecto, igual que
//! `ssh host` conecta con el usuario local. Antes se proponía siempre `root`.
//!
//! Primero las variables de entorno de la sesión y, en Unix, la cuenta del
//! uid efectivo (`getpwuid_r`) si el entorno no lo dice (un lanzador que no
//! exporte `USER`). En Windows `USERNAME` siempre está puesta.

/// Variables de entorno que llevan el usuario, por orden de confianza.
#[cfg(unix)]
const USER_VARS: &[&str] = &["USER", "LOGNAME"];
#[cfg(not(unix))]
const USER_VARS: &[&str] = &["USERNAME", "USER"];

/// Primer valor no vacío (ya sin espacios alrededor) de [`USER_VARS`] según
/// `lookup`. Puro: la consulta al entorno se inyecta para poder probarlo.
fn username_from_env(lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    USER_VARS.iter().find_map(|var| {
        lookup(var)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

/// Nombre del usuario local, o `None` si el sistema no lo dice.
pub fn local_username() -> Option<String> {
    username_from_env(|var| std::env::var(var).ok()).or_else(username_from_system)
}

/// Cuenta del uid efectivo según la base de usuarios del sistema.
#[cfg(unix)]
fn username_from_system() -> Option<String> {
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0u8; 16 * 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: `pwd` y `buf` viven durante la llamada y `buf.len()` es su
    // tamaño real; `getpwuid_r` es la variante reentrante y solo escribe en
    // ellos. `result` apunta a `pwd` (o a nulo) al volver.
    let rc = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr().cast::<libc::c_char>(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_name.is_null() {
        return None;
    }
    // SAFETY: `pw_name` no es nulo y apunta dentro de `buf`, que sigue vivo,
    // a una cadena terminada en cero que escribió `getpwuid_r`.
    let name = unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) }
        .to_string_lossy()
        .trim()
        .to_string();
    (!name.is_empty()).then_some(name)
}

#[cfg(not(unix))]
fn username_from_system() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// La primera variable con valor manda, y se le quitan los espacios.
    #[test]
    fn prefiere_la_primera_variable_con_valor() {
        let lookup = |var: &str| {
            if var == USER_VARS[0] {
                Some("  ana ".to_string())
            } else {
                Some("otra".to_string())
            }
        };
        assert_eq!(username_from_env(lookup), Some("ana".to_string()));
    }

    /// Una variable vacía o solo espacios no cuenta: se pasa a la siguiente; y
    /// sin ninguna no se inventa nada (el llamador decide la reserva).
    #[test]
    fn salta_las_vacias_y_sin_ninguna_no_inventa() {
        let lookup = |var: &str| {
            if var == USER_VARS[0] {
                Some("   ".to_string())
            } else if var == USER_VARS[1] {
                Some("luis".to_string())
            } else {
                None
            }
        };
        assert_eq!(username_from_env(lookup), Some("luis".to_string()));
        assert_eq!(username_from_env(|_| None), None);
        assert_eq!(username_from_env(|_| Some(String::new())), None);
    }

    /// En esta máquina hay un usuario: por el entorno o por la cuenta del uid.
    #[cfg(unix)]
    #[test]
    fn el_usuario_local_de_esta_maquina_se_resuelve() {
        let name = local_username().expect("usuario local");
        assert!(!name.trim().is_empty());
        assert!(username_from_system().is_some(), "getpwuid_r debe conocer al uid actual");
    }
}
