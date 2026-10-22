//! Frontera de mínimo privilegio del keyring.
//!
//! Los comandos `keyring_get/set/delete` los invoca el renderer, así que su
//! `service` y su `key` son entrada no confiable: ante una XSS o una WebView
//! comprometida, un `service` libre convertiría a Rustty en un lector universal
//! del gestor de credenciales del usuario (el token de sesión del navegador, la
//! contraseña maestra de otro gestor…), y una `key` libre dejaría enumerar o
//! pisar entradas fuera de las que la aplicación gestiona.
//!
//! Aquí viven las dos respuestas: el servicio es **fijo** y la clave tiene que
//! caer en uno de los namespaces que Rustty realmente usa. Es defensa en
//! profundidad —no hay explotación conocida—, y por eso el filtro es una
//! allowlist: lo que no está previsto se rechaza.

/// Único servicio del gestor de credenciales del SO que Rustty escribe o lee.
/// Fuente única: todo el backend (perfiles, credenciales, sync, CLI) referencia
/// esta constante en vez de repetir el literal.
pub const SERVICE: &str = "rustty";

/// Namespaces de clave que la aplicación gestiona, con lo que hay detrás:
///
/// - `password:<perfil>` / `password:<perfil>:<credencial>` — contraseñas de
///   conexión, del perfil o de una identidad adicional suya.
/// - `passphrase:<perfil>` / `passphrase:<perfil>:<credencial>` — passphrases
///   de la clave privada.
/// - `master:<id>` / `secret:<id>` — valores del catálogo de credenciales del
///   motor de sustitución.
/// - `sync:…` — passphrase del blob E2E, contraseña WebDAV y secretos OAuth.
///
/// Al añadir un namespace nuevo hay que sumarlo aquí, o el comando IPC lo
/// rechazará (que es justo lo que debe pasar si nadie lo ha pensado).
const NAMESPACES: &[&str] = &[
    "password:",
    "passphrase:",
    "master:",
    "secret:",
    "sync:",
];

/// Tope de longitud de una clave. Las reales son `<namespace>` + uno o dos
/// UUID; 256 deja margen de sobra y evita que el renderer empuje cadenas
/// enormes al backend del SO.
const MAX_KEY_LEN: usize = 256;

/// Comprueba que un comando IPC de keyring se mueve dentro de lo que Rustty
/// gestiona. Función pura para poder probarla sin tocar el keyring real.
pub fn check(service: &str, key: &str) -> Result<(), String> {
    if service != SERVICE {
        return Err(format!(
            "servicio de keyring no permitido: solo «{SERVICE}»"
        ));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!(
            "clave de keyring demasiado larga (máximo {MAX_KEY_LEN} caracteres)"
        ));
    }
    // Los caracteres de control no aparecen en ninguna clave legítima y sí
    // pueden confundir a los backends del SO (D-Bus, Credential Manager).
    if key.contains(|c: char| c.is_control()) {
        return Err("clave de keyring con caracteres de control".to_string());
    }
    let Some(ns) = NAMESPACES.iter().find(|ns| key.starts_with(**ns)) else {
        return Err("clave de keyring fuera de los namespaces de Rustty".to_string());
    };
    // `password:` a secas no identifica nada: sin sufijo la clave no es de un
    // perfil ni de una credencial concretos.
    if key.len() == ns.len() {
        return Err("clave de keyring sin identificador tras el namespace".to_string());
    }
    Ok(())
}

/// Marcador estable de «el keyring del SO no está disponible»: el servicio de
/// secretos rechazó la operación o no se pudo llegar a él. Se conserva al
/// clasificar el fallo (como los de sync): el frontend lo lee para culpar al
/// keyring y no al paso que falló (OAuth, backend…). Espejado en
/// `src/modules/ipc/errors.js`; un test de este módulo comprueba que el literal
/// sigue allí.
pub const STORAGE_UNAVAILABLE_MARKER: &str = "keyring-unavailable:";

/// Texto de un fallo del keyring. Los del propio almacén del SO
/// (`PlatformFailure`, `NoStorageAccess`: el servicio de secretos rechaza la
/// operación, está bloqueado o no responde) llevan el marcador delante; los de
/// los datos (entrada inexistente, codificación, ambigüedad) salen tal cual.
pub fn error_text(err: &keyring::Error) -> String {
    match err {
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => {
            format!("{STORAGE_UNAVAILABLE_MARKER} {err}")
        }
        _ => err.to_string(),
    }
}

/// Abre la entrada del keyring de `key` en el servicio de Rustty, validando
/// antes que la clave esté dentro de la allowlist.
pub fn entry(service: &str, key: &str) -> Result<keyring::Entry, String> {
    check(service, key)?;
    keyring::Entry::new(SERVICE, key).map_err(|e| error_text(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_las_claves_que_la_app_usa_de_verdad() {
        for key in [
            "password:0f3c-uuid",
            "password:0f3c-uuid:cred-1",
            "passphrase:0f3c-uuid",
            "passphrase:0f3c-uuid:cred-1",
            "master:cred-7",
            "secret:cred-7",
            "sync:passphrase",
            "sync:webdav_password",
            "sync:oauth:gdrive:refresh_token",
            "sync:oauth:gdrive:client_secret",
        ] {
            assert!(check(SERVICE, key).is_ok(), "debería aceptar {key}");
        }
    }

    #[test]
    fn rechaza_el_keyring_de_otras_aplicaciones() {
        // El caso que motiva la restricción: leer credenciales ajenas.
        assert!(check("Chrome Safe Storage", "password:x").is_err());
        assert!(check("", "password:x").is_err());
        // Ni siquiera una variante del propio nombre.
        assert!(check("Rustty", "password:x").is_err());
        assert!(check("rustty2", "password:x").is_err());
    }

    #[test]
    fn rechaza_namespaces_no_previstos() {
        assert!(check(SERVICE, "oauth:google").is_err());
        assert!(check(SERVICE, "").is_err());
        assert!(check(SERVICE, "totp:cuenta").is_err());
        // Sin sufijo no identifica ninguna entrada.
        assert!(check(SERVICE, "password:").is_err());
        assert!(check(SERVICE, "sync:").is_err());
        // El namespace tiene que ir al principio, no en medio.
        assert!(check(SERVICE, "otro/password:x").is_err());
    }

    #[test]
    fn rechaza_claves_abusivas() {
        assert!(check(SERVICE, &format!("password:{}", "a".repeat(MAX_KEY_LEN))).is_err());
        assert!(check(SERVICE, "password:a\0b").is_err());
        assert!(check(SERVICE, "password:a\nb").is_err());
    }

    #[test]
    fn los_fallos_del_almacen_llevan_el_marcador() {
        // Lo que devolvía oo7 0.7.0~beta (Fedora 45) al crear cualquier entrada.
        let platform = keyring::Error::PlatformFailure(
            "Failed to create a new item Password too short: 2.".into(),
        );
        let text = error_text(&platform);
        assert!(text.starts_with(STORAGE_UNAVAILABLE_MARKER), "{text}");
        assert!(text.contains("Password too short: 2"), "conserva el detalle: {text}");

        let access = keyring::Error::NoStorageAccess("collection is locked".into());
        assert!(error_text(&access).starts_with(STORAGE_UNAVAILABLE_MARKER));
    }

    #[test]
    fn los_fallos_de_los_datos_no_culpan_al_keyring() {
        for err in [
            keyring::Error::NoEntry,
            keyring::Error::BadEncoding(vec![0xff]),
            keyring::Error::TooLong("user".into(), 255),
            keyring::Error::Invalid("user".into(), "vacío".into()),
        ] {
            assert!(!error_text(&err).contains(STORAGE_UNAVAILABLE_MARKER), "{err}");
        }
    }

    #[test]
    fn el_marcador_sigue_espejado_en_el_frontend() {
        let mirror = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/modules/ipc/errors.js");
        let js = std::fs::read_to_string(&mirror).expect("espejo del frontend");
        assert!(
            js.contains(&format!("\"{STORAGE_UNAVAILABLE_MARKER}\"")),
            "{} debe declarar el mismo marcador",
            mirror.display()
        );
    }
}
