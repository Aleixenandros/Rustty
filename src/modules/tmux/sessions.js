// @ts-check
/**
 * Qué es cada sesión del modo control de tmux, sin DOM ni IPC.
 *
 * Una conexión en modo control deja tres clases de entradas en el mapa de
 * sesiones de la interfaz:
 * - la **raíz** (`_tmuxControl`): la conexión SSH que habla el protocolo de
 *   control. Su pestaña se oculta en cuanto aparecen ventanas y su canal es un
 *   protocolo de líneas, no un terminal: no debe recibir teclado.
 * - las **pestañas-ventana** (`type: "tmux-window"`, con `_tmux`): una por
 *   ventana tmux; su `pane` es el contenedor del árbol de splits.
 * - las **panes** (`_tmux` sin ser ventana): una por pane tmux, sin pestaña; su
 *   hueco vive dentro de una celda del contenedor de su ventana.
 */

/**
 * @typedef {object} TmuxSessionLike
 * @property {string} [type]
 * @property {boolean} [_tmuxControl]
 * @property {Map<number, { tabId: string }>} [_tmuxWindows]
 * @property {{ conn: string, window: number, pane?: number }} [_tmux]
 */

/**
 * ¿Es una pane tmux (no su pestaña-ventana)? Su hueco viaja dentro del
 * contenedor de su ventana: quien pinta la vista no debe desengancharlo.
 * @param {TmuxSessionLike | null | undefined} s
 * @returns {boolean}
 */
export function isTmuxPaneSession(s) {
  return !!s?._tmux && s.type !== "tmux-window";
}

/**
 * ¿Es la raíz de una conexión cuyo modo control ya muestra ventanas? Mientras
 * conecta, o si tmux faltó y se degradó a un shell normal, aún no hay ventanas
 * y la raíz se comporta como una sesión SSH corriente.
 * @param {TmuxSessionLike | null | undefined} s
 * @returns {boolean}
 */
export function isActiveTmuxControlRoot(s) {
  return !!s?._tmuxControl && (s._tmuxWindows?.size ?? 0) > 0;
}

/**
 * Pestaña que debe mostrarse en lugar de `s`: la primera ventana si `s` es una
 * raíz oculta con ventanas; `null` si `s` se puede mostrar tal cual.
 * @param {TmuxSessionLike | null | undefined} s
 * @returns {string | null}
 */
export function tmuxRootRedirect(s) {
  if (!isActiveTmuxControlRoot(s)) return null;
  const first = /** @type {Map<number, { tabId: string }>} */ (s?._tmuxWindows).values().next().value;
  return first?.tabId || null;
}
