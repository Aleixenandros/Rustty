// @ts-check

/**
 * Temporizador de un aviso que se puede pausar: con el ratón encima o el
 * foco dentro no caduca, y al salir sigue donde se quedó (no vuelve a
 * empezar). Un «Deshacer» o «Copiar error» tiene que dar tiempo a llegar a él
 * (WCAG 2.2.1). Varias causas de pausa se acumulan: el aviso sigue parado
 * mientras quede alguna (ratón fuera pero foco dentro, por ejemplo).
 *
 * No conoce el DOM; el reloj y el planificador se inyectan para los tests.
 */

/** Duraciones de los avisos que el usuario puede elegir en Preferencias. */
export const TOAST_DURATIONS = Object.freeze(["normal", "long", "sticky"]);

/** Mínimo de un aviso en modo «largo». */
const LONG_MIN_MS = 10000;

/**
 * Duración efectiva de un aviso según la preferencia. `normal` respeta la de
 * cada llamada (comportamiento de siempre); `long` la dobla con un mínimo de
 * 10 s; `sticky` no caduca (se cierra a mano). Un valor desconocido cuenta
 * como `normal`. Pedir `0` es «hasta que se cierre» (el aviso de conexiones
 * perdidas): antes un `setTimeout(…, 0)` lo retiraba en el acto.
 *
 * @param {number} ms Duración pedida por quien lanza el aviso.
 * @param {string} [mode]
 * @returns {number} Milisegundos, o `Infinity` si no caduca.
 */
export function toastDurationMs(ms, mode = "normal") {
  if (ms === 0 || ms === Infinity) return Infinity;
  const base = Number.isFinite(ms) && ms > 0 ? ms : 3500;
  if (mode === "sticky") return Infinity;
  if (mode === "long") return Math.max(base * 2, LONG_MIN_MS);
  return base;
}

/**
 * @param {object} opts
 * @param {number} opts.ms Duración; `Infinity` no caduca nunca.
 * @param {() => void} opts.onExpire
 * @param {() => number} [opts.now]
 * @param {(fn: () => void, ms: number) => unknown} [opts.schedule]
 * @param {(handle: any) => void} [opts.unschedule]
 */
export function createPausableTimer({
  ms, onExpire, now = () => Date.now(),
  schedule = (fn, delay) => setTimeout(fn, delay),
  unschedule = (handle) => clearTimeout(handle),
}) {
  let remaining = ms;
  let startedAt = 0;
  /** @type {unknown} */
  let handle = null;
  let done = false;
  /** @type {Set<string>} */
  const reasons = new Set();

  /** Retira la cuenta atrás programada, si la hay. */
  function clear() {
    if (handle != null) unschedule(handle);
    handle = null;
  }

  /** Programa lo que quede, salvo en pausa, terminado o sin caducidad. */
  function run() {
    clear();
    if (done || reasons.size || !Number.isFinite(remaining)) return;
    startedAt = now();
    handle = schedule(() => {
      handle = null;
      if (done) return;
      done = true;
      onExpire();
    }, Math.max(0, remaining));
  }

  /** Descuenta lo ya transcurrido antes de parar. */
  function consume() {
    if (handle == null || !Number.isFinite(remaining)) return;
    remaining = Math.max(0, remaining - (now() - startedAt));
  }

  run();

  return {
    /** @param {string} [reason] */
    pause(reason = "manual") {
      if (done) return;
      if (!reasons.size) consume();
      reasons.add(reason);
      clear();
    },
    /** @param {string} [reason] */
    resume(reason = "manual") {
      if (done || !reasons.delete(reason) || reasons.size) return;
      run();
    },
    /**
     * Vuelve a empezar con una duración nueva (un aviso agrupado que recibe
     * otro evento). Si está en pausa, sigue en pausa con el tiempo nuevo.
     * @param {number} nextMs
     */
    restart(nextMs) {
      if (done) return;
      remaining = nextMs;
      run();
    },
    /** Cancela sin disparar (el aviso se cierra a mano). */
    stop() {
      done = true;
      clear();
    },
    remaining() {
      if (handle != null && Number.isFinite(remaining)) return Math.max(0, remaining - (now() - startedAt));
      return remaining;
    },
    isPaused: () => reasons.size > 0,
  };
}
