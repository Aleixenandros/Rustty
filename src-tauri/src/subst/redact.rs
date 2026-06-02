//! Redacción anti-fuga de valores secretos en textos no confiables.
//!
//! Fase 7 del motor de variables/secretos: garantiza que los valores resueltos
//! de `${master:}`/`${secret:}` (y la contraseña efectiva) NUNCA aparezcan en
//! claro en mensajes que viajen a un canal no confiable (logs, eventos de
//! diagnóstico, toasts/errores). Se aplica **sobre el texto ya construido**,
//! justo antes de emitirlo, sustituyendo cualquier aparición literal del valor
//! por el marcador fijo `••••`.

/// Marcador de redacción (4 puntos), igual que en el frontend/contrato.
pub const REDACTED: &str = "••••";

/// Sustituye en `text` toda aparición literal de cada valor de `secret_values`
/// por `••••`. Defensivo: ignora valores vacíos (no aportan nada que enmascarar
/// y `replace("")` insertaría ruido). No revela la longitud del secreto.
///
/// La redacción es por valor literal: si un secreto no aparece tal cual en el
/// texto, no se altera nada. Esto basta para los canales auditados, donde el
/// único riesgo sería interpolar el valor resuelto en un mensaje.
pub fn redact_secrets(text: &str, secret_values: &[String]) -> String {
    let mut out = text.to_string();
    for value in secret_values {
        // Ignora cadenas vacías (umbral mínimo: >= 1 carácter).
        if value.is_empty() {
            continue;
        }
        if out.contains(value.as_str()) {
            out = out.replace(value.as_str(), REDACTED);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacta_valor_presente() {
        let secretos = vec!["s3cr3t".to_string()];
        assert_eq!(
            redact_secrets("clave=s3cr3t fin", &secretos),
            "clave=•••• fin"
        );
    }

    #[test]
    fn redacta_multiples_apariciones() {
        let secretos = vec!["abc".to_string()];
        assert_eq!(redact_secrets("abc-abc-abc", &secretos), "••••-••••-••••");
    }

    #[test]
    fn redacta_varios_valores() {
        let secretos = vec!["pass1".to_string(), "pass2".to_string()];
        assert_eq!(
            redact_secrets("user pass1 y pass2", &secretos),
            "user •••• y ••••"
        );
    }

    #[test]
    fn ignora_valores_vacios() {
        let secretos = vec!["".to_string()];
        assert_eq!(redact_secrets("hola mundo", &secretos), "hola mundo");
    }

    #[test]
    fn sin_aparicion_no_altera() {
        let secretos = vec!["noexiste".to_string()];
        assert_eq!(redact_secrets("texto limpio", &secretos), "texto limpio");
    }

    #[test]
    fn lista_vacia_devuelve_igual() {
        assert_eq!(redact_secrets("texto", &[]), "texto");
    }

    #[test]
    fn no_revela_longitud() {
        // Secretos de distinta longitud producen el mismo marcador.
        let corto = redact_secrets("x=ab", &["ab".to_string()]);
        let largo = redact_secrets("x=abcdefghij", &["abcdefghij".to_string()]);
        assert_eq!(corto, "x=••••");
        assert_eq!(largo, "x=••••");
    }

    #[test]
    fn error_de_conexion_simulado_no_filtra() {
        // Caso anti-fuga: un mensaje de error que (hipotéticamente) interpola la
        // contraseña resuelta no debe contener el valor tras redactar.
        let password = "MiClaveSuperSecreta".to_string();
        let mensaje = format!("Autenticación fallida para ada con clave {password}");
        let redactado = redact_secrets(&mensaje, &[password.clone()]);
        assert!(!redactado.contains(&password));
        assert!(redactado.contains("••••"));
    }
}
