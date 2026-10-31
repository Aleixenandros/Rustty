// @ts-check
/**
 * Rueda del ratón sobre la barra de pestañas: núcleo puro.
 *
 * La tira de pestañas (`#tab-scroll`) desborda en horizontal cuando hay
 * muchas, pero la rueda del ratón produce `deltaY`: sin ayuda, girarla sobre
 * las pestañas no hace nada. Según la preferencia `tabWheel`, la rueda
 * desplaza la tira («scroll», por defecto), cambia de pestaña («switch», como
 * hacen algunos navegadores) o no hace nada («off»).
 */

export const TAB_WHEEL_MODES = /** @type {const} */ (["scroll", "switch", "off"]);

/** @typedef {typeof TAB_WHEEL_MODES[number]} TabWheelMode */

/** Píxeles por «línea» cuando la rueda clásica informa en líneas (deltaMode 1). */
export const TAB_WHEEL_LINE_PX = 32;

/**
 * Normaliza el valor guardado de la preferencia.
 * @param {unknown} value
 * @returns {TabWheelMode}
 */
export function normalizeTabWheel(value) {
  return TAB_WHEEL_MODES.includes(/** @type {any} */ (value)) ? /** @type {TabWheelMode} */ (value) : "scroll";
}

/**
 * Decide qué hacer con un evento de rueda sobre la tira de pestañas.
 *
 * - Ctrl/Cmd+rueda está reservado al zoom del terminal: nunca se toca.
 * - Un gesto predominantemente horizontal (trackpad) ya lo resuelve el
 *   navegador con el `overflow-x` nativo: tampoco se toca.
 * - En modo «scroll», solo hay algo que desplazar si la tira desborda.
 * - En modo «switch», cada muesca cambia una pestaña en el sentido del giro.
 *
 * @param {{ ctrlKey?: boolean, metaKey?: boolean, deltaX?: number, deltaY?: number, deltaMode?: number }} ev
 * @param {{ mode: unknown, overflowing: boolean }} ctx
 * @returns {{ type: "scroll", px: number } | { type: "switch", delta: 1 | -1 } | null}
 */
export function tabWheelAction(ev, ctx) {
  const mode = normalizeTabWheel(ctx.mode);
  if (mode === "off") return null;
  if (ev.ctrlKey || ev.metaKey) return null;
  const dx = ev.deltaX || 0;
  const dy = ev.deltaY || 0;
  if (dy === 0 || Math.abs(dx) > Math.abs(dy)) return null;
  if (mode === "switch") return { type: "switch", delta: dy > 0 ? 1 : -1 };
  if (!ctx.overflowing) return null;
  const px = ev.deltaMode === 1 ? dy * TAB_WHEEL_LINE_PX : dy;
  return { type: "scroll", px };
}
