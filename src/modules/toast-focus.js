// @ts-check

/**
 * «Ir al último aviso»: decide a qué aviso de la pila llevar el foco y
 * cuándo hay que devolverlo a donde estaba. Sin DOM: `main.js` describe la
 * pila y aplica el resultado.
 *
 * El foco va al último aviso visible que tenga una acción («Copiar error»,
 * «Ver log», «Deshacer»…): es lo que el usuario quiere alcanzar sin el ratón.
 * Si ningún aviso visible tiene acción, al último visible (su botón de
 * cerrar), para que el atajo haga siempre algo cuando hay avisos.
 */

/**
 * @typedef {object} ToastInfo
 * @property {boolean} hasAction El aviso tiene un botón de acción.
 * @property {boolean} [hidden] Colapsado detrás del contador «+N».
 */

/**
 * Índice del aviso que recibe el foco, o `-1` si no hay ninguno visible.
 * @param {ToastInfo[]} toasts En orden del DOM: el más reciente, al final.
 * @returns {number}
 */
export function pickToastToFocus(toasts) {
  let lastVisible = -1;
  let lastWithAction = -1;
  toasts.forEach((toast, index) => {
    if (toast.hidden) return;
    lastVisible = index;
    if (toast.hasAction) lastWithAction = index;
  });
  return lastWithAction >= 0 ? lastWithAction : lastVisible;
}

/**
 * Si una tecla pulsada dentro del aviso enfocado significa «salir»: Escape
 * siempre; Tab solo cuando se sale del aviso por un extremo (desde el último
 * control hacia delante o desde el primero hacia atrás). Entre los controles
 * del propio aviso (acción → cerrar) Tab navega con normalidad.
 *
 * @param {object} key
 * @param {string} key.key `KeyboardEvent.key`.
 * @param {boolean} [key.shiftKey]
 * @param {boolean} [key.altKey]
 * @param {boolean} [key.ctrlKey]
 * @param {boolean} [key.metaKey]
 * @param {number} index Posición del control enfocado entre los del aviso.
 * @param {number} count Controles enfocables del aviso.
 * @returns {boolean}
 */
export function isToastExitKey({ key, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false }, index, count) {
  if (key === "Escape") return true;
  if (key !== "Tab" || altKey || ctrlKey || metaKey) return false;
  return shiftKey ? index <= 0 : index >= count - 1;
}

/**
 * Si al terminar (salida por teclado, cierre del aviso) hay que devolver el
 * foco a quien lo tenía: solo si sigue dentro del aviso o se ha perdido (el
 * aviso desapareció y el foco cayó al documento). Si la acción del aviso ya
 * lo llevó a otro sitio (abrió un diálogo, enfocó un campo), se respeta.
 *
 * @param {{ activeInsideToast: boolean, activeIsBody: boolean }} state
 * @returns {boolean}
 */
export function shouldReturnToastFocus({ activeInsideToast, activeIsBody }) {
  return activeInsideToast || activeIsBody;
}
