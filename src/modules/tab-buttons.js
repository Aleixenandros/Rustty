// @ts-check
/**
 * Botones de la pestaña (panel SFTP, túneles, nota): cuándo se ven. Núcleo
 * puro de la preferencia `tabButtons`; lo aplica la hoja desde
 * `body[data-tab-buttons]`.
 *
 * - «always» (de serie): siempre. Las pestañas ancladas, más estrechas, los
 *   enseñan solo en la activa, al pasar el ratón o con el foco dentro.
 * - «hover»: como las ancladas, en todas: en la activa, al pasar el ratón o
 *   con el foco dentro. Menos ruido con muchas pestañas abiertas.
 * - «active»: solo en la pestaña activa.
 * - «never»: nunca. Sus funciones siguen en el menú contextual de la pestaña
 *   y en los atajos.
 *
 * En «always» y «hover» (y en las ancladas), el botón de un panel abierto
 * —o el de túneles, si la sesión tiene alguno activo— sigue a la vista y en
 * azul aunque la pestaña no esté activa: es un indicador, no ruido.
 */

export const TAB_BUTTONS_MODES = /** @type {const} */ (["always", "hover", "active", "never"]);

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

/**
 * @typedef {object} TabPanelButton
 * @property {boolean} on Se pinta encendido (azul) y no se esconde en «hover».
 * @property {boolean} pressed Su panel está a la vista (`aria-pressed`).
 */

/**
 * Estado de los botones de panel de una pestaña a partir de lo que tiene
 * abierto su sesión.
 * @param {object} state
 * @param {boolean} [state.sftpOpen] Panel SFTP a la vista.
 * @param {boolean} [state.tunnelPanelOpen] Panel de túneles a la vista.
 * @param {number} [state.activeTunnels] Túneles activos de la sesión.
 * @param {boolean} [state.runbookOpen] Nota a la vista.
 * @returns {{ sftp: TabPanelButton, tunnels: TabPanelButton, runbook: TabPanelButton }}
 */
export function tabPanelButtons({ sftpOpen = false, tunnelPanelOpen = false, activeTunnels = 0, runbookOpen = false } = {}) {
  return {
    sftp: { on: sftpOpen, pressed: sftpOpen },
    // Un túnel activo enciende el botón aunque su panel esté cerrado: es lo
    // que hace falta saber de una pestaña en segundo plano.
    tunnels: { on: tunnelPanelOpen || activeTunnels > 0, pressed: tunnelPanelOpen },
    runbook: { on: runbookOpen, pressed: runbookOpen },
  };
}
