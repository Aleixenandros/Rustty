// @ts-check
/**
 * Reparto del ancho entre los dos lados del panel SFTP (divisor central
 * arrastrable). Núcleo puro: la proporción es la parte del ancho útil que se
 * lleva la columna de la IZQUIERDA (la que se ve a la izquierda, sea el
 * remoto o el local según «Disposición de paneles»).
 */

export const SFTP_SPLIT_DEFAULT = 0.5;
export const SFTP_SPLIT_MIN = 0.2;
export const SFTP_SPLIT_MAX = 0.8;
/** Paso de las flechas del teclado sobre el divisor. */
export const SFTP_SPLIT_STEP = 0.05;

/**
 * Proporción válida: un número dentro de los topes; lo demás, la de serie.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeSftpSplit(value) {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return SFTP_SPLIT_DEFAULT;
  return Math.min(SFTP_SPLIT_MAX, Math.max(SFTP_SPLIT_MIN, n));
}

/**
 * Proporción para el puntero en `x` (píxeles de ventana), con el panel en
 * `[left, left + width)` y el divisor de `divider` píxeles en medio. Se mide
 * hasta el centro del divisor, así no salta al empezar a arrastrar.
 * @param {{ x: number, left: number, width: number, divider: number }} geometry
 * @returns {number}
 */
export function sftpSplitFromPointer({ x, left, width, divider }) {
  const usable = width - divider;
  if (!(usable > 0)) return SFTP_SPLIT_DEFAULT;
  return normalizeSftpSplit((x - left - divider / 2) / usable);
}

/**
 * Valores de `grid-template-columns` de los dos lados (en `fr`, para que el
 * divisor conserve su ancho fijo).
 * @param {unknown} ratio
 * @returns {{ left: string, right: string }}
 */
export function sftpSplitColumns(ratio) {
  const r = normalizeSftpSplit(ratio);
  const round = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;
  return { left: `${round(r)}fr`, right: `${round(1 - r)}fr` };
}

/**
 * Teclado sobre el divisor (role="separator"): flechas mueven un paso,
 * Inicio/Fin van a los topes e Intro vuelve a la mitad. `null` si la tecla
 * no es suya.
 * @param {number} ratio
 * @param {string} key
 * @returns {number|null}
 */
export function sftpSplitForKey(ratio, key) {
  const r = normalizeSftpSplit(ratio);
  switch (key) {
    case "ArrowLeft": return normalizeSftpSplit(Math.round((r - SFTP_SPLIT_STEP) * 100) / 100);
    case "ArrowRight": return normalizeSftpSplit(Math.round((r + SFTP_SPLIT_STEP) * 100) / 100);
    case "Home": return SFTP_SPLIT_MIN;
    case "End": return SFTP_SPLIT_MAX;
    case "Enter": return SFTP_SPLIT_DEFAULT;
    default: return null;
  }
}
