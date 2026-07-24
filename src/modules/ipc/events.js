// @ts-check
/**
 * Contrato de nombres de eventos IPC (frontend ⇄ backend).
 *
 * Espejo de `src-tauri/src/ipc.rs`: misma lista de prefijos y misma regla de
 * construcción `prefijo + sufijo`, donde el sufijo es el `sessionId` /
 * `transferId`. Centralizar aquí los nombres evita las plantillas sueltas
 * (`` `ssh-connected-${id}` ``) repartidas por `main.js` y deja un único sitio
 * que tocar si el backend renombra un evento.
 *
 * El caudal de datos del terminal (SSH y consola local) NO es un evento: viaja
 * por `tauri::ipc::Channel` (binario), creado en `main.js` y pasado al
 * `invoke("ssh_connect" / "local_shell_open")`.
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
  /** `ssh-error-{sessionId}` → payload: mensaje (string) */
  sshError: "ssh-error-",
  /** `ssh-closed-{sessionId}` → payload: "" */
  sshClosed: "ssh-closed-",
  /** `ssh-reconnecting-{sessionId}` → {@link SshReconnectingEvent} */
  sshReconnecting: "ssh-reconnecting-",
  /** `ssh-tunnel-traffic-{sessionId}` → {@link SshTunnelTrafficEvent} */
  sshTunnelTraffic: "ssh-tunnel-traffic-",
  /** `ssh-metrics-{sessionId}` → {@link SshMetricsEvent} */
  sshMetrics: "ssh-metrics-",
  /** `shell-closed-{sessionId}` → payload: null */
  shellClosed: "shell-closed-",
  /** `sftp-log-{sessionId}` → {@link SftpLogEvent} */
  sftpLog: "sftp-log-",
  /** `sftp-progress-{transferId}` → {@link SftpProgressEvent} */
  sftpProgress: "sftp-progress-",
  /** `rdp-closed-{sessionId}` → {@link RdpClosedEvent} */
  rdpClosed: "rdp-closed-",
  /** `vnc-closed-{sessionId}` → payload: null */
  vncClosed: "vnc-closed-",
  /** `telnet-closed-{sessionId}` → payload: null */
  telnetClosed: "telnet-closed-",
  /** `script-progress-{runId}` → {@link ScriptProgressEvent} */
  scriptProgress: "script-progress-",
  /** `script-output-{runId}` → {@link ScriptOutputEvent} */
  scriptOutput: "script-output-",
  /** `script-host-done-{runId}` → {@link ScriptHostDoneEvent} */
  scriptHostDone: "script-host-done-",
  /** `script-host-error-{runId}` → {@link ScriptHostErrorEvent} */
  scriptHostError: "script-host-error-",
  /** `script-done-{runId}` → {@link ScriptDoneEvent} */
  scriptDone: "script-done-",
});

/**
 * Eventos globales (sin sufijo de sesión).
 * @satisfies {Record<string, string>}
 */
export const EVENT = Object.freeze({
  /** `tray-action` → {@link TrayAction} */
  trayAction: "tray-action",
  /**
   * `ssh-hostkey-prompt` → {@link HostKeyPromptEvent}
   *
   * Global y no por sesión: la política de primera conexión es global (una
   * preferencia) y el handler TOFU del backend no conoce el `sessionId`. La
   * respuesta vuelve por el comando `ssh_hostkey_response` con el `promptId`.
   */
  hostKeyPrompt: "ssh-hostkey-prompt",
  /**
   * `ftps-cert-prompt` → {@link FtpsCertPromptEvent}
   *
   * Igual que `hostKeyPrompt` pero para el certificado TLS de un servidor FTPS
   * desconocido (TOFU). La respuesta vuelve por el comando `ftps_cert_response`.
   */
  ftpsCertPrompt: "ftps-cert-prompt",
});

/**
 * Payload de `ssh-hostkey-prompt`: el servidor presenta una host key desconocida
 * y el modo estricto exige confirmarla antes de aprenderla.
 * @typedef {object} HostKeyPromptEvent
 * @property {string} promptId Identificador con el que responder.
 * @property {string} host
 * @property {number} port
 * @property {string} fingerprint Huella SHA256 de la clave presentada.
 * @property {string} keyType Algoritmo (`ssh-ed25519`, `rsa-sha2-512`…).
 * @property {boolean} viaJump `true` si la clave es de un bastión ProxyJump.
 */

/**
 * Payload de `ftps-cert-prompt`: un servidor FTPS presenta un certificado TLS
 * desconocido (autofirmado) y el modo estricto exige confirmar su huella.
 * @typedef {object} FtpsCertPromptEvent
 * @property {string} promptId Identificador con el que responder.
 * @property {string} host
 * @property {number} port
 * @property {string} fingerprint Huella SHA-256 del certificado presentado.
 */

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
 * @property {number} transferred Bytes transferidos hasta ahora (agregado en carpetas).
 * @property {number} total Bytes totales esperados.
 * @property {boolean} done `true` cuando la transferencia ha terminado.
 * @property {boolean} [canceled] `true` si se canceló.
 * @property {string} [kind] `"dir"` en transferencias/resúmenes de carpeta recursiva.
 * @property {string} [current] Ruta relativa del archivo/subcarpeta que se transfiere ahora (solo carpetas).
 * @property {number} [filesDone] Archivos completados hasta ahora (solo carpetas).
 * @property {number} [filesTotal] Total de archivos de la carpeta (solo carpetas).
 * @property {number} [skippedSymlinks] Enlaces simbólicos omitidos (solo en el
 *   evento final de una carpeta): no se transfieren en ninguna dirección, pero
 *   se cuentan para poder avisar de que la copia no los incluye.
 */

/**
 * @typedef {object} RdpClosedEvent
 * @property {"cert-changed"|"no-password"|"error"|null} code Motivo del cierre:
 *   `null` = cierre limpio; `"cert-changed"` = el certificado del servidor no
 *   coincide con el recordado por el cliente (TOFU); `"no-password"` = el
 *   cliente pidió credenciales que nadie podía teclear (perfil sin contraseña
 *   guardada); `"error"` = cualquier otro fallo.
 * @property {string|null} detail Cola de salida del cliente externo (solo
 *   Linux) con las líneas de error, para diagnóstico.
 */

/**
 * @typedef {object} SshTunnelTrafficEvent
 * @property {string} id Identificador del túnel.
 * @property {number} bytesUp Bytes enviados acumulados.
 * @property {number} bytesDown Bytes recibidos acumulados.
 */

/**
 * Muestra de recursos del servidor remoto (monitor por sesión). Espejo de
 * `metrics::Metrics` (Rust), serializado en camelCase. Los campos derivados por
 * delta (`cpuPct`, `cpuCoresPct`, `netRxBps`, `netTxBps`) llegan `null` en la
 * primera muestra, cuando aún no hay anterior con la que comparar.
 * @typedef {object} SshMetricsEvent
 * @property {number|null} cpuPct Uso de CPU agregado, 0..100.
 * @property {number[]} cpuCoresPct Uso por core, 0..100.
 * @property {{ totalKb: number, availableKb: number, swapTotalKb: number, swapFreeKb: number }} mem Memoria en kiB.
 * @property {number} memUsedKb Memoria usada (total − disponible), en kiB.
 * @property {{ one: number, five: number, fifteen: number }|null} load Carga media.
 * @property {number} uptimeSecs Segundos encendido el servidor.
 * @property {number|null} netRxBps Bytes/s de bajada.
 * @property {number|null} netTxBps Bytes/s de subida.
 * @property {Array<{ filesystem: string, sizeKb: number, usedKb: number, availKb: number, mount: string }>} disks Uso por sistema de ficheros.
 * @property {Array<{ pid: number, cpuPct: number, memPct: number, command: string }>} procs Procesos top por CPU.
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

// --- Payloads de los eventos de scripts (sufijo = `runId`) ------------------
// Emitidos por el ejecutor de scripts del backend durante una tirada. Cada host
// (perfil) de la tirada se identifica por su `profileId`.

/**
 * @typedef {object} ScriptProgressEvent
 * @property {string} profileId Perfil (host) al que corresponde el progreso.
 * @property {string} host Host (dirección) del perfil.
 * @property {"connecting"|"connected"|"running"|"waiting"|"draining"|"done"} phase
 *   Fase del runner (`draining` = drenaje final implícito tras el último paso).
 * @property {number} stepIndex Índice (0-based) del paso en curso.
 * @property {number} totalSteps Total de pasos de la receta.
 */

/**
 * @typedef {object} ScriptOutputEvent
 * @property {string} profileId Perfil (host) que produjo la salida.
 * @property {string} host Host (dirección) del perfil.
 * @property {string} chunk Fragmento de salida del terminal (texto).
 */

/**
 * @typedef {object} ScriptHostDoneEvent
 * @property {string} profileId Perfil (host) que terminó su receta.
 * @property {string} host Host (dirección) del perfil.
 * @property {number|null} exitCode Código de salida observado, si aplica.
 * @property {number} durationMs Duración total de la receta en este host.
 */

/**
 * @typedef {object} ScriptHostErrorEvent
 * @property {string} profileId Perfil (host) que falló.
 * @property {string} host Host (dirección) del perfil.
 * @property {string} message Mensaje de error legible.
 * @property {number|null} stepIndex Paso (0-based) en el que falló, si se sabe.
 */

/**
 * @typedef {object} ScriptDoneEvent
 * @property {number} total Hosts totales de la tirada.
 * @property {number} okCount Hosts completados sin error.
 * @property {number} errorCount Hosts que fallaron.
 */
