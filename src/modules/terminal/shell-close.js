// @ts-check
/**
 * Ordena el aviso «el shell ha terminado» de una consola local respecto a la
 * salida que aún esté de camino. Núcleo **puro**: sin DOM ni IPC, con los
 * temporizadores inyectables para probarlo.
 *
 * El problema: la salida del shell llega por un `Channel` binario y el cierre
 * por un evento Tauri. Son dos caminos y el evento puede adelantar al último
 * bloque de datos (los bloques grandes viajan por un `fetch` aparte), así que
 * el aviso de cierre se pintaba a veces **encima** de las últimas líneas del
 * comando que acababa de terminar.
 *
 * La solución: el backend manda por el propio Channel un bloque **vacío** como
 * marca de fin. El Channel sí ordena sus mensajes, así que cuando llega la marca
 * la salida ya está entera. El aviso se pinta cuando se han visto las dos
 * señales —marca y evento—, en el orden que sea; y si la marca no llega nunca
 * (un canal roto), un plazo corto lo pinta igual: peor es un aviso que no sale.
 */

/** Espera máxima por la marca de fin una vez recibido el evento de cierre. */
export const SHELL_CLOSE_GRACE_MS = 400;

/**
 * @typedef {object} ShellCloseGate
 * @property {() => void} markDrained  Llegó la marca de fin por el Channel.
 * @property {() => void} markClosed   Llegó el evento de cierre.
 * @property {() => void} cancel       Descarta la espera (la sesión se reabre o se destruye).
 */

/**
 * @param {object} options
 * @param {() => void} options.onReady  Se llama **una sola vez**, con la salida ya entera.
 * @param {number} [options.graceMs]
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(id: any) => void} [options.clearTimer]
 * @returns {ShellCloseGate}
 */
export function createShellCloseGate({
  onReady,
  graceMs = SHELL_CLOSE_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let drained = false;
  let closed = false;
  let done = false;
  /** @type {any} */
  let timer = null;

  const stopTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const fire = () => {
    if (done) return;
    done = true;
    stopTimer();
    onReady();
  };

  return {
    markDrained() {
      drained = true;
      if (closed) fire();
    },
    markClosed() {
      if (closed || done) return;
      closed = true;
      if (drained) fire();
      else timer = setTimer(fire, graceMs);
    },
    cancel() {
      done = true;
      stopTimer();
    },
  };
}
