// @ts-check
/**
 * Núcleo **puro** de la conexión rápida `[usuario@]host[:puerto]`: la usan la
 * pantalla de primer inicio y la paleta de comandos. Interpreta el destino,
 * decide si la paleta debe ofrecerlo y arma el perfil SSH mínimo que se guarda
 * antes de conectar. Sin DOM ni IPC: el llamador pone el id, la fecha y el
 * workspace, y hace el guardado y la conexión.
 */

/**
 * Usuario de RESERVA cuando el destino no lo lleva y el llamador no inyecta
 * otro (`defaultUser`). La conexión rápida propone el usuario local del
 * sistema, como hace `ssh host`; este `root` histórico solo queda para cuando
 * el backend no lo sabe. La paleta enseña siempre el usuario en su entrada
 * («Conectar a ana@host:22»), así que nunca se usa sin que se vea.
 */
export const QUICK_DEFAULT_USER = "root";

const TARGET_RE = /^(?:([^@\s]+)@)?([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(?::(\d{1,5}))?$/;

/**
 * @typedef {{ username: string, host: string, port: number, userGiven?: boolean, portGiven?: boolean }} QuickTarget
 * `userGiven`/`portGiven`: si la consulta los traía o son los de por defecto
 * (para reutilizar el perfil guardado de ese host aunque tenga otro usuario o
 * puerto).
 */

/**
 * Parsea un destino rápido `[usuario@]host[:puerto]` (IPv6 entre corchetes).
 * Devuelve `null` si no es interpretable como destino SSH.
 * @param {unknown} raw
 * @param {{ defaultUser?: string }} [options]
 * @returns {QuickTarget|null}
 */
export function parseQuickTarget(raw, { defaultUser = QUICK_DEFAULT_USER } = {}) {
  const m = TARGET_RE.exec(String(raw ?? "").trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    username: m[1] || defaultUser,
    host: m[2].replace(/^\[|\]$/g, ""),
    port,
    userGiven: !!m[1],
    portGiven: !!m[3],
  };
}

/**
 * Destino en texto, con los corchetes de vuelta si el host es IPv6.
 * @param {QuickTarget} target
 * @returns {string}
 */
export function formatQuickTarget(target) {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${target.username}@${host}:${target.port}`;
}

/**
 * ¿El host es una IPv4 escrita entera (cuatro octetos de 0 a 255)?
 * @param {string} host
 */
function isIpv4(host) {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Lectura de la consulta de la paleta como destino. `defaultUser` es el usuario
 * cuando la consulta no lo lleva (el local del sistema, inyectado por el
 * llamador). Casi cualquier texto encaja
 * en la gramática de host, así que no basta con que parsee: `explicit` dice si
 * la consulta tiene inequívocamente forma de destino (usuario@, :puerto, IPv6,
 * IPv4 completa o `localhost`), y solo esas van arriba. Un nombre con punto
 * puede ser un host (`db1.example.com`) o lo que se buscaba (`deploy.sh`,
 * `notes.md`): se ofrece, pero detrás del primer resultado, para no robarle el
 * Intro. Una palabra suelta sin punto («tunnels», una errata) no se ofrece:
 * como única fila, Intro guardaría y sincronizaría un perfil que nadie pidió;
 * para un host corto basta con `usuario@nas` o `nas:22`. Lo que solo tiene
 * números y puntos sin ser una IPv4 completa («22», «1.5») tampoco.
 * @param {unknown} query
 * @param {{ defaultUser?: string }} [options]
 * @returns {{ target: QuickTarget, explicit: boolean }|null}
 */
export function paletteQuickTarget(query, { defaultUser = QUICK_DEFAULT_USER } = {}) {
  const text = String(query ?? "").trim();
  const target = parseQuickTarget(text, { defaultUser });
  if (!target) return null;
  const { host } = target;
  const numeric = /^[\d.]+$/.test(host);
  if (numeric && !isIpv4(host)) return null;
  if (/^[.-]|[.-]$/.test(host) || host.includes("..")) return null;
  const explicit = text.includes("@")
    || /:\d+$/.test(text)
    || text.startsWith("[")
    || numeric
    || host.toLowerCase() === "localhost";
  if (!explicit && !host.includes(".")) return null;
  return { target, explicit };
}

/**
 * Perfil SSH ya guardado para ese destino: conectar a él evita que repetir la
 * conexión rápida llene el catálogo de duplicados. Primero el que casa en
 * usuario, host (sin distinguir mayúsculas) y puerto; si la consulta no traía
 * usuario o puerto (`userGiven`/`portGiven` a `false`), vale también el perfil
 * de ese host con otro usuario o puerto: «db1.example.com» es el
 * `admin@db1.example.com:2222` que ya se tiene, no un `root@…:22` nuevo.
 * @template {{ connection_type?: string, host?: string, port?: number, username?: string }} P
 * @param {readonly P[]} profiles
 * @param {QuickTarget} target
 * @returns {P|null}
 */
export function findQuickTargetProfile(profiles, target) {
  const host = target.host.toLowerCase();
  const sameHost = profiles.filter((p) => (p.connection_type || "ssh") === "ssh"
    && String(p.host || "").toLowerCase() === host);
  const portOk = (/** @type {P} */ p) => Number(p.port || 22) === target.port;
  const userOk = (/** @type {P} */ p) => (p.username || "") === target.username;
  return sameHost.find((p) => portOk(p) && userOk(p))
    || sameHost.find((p) => (portOk(p) || target.portGiven === false)
      && (userOk(p) || target.userGiven === false))
    || null;
}

/**
 * Perfil SSH mínimo de una conexión rápida: contraseña (se pide al conectar
 * y va al keyring) y seguimiento del directorio, como un perfil nuevo.
 * @param {QuickTarget} target
 * @param {{ id: string, now: string, workspaceId: string }} meta
 */
export function buildQuickProfile(target, { id, now, workspaceId }) {
  return {
    id,
    name: target.host,
    host: target.host,
    port: target.port,
    username: target.username,
    connection_type: "ssh",
    auth_type: "password",
    follow_cwd: true,
    workspace_id: workspaceId,
    updated_at: now,
  };
}
