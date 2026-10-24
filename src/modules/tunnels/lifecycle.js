// @ts-check
/**
 * Qué túneles mueren cuando cae una sesión SSH. Núcleo **puro**: sin DOM ni IPC.
 *
 * El backend crea los túneles dentro de cada intento de conexión y los aborta
 * al salir: tras `ssh-reconnecting` o `ssh-closed` ya no escucha ninguno, y en
 * la reconexión solo vuelven los marcados como automáticos. La interfaz, en
 * cambio, los seguía listando como activos (contador, barra lateral, panel
 * global, «Abrir» bloqueado).
 *
 * Los túneles son de la **conexión**: los que se abren desde una shell hija
 * («Nueva pestaña en esta conexión») viven en el worker de su raíz. Por eso:
 * - si cae una raíz, se olvidan los suyos y los de todas sus hijas;
 * - si se cierra solo una hija con la raíz viva, sus túneles siguen escuchando
 *   y no se tocan (ocultarlos dejaría un puerto abierto sin nada que lo diga);
 * - si la hija se cierra con la raíz ya muerta o retirada, se olvidan los suyos.
 */

/**
 * @typedef {object} TunnelOwnerLike
 * @property {string | null} [_parentSessionId]
 * @property {string} [status]
 */

/**
 * Ids de las sesiones cuyos túneles hay que dar por cerrados al caer `closedId`.
 * @param {Iterable<[string, TunnelOwnerLike]>} entries  Las sesiones (`sessions` vale tal cual).
 * @param {string} closedId
 * @param {(s: TunnelOwnerLike) => boolean} isLive  ¿Sigue viva esa sesión?
 * @returns {string[]}
 */
export function connectionTunnelOwners(entries, closedId, isLive) {
  const all = [...entries];
  const closed = all.find(([sid]) => sid === closedId)?.[1];
  if (!closed) return [];
  const parentId = closed._parentSessionId;
  if (parentId) {
    const parent = all.find(([sid]) => sid === parentId)?.[1];
    return parent && isLive(parent) ? [] : [closedId];
  }
  return all
    .filter(([sid, s]) => sid === closedId || s._parentSessionId === closedId)
    .map(([sid]) => sid);
}
