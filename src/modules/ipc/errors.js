// @ts-check
/**
 * Espejo del contrato de errores estructurados de la frontera IPC.
 *
 * Fuente única: `src-tauri/src/ipc_error.rs` (`IpcErrorKind` + `IpcError`).
 * **Al añadir o renombrar un `kind` hay que tocar los dos ficheros**, igual que
 * con los nombres de evento: los tests de paridad de cada lado lo exigen.
 *
 * Los comandos que devuelven `IpcError` rechazan con un objeto
 * `{ kind, message }` en vez de con una cadena, así que el `${err}` de toda la
 * vida imprimiría `[object Object]`. Por eso todo consumidor pasa por
 * `ipcErrorText`, que entiende las dos formas: los comandos aún no migrados
 * siguen rechazando con string y no hay que tocarlos.
 */

/**
 * Discriminantes estables. El `kind` es el contrato; el `message` es humano y
 * puede reescribirse sin avisar.
 * @type {Readonly<Record<string, string>>}
 */
export const IPC_ERROR_KIND = Object.freeze({
  authFailed: "authFailed",
  hostKeyUnknown: "hostKeyUnknown",
  hostKeyMismatch: "hostKeyMismatch",
  networkUnreachable: "networkUnreachable",
  timeout: "timeout",
  permissionDenied: "permissionDenied",
  conflict: "conflict",
  badPassphrase: "badPassphrase",
  offline: "offline",
  notFound: "notFound",
  protocol: "protocol",
  internal: "internal",
});

/**
 * Discriminante de un rechazo, o `null` si viene de un comando que aún rechaza
 * con una cadena suelta.
 * @param {unknown} err
 * @returns {string|null}
 */
export function ipcErrorKind(err) {
  if (!err || typeof err !== "object") return null;
  const kind = /** @type {{ kind?: unknown }} */ (err).kind;
  return typeof kind === "string" && kind in IPC_ERROR_KIND ? kind : null;
}

/**
 * Texto mostrable de un rechazo, venga estructurado o como cadena.
 * @param {unknown} err
 * @returns {string}
 */
export function ipcErrorText(err) {
  if (err && typeof err === "object") {
    const message = /** @type {{ message?: unknown }} */ (err).message;
    if (typeof message === "string" && message) return message;
  }
  return String(err);
}

/**
 * `true` si el fallo es un problema de host key (desconocida o cambiada). Son
 * los dos casos en los que la UI **no** debe invitar a reescribir la
 * contraseña: no hay nada malo en las credenciales.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isHostKeyError(err) {
  const kind = ipcErrorKind(err);
  return kind === IPC_ERROR_KIND.hostKeyUnknown || kind === IPC_ERROR_KIND.hostKeyMismatch;
}

/**
 * `true` si reintentar con las mismas credenciales tiene sentido (la causa es
 * la red, no el usuario ni el servidor).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryableIpcError(err) {
  const kind = ipcErrorKind(err);
  return kind === IPC_ERROR_KIND.networkUnreachable
    || kind === IPC_ERROR_KIND.timeout
    || kind === IPC_ERROR_KIND.offline;
}
