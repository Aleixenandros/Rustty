// @ts-check
/**
 * Cola FIFO de los diálogos que comparten el único modal de credenciales
 * (contraseña, MFA, host key, certificado FTPS, confirmaciones). Núcleo
 * **puro**: no conoce el DOM; quien la usa le pasa cómo pintar cada diálogo.
 *
 * El problema que resuelve: abrir un diálogo nuevo cancelaba el visible. Los
 * que pide el backend (host key, MFA) llegan en cualquier momento, así que con
 * dos conexiones en curso el segundo anulaba al primero —una host key
 * rechazada, una ronda MFA abortada, una contraseña que volvía `null`— y el
 * Intro con el que el usuario terminaba de teclear en uno caía en el otro.
 * Ahora cada petición espera su turno y ninguna se resuelve por culpa de otra.
 *
 * Dos detalles de orden que importan:
 * - La limpieza que devuelve `open` se ejecuta **antes** de resolver y antes
 *   de abrir el siguiente: lo que un diálogo cambió en el modal no se filtra.
 * - El siguiente se abre en una macrotarea (`schedule`), no en el mismo tick:
 *   así el llamador que acaba de resolver termina su propia limpieza tras el
 *   `await` antes de que se pinte el diálogo de otro. Un paso nuevo que pida
 *   ese llamador (la segunda pregunta de una ronda MFA) se pone a la cola,
 *   detrás de los que ya esperaban.
 */

/**
 * @typedef {object} PromptQueue
 * @property {(open: () => (void | (() => void)), options?: { armMs?: number, expiresAt?: number }) => Promise<any>} request
 *   Encola un diálogo. `open` lo pinta cuando le toca y puede devolver su
 *   limpieza. `armMs`: tras mostrarse, el envío se ignora durante esos ms (un
 *   Intro que ya venía tecleado no confirma un diálogo que acaba de salir).
 *   `expiresAt` (ms del reloj de la cola): si le llega el turno pasada esa
 *   hora, no se muestra y se resuelve con `null` —una pregunta del backend que
 *   ya caducó esperando (huella, ronda MFA) no debe hacer esperar a la vigente—.
 *   Resuelve con lo que se pase a `close`, o `null` si no se pudo pintar.
 * @property {(result: any) => boolean} close
 *   Resuelve el diálogo visible con `result` y da paso al siguiente; `false` si no había ninguno.
 * @property {() => boolean} canSubmit  `false` mientras el visible no admite envío (recién mostrado).
 * @property {() => boolean} isOpen     Hay un diálogo visible.
 * @property {() => number} pending     Diálogos esperando turno (sin contar el visible).
 */

/**
 * @param {object} [options]
 * @param {(fn: () => void) => void} [options.schedule] Cómo diferir la apertura del siguiente.
 * @param {() => number} [options.now] Reloj en ms (para el armado del envío).
 * @returns {PromptQueue}
 */
export function createPromptQueue({
  schedule = (fn) => { setTimeout(fn, 0); },
  now = () => Date.now(),
} = {}) {
  /** @type {{ open: () => (void | (() => void)), resolve: (v: any) => void, armMs: number, expiresAt: number }[]} */
  const waiting = [];
  /** @type {{ resolve: (v: any) => void, cleanup: (() => void) | null, armedAt: number } | null} */
  let current = null;

  /** Muestra la cabeza de la cola si no hay ningún diálogo a la vista. */
  function showNext() {
    while (!current && waiting.length) {
      const next = /** @type {typeof waiting[number]} */ (waiting.shift());
      if (next.expiresAt && now() >= next.expiresAt) {
        next.resolve(null);
        continue;
      }
      const entry = { resolve: next.resolve, cleanup: /** @type {(() => void) | null} */ (null), armedAt: now() + next.armMs };
      current = entry;
      try {
        const cleanup = next.open();
        if (current === entry) entry.cleanup = typeof cleanup === "function" ? cleanup : null;
        else if (typeof cleanup === "function") runQuietly(cleanup);
      } catch (err) {
        // Un diálogo que no se pudo pintar se da por cancelado; la cola sigue.
        console.warn("[prompt-queue] open failed", err);
        if (current === entry) current = null;
        next.resolve(null);
      }
    }
  }

  return {
    request(open, { armMs = 0, expiresAt = 0 } = {}) {
      return new Promise((resolve) => {
        waiting.push({
          open, resolve, armMs: Math.max(0, Number(armMs) || 0), expiresAt: Number(expiresAt) || 0,
        });
        if (!current) showNext();
      });
    },
    close(result) {
      if (!current) return false;
      const { resolve, cleanup } = current;
      current = null;
      if (cleanup) runQuietly(cleanup);
      resolve(result);
      if (waiting.length) schedule(showNext);
      return true;
    },
    canSubmit() {
      return !!current && now() >= current.armedAt;
    },
    isOpen() {
      return !!current;
    },
    pending() {
      return waiting.length;
    },
  };
}

/** @param {() => void} fn */
function runQuietly(fn) {
  try {
    fn();
  } catch (err) {
    console.warn("[prompt-queue] cleanup failed", err);
  }
}
