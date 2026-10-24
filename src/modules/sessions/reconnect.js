// @ts-check
/**
 * Decide cómo se reconecta una pestaña cerrada y garantiza que no haya dos
 * intentos a la vez. Núcleo **puro**: sin DOM ni IPC.
 *
 * Dos fallos que evita:
 * - **Reentrada.** La reconexión SSH espera al keyring (o a un diálogo) antes de
 *   pasar a «conectando»; un segundo Intro, Ctrl+Shift+R o el vigilante de
 *   despertar pasaban la guarda de estado en esa espera y abrían una segunda
 *   conexión con el mismo id, huérfana e imposible de cerrar desde la interfaz.
 * - **Tipo equivocado.** Una pestaña RDP/VNC/Telnet cerrada tiene `profileId` y
 *   ningún terminal; entraba por la rama SSH y acababa en un TypeError.
 */

/** Tipos que se lanzan como cliente externo, con su propio camino de reconexión. */
const EXTERNAL_TYPES = new Set(["rdp", "vnc", "telnet"]);

/**
 * @typedef {object} ReconnectableSession
 * @property {string} [type]
 * @property {string} [status]
 * @property {string | null} [profileId]
 * @property {unknown} [terminal]
 * @property {unknown} [_closeOverride]  Marca de la consola local.
 * @property {boolean} [_reconnecting]   Hay un intento en curso.
 */

/**
 * Camino de reconexión de `s`, o `null` si no toca reconectar (no está cerrada,
 * ya hay un intento en curso o no es una pestaña que se pueda reabrir).
 * @param {ReconnectableSession | null | undefined} s
 * @returns {"external" | "local" | "ssh" | null}
 */
export function reconnectRoute(s) {
  if (!s || s._reconnecting) return null;
  if (s.status !== "closed" && s.status !== "error") return null;
  if (EXTERNAL_TYPES.has(String(s.type))) return "external";
  if (!s.terminal) return null;
  if (s._closeOverride) return "local";
  if (s.profileId) return "ssh";
  return null;
}

/**
 * Ejecuta `task` como el único intento de reconexión de `s`. La marca se pone
 * de forma **síncrona**, antes del primer `await`, y se retira aunque la tarea
 * falle. Devuelve `false` (sin ejecutar nada) si ya había uno en curso.
 * @param {ReconnectableSession} s
 * @param {() => Promise<unknown> | unknown} task
 * @returns {Promise<boolean>}
 */
export async function runReconnectOnce(s, task) {
  if (!s || s._reconnecting) return false;
  s._reconnecting = true;
  try {
    await task();
  } finally {
    s._reconnecting = false;
  }
  return true;
}
