// @ts-check
/**
 * Qué enseña la barra inferior (`#status-bar`) para la sesión activa. Núcleo
 * **puro**: sin DOM ni IPC. `updateStatusBar()` (main.js) lo consulta y pinta.
 *
 * Dos clases de sesión la tienen:
 *   - SSH: usuario@host:puerto, entorno, ruta de saltos, túneles, latencia,
 *     REC, el log de conexión y el monitor de recursos del servidor.
 *   - Consola local (si la preferencia `localShellStatusBar` no la apaga):
 *     usuario@equipo, carpeta (OSC 7), tamaño, el estado y, donde el backend
 *     sabe muestrear este equipo (Linux), el monitor de recursos. Lo que es de
 *     una conexión remota (latencia, túneles, saltos, entorno, REC, log de
 *     conexión) no aplica y no se enseña.
 *
 * Terminar procesos desde el panel del monitor es solo remoto: en la consola
 * local sería una primitiva nueva del IPC para señalar cualquier proceso del
 * usuario, sin rastro en ningún terminal (mínimo privilegio del IPC).
 */

/**
 * @typedef {object} StatusBarInput
 * @property {boolean} local Si es una consola local (`isLocalShellSession`).
 * @property {{ connection_type?: string } | null | undefined} profile Perfil de la sesión, si lo hay.
 * @property {boolean} [localBarEnabled] Preferencia `localShellStatusBar` (por defecto, sí).
 * @property {boolean} [localMetrics] Si el backend sabe muestrear este equipo.
 * @property {boolean} [childShell] Pestaña hija de una conexión: el monitor es de la raíz.
 */

/**
 * @typedef {object} StatusBarModel
 * @property {"ssh" | "local"} kind
 * @property {boolean} latency Sondeo de latencia (`tcp_ping`).
 * @property {boolean} tunnels Segmento de túneles abiertos.
 * @property {boolean} route Ruta de saltos.
 * @property {boolean} env Distintivo de entorno (PROD, …).
 * @property {boolean} rec Distintivo REC (grabación del perfil).
 * @property {boolean} connectionLog Último paso del log de conexión y el punto pulsable que abre el diagnóstico.
 * @property {boolean} metrics Botón del monitor de recursos y su panel.
 * @property {boolean} killProcess Terminar procesos desde la tabla del panel.
 * @property {boolean} cwdNavigates Los segmentos de la carpeta navegan el panel SFTP (si no, copian la ruta).
 */

/**
 * Modelo de la barra para una sesión, o `null` si no lleva barra.
 * @param {StatusBarInput} input
 * @returns {StatusBarModel | null}
 */
export function statusBarModel(input) {
  if (input.local) {
    if (input.localBarEnabled === false) return null;
    return {
      kind: "local",
      latency: false,
      tunnels: false,
      route: false,
      env: false,
      rec: false,
      connectionLog: false,
      metrics: !!input.localMetrics,
      killProcess: false,
      cwdNavigates: false,
    };
  }
  const profile = input.profile;
  if (!profile || (profile.connection_type || "ssh") !== "ssh") return null;
  return {
    kind: "ssh",
    latency: true,
    tunnels: true,
    route: true,
    env: true,
    rec: true,
    connectionLog: true,
    metrics: !input.childShell,
    killProcess: true,
    cwdNavigates: true,
  };
}

/**
 * `usuario@equipo` de la consola local (sin puerto: no hay conexión). Con un
 * solo dato, ese dato; sin ninguno, `localhost`.
 * @param {string | null | undefined} user
 * @param {string | null | undefined} host
 * @returns {string}
 */
export function localUserHost(user, host) {
  const u = typeof user === "string" ? user.trim() : "";
  const h = typeof host === "string" ? host.trim() : "";
  if (u && h) return `${u}@${h}`;
  return h || u || "localhost";
}
