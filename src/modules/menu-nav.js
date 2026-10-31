// @ts-check

/**
 * Teclado de los menús contextuales (patrón APG «menu» con submenús).
 *
 * Sin DOM: recibe las entradas del nivel actual (ítems, separadores,
 * desactivados, padres con submenú), la posición del foco y si se está dentro
 * de un submenú, y devuelve qué hacer. El adaptador de `main.js` mueve el
 * foco, abre o cierra el submenú y cierra el menú.
 */

/**
 * @typedef {object} MenuEntry
 * @property {boolean} [disabled] No se puede activar ni enfocar.
 * @property {boolean} [separator] Línea divisoria: se salta siempre.
 * @property {boolean} [submenu] Ítem padre que despliega un submenú.
 */

/**
 * @typedef {{ action: "focus", index: number }
 *   | { action: "open" | "parent" | "activate" | "close" | "none" }} MenuKeyResult
 * `focus` lleva el foco a la entrada `index`; `open` despliega el submenú del
 * ítem actual y enfoca su primer ítem; `parent` vuelve al ítem padre cerrando
 * el submenú; `activate` ejecuta el ítem (si no es un botón nativo); `close`
 * cierra el menú entero devolviendo el foco a quien lo abrió.
 */

/**
 * @param {MenuEntry[]} entries
 * @param {number} i
 */
function selectable(entries, i) {
  const e = entries[i];
  return !!e && !e.separator && !e.disabled;
}

/**
 * Entrada a la que ir con ↑/↓/Inicio/Fin, saltando separadores y
 * desactivados y dando la vuelta en los extremos. Sin foco (`current` -1),
 * ↓ va a la primera y ↑ a la última.
 * @param {MenuEntry[]} entries
 * @param {number} current Índice con el foco (-1 si ninguno).
 * @param {string} key `ArrowDown`, `ArrowUp`, `Home` o `End`.
 * @returns {number|null} `null` si la tecla no navega o no hay nada enfocable.
 */
export function menuMove(entries, current, key) {
  const count = entries.length;
  if (count === 0) return null;
  const first = () => entries.findIndex((_, i) => selectable(entries, i));
  const last = () => {
    for (let i = count - 1; i >= 0; i--) if (selectable(entries, i)) return i;
    return -1;
  };
  const finish = (/** @type {number} */ i) => (i < 0 ? null : i);
  if (key === "Home") return finish(first());
  if (key === "End") return finish(last());
  const dir = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (dir === 0) return null;
  if (current < 0 || current >= count) return finish(dir > 0 ? first() : last());
  for (let k = 1; k <= count; k++) {
    const i = (current + dir * k + count * k) % count;
    if (selectable(entries, i)) return i;
  }
  return null;
}

/**
 * Resuelve una tecla sobre el menú.
 *
 * ↑/↓ recorren el nivel actual (dando la vuelta), Inicio/Fin van a los
 * extremos; → abre el submenú del ítem actual; ← vuelve al padre desde un
 * submenú; Enter y Espacio abren el submenú o activan el ítem; Escape cierra
 * el nivel actual (el submenú si se está en uno, si no el menú entero); Tab
 * cierra el menú.
 *
 * @param {string} key
 * @param {{ entries: MenuEntry[], index: number, inSubmenu?: boolean }} ctx
 * @returns {MenuKeyResult}
 */
export function menuKey(key, { entries, index, inSubmenu = false }) {
  const current = entries[index];
  switch (key) {
    case "ArrowDown":
    case "ArrowUp":
    case "Home":
    case "End": {
      const next = menuMove(entries, index, key);
      return next === null ? { action: "none" } : { action: "focus", index: next };
    }
    case "ArrowRight":
      return current?.submenu && !current.disabled ? { action: "open" } : { action: "none" };
    case "ArrowLeft":
      return inSubmenu ? { action: "parent" } : { action: "none" };
    case "Enter":
    case " ":
      if (!current || current.disabled || current.separator) return { action: "none" };
      return current.submenu ? { action: "open" } : { action: "activate" };
    case "Escape":
      return inSubmenu ? { action: "parent" } : { action: "close" };
    case "Tab":
      return { action: "close" };
    default:
      return { action: "none" };
  }
}
