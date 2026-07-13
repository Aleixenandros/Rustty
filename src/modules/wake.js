// @ts-check
/**
 * Detección de suspensión/reanudación del equipo y reconexión escalonada.
 *
 * Módulo puro (sin DOM ni `invoke`).
 *
 * **Por qué por reloj y no por una API del SO**: un proceso congelado no puede
 * enterarse de que lo están congelando —no hay evento que recibir mientras el
 * equipo duerme—, pero al despertar sí puede ver que su tick, programado para
 * dentro de 15 segundos, ha llegado 40 minutos tarde. Ese desfase es la señal, y
 * sale gratis: cubre suspensión, hibernación y congelación del proceso por igual,
 * en las tres plataformas y sin permisos.
 */

/**
 * ¿El desfase del tick delata que el equipo estuvo dormido?
 *
 * @param {number} nowMs      Instante actual (`Date.now()`).
 * @param {number} lastTickMs Instante del tick anterior.
 * @param {number} intervalMs Cada cuánto se esperaba el tick.
 * @param {number} thresholdMs Desfase a partir del cual se asume suspensión. Debe
 *   ser holgado: un equipo cargado retrasa un timer unos segundos sin haber
 *   dormido, y un falso positivo aquí molesta al usuario (avisos, reconexiones).
 * @returns {boolean}
 */
export function detectedWake(nowMs, lastTickMs, intervalMs, thresholdMs) {
  if (![nowMs, lastTickMs, intervalMs, thresholdMs].every(Number.isFinite)) return false;
  if (lastTickMs <= 0) return false;
  const drift = nowMs - lastTickMs - intervalMs;
  return drift >= thresholdMs;
}

/**
 * Retardos para reenganchar N sesiones **sin provocar una tormenta**.
 *
 * Al volver de suspensión, todas las sesiones quieren reconectar a la vez: si se
 * lanzan juntas, el servidor (o el bastión ProxyJump compartido) recibe un pico
 * de handshakes simultáneos, que es justo lo que hace fallar la reconexión —y
 * varios clientes despertando a la vez del mismo suspend cooperativo lo empeoran—.
 * De ahí el escalonado con jitter: cada sesión espera `i * stepMs` más un
 * pellizco aleatorio, de modo que ni siquiera dos equipos con el mismo perfil
 * coinciden.
 *
 * @param {number} count Cuántas sesiones hay que reenganchar.
 * @param {number} stepMs Separación base entre una y la siguiente.
 * @param {number} jitterMs Aleatoriedad máxima a añadir a cada una.
 * @param {() => number} [rand] Fuente de aleatoriedad (inyectable en tests).
 * @returns {number[]} Retardo en ms de cada sesión, en orden.
 */
export function staggerDelays(count, stepMs, jitterMs, rand = Math.random) {
  const n = Math.max(0, Math.trunc(count));
  const step = Math.max(0, stepMs);
  const jitter = Math.max(0, jitterMs);
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(i * step + rand() * jitter));
  }
  return out;
}
