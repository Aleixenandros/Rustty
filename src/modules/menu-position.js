// @ts-check

/**
 * Posicionamiento de menús flotantes dentro del viewport.
 *
 * Los menús contextuales son elementos del DOM: dentro de la WebView no pueden
 * sobresalir de la ventana del SO, así que la única salida en ventanas pequeñas
 * es clampar la posición y, si ni siquiera caben, acotarlos con scroll interno.
 */

/** Margen mínimo entre el menú y el borde de la ventana, en px. */
export const MENU_VIEWPORT_MARGIN = 6;

/**
 * Clampa la esquina superior izquierda de un menú para que quede íntegro
 * dentro del viewport, con un margen de respeto en los cuatro bordes.
 *
 * Si el menú es más grande que el viewport, prioriza el borde superior
 * izquierdo (nunca devuelve valores por debajo del margen): el contenido
 * restante queda alcanzable con el scroll interno del menú.
 *
 * @param {number} x Coordenada solicitada (clic).
 * @param {number} y Coordenada solicitada (clic).
 * @param {number} menuWidth Ancho medido del menú.
 * @param {number} menuHeight Alto medido del menú.
 * @param {number} viewportWidth Ancho del viewport.
 * @param {number} viewportHeight Alto del viewport.
 * @param {number} [margin] Margen de respeto (por defecto `MENU_VIEWPORT_MARGIN`).
 * @returns {{ left: number, top: number }}
 */
export function clampMenuPosition(
  x,
  y,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = MENU_VIEWPORT_MARGIN
) {
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - menuWidth - margin)),
    top: Math.max(margin, Math.min(y, viewportHeight - menuHeight - margin)),
  };
}

/**
 * ¿Necesita el menú acotarse con scroll interno para caber en el viewport?
 *
 * @param {number} menuHeight Alto natural medido del menú.
 * @param {number} viewportHeight Alto del viewport.
 * @param {number} [margin] Margen de respeto por borde.
 * @returns {boolean}
 */
export function menuNeedsScroll(menuHeight, viewportHeight, margin = MENU_VIEWPORT_MARGIN) {
  return menuHeight > viewportHeight - margin * 2;
}
