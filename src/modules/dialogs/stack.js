// @ts-check

/**
 * Núcleo puro de la pila de diálogos: qué diálogo está arriba, a quién vuelve
 * el foco al cerrar, quién recibe Escape, qué queda inerte detrás y dónde va
 * el Tab en los extremos. No conoce el DOM: el «opener» (quien abrió el
 * diálogo) se guarda como un valor opaco que el adaptador interpreta.
 *
 * Todas las funciones devuelven estructuras nuevas; la pila de entrada no se
 * modifica nunca.
 */

/**
 * @typedef {object} DialogEntry
 * @property {string} id
 * @property {unknown} opener Elemento (u otra referencia) al que volver.
 * @property {boolean} modal Si deja inerte lo que tiene debajo.
 */

/** @typedef {ReadonlyArray<DialogEntry>} DialogStack */

/**
 * Atajos globales que siguen funcionando con un diálogo modal abierto: solo
 * los que no actúan sobre nada de lo que queda detrás (el zoom de la
 * interfaz agranda también el diálogo). Ctrl+W, Ctrl+Tab, Ctrl+P o Ctrl+1…9
 * cerrarían, cambiarían o escribirían en una sesión oculta tras el velo.
 */
export const MODAL_SAFE_SHORTCUTS = Object.freeze(["ui_zoom_in", "ui_zoom_out", "ui_zoom_reset"]);

/**
 * Abre (o sube a la cima) un diálogo. Reabrir un id que ya estaba en la pila
 * lo lleva arriba y conserva su opener original: un diálogo que se refresca
 * no debe olvidar a quién devolver el foco.
 *
 * @param {DialogStack} stack
 * @param {{ id: string, opener?: unknown, modal?: boolean }} entry
 * @returns {DialogEntry[]}
 */
export function openDialog(stack, { id, opener = null, modal = true }) {
  const existing = stack.find((item) => item.id === id);
  const rest = stack.filter((item) => item.id !== id);
  if (existing) return [...rest, { ...existing, modal }];
  return [...rest, { id, opener, modal }];
}

/**
 * Cierra un diálogo. Si estaba arriba, el foco vuelve a su opener. Si no lo
 * estaba (se cierra un padre con un hijo abierto encima), el hijo hereda su
 * opener: el disparador del hijo vivía dentro del padre, que ya no existe.
 *
 * @param {DialogStack} stack
 * @param {string} id
 * @returns {{ stack: DialogEntry[], restore: unknown, wasTop: boolean, found: boolean }}
 */
export function closeDialog(stack, id) {
  const index = stack.findIndex((item) => item.id === id);
  if (index < 0) return { stack: [...stack], restore: null, wasTop: false, found: false };
  const wasTop = index === stack.length - 1;
  const closing = stack[index];
  const next = stack.filter((_, i) => i !== index).map((item) => ({ ...item }));
  if (wasTop) return { stack: next, restore: closing.opener, wasTop, found: true };
  // El diálogo que estaba justo encima ocupa ahora la posición `index`.
  next[index] = { ...next[index], opener: closing.opener };
  return { stack: next, restore: null, wasTop, found: true };
}

/**
 * @param {DialogStack} stack
 * @returns {DialogEntry|null}
 */
export function topDialog(stack) {
  return stack.length ? stack[stack.length - 1] : null;
}

/**
 * A qué diálogo le toca un Escape. Un componente interno que ya lo ha
 * consumido (un desplegable, el selector de carpeta) lo marca con
 * `preventDefault` y entonces no cierra nada más; durante la composición de
 * un IME, Escape cancela la composición y tampoco es para el diálogo.
 *
 * @param {DialogStack} stack
 * @param {{ defaultPrevented?: boolean, isComposing?: boolean }} event
 * @returns {string|null}
 */
export function escapeTarget(stack, { defaultPrevented = false, isComposing = false } = {}) {
  if (defaultPrevented || isComposing) return null;
  return topDialog(stack)?.id ?? null;
}

/**
 * Trampa de Tab: índice al que llevar el foco cuando Tab/Shift+Tab saldría
 * del diálogo, o `null` si el navegador puede moverlo por su cuenta (no está
 * en un extremo). `-1` significa «enfoca el contenedor» (no hay nada
 * enfocable dentro).
 *
 * @param {number} index Posición del foco actual entre los enfocables (-1 si está fuera).
 * @param {number} count Número de enfocables del diálogo.
 * @param {boolean} backwards Shift+Tab.
 * @returns {number|null}
 */
export function trapIndex(index, count, backwards) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (!Number.isInteger(index) || index < 0 || index >= count) return backwards ? count - 1 : 0;
  if (backwards && index === 0) return count - 1;
  if (!backwards && index === count - 1) return 0;
  return null;
}

/**
 * Qué queda inerte con la pila actual: el fondo de la app en cuanto hay un
 * diálogo modal, y todos los diálogos por debajo de la cima.
 *
 * @param {DialogStack} stack
 * @returns {{ background: boolean, dialogs: string[] }}
 */
export function backgroundPlan(stack) {
  if (!stack.length) return { background: false, dialogs: [] };
  return {
    background: stack.some((item) => item.modal),
    dialogs: stack.slice(0, -1).map((item) => item.id),
  };
}

/**
 * Qué enfocar al abrir un diálogo.
 * - `explicit`: el llamador ha nombrado un elemento.
 * - `cancel`: confirmación destructiva sin campo; un Enter por reflejo no
 *   debe borrar nada.
 * - `field`: primer campo editable.
 * - `submit`: confirmación no destructiva sin campo (Enter acepta, como hasta ahora).
 * - `first`: primer enfocable.
 * - `container`: el propio diálogo (listas, paneles sin controles).
 *
 * @param {{ explicit?: boolean, confirm?: boolean, danger?: boolean, hasField?: boolean, hasFocusable?: boolean }} opts
 * @returns {"explicit"|"cancel"|"field"|"submit"|"first"|"container"}
 */
export function initialFocusKind({ explicit = false, confirm = false, danger = false, hasField = false, hasFocusable = true } = {}) {
  if (explicit) return "explicit";
  if (confirm && !hasField) return danger ? "cancel" : "submit";
  if (hasField) return "field";
  return hasFocusable ? "first" : "container";
}

/**
 * El primer destino válido para devolver el foco: sigue en el documento, se
 * ve y no está inerte. Si ninguno vale, `null` (el adaptador cae al terminal
 * activo o a la lista de conexiones).
 *
 * @template T
 * @param {ReadonlyArray<{ target: T, connected?: boolean, visible?: boolean, inert?: boolean }>} candidates
 * @returns {T|null}
 */
export function pickRestore(candidates) {
  for (const c of candidates) {
    if (c && c.target != null && c.connected && c.visible && !c.inert) return c.target;
  }
  return null;
}

/**
 * Si un atajo global puede actuar con este diálogo arriba. Sin diálogo, todo.
 *
 * @param {string} shortcutId
 * @param {DialogStack} stack
 * @returns {boolean}
 */
export function allowShortcutInDialog(shortcutId, stack) {
  if (!stack.some((item) => item.modal)) return true;
  return MODAL_SAFE_SHORTCUTS.includes(shortcutId);
}
