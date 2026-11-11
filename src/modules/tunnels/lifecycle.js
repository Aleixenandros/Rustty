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
 * Los túneles viven en el worker de la **conexión**, pero cada uno recuerda la
 * pestaña que lo abrió: los de una shell hija («Nueva pestaña en esta
 * conexión») se paran en el backend al cerrarse esa hija. Por eso:
 * - si cae una raíz, se olvidan los suyos y los de todas sus hijas;
 * - si se cierra una hija, se olvidan solo los suyos: los de la raíz y los de
 *   sus hermanas siguen escuchando (antes la hija cerrada desaparecía de la
 *   lista con sus túneles aún vivos en la conexión, sin nada que lo dijera).
 */

/**
 * @typedef {object} TunnelOwnerLike
 * @property {string | null} [_parentSessionId]
 */

/**
 * Ids de las sesiones cuyos túneles hay que dar por cerrados al caer `closedId`.
 * @param {Iterable<[string, TunnelOwnerLike]>} entries  Las sesiones (`sessions` vale tal cual).
 * @param {string} closedId
 * @returns {string[]}
 */
export function connectionTunnelOwners(entries, closedId) {
  const all = [...entries];
  const closed = all.find(([sid]) => sid === closedId)?.[1];
  if (!closed) return [];
  if (closed._parentSessionId) return [closedId];
  return all
    .filter(([sid, s]) => sid === closedId || s._parentSessionId === closedId)
    .map(([sid]) => sid);
}

/**
 * @template T
 * @typedef {TunnelOwnerLike & { tunnels?: { values(): Iterable<T> } | null }} TunnelHolderLike
 */

/**
 * Túneles abiertos que se cierran al cerrar las pestañas `closedIds`: los de
 * cada una y, si es una raíz, los de sus hijas. Sirve para avisarlo ANTES de
 * cerrar; cada túnel sale una sola vez aunque se cierren a la vez una raíz y
 * sus hijas.
 *
 * @template T
 * @param {Iterable<[string, TunnelHolderLike<T>]>} entries  Las sesiones.
 * @param {Iterable<string>} closedIds
 * @returns {T[]}
 */
export function tunnelsClosedWith(entries, closedIds) {
  const all = [...entries];
  const owners = new Set();
  for (const id of closedIds) {
    for (const sid of connectionTunnelOwners(all, id)) owners.add(sid);
  }
  /** @type {T[]} */
  const closing = [];
  for (const [sid, session] of all) {
    if (!owners.has(sid)) continue;
    for (const tunnel of session.tunnels?.values() || []) closing.push(tunnel);
  }
  return closing;
}
