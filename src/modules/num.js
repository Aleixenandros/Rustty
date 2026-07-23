// @ts-check
/**
 * Utilidades numéricas puras (acotado, redondeo) sin estado ni DOM.
 *
 * Parte del troceo de `main.js` (>23k líneas): funciones **puras** con tests
 * vitest, mismo patrón que `format`, `html`, etc.
 */

/**
 * Acota el factor de zoom de la interfaz al rango soportado `[0.6, 1.6]` y lo
 * redondea a centésimas (dos decimales). Un valor no finito cae al `1` neutro.
 * @param {number} z
 * @returns {number}
 */
export function clampUiZoom(z) {
  if (!Number.isFinite(z)) return 1;
  return Math.min(1.6, Math.max(0.6, Math.round(z * 100) / 100));
}
