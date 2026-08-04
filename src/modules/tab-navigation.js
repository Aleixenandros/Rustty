// @ts-check

/**
 * Calcula la pestaña a activar para las teclas habituales de un `tablist`.
 * No conoce el DOM: sirve tanto para listas horizontales como verticales y
 * deja al llamador decidir si mueve también el foco.
 *
 * @param {number} current Índice activo.
 * @param {number} count Número total de pestañas.
 * @param {string} key `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home` o `End`.
 * @returns {number|null} El nuevo índice, o `null` si la tecla no navega.
 */
export function tabIndexForKey(current, count, key) {
  if (!Number.isInteger(current) || !Number.isInteger(count) || count <= 0 || current < 0 || current >= count) {
    return null;
  }
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  return null;
}
