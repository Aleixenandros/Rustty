//! Motor de sustitución: parser de `${...}` y aplicación de un `Resolver`.
//!
//! Implementa la gramática del contrato (ver `memoria/arquitectura.md`): escape
//! `$${...}` → literal `${...}`, marcador desconocido/mal formado/sin cierre →
//! literal, cuerpo leído hasta el primer `}` sin anidamiento, y sustitución de
//! **una sola pasada** (el resultado no se reescanea, por seguridad).

use super::types::{InternalVar, Marker, Resolver};

/// Parsea una plantilla en una secuencia de marcadores y literales.
///
/// Nunca falla: cualquier construcción desconocida o mal formada se conserva
/// como `Marker::Literal` con el texto original. Los literales contiguos se
/// fusionan en un solo `Marker::Literal`.
pub fn parse(template: &str) -> Vec<Marker> {
    let mut markers: Vec<Marker> = Vec::new();
    // Acumulador de texto literal pendiente de emitir.
    let mut literal = String::new();
    // Trabajamos sobre bytes para indexar barato; el contenido es UTF-8 y solo
    // inspeccionamos caracteres ASCII (`$`, `{`, `}`), así que es seguro.
    let bytes = template.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    // Emite el literal acumulado (si hay) como un único marcador.
    let flush = |literal: &mut String, markers: &mut Vec<Marker>| {
        if !literal.is_empty() {
            markers.push(Marker::Literal(std::mem::take(literal)));
        }
    };

    while i < len {
        // Escape `$${...}` → literal `${...}`.
        if bytes[i] == b'$'
            && i + 1 < len
            && bytes[i + 1] == b'$'
            && i + 2 < len
            && bytes[i + 2] == b'{'
        {
            // Buscamos el `}` de cierre a partir del `{`.
            if let Some(close) = find_close(bytes, i + 3) {
                // El literal producido es `${` + cuerpo + `}` (se elimina un `$`).
                literal.push('$');
                literal.push_str(&template[i + 2..=close]);
                i = close + 1;
                continue;
            }
            // Sin cierre: `$$` se trata como literal normal; reposamos un byte.
            literal.push('$');
            i += 1;
            continue;
        }

        // Marcador `${cuerpo}`.
        if bytes[i] == b'$' && i + 1 < len && bytes[i + 1] == b'{' {
            if let Some(close) = find_close(bytes, i + 2) {
                let body = &template[i + 2..close];
                match parse_body(body) {
                    Some(marker) => {
                        flush(&mut literal, &mut markers);
                        markers.push(marker);
                    }
                    // Marcador desconocido/mal formado: literal tal cual.
                    None => literal.push_str(&template[i..=close]),
                }
                i = close + 1;
                continue;
            }
            // Sin `}` de cierre: el resto se deja literal.
            literal.push_str(&template[i..]);
            break;
        }

        // Carácter literal cualquiera. Avanzamos por carácter UTF-8 completo.
        let ch_len = utf8_char_len(bytes[i]);
        literal.push_str(&template[i..i + ch_len]);
        i += ch_len;
    }

    flush(&mut literal, &mut markers);
    markers
}

/// Aplica el `Resolver` sobre la plantilla en una sola pasada.
///
/// El resultado de sustituir un marcador **no** se reescanea (decisión de
/// seguridad del contrato). Un marcador cuyo resolver devuelve `None` se deja
/// literal (`${...}`).
pub fn substitute(template: &str, resolver: &dyn Resolver) -> String {
    let mut out = String::with_capacity(template.len());
    for marker in parse(template) {
        match marker {
            Marker::Literal(text) => out.push_str(&text),
            Marker::Internal(var) => match resolver.internal(var) {
                Some(value) => out.push_str(&value),
                None => out.push_str(&render_literal(&marker)),
            },
            Marker::Env(ref name) => match resolver.env(name) {
                Some(value) => out.push_str(&value),
                None => out.push_str(&render_literal(&marker)),
            },
            Marker::Var(ref name) => match resolver.var(name) {
                Some(value) => out.push_str(&value),
                None => out.push_str(&render_literal(&marker)),
            },
            Marker::Secret(ref name) => match resolver.secret(name) {
                Some(value) => out.push_str(&value),
                None => out.push_str(&render_literal(&marker)),
            },
            Marker::Master(ref name) => match resolver.master(name) {
                Some(value) => out.push_str(&value),
                None => out.push_str(&render_literal(&marker)),
            },
            Marker::Ask {
                ref label,
                ref options,
            } => match resolver.ask(label, options) {
                Some(value) => out.push_str(&value),
                None => out.push_str(&render_literal(&marker)),
            },
            Marker::Cmd(ref command) => match resolver.cmd(command) {
                Some(value) => out.push_str(&value),
                None => out.push_str(&render_literal(&marker)),
            },
        }
    }
    out
}

/// Reconstruye el texto literal original de un marcador no resuelto.
fn render_literal(marker: &Marker) -> String {
    match marker {
        Marker::Literal(text) => text.clone(),
        Marker::Internal(var) => {
            let name = match var {
                InternalVar::Host => "host",
                InternalVar::Port => "port",
                InternalVar::User => "user",
                InternalVar::ProfileName => "profileName",
                InternalVar::Workspace => "workspace",
                InternalVar::Date => "date",
                InternalVar::Time => "time",
            };
            format!("${{{name}}}")
        }
        Marker::Env(name) => format!("${{env:{name}}}"),
        Marker::Var(name) => format!("${{var:{name}}}"),
        Marker::Secret(name) => format!("${{secret:{name}}}"),
        Marker::Master(name) => format!("${{master:{name}}}"),
        Marker::Ask { label, options } => {
            if options.is_empty() {
                format!("${{ask:{label}}}")
            } else {
                format!("${{ask:{label}|{}}}", options.join("|"))
            }
        }
        Marker::Cmd(command) => format!("${{cmd:{command}}}"),
    }
}

/// Devuelve el índice del primer `}` a partir de `start` (sin anidamiento).
fn find_close(bytes: &[u8], start: usize) -> Option<usize> {
    (start..bytes.len()).find(|&j| bytes[j] == b'}')
}

/// Longitud en bytes del carácter UTF-8 que empieza en este byte líder.
fn utf8_char_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// Interpreta el cuerpo de un marcador `${cuerpo}` ya extraído (sin llaves).
///
/// Devuelve `None` si el prefijo es desconocido o el nombre/cuerpo es inválido,
/// en cuyo caso el llamante deja el marcador literal.
fn parse_body(body: &str) -> Option<Marker> {
    // Interno sin prefijo (`host`, `date`, ...).
    if let Some(var) = InternalVar::from_name(body) {
        return Some(Marker::Internal(var));
    }

    // Namespaces con prefijo `nombre:resto`.
    let (prefix, rest) = body.split_once(':')?;
    match prefix {
        "env" => {
            if is_valid_env_name(rest) {
                Some(Marker::Env(rest.to_string()))
            } else {
                None
            }
        }
        "var" => is_valid_name(rest).then(|| Marker::Var(rest.to_string())),
        "secret" => is_valid_name(rest).then(|| Marker::Secret(rest.to_string())),
        "master" => is_valid_name(rest).then(|| Marker::Master(rest.to_string())),
        "ask" => {
            // etiqueta[|op1|op2|...]; la etiqueta no puede estar vacía.
            let mut parts = rest.split('|');
            let label = parts.next().unwrap_or("");
            if label.is_empty() {
                return None;
            }
            let options: Vec<String> = parts.map(|s| s.to_string()).collect();
            Some(Marker::Ask {
                label: label.to_string(),
                options,
            })
        }
        // `cmd` está reservado: se reconoce en la gramática pero queda literal
        // hasta la fase futura. Lo modelamos para que el motor lo deje sin
        // resolver (el resolver por defecto devuelve `None`).
        "cmd" => (!rest.is_empty()).then(|| Marker::Cmd(rest.to_string())),
        _ => None,
    }
}

/// Valida un nombre de `var`/`secret`/`master`: empieza por letra o `_`, y
/// continúa con letras, dígitos, `_`, `-` o `.`. Case-sensitive, sin espacios.
fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Valida un nombre de variable de entorno: letra o `_` inicial, luego letras,
/// dígitos o `_` (convención del SO).
fn is_valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subst::types::{DefaultResolver, SubstContext};

    /// Contexto de prueba con valores fijos para los internos.
    fn ctx() -> SubstContext {
        SubstContext {
            host: "192.168.1.10".to_string(),
            port: 2222,
            user: "ada".to_string(),
            profile_name: "Servidor Pruebas".to_string(),
            workspace: "ws-1".to_string(),
        }
    }

    fn resolver() -> DefaultResolver {
        DefaultResolver::new(ctx())
    }

    #[test]
    fn literal_puro() {
        assert_eq!(
            parse("hola mundo"),
            vec![Marker::Literal("hola mundo".into())]
        );
        assert_eq!(substitute("hola mundo", &resolver()), "hola mundo");
    }

    #[test]
    fn un_interno() {
        assert_eq!(parse("${host}"), vec![Marker::Internal(InternalVar::Host)]);
        assert_eq!(
            substitute("ssh ${user}@${host}", &resolver()),
            "ssh ada@192.168.1.10"
        );
        assert_eq!(substitute("puerto ${port}", &resolver()), "puerto 2222");
        assert_eq!(
            substitute("${profileName} en ${workspace}", &resolver()),
            "Servidor Pruebas en ws-1"
        );
    }

    #[test]
    fn varios_marcadores_en_una_linea() {
        let out = substitute("${user}@${host}:${port}", &resolver());
        assert_eq!(out, "ada@192.168.1.10:2222");
    }

    #[test]
    fn internos_date_time_no_vacios() {
        // date/time se calculan al resolver; solo comprobamos formato/no vacío.
        let date = substitute("${date}", &resolver());
        let time = substitute("${time}", &resolver());
        assert_eq!(date.len(), "YYYY-MM-DD".len());
        assert_eq!(time.len(), "HH:MM:SS".len());
        assert!(date.contains('-'));
        assert!(time.contains(':'));
    }

    #[test]
    fn env_presente() {
        std::env::set_var("RUSTTY_SUBST_TEST", "valor_env");
        assert_eq!(
            substitute("x=${env:RUSTTY_SUBST_TEST}", &resolver()),
            "x=valor_env"
        );
        std::env::remove_var("RUSTTY_SUBST_TEST");
    }

    #[test]
    fn env_ausente_es_cadena_vacia() {
        std::env::remove_var("RUSTTY_SUBST_NO_EXISTE");
        assert_eq!(
            substitute("[${env:RUSTTY_SUBST_NO_EXISTE}]", &resolver()),
            "[]"
        );
    }

    #[test]
    fn escape_produce_literal() {
        assert_eq!(parse("$${host}"), vec![Marker::Literal("${host}".into())]);
        assert_eq!(substitute("$${host}", &resolver()), "${host}");
        // Escape junto a marcador real.
        assert_eq!(
            substitute("literal $${host} real ${host}", &resolver()),
            "literal ${host} real 192.168.1.10"
        );
    }

    #[test]
    fn doble_dolar_sin_llave_es_literal() {
        // `$$` que no precede a `{` es literal normal.
        assert_eq!(
            substitute("precio 5$$ total", &resolver()),
            "precio 5$$ total"
        );
    }

    #[test]
    fn marcador_desconocido_se_mantiene_literal() {
        assert_eq!(parse("${nope}"), vec![Marker::Literal("${nope}".into())]);
        assert_eq!(substitute("${nope}", &resolver()), "${nope}");
        assert_eq!(substitute("${foo:bar}", &resolver()), "${foo:bar}");
        // Nombre interno vacío / prefijo vacío.
        assert_eq!(substitute("${}", &resolver()), "${}");
        assert_eq!(substitute("${:x}", &resolver()), "${:x}");
    }

    #[test]
    fn sin_cierre_es_literal() {
        assert_eq!(parse("${host"), vec![Marker::Literal("${host".into())]);
        assert_eq!(
            substitute("antes ${host sin cierre", &resolver()),
            "antes ${host sin cierre"
        );
    }

    #[test]
    fn sin_anidamiento_lee_hasta_primer_cierre() {
        // El cuerpo se lee hasta el primer `}`; lo que sigue es literal.
        assert_eq!(substitute("${host}}", &resolver()), "192.168.1.10}");
    }

    #[test]
    fn var_secret_master_ask_quedan_literales_en_fase1() {
        // El resolver por defecto devuelve None para estos namespaces.
        assert_eq!(substitute("${var:dominio}", &resolver()), "${var:dominio}");
        assert_eq!(
            substitute("${secret:token}", &resolver()),
            "${secret:token}"
        );
        assert_eq!(
            substitute("${master:bastion}", &resolver()),
            "${master:bastion}"
        );
        assert_eq!(
            substitute("${ask:Entorno|prod|staging}", &resolver()),
            "${ask:Entorno|prod|staging}"
        );
        assert_eq!(
            substitute("${cmd:hostname}", &resolver()),
            "${cmd:hostname}"
        );
    }

    #[test]
    fn parse_reconoce_namespaces_sin_resolver() {
        // La gramática reconoce los namespaces aunque la Fase 1 no los resuelva.
        assert_eq!(parse("${var:dominio}"), vec![Marker::Var("dominio".into())]);
        assert_eq!(
            parse("${secret:token}"),
            vec![Marker::Secret("token".into())]
        );
        assert_eq!(
            parse("${master:bastion}"),
            vec![Marker::Master("bastion".into())]
        );
        assert_eq!(parse("${env:HOME}"), vec![Marker::Env("HOME".into())]);
        assert_eq!(
            parse("${ask:Entorno|prod|staging}"),
            vec![Marker::Ask {
                label: "Entorno".into(),
                options: vec!["prod".into(), "staging".into()],
            }]
        );
        assert_eq!(
            parse("${ask:Token libre}"),
            vec![Marker::Ask {
                label: "Token libre".into(),
                options: vec![],
            }]
        );
        assert_eq!(
            parse("${cmd:hostname}"),
            vec![Marker::Cmd("hostname".into())]
        );
    }

    #[test]
    fn nombres_invalidos_son_literales() {
        // Nombre que empieza por dígito o con espacio no es válido.
        assert_eq!(substitute("${var:1mal}", &resolver()), "${var:1mal}");
        assert_eq!(
            substitute("${var:con espacio}", &resolver()),
            "${var:con espacio}"
        );
        assert_eq!(substitute("${env:1MAL}", &resolver()), "${env:1MAL}");
        // env no admite `-` ni `.` (convención del SO).
        assert_eq!(substitute("${env:MI-VAR}", &resolver()), "${env:MI-VAR}");
        // var sí admite `-` y `.`.
        assert_eq!(
            parse("${var:mi-var.sub}"),
            vec![Marker::Var("mi-var.sub".into())]
        );
    }

    #[test]
    fn una_sola_pasada_sin_reescaneo() {
        // Si un env resolviera a algo con forma de marcador, NO se reexpande.
        std::env::set_var("RUSTTY_SUBST_INJECT", "${host}");
        assert_eq!(
            substitute("${env:RUSTTY_SUBST_INJECT}", &resolver()),
            "${host}"
        );
        std::env::remove_var("RUSTTY_SUBST_INJECT");
    }
}
