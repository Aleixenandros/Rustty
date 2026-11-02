// @ts-check

/**
 * Geometría pura de un diálogo movible y redimensionable.
 *
 * El diálogo sigue centrado por su overlay (flex); el usuario lo desplaza
 * (`dx`, `dy`: desplazamiento del centro) y le cambia el tamaño (`width`,
 * `height`). Guardarlo así, relativo al centro, hace que un tamaño recordado
 * siga teniendo sentido en otra ventana o en otra pantalla.
 *
 * Todas las medidas van en píxeles del diálogo: los de la ventana divididos
 * por el zoom de la interfaz (`--ui-zoom`), que escala los diálogos.
 */

/**
 * @typedef {{ width: number, height: number, dx: number, dy: number }} Frame
 * @typedef {{ width: number, height: number }} Size
 * @typedef {{ minWidth: number, minHeight: number, margin?: number }} Limits
 * @typedef {"n"|"s"|"e"|"w"|"ne"|"nw"|"se"|"sw"} Direction
 */

export const RESIZE_DIRECTIONS = /** @type {Direction[]} */ (["n", "s", "e", "w", "ne", "nw", "se", "sw"]);

/**
 * Encaja el marco en la ventana: el tamaño entre el mínimo y lo que cabe, y
 * la posición de modo que el diálogo entero quede a la vista.
 * @param {Frame} frame
 * @param {Size} viewport
 * @param {Limits} limits
 * @returns {Frame}
 */
export function clampFrame(frame, viewport, { minWidth, minHeight, margin = 8 }) {
  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const maxHeight = Math.max(0, viewport.height - 2 * margin);
  const width = clamp(frame.width, Math.min(minWidth, maxWidth), maxWidth);
  const height = clamp(frame.height, Math.min(minHeight, maxHeight), maxHeight);
  const maxDx = Math.max(0, (viewport.width - width) / 2 - margin);
  const maxDy = Math.max(0, (viewport.height - height) / 2 - margin);
  return {
    width: Math.round(width),
    height: Math.round(height),
    dx: Math.round(clamp(frame.dx, -maxDx, maxDx)),
    dy: Math.round(clamp(frame.dy, -maxDy, maxDy)),
  };
}

/**
 * Desplaza el marco lo que se ha movido el puntero.
 * @param {Frame} frame
 * @param {number} deltaX
 * @param {number} deltaY
 * @param {Size} viewport
 * @param {Limits} limits
 */
export function moveFrame(frame, deltaX, deltaY, viewport, limits) {
  return clampFrame({ ...frame, dx: frame.dx + deltaX, dy: frame.dy + deltaY }, viewport, limits);
}

/**
 * Redimensiona desde un borde o esquina con el lado opuesto quieto. Como el
 * overlay centra el diálogo, crecer `d` por la derecha desplaza el centro
 * `d/2` a la derecha; por la izquierda, `d/2` a la izquierda.
 * @param {Frame} frame
 * @param {Direction} dir
 * @param {number} deltaX
 * @param {number} deltaY
 * @param {Size} viewport
 * @param {Limits} limits
 * @returns {Frame}
 */
export function resizeFrame(frame, dir, deltaX, deltaY, viewport, limits) {
  const { minWidth, minHeight, margin = 8 } = limits;
  let { width, height, dx, dy } = frame;
  // Bordes actuales, relativos al centro de la ventana.
  let left = dx - width / 2;
  let right = dx + width / 2;
  let top = dy - height / 2;
  let bottom = dy + height / 2;
  const halfW = viewport.width / 2 - margin;
  const halfH = viewport.height / 2 - margin;
  if (dir.includes("e")) right = clamp(right + deltaX, left + Math.min(minWidth, 2 * halfW), halfW);
  if (dir.includes("w")) left = clamp(left + deltaX, -halfW, right - Math.min(minWidth, 2 * halfW));
  if (dir.includes("s")) bottom = clamp(bottom + deltaY, top + Math.min(minHeight, 2 * halfH), halfH);
  if (dir.includes("n")) top = clamp(top + deltaY, -halfH, bottom - Math.min(minHeight, 2 * halfH));
  width = right - left;
  height = bottom - top;
  dx = (left + right) / 2;
  dy = (top + bottom) / 2;
  return clampFrame({ width, height, dx, dy }, viewport, limits);
}

/**
 * Valida un marco leído del almacenamiento. Cualquier cosa rara (un JSON a
 * medias, números no finitos, tamaños absurdos) vale `null`: mejor el tamaño
 * de fábrica que un diálogo invisible.
 * @param {unknown} raw
 * @returns {Frame|null}
 */
export function parseStoredFrame(raw) {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  const nums = ["width", "height", "dx", "dy"].map((k) => v[k]);
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [width, height, dx, dy] = /** @type {number[]} */ (nums);
  if (width < 50 || height < 50 || width > 20000 || height > 20000) return null;
  return { width, height, dx, dy };
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
