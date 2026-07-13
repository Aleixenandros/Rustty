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

/// Parsea el export YAML de Ásbrú y devuelve el árbol normalizado de nodos raíz.
#[tauri::command]
pub fn parse_asbru(path: String) -> Result<Vec<AsbruNode>, String> {
    // Los errores se devuelven como códigos estables («code» o «code|detalle»)
    // para que el frontend los traduzca; ver `import_wizard.err_*` en i18n.js.
    let text = crate::commands::read_text_capped(std::path::Path::new(&path), ASBRU_READ_LIMIT)
        .map_err(|e| format!("read|{e}"))?;
    let doc: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(&text).map_err(|e| format!("yaml|{e}"))?;

    let envs = doc
        .get("environments")
        .and_then(|v| v.as_mapping())
        .ok_or_else(|| "not_asbru".to_string())?;

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
    ) -> Option<AsbruNode> {
        let env = nodes.get(uuid)?;
        let is_group = env.get("_is_group").and_then(|v| v.as_i64()).unwrap_or(0) == 1;
        let name = val_str(env, "name").unwrap_or_else(|| "(sin nombre)".to_string());

        if is_group {
            let children = by_parent
                .get(uuid)
                .map(|kids| {
                    kids.iter()
                        .filter_map(|k| build(k, nodes, by_parent))
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

    let tree: Vec<AsbruNode> = roots
        .iter()
        .filter_map(|r| build(r, &nodes, &by_parent))
        .collect();
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
}
