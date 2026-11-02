// @ts-check
/**
 * Sondeo del monitor de recursos de la consola local. Núcleo **puro**: el
 * muestreo y los temporizadores llegan inyectados.
 *
 * En SSH el backend empuja una muestra por evento con su propio temporizador;
 * en local es el frontend quien la pide (`local_metrics_sample`) con este
 * sondeo, así no queda en el backend ningún hilo vivo que limpiar: si la
 * interfaz deja de preguntar, se deja de muestrear. Tres garantías:
 *   - nunca dos muestras a la vez: la siguiente se programa al volver la
 *     anterior (con éxito o con error), no a intervalo fijo;
 *   - lo que vuelve tras `stop()` se descarta, aunque luego se haya vuelto a
 *     encender (cada arranque es una generación nueva);
 *   - la primera muestra de cada arranque va `fresh` (sin la previa vieja), y
 *     el intervalo se lee en cada vuelta (un cambio de preferencia se aplica).
 */

/**
 * @template T
 * @typedef {object} MetricsPollerOptions
 * @property {(fresh: boolean) => Promise<T>} sample Pide una muestra.
 * @property {(value: T) => void} onSample Entrega una muestra vigente.
 * @property {(err: unknown) => void} [onError] Una muestra fallida (se sigue sondeando).
 * @property {() => number} intervalMs Pausa entre el final de una muestra y la siguiente.
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 */

/**
 * @typedef {object} MetricsPoller
 * @property {() => void} start Enciende (idempotente).
 * @property {() => void} stop Apaga (idempotente) y descarta lo que esté en vuelo.
 * @property {() => boolean} isRunning
 */

/**
 * @template T
 * @param {MetricsPollerOptions<T>} opts
 * @returns {MetricsPoller}
 */
export function createMetricsPoller(opts) {
  const {
    sample,
    onSample,
    onError = () => {},
    intervalMs,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(/** @type {any} */ (handle)),
  } = opts;
  let generation = 0;
  let running = false;
  /** @type {unknown} */
  let timer = null;

  /**
   * @param {number} gen Generación del arranque que pidió esta vuelta.
   * @param {boolean} fresh Primera muestra del arranque.
   */
  async function tick(gen, fresh) {
    timer = null;
    if (gen !== generation) return;
    try {
      const value = await sample(fresh);
      if (gen === generation) onSample(value);
    } catch (err) {
      if (gen === generation) onError(err);
    }
    if (gen !== generation) return;
    const ms = Math.max(0, Number(intervalMs()) || 0);
    timer = setTimer(() => { tick(gen, false); }, ms);
  }

  return {
    start() {
      if (running) return;
      running = true;
      generation += 1;
      tick(generation, true);
    },
    stop() {
      if (!running) return;
      running = false;
      generation += 1;
      if (timer != null) clearTimer(timer);
      timer = null;
    },
    isRunning: () => running,
  };
}
