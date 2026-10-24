// @ts-check
/**
 * Reconocer la consola local entre las sesiones de la interfaz. Núcleo
 * **puro**: sin DOM ni IPC.
 *
 * La consola local se crea con la misma pestaña que una SSH y conserva
 * `type: "ssh"` (grabar scripts, el SFTP activo y los menús cuentan con ello);
 * lo que la distingue es su manejador de cierre propio, `_closeOverride`, que es
 * también lo que manda su entrada al PTY local. Mirar `type === "local"` no
 * funcionaba: ninguna sesión lo tiene, y soltar ficheros del sistema sobre la
 * consola, su «Host» en el Markdown de un bloque y su borrador de comando no
 * llegaban a reconocerla nunca.
 */

/**
 * @typedef {object} SessionLike
 * @property {string} [type]
 * @property {string} [status]
 * @property {string | null} [profileId]
 * @property {unknown} [terminal]
 * @property {boolean} [private]
 * @property {unknown} [_closeOverride]
 */

/**
 * @param {SessionLike | null | undefined} s
 * @returns {boolean}
 */
export function isLocalShellSession(s) {
  return !!s?._closeOverride;
}

/**
 * Consola local que ya puede recibir texto: conectada y con su terminal.
 * Mientras se abre o se reabre el PTY no está listo y lo escrito se perdería.
 * @param {SessionLike | null | undefined} s
 * @returns {boolean}
 */
export function isLocalShellReady(s) {
  return isLocalShellSession(s) && s?.status === "connected" && !!s?.terminal;
}

/**
 * Clave del borrador del editor de comandos: el perfil en SSH y una sola,
 * compartida, para todas las consolas locales (su `profileId` es un id
 * aleatorio por consola). Las sesiones privadas no guardan borrador.
 * @param {SessionLike | null | undefined} s
 * @returns {string | null}
 */
export function commandDraftKey(s) {
  if (!s || s.private) return null;
  // Antes que la rama SSH: la consola local también es `type: "ssh"`.
  if (isLocalShellSession(s)) return "local";
  if (s.type === "ssh" && s.profileId) return s.profileId;
  return null;
}
