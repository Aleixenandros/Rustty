// @ts-check
/**
 * Detección de plataforma y presentación de atajos dependiente de ella.
 *
 * La detección lee `navigator`, que no existe fuera del navegador; por eso la
 * lógica pura (`formatAccelerator`) recibe `isMac` inyectable y solo cae a
 * `isMacPlatform()` como default en la app.
 */

/**
 * ¿Estamos en macOS? Lee `navigator.userAgentData.platform` (o el UA como
 * respaldo). Devuelve `false` si no hay `navigator` (entorno sin DOM).
 * @returns {boolean}
 */
export function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  // `userAgentData` es una API experimental ausente de los tipos DOM de TS.
  const nav = /** @type {any} */ (navigator);
  const platform = nav.userAgentData?.platform ?? nav.userAgent ?? "";
  return /mac/i.test(platform);
}

/**
 * Presenta un acelerador de teclado para la plataforma: en macOS reemplaza
 * `Ctrl` por `Cmd`; en el resto lo deja igual. Devuelve `""` si no hay atajo.
 *
 * `isMac` se inyecta para los tests; en la app se detecta con
 * {@link isMacPlatform}.
 * @param {string} accel
 * @param {boolean} [isMac]
 * @returns {string}
 */
export function formatAccelerator(accel, isMac = isMacPlatform()) {
  if (!accel) return "";
  return isMac ? accel.replace(/\bCtrl\b/g, "Cmd") : accel;
}
