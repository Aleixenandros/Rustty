/**
 * Contrato de nombres de eventos IPC (frontend ⇄ backend).
 *
 * Espejo de `src-tauri/src/ipc.rs`: misma lista de prefijos y misma regla de
 * construcción `prefijo + sufijo`, donde el sufijo es el `sessionId` /
 * `transferId`. Centralizar aquí los nombres evita las plantillas sueltas
 * (`` `ssh-data-${id}` ``) repartidas por `main.js` y deja un único sitio que
 * tocar si el backend renombra un evento.
 *
 * Si se añade o renombra un evento, hay que cambiarlo **en los dos ficheros**
 * (este y `ipc.rs`) para que el contrato siga alineado.
 */

/**
 * Prefijos de los eventos dirigidos a una sesión o transferencia. El nombre
 * completo se obtiene con {@link eventName} anteponiendo el prefijo al sufijo.
 * @satisfies {Record<string, string>}
 */
export const EVENT_PREFIX = Object.freeze({
  /** `ssh-log-{sessionId}` → {@link SshLogEvent} */
  sshLog: "ssh-log-",
  /** `ssh-connected-{sessionId}` → payload: nombre del perfil (string) */
  sshConnected: "ssh-connected-",
  /** `ssh-data-{sessionId}` → payload: bytes del servidor (number[] / Uint8Array) */
  sshData: "ssh-data-",
  /** `ssh-error-{sessionId}` → payload: mensaje (string) */
  sshError: "ssh-error-",
  /** `ssh-closed-{sessionId}` → payload: "" */
  sshClosed: "ssh-closed-",
  /** `ssh-reconnecting-{sessionId}` → {@link SshReconnectingEvent} */
  sshReconnecting: "ssh-reconnecting-",
  /** `ssh-tunnel-traffic-{sessionId}` → {@link SshTunnelTrafficEvent} */
  sshTunnelTraffic: "ssh-tunnel-traffic-",
  /** `shell-data-{sessionId}` → payload: bytes de la consola local */
  shellData: "shell-data-",
  /** `shell-closed-{sessionId}` → payload: null */
  shellClosed: "shell-closed-",
  /** `sftp-log-{sessionId}` → {@link SftpLogEvent} */
  sftpLog: "sftp-log-",
  /** `sftp-progress-{transferId}` → {@link SftpProgressEvent} */
  sftpProgress: "sftp-progress-",
  /** `rdp-closed-{sessionId}` → payload: null */
  rdpClosed: "rdp-closed-",
});

/**
 * Eventos globales (sin sufijo de sesión).
 * @satisfies {Record<string, string>}
 */
export const EVENT = Object.freeze({
  /** `tray-action` → {@link TrayAction} */
  trayAction: "tray-action",
});

/**
 * Nombre completo de un evento por sesión/transferencia: `prefijo + sufijo`.
 *
 * @param {keyof typeof EVENT_PREFIX} kind Familia de evento (clave de {@link EVENT_PREFIX}).
 * @param {string} suffix `sessionId` o `transferId`.
 * @returns {string} Nombre del evento listo para `listen()`.
 */
export function eventName(kind, suffix) {
  const prefix = EVENT_PREFIX[kind];
  if (prefix === undefined) {
    throw new Error(`eventName: familia de evento desconocida: ${String(kind)}`);
  }
  return `${prefix}${suffix}`;
}

// --- Payloads de eventos (typedefs compartidos) -----------------------------
// Reflejan los structs/JSON que emite el backend (`ssh_manager.rs`,
// `sftp_manager.rs`, `host_keys.rs`, `app_tray.rs`). `timestamp` viaja como
// string ISO; los túneles y el progreso usan camelCase / snake según el origen.

/**
 * @typedef {object} SshLogEvent
 * @property {string} stage Etapa: `connect` | `host_key` | `auth` | `channel` | `shell` | …
 * @property {string} status `info` | `ok` | `error` | …
 * @property {string} message Texto legible de la etapa.
 * @property {string} timestamp Marca de tiempo ISO.
 */

/**
 * @typedef {object} SftpLogEvent
 * @property {string} stage Etapa: `connect` | `host_key` | `auth` | `channel` | `subsystem` | `ready`.
 * @property {string} status `info` | `ok` | `error` | …
 * @property {string} message Texto legible de la etapa.
 * @property {string} timestamp Marca de tiempo ISO.
 */

/**
 * @typedef {object} SftpProgressEvent
 * @property {number} transferred Bytes transferidos hasta ahora.
 * @property {number} total Bytes totales esperados.
 * @property {boolean} done `true` cuando la transferencia ha terminado.
 * @property {boolean} [canceled] `true` si se canceló.
 * @property {string} [kind] `"dir"` en resúmenes de carpeta recursiva.
 */

/**
 * @typedef {object} SshTunnelTrafficEvent
 * @property {string} id Identificador del túnel.
 * @property {number} bytesUp Bytes enviados acumulados.
 * @property {number} bytesDown Bytes recibidos acumulados.
 */

/**
 * @typedef {object} SshReconnectingEvent
 * @property {number} attempt Intento actual (1-based).
 * @property {number} max Número máximo de reintentos configurado.
 * @property {number} delay_ms Espera antes del siguiente intento, en ms.
 */

/**
 * @typedef {object} TrayAction
 * @property {string} action Acción solicitada desde la bandeja (p. ej. `switch-workspace`).
 * @property {string} [workspaceId] Workspace destino cuando `action === "switch-workspace"`.
 */
