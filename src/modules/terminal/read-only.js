// @ts-check
/**
 * Modo solo lectura de una sesión de terminal. Núcleo **puro**: las decisiones
 * (qué entrada pasa, qué hace una tecla, con qué estado se abre una sesión);
 * el estado vive en el objeto de sesión de `main.js`.
 *
 * El control está en un único sitio, `sendTerminalInput`, por donde pasa la
 * pane activa, la réplica del broadcast, los pegados, Ctrl+P, los snippets,
 * el editor multilínea y las panes de tmux. La segunda barrera es
 * `disableStdin` de xterm, que corta el teclado, el pegado y los informes de
 * ratón antes de llegar a `onData`.
 */

/**
 * Origen de lo que se quiere enviar:
 * - `user`: lo que el usuario manda a esa sesión (tecla, pegado, snippet…).
 * - `broadcast`: la copia de lo tecleado en otra pane de la vista.
 * - `system`: lo que Rustty manda por su cuenta al conectar (el gancho OSC 7,
 *   la carpeta inicial): no es entrada del usuario y lo configuró él.
 * @typedef {"user" | "broadcast" | "system"} InputOrigin
 */

/**
 * `send` = se envía; `block` = no se envía y se avisa; `skip` = no se envía y
 * no se avisa (una pane bloqueada que el broadcast se salta en silencio).
 * @param {{ readOnly: boolean, origin?: InputOrigin }} input
 * @returns {"send" | "block" | "skip"}
 */
export function readOnlyInputDecision({ readOnly, origin = "user" }) {
  if (!readOnly || origin === "system") return "send";
  return origin === "broadcast" ? "skip" : "block";
}

/**
 * Qué hacer con una tecla que xterm ha traducido (su `onKey`) en una sesión
 * en solo lectura, donde `disableStdin` ya impide que salga: `pass` si la
 * sesión no está bloqueada (sigue el camino normal), `reconnect` para el Intro
 * sobre una sesión cerrada —reconectar no envía nada a ningún sitio— y
 * `notify` para todo lo demás.
 * @param {{ readOnly: boolean, status?: string, key: string }} input
 * @returns {"pass" | "reconnect" | "notify"}
 */
export function readOnlyKeyAction({ readOnly, status, key }) {
  if (!readOnly) return "pass";
  const closed = status === "closed" || status === "error";
  if (closed && (key === "\r" || key === "\n")) return "reconnect";
  return "notify";
}

/**
 * ¿Se abre en solo lectura una sesión de este perfil? Por el perfil («Abrir
 * en solo lectura») o por la preferencia global para las conexiones PROD.
 * @param {{ open_read_only?: boolean, environment?: string | null } | null | undefined} profile
 * @param {{ readOnlyProd?: boolean } | null | undefined} prefs
 * @returns {boolean}
 */
export function opensReadOnly(profile, prefs) {
  if (!profile) return false;
  if (profile.open_read_only === true) return true;
  return prefs?.readOnlyProd === true && String(profile.environment || "").toLowerCase() === "prod";
}
