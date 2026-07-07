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

/**
 * Caracteres que en Windows no necesitan quoting (incluye `\` y `:` de unidad).
 * Sin `%` (cmd expande `%VAR%` incluso entre comillas dobles) ni `,` (PowerShell
 * parte un token sin quotear en varios argumentos por la coma).
 */
const WINDOWS_SAFE = /^[A-Za-z0-9_@+=:.\\/-]+$/;

/**
 * Comillas simples que PowerShell acepta como delimitador de string literal:
 * la ASCII y las tipográficas U+2018/U+2019/U+201A/U+201B. Todas se escapan
 * doblándolas; si no, un nombre de fichero con una de ellas rompería el
 * quoting y el resto (`$(…)`, backticks) se evaluaría al pulsar Intro.
 */
const PS_QUOTE_CHARS = /['‘’‚‛]/g;

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
 * Quoting para la consola local de Windows, cuyo shell es PowerShell salvo
 * fallback extremo (el backend lanza pwsh → powershell → cmd). Las comillas
 * dobles NO sirven: dentro de `"…"` PowerShell interpola `$(…)`, `$var` y
 * backticks, así que un fichero llamado `x$(calc)y.txt` ejecutaría comandos al
 * pulsar Intro. Se usa la string literal de comillas simples, donde todo es
 * inerte salvo la propia comilla (ASCII o tipográfica), que se dobla. Una ruta
 * "limpia" se deja tal cual, lo que además la mantiene válida en cmd.
 * @param {string} path
 * @returns {string}
 */
export function quoteWindowsPath(path) {
  if (path === "") return "''";
  if (WINDOWS_SAFE.test(path)) return path;
  return "'" + path.replace(PS_QUOTE_CHARS, "$&$&") + "'";
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
