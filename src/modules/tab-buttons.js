// @ts-check
/**
 * Botones de la pestaña (panel SFTP, túneles, nota): cuándo se ven. Núcleo
 * puro de la preferencia `tabButtons`; lo aplica la hoja desde
 * `body[data-tab-buttons]`.
 *
 * - «always» (de serie): siempre. Las pestañas ancladas, más estrechas, los
 *   enseñan solo en la activa, al pasar el ratón o con el foco dentro.
 * - «active»: solo en la pestaña activa.
 * - «never»: nunca. Sus funciones siguen en el menú contextual de la pestaña
 *   y en los atajos.
 */

export const TAB_BUTTONS_MODES = /** @type {const} */ (["always", "active", "never"]);

/** @typedef {typeof TAB_BUTTONS_MODES[number]} TabButtonsMode */

/**
 * Normaliza el valor guardado de la preferencia (lo desconocido vuelve al de
 * serie, que es el comportamiento de antes de existir la opción).
 * @param {unknown} value
 * @returns {TabButtonsMode}
 */
export function normalizeTabButtons(value) {
  return TAB_BUTTONS_MODES.includes(/** @type {any} */ (value)) ? /** @type {TabButtonsMode} */ (value) : "always";
}
