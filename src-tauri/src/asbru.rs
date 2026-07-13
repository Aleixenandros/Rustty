//! Importador de Ásbrú Connection Manager.
//!
//! Ásbrú guarda su configuración en un YAML (`asbru.yml`) bajo la clave
//! `environments`, un mapa `UUID → nodo`. Cada nodo es un grupo
//! (`_is_group: 1`) o una conexión, y se enlaza al árbol por su `parent`
//! (la raíz es el marcador `__PAC__ROOT__`).
//!
//! Las contraseñas (`pass`, `passphrase`) están cifradas con Blowfish-CBC y la
//! KDF de OpenSSL (`EVP_BytesToKey` con MD5) usando una clave fija. Ni Blowfish
//! ni MD5 están disponibles en el WebCrypto del frontend, así que el parseo y
//! el descifrado viven aquí, en el backend, y se exponen como comandos Tauri.

use std::collections::HashMap;

use blowfish::cipher::{Block, BlockCipherDecrypt, KeyInit};
use blowfish::Blowfish;
use md5::{Digest, Md5};
use serde::Serialize;

/// Clave de cifrado fija de Ásbrú cuando no hay contraseña de GUI configurada.
/// Tomada de `lib/PACUtils.pm` (`Crypt::CBC->new(-key => ...)`).
const ASBRU_KEY: &[u8] = b"PAC Manager (David Torrejon Vaquerizas, david.tv@gmail.com)";

/// Nodo normalizado que consume el asistente de importación del frontend.
/// Comparte forma con el modelo que mRemoteNG construye en JS.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsbruNode {
    uid: String,
    name: String,
    #[serde(rename = "type")]
    node_type: String, // "Container" | "Connection"
    protocol: String,
    conn_type: Option<String>, // "ssh" | "rdp" | None (no soportado)
    host: Option<String>,
    port: Option<u32>,
    username: Option<String>,
    domain: Option<String>,
    notes: Option<String>,
    enc_password: Option<String>, // blob hex cifrado (se descifra al importar)
    children: Vec<AsbruNode>,
}

/// Mapea el `method` de Ásbrú al `connection_type` de Rustty.
/// `SSH`/`SSH2` → ssh, cualquier `RDP (...)` → rdp, el resto no soportado.
fn method_to_conn_type(method: &str) -> (String, Option<String>) {
    let m = method.trim();
    let upper = m.to_uppercase();
    if upper.starts_with("SSH") {
        ("SSH".to_string(), Some("ssh".to_string()))
    } else if upper.starts_with("RDP") {
        ("RDP".to_string(), Some("rdp".to_string()))
    } else {
        // Protocolo no soportado (PACShell, VNC, Telnet…): se muestra deshabilitado.
        (
            if m.is_empty() {
                "?".to_string()
            } else {
                m.to_string()
            },
            None,
        )
    }
}

fn val_str(env: &serde_yaml_ng::Value, key: &str) -> Option<String> {
    env.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Cuota del YAML de Ásbrú (`asbru.yml`). Un catálogo enorme de conexiones no
/// llega a 8 MiB; leer sin tope un fichero elegido a mano deja la puerta abierta
/// a apuntar la app a un fichero gigante y congelar el proceso al parsearlo.
const ASBRU_READ_LIMIT: u64 = 8 * 1024 * 1024;

/// Anclas distintas admitidas en el YAML. Un export real de Ásbrú no usa ninguna.
const MAX_ANCHORS: usize = 512;
/// Apariciones de alias admitidas en el YAML.
const MAX_ALIASES: usize = 4096;
/// Nodos que puede llegar a materializar la expansión de alias (estimado).
const MAX_EXPANDED_NODES: u64 = 100_000;
/// Entradas del mapa `environments` (conexiones + grupos).
const MAX_NODES: usize = 20_000;
/// Profundidad de anidamiento de grupos. `build` es recursivo: sin tope, una
/// cadena larga de grupos padre→hijo desborda la pila.
const MAX_DEPTH: usize = 64;

/// Token de anclaje YAML relevante para el presupuesto de expansión.
enum Tok {
    Anchor(String),
    Alias(String),
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// Extrae del texto YAML las anclas (`&nombre`) y los alias (`*nombre`), en
/// orden de aparición, ignorando comentarios y contenido entrecomillado.
///
/// Es un escáner léxico deliberadamente tosco: solo reconoce `&`/`*` en
/// posición de indicador (inicio de línea o tras un separador). Al usarse para
/// *acotar*, errar por exceso solo sobreestima el coste; lo que no puede es
/// pasar por alto una bomba, y una bomba necesita anclas y alias reales.
fn scan_anchor_tokens(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    for line in text.lines() {
        let bytes = line.as_bytes();
        let mut i = 0usize;
        let mut in_single = false;
        let mut in_double = false;
        let mut at_boundary = true;
        while i < bytes.len() {
            let c = bytes[i];
            if in_single {
                if c == b'\'' {
                    in_single = false;
                }
                i += 1;
                at_boundary = false;
                continue;
            }
            if in_double {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == b'"' {
                    in_double = false;
                }
                i += 1;
                at_boundary = false;
                continue;
            }
            match c {
                b'#' if at_boundary => break, // comentario hasta fin de línea
                b'&' | b'*' if at_boundary => {
                    let start = i + 1;
                    let mut j = start;
                    while j < bytes.len() && is_name_byte(bytes[j]) {
                        j += 1;
                    }
                    if j > start {
                        let name = line[start..j].to_string();
                        out.push(if c == b'&' {
                            Tok::Anchor(name)
                        } else {
                            Tok::Alias(name)
                        });
                        i = j;
                    } else {
                        i += 1;
                    }
                    at_boundary = false;
                }
                b'\'' => {
                    in_single = true;
                    i += 1;
                    at_boundary = false;
                }
                b'"' => {
                    in_double = true;
                    i += 1;
                    at_boundary = false;
                }
                b' ' | b'\t' | b',' | b'[' | b'{' | b'-' | b':' => {
                    i += 1;
                    at_boundary = true;
                }
                _ => {
                    i += 1;
                    at_boundary = false;
                }
            }
        }
    }
    out
}

/// Acota el coste de expandir los alias del YAML **antes** de parsearlo.
///
/// La cuota de tamaño (`ASBRU_READ_LIMIT`) no protege de una bomba de alias
/// («billion laughs»): unos cientos de bytes con nueve anclas que se referencian
/// nueve veces cada una expanden a 9⁹ nodos *dentro* de `from_str`, cuando ya es
/// tarde para contar nada. Aquí se estima el coste sin construir el documento:
/// cada ancla pesa 1 + el peso de los alias que la siguen (hasta la siguiente
/// ancla), y se rechaza el fichero si algún peso —o el del documento— se dispara.
fn check_alias_budget(text: &str) -> Result<(), String> {
    let mut weights: HashMap<String, u64> = HashMap::new();
    // Ancla que se está definiendo: los alias que la siguen suman a su peso.
    let mut current: Option<(String, u64)> = None;
    let mut anchors = 0usize;
    let mut aliases = 0usize;
    // Peso del documento (nodos sueltos) y el mayor de los pesos vistos.
    let mut document: u64 = 1;
    let mut worst: u64 = 1;

    let close = |cur: Option<(String, u64)>, weights: &mut HashMap<String, u64>, worst: &mut u64| {
        if let Some((name, w)) = cur {
            *worst = (*worst).max(w);
            weights.insert(name, w);
        }
    };

    for tok in scan_anchor_tokens(text) {
        match tok {
            Tok::Anchor(name) => {
                anchors += 1;
                if anchors > MAX_ANCHORS {
                    return Err("yaml_bomb".to_string());
                }
                close(current.take(), &mut weights, &mut worst);
                current = Some((name, 1));
            }
            Tok::Alias(name) => {
                aliases += 1;
                if aliases > MAX_ALIASES {
                    return Err("yaml_bomb".to_string());
                }
                // Un alias sin ancla previa no expande nada (YAML no admite
                // referencias hacia adelante): cuenta como un nodo.
                let w = weights.get(&name).copied().unwrap_or(1);
                match current.as_mut() {
                    Some((_, acc)) => *acc = acc.saturating_add(w),
                    None => document = document.saturating_add(w),
                }
            }
        }
    }
    close(current.take(), &mut weights, &mut worst);
    worst = worst.max(document);

    if worst > MAX_EXPANDED_NODES {
        return Err("yaml_bomb".to_string());
    }
    Ok(())
}

/// Parsea el export YAML de Ásbrú y devuelve el árbol normalizado de nodos raíz.
#[tauri::command]
pub fn parse_asbru(path: String) -> Result<Vec<AsbruNode>, String> {
    // Los errores se devuelven como códigos estables («code» o «code|detalle»)
    // para que el frontend los traduzca; ver `import_wizard.err_*` en i18n.js.
    let text = crate::commands::read_text_capped(std::path::Path::new(&path), ASBRU_READ_LIMIT)
        .map_err(|e| format!("read|{e}"))?;
    check_alias_budget(&text)?;
    let doc: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(&text).map_err(|e| format!("yaml|{e}"))?;

    let envs = doc
        .get("environments")
        .and_then(|v| v.as_mapping())
        .ok_or_else(|| "not_asbru".to_string())?;

    if envs.len() > MAX_NODES {
        return Err(format!("too_many|{MAX_NODES}"));
    }

    // Indexa nodos por UUID y agrupa hijos por padre, preservando el orden de
    // aparición (Ásbrú no garantiza orden, pero así es estable).
    let mut by_parent: HashMap<String, Vec<String>> = HashMap::new();
    let mut nodes: HashMap<String, serde_yaml_ng::Value> = HashMap::new();
    let mut roots: Vec<String> = Vec::new();

    for (uuid_v, env) in envs.iter() {
        let uuid = match uuid_v.as_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let parent = val_str(env, "parent");
        match parent.as_deref() {
            None | Some("__PAC__ROOT__") => roots.push(uuid.clone()),
            Some(p) => by_parent
                .entry(p.to_string())
                .or_default()
                .push(uuid.clone()),
        }
        nodes.insert(uuid, env.clone());
    }

    fn build(
        uuid: &str,
        nodes: &HashMap<String, serde_yaml_ng::Value>,
        by_parent: &HashMap<String, Vec<String>>,
        depth: usize,
        too_deep: &mut bool,
    ) -> Option<AsbruNode> {
        if depth > MAX_DEPTH {
            *too_deep = true;
            return None;
        }
        let env = nodes.get(uuid)?;
        let is_group = env.get("_is_group").and_then(|v| v.as_i64()).unwrap_or(0) == 1;
        let name = val_str(env, "name").unwrap_or_else(|| "(sin nombre)".to_string());

        if is_group {
            let children = by_parent
                .get(uuid)
                .map(|kids| {
                    kids.iter()
                        .filter_map(|k| build(k, nodes, by_parent, depth + 1, too_deep))
                        .collect()
                })
                .unwrap_or_default();
            return Some(AsbruNode {
                uid: uuid.to_string(),
                name,
                node_type: "Container".to_string(),
                protocol: String::new(),
                conn_type: None,
                host: None,
                port: None,
                username: None,
                domain: None,
                notes: None,
                enc_password: None,
                children,
            });
        }

        let method = val_str(env, "method").unwrap_or_default();
        let (protocol, conn_type) = method_to_conn_type(&method);
        let port = env.get("port").and_then(|v| v.as_u64()).map(|p| p as u32);

        Some(AsbruNode {
            uid: uuid.to_string(),
            name,
            node_type: "Connection".to_string(),
            protocol,
            conn_type,
            host: val_str(env, "ip"),
            port,
            username: val_str(env, "user"),
            domain: None,
            notes: val_str(env, "description"),
            enc_password: val_str(env, "pass"),
            children: Vec::new(),
        })
    }

    // La poda por profundidad no se hace en silencio: si el árbol excede el
    // tope, el import falla en vez de importar un catálogo incompleto.
    let mut too_deep = false;
    let tree: Vec<AsbruNode> = roots
        .iter()
        .filter_map(|r| build(r, &nodes, &by_parent, 0, &mut too_deep))
        .collect();
    if too_deep {
        return Err(format!("too_deep|{MAX_DEPTH}"));
    }
    Ok(tree)
}

/// KDF de OpenSSL (`EVP_BytesToKey`) con MD5, sin iteraciones extra.
fn evp_bytes_to_key(password: &[u8], salt: &[u8], want: usize) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(want + 16);
    let mut prev: Vec<u8> = Vec::new();
    while out.len() < want {
        let mut h = Md5::new();
        h.update(&prev);
        h.update(password);
        h.update(salt);
        prev = h.finalize().to_vec();
        out.extend_from_slice(&prev);
    }
    out.truncate(want);
    out
}

/// Descifra un blob de contraseña de Ásbrú (`pass`/`passphrase`).
///
/// El blob es hex de `Salted__` + salt(8) + ciphertext. Deriva clave (56 B) e
/// IV (8 B) con la KDF de OpenSSL y descifra Blowfish-CBC (bloques de 8 B),
/// retirando el relleno PKCS#7.
#[tauri::command]
pub fn asbru_decrypt(blob: String) -> Result<String, String> {
    let raw = hex::decode(blob.trim()).map_err(|e| format!("hex no válido: {e}"))?;
    if raw.len() < 16 || &raw[0..8] != b"Salted__" {
        return Err("blob no tiene cabecera Salted__".to_string());
    }
    let salt = &raw[8..16];
    let ct = &raw[16..];
    if ct.is_empty() || ct.len() % 8 != 0 {
        return Err("longitud de ciphertext no válida".to_string());
    }

    // Blowfish admite claves de hasta 56 B; Ásbrú usa la longitud máxima.
    let material = evp_bytes_to_key(ASBRU_KEY, salt, 56 + 8);
    let key = &material[..56];
    let iv = &material[56..64];

    // Blowfish estándar (OpenSSL) usa big-endian, el byte order por defecto.
    let cipher: Blowfish =
        Blowfish::new_from_slice(key).map_err(|e| format!("clave inválida: {e}"))?;

    let mut out: Vec<u8> = Vec::with_capacity(ct.len());
    let mut prev: [u8; 8] = iv.try_into().unwrap();
    for chunk in ct.chunks(8) {
        let mut block = Block::<Blowfish>::try_from(chunk)
            .map_err(|_| "bloque de tamaño inválido".to_string())?;
        cipher.decrypt_block(&mut block);
        let mut plain = [0u8; 8];
        for i in 0..8 {
            plain[i] = block[i] ^ prev[i];
        }
        out.extend_from_slice(&plain);
        prev.copy_from_slice(chunk);
    }

    // Retira el relleno PKCS#7.
    let pad = *out.last().ok_or("salida vacía")? as usize;
    if pad == 0 || pad > 8 || pad > out.len() {
        return Err("relleno PKCS#7 no válido (¿contraseña incorrecta?)".to_string());
    }
    out.truncate(out.len() - pad);

    String::from_utf8(out).map_err(|_| "el texto descifrado no es UTF-8 válido".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_known_blob() {
        // Blob real de un nodo del export de Ásbrú.
        let blob =
            "53616c7465645f5f4e61bc0000000000d761fb328fd62b3acd6c43dd4b160708655044057b636f78";
        let pt = asbru_decrypt(blob.to_string()).unwrap();
        assert_eq!(pt, "<password|/Fujitsu/AD>");
    }

    /// Escribe un YAML temporal y lo pasa por `parse_asbru`.
    fn parse_yaml(tag: &str, yaml: &str) -> Result<Vec<AsbruNode>, String> {
        let dir = std::env::temp_dir().join(format!("rustty-asbru-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("crea dir temporal de test");
        let path = dir.join("asbru.yml");
        std::fs::write(&path, yaml).expect("escribe el yaml");
        let res = parse_asbru(path.to_string_lossy().into_owned());
        let _ = std::fs::remove_dir_all(&dir);
        res
    }

    #[test]
    fn rechaza_bomba_de_alias_antes_de_parsear() {
        // «Billion laughs»: 9 anclas encadenadas, cada una con 9 alias de la
        // anterior. Ocupa menos de 1 KiB pero expande a 9⁹ nodos.
        let mut yaml = String::from("a: &a [x, x, x, x, x, x, x, x, x]\n");
        let names = ["b", "c", "d", "e", "f", "g", "h", "i"];
        let mut prev = "a";
        for n in names {
            yaml.push_str(&format!(
                "{n}: &{n} [*{prev}, *{prev}, *{prev}, *{prev}, *{prev}, *{prev}, *{prev}, *{prev}, *{prev}]\n"
            ));
            prev = n;
        }
        yaml.push_str("environments: *i\n");
        assert_eq!(check_alias_budget(&yaml), Err("yaml_bomb".to_string()));
        assert_eq!(
            parse_yaml("bomb", &yaml).err().as_deref(),
            Some("yaml_bomb")
        );
    }

    #[test]
    fn admite_alias_legitimos_y_texto_con_asteriscos() {
        // Un alias suelto (referencia compartida) no es una bomba, y ni `*` ni
        // `&` dentro de un valor son indicadores YAML.
        let yaml = "\
defaults: &def
  user: root
environments:
  uuid-1:
    name: web
    method: SSH
    ip: 10.0.0.1
    description: 'ls *.log && echo *ok*'
    <<: *def
";
        assert_eq!(check_alias_budget(yaml), Ok(()));
        let tree = parse_yaml("ok", yaml).expect("parsea");
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "web");
    }

    #[test]
    fn rechaza_un_arbol_de_grupos_mas_profundo_que_el_tope() {
        // Cadena de MAX_DEPTH + 2 grupos anidados: sin tope, `build` recursivo
        // desborda la pila con una cadena larga.
        let mut yaml = String::from("environments:\n");
        for i in 0..=(MAX_DEPTH + 1) {
            let parent = if i == 0 {
                "__PAC__ROOT__".to_string()
            } else {
                format!("g{}", i - 1)
            };
            yaml.push_str(&format!(
                "  g{i}:\n    name: grupo{i}\n    _is_group: 1\n    parent: {parent}\n"
            ));
        }
        assert_eq!(
            parse_yaml("deep", &yaml).err(),
            Some(format!("too_deep|{MAX_DEPTH}"))
        );
    }
}
