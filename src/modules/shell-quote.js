// @ts-check
//
// Quoting de rutas para insertarlas en un terminal al soltar ficheros del SO
// sobre una consola local. Núcleo puro y testeable: no toca el DOM ni xterm.
//
// El objetivo es que una ruta arrastrada desde el explorador de archivos llegue
// al prompt como un único argumento seguro, aunque contenga espacios, comillas
// o metacaracteres del shell. La inserción NO ejecuta nada (no añade salto de
// línea): el usuario revisa la línea y pulsa Intro.

/** Caracteres que en POSIX no necesitan quoting (ruta "limpia"). */
const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

/** Caracteres que en Windows no necesitan quoting (incluye `\` y `:` de unidad). */
const WINDOWS_SAFE = /^[A-Za-z0-9_@%+=:,.\\/-]+$/;

/**
 * Quoting POSIX robusto. Una ruta "limpia" se deja tal cual para no ensuciar la
 * línea; en cualquier otro caso se envuelve en comillas simples, donde todo es
 * literal salvo la propia comilla simple, que se escapa como `'\''`.
 * @param {string} path
 * @returns {string}
 */
export function quotePosixPath(path) {
  if (path === "") return "''";
  if (POSIX_SAFE.test(path)) return path;
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

/**
 * Quoting para Windows (cmd.exe / PowerShell). Los nombres de archivo de Windows
 * no admiten `" < > | * ?`, así que basta con envolver en comillas dobles cuando
 * hay espacios o caracteres que el shell trataría de forma especial. Por robustez,
 * una comilla doble (no válida en rutas Windows reales) se duplica como `""`.
 * @param {string} path
 * @returns {string}
 */
export function quoteWindowsPath(path) {
  if (path === "") return '""';
  if (WINDOWS_SAFE.test(path)) return path;
  return '"' + path.replace(/"/g, '""') + '"';
}

/**
 * Quotea una ruta según la plataforma del SO local.
 * @param {string} path
 * @param {"windows"|"posix"} platform
 * @returns {string}
 */
export function quotePath(path, platform) {
  return platform === "windows" ? quoteWindowsPath(path) : quotePosixPath(path);
}

/**
 * Construye el texto a insertar al soltar una o varias rutas del SO sobre una
 * consola local: rutas quoteadas y unidas por un espacio. Opcionalmente envuelto
 * en los marcadores de *bracketed paste* (`ESC [200~` … `ESC [201~`) para que el
 * shell trate el contenido como datos pegados y nunca lo autoejecute —defensa
 * ante nombres de fichero con saltos de línea, válidos en POSIX—.
 * @param {string[]} paths
 * @param {{ platform?: "windows"|"posix", bracketed?: boolean, trailingSpace?: boolean }} [opts]
 * @returns {string}
 */
export function buildDropInsertText(paths, opts = {}) {
  const { platform = "posix", bracketed = false, trailingSpace = true } = opts;
  const list = (Array.isArray(paths) ? paths : []).filter(
    (p) => typeof p === "string" && p.length > 0
  );
  if (list.length === 0) return "";
  let text = list.map((p) => quotePath(p, platform)).join(" ");
  if (trailingSpace) text += " ";
  if (bracketed) text = "\x1b[200~" + text + "\x1b[201~";
  return text;
}
