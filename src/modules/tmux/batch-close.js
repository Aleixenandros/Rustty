// @ts-check
/**
 * Normaliza un cierre en lote de pestañas («Cerrar todas», «las demás», «a la
 * derecha») cuando entre ellas hay conexiones tmux en modo control. Núcleo
 * **puro**: recibe ids y el papel de cada uno.
 *
 * Por qué hace falta: el lote salía de todas las sesiones, así que incluía la
 * raíz oculta, sus pestañas-ventana y sus panes. Cerrar la raíz primero soltaba
 * la conexión y las ventanas quedaban zombi (su `kill-window` ya no tenía
 * conexión); «Cerrar las demás» desde una ventana mataba la conexión de esa
 * misma ventana; y «a la derecha» podía matar ventanas en el servidor con el
 * aviso genérico, no con el rojo propio.
 *
 * Reglas:
 * - Las panes nunca entran: caen con su ventana o con su raíz.
 * - Una conexión se **conserva** si alguna de sus ventanas queda fuera del lote
 *   (la elegida, una anclada o una fuera del rango). Entonces su raíz no se
 *   cierra, y sus ventanas que sí entran se cierran una a una con su propia
 *   confirmación (`confirmEach`): cerrarlas mata procesos en el servidor.
 * - Si todas sus ventanas entran, se sustituyen por la raíz: se desconecta y la
 *   sesión tmux sigue viva en el servidor.
 */

/**
 * @typedef {{ role: "pane" | "window", conn: string } | { role: "root" | "plain" }} BatchRole
 *   `root` = raíz con ventanas; una raíz que aún conecta o se degradó a shell
 *   normal es `plain`.
 */

/**
 * @param {object} params
 * @param {string[]} params.candidates  Ids que cerraría la acción, en orden y ya sin las ancladas.
 * @param {Iterable<string>} params.all  Todos los ids de sesión (para ver qué ventanas quedan fuera).
 * @param {(sid: string) => BatchRole} params.roleOf
 * @returns {{ ids: string[], confirmEach: string[] }}
 *   `ids`: a cerrar sin preguntar de nuevo; `confirmEach`: ventanas que piden su propia confirmación.
 */
export function normalizeTmuxBatchClose({ candidates, all, roleOf }) {
  const inBatch = new Set(candidates);
  /** @type {Set<string>} */
  const keptConns = new Set();
  for (const sid of all) {
    const r = roleOf(sid);
    if (r.role === "window" && !inBatch.has(sid)) keptConns.add(r.conn);
  }

  /** @type {string[]} */
  const ids = [];
  /** @type {string[]} */
  const confirmEach = [];
  const seen = new Set();
  /**
   * @param {string[]} list
   * @param {string} id
   */
  const add = (list, id) => {
    if (seen.has(id)) return;
    seen.add(id);
    list.push(id);
  };

  for (const sid of candidates) {
    const r = roleOf(sid);
    if (r.role === "pane") continue;
    if (r.role === "window") {
      if (keptConns.has(r.conn)) add(confirmEach, sid);
      else add(ids, r.conn);
      continue;
    }
    if (r.role === "root" && keptConns.has(sid)) continue;
    add(ids, sid);
  }
  return { ids, confirmEach };
}
