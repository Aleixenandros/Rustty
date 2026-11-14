// @ts-check
/**
 * Destino de un enlace simbólico remoto: a qué ruta apunta y cómo se enseña.
 *
 * `READLINK` devuelve el texto que guarda el enlace, tal cual: puede ser
 * absoluto (`/etc/app.conf`) o relativo a la carpeta **del enlace**
 * (`../comun/actual`), no a la carpeta que el panel tenga delante. Aquí se
 * resuelve a una ruta absoluta por la que se puede navegar.
 *
 * Todo lo que entra es **texto del servidor**. Se trata como entrada hostil:
 * la ruta resuelta solo sirve para pedirle un listado al propio servidor, y lo
 * que se enseña pasa antes por `displayLinkTarget` (sin caracteres de control
 * ni marcas de dirección, y acotado) y después por el escapado de quien pinta.
 *
 * La resolución de aquí es **léxica**: `..` quita el componente anterior sin
 * preguntar al servidor si ese componente era a su vez un enlace. Con la
 * carpeta del enlace alcanzada por otro enlace (`current -> releases/v2` y,
 * dentro, `shared -> ../../shared`) la cuenta léxica se equivoca, así que el
 * backend manda además la ruta real que resuelve el servidor y `linkInfo` la
 * prefiere. La léxica queda de reserva para cuando el servidor no la da.
 */

/** Tope de caracteres del destino que se enseña en un tooltip o un aviso. */
export const LINK_TARGET_DISPLAY_MAX = 240;

// C0, DEL y C1: en un nombre de fichero solo sirven para confundir a quien lee.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// Marcas y anulaciones de dirección (RLO, LRI…): invierten o reordenan el texto.
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * Normaliza una ruta remota absoluta: sin barras repetidas, sin `.` y con los
 * `..` aplicados. Por encima de la raíz no hay nada: `/..` es `/`.
 * @param {string} path
 * @returns {string}
 */
export function normalizeRemotePath(path) {
  /** @type {string[]} */
  const out = [];
  for (const part of String(path ?? "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * Carpeta que contiene una ruta remota absoluta (`/` es su propia carpeta).
 * @param {string} path
 * @returns {string}
 */
export function remoteDirname(path) {
  const parts = normalizeRemotePath(path).split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}`;
}

/**
 * Ruta absoluta a la que apunta el enlace `linkPath` cuyo texto es `target`.
 * `null` si no se puede resolver: destino vacío o con un byte nulo, o enlace
 * sin ruta absoluta de la que partir.
 * @param {string} linkPath Ruta absoluta del propio enlace.
 * @param {unknown} target Lo que devolvió `READLINK`.
 * @returns {string|null}
 */
export function resolveLinkTarget(linkPath, target) {
  if (typeof target !== "string" || target === "" || target.includes("\0")) return null;
  if (target.startsWith("/")) return normalizeRemotePath(target);
  if (typeof linkPath !== "string" || !linkPath.startsWith("/")) return null;
  // Relativo: cuenta desde la carpeta del enlace. El último componente de
  // `linkPath` es el enlace, y se quita sin normalizar antes (un enlace que se
  // llamara `..` no existe, pero tampoco hay que inventarle un padre).
  const cut = linkPath.replace(/\/+$/, "").lastIndexOf("/");
  const parent = cut <= 0 ? "/" : linkPath.slice(0, cut);
  return normalizeRemotePath(`${parent}/${target}`);
}

/**
 * El destino tal como se enseña: cada carácter de control se cambia por `�`
 * (se ve que había algo), las marcas de dirección se quitan y el texto se
 * corta a `max` caracteres (por puntos de código, sin partir un emoji).
 * No es un escapado HTML: quien lo pinte lo escapa además.
 * @param {unknown} target
 * @param {number} [max]
 * @returns {string}
 */
export function displayLinkTarget(target, max = LINK_TARGET_DISPLAY_MAX) {
  const limit = Math.max(1, Math.floor(max));
  const clean = String(target ?? "")
    // Recorte previo: el saneado no tiene por qué recorrer un texto enorme.
    .slice(0, limit * 4)
    .replace(CONTROL_RE, "�")
    .replace(BIDI_RE, "");
  const chars = Array.from(clean);
  if (chars.length <= limit) return clean;
  return `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * @typedef {object} LinkInfo
 * @property {string} target Texto del enlace, saneado para enseñarlo.
 * @property {string|null} path Ruta absoluta del destino; `null` si no se resuelve.
 * @property {"dir"|"file"|"unknown"} kind Qué hay al final del enlace.
 */

/**
 * Junta la respuesta de `sftp_read_link` con la ruta del enlace. `null` si el
 * servidor no dio destino (FTP, que no sabe leer enlaces).
 *
 * La ruta del destino es la que resolvió el servidor (`resolved`, su
 * `REALPATH`) cuando la hay: es la única exacta. Si no la da, se cae en la
 * cuenta léxica de `resolveLinkTarget`. Que haya ruta no dice que el destino
 * exista (OpenSSH la da también para un enlace roto): eso lo dice `kind`, y es
 * lo que hay que mirar antes de navegar.
 * @param {string} linkPath
 * @param {unknown} raw `{ target, is_dir, resolved }` o `null`.
 * @returns {LinkInfo|null}
 */
export function linkInfo(linkPath, raw) {
  if (!raw || typeof raw !== "object") return null;
  const { target, is_dir: isDir, resolved } = /** @type {Record<string, unknown>} */ (raw);
  if (typeof target !== "string" || target === "") return null;
  const real = typeof resolved === "string" && resolved.startsWith("/") && !resolved.includes("\0")
    ? normalizeRemotePath(resolved)
    : null;
  return {
    target: displayLinkTarget(target),
    path: real ?? resolveLinkTarget(linkPath, target),
    kind: isDir === true ? "dir" : isDir === false ? "file" : "unknown",
  };
}
