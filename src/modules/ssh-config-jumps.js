// @ts-check
/**
 * Núcleo **puro** del enlace de bastiones al importar `~/.ssh/config`: si el
 * `ProxyJump` de un `Host` es el alias de otro `Host` del mismo fichero (un
 * solo salto, sin usuario ni puerto), el perfil importado apunta a ese perfil
 * (`proxy_jump_profile_id`) en vez de guardar el texto. Así el salto entra con
 * **sus** credenciales (las de su bloque: su usuario, su `IdentityFile`), como
 * hace `ssh`, y no con las del destino. Todo lo demás —una dirección, una
 * cadena `a,b`, `usuario@alias`, un alias que no está en el fichero— se queda
 * como texto, igual que antes.
 *
 * Sin DOM ni IPC: el llamador da los ids finales de cada alias (los existentes
 * o los nuevos) y aplica el resultado a los perfiles.
 */

/**
 * @typedef {{ alias: string, proxyJump?: string|null }} SshConfigJumpBlock
 */

/**
 * Alias de bastión que se puede enlazar: uno solo, sin `usuario@`, sin
 * `:puerto`, sin espacios y que no sea `none` (que en OpenSSH quita el salto).
 * @param {unknown} raw
 * @returns {string|null}
 */
function linkableAlias(raw) {
  const spec = typeof raw === "string" ? raw.trim() : "";
  if (!spec || /[\s,@:\[\]]/.test(spec) || spec.toLowerCase() === "none") return null;
  return spec;
}

/**
 * Enlaces `alias del destino → id del perfil-salto` de un lote importado. Un
 * bloque que se usa a sí mismo de salto, o un ciclo de bastiones (`a` salta
 * por `b` y `b` por `a`), no se enlaza: se queda como texto y el aviso lo da la
 * conexión, como hasta ahora.
 * @param {SshConfigJumpBlock[]} blocks
 * @param {Map<string, string>} aliasIds Id final del perfil de cada alias.
 * @returns {Map<string, string>}
 */
export function linkSshConfigJumps(blocks, aliasIds) {
  /** @type {Map<string, string>} alias → alias del salto */
  const via = new Map();
  for (const block of blocks) {
    const target = linkableAlias(block.proxyJump);
    if (!target || target === block.alias || !aliasIds.has(target)) continue;
    via.set(block.alias, target);
  }
  // Fuera los ciclos: siguiendo los saltos desde un alias se vuelve a él.
  const cyclic = new Set();
  for (const start of via.keys()) {
    const seen = new Set([start]);
    let current = via.get(start);
    while (current !== undefined) {
      if (current === start) {
        for (const alias of seen) cyclic.add(alias);
        break;
      }
      if (seen.has(current)) break;
      seen.add(current);
      current = via.get(current);
    }
  }
  /** @type {Map<string, string>} */
  const links = new Map();
  for (const [alias, target] of via) {
    const id = aliasIds.get(target);
    if (!cyclic.has(alias) && id) links.set(alias, id);
  }
  return links;
}

/**
 * Campos de bastión de un bloque importado. Con `ProxyJump` enlazable, el
 * perfil del salto y sin texto; con otro `ProxyJump`, el texto y sin perfil
 * (el fichero dice por dónde se sale); sin `ProxyJump`, solo `proxy_jump:
 * null` y el bastión de perfil **no se toca** (el usuario pudo ponerlo en la
 * app), por eso falta la clave.
 * @param {SshConfigJumpBlock} block
 * @param {Map<string, string>} links Resultado de {@link linkSshConfigJumps}.
 * @returns {{ proxy_jump: string|null, proxy_jump_profile_id?: string|null }}
 */
export function sshConfigJumpFields(block, links) {
  const linked = links.get(block.alias);
  if (linked) return { proxy_jump: null, proxy_jump_profile_id: linked };
  const text = typeof block.proxyJump === "string" ? block.proxyJump.trim() : "";
  if (text) return { proxy_jump: text, proxy_jump_profile_id: null };
  return { proxy_jump: null };
}

/**
 * Un bloque por alias: con un `Host` repetido se queda el primero, como hace
 * `ssh` (el primer valor de cada opción gana). Sin esto, los dos bloques
 * recibían el mismo id de perfil y se creaban dos perfiles con él. Devuelve
 * también los alias repetidos, para decirlo en el resumen.
 * @template {{ alias: string }} B
 * @param {B[]} blocks
 * @returns {{ blocks: B[], duplicates: string[] }}
 */
export function firstBlockPerAlias(blocks) {
  /** @type {B[]} */
  const kept = [];
  const seen = new Set();
  /** @type {string[]} */
  const duplicates = [];
  for (const block of blocks || []) {
    if (seen.has(block.alias)) {
      if (!duplicates.includes(block.alias)) duplicates.push(block.alias);
      continue;
    }
    seen.add(block.alias);
    kept.push(block);
  }
  return { blocks: kept, duplicates };
}
