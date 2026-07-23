// @ts-check
/**
 * Utilidades de formateo legible: tamaños en bytes y duraciones en segundos.
 *
 * Primer módulo extraído de `main.js` (>23k líneas) en el troceo del god-file:
 * funciones **puras** sin estado ni DOM, que estaban definidas sueltas y ahora
 * viven aquí con tests. El patrón —sacar la lógica pura a `src/modules/` con
 * vitest— es el mismo de `subst`, `markdown`, `path-history`, etc.
 */

/**
 * Tamaño en bytes a texto legible (B/KB/MB/GB/TB, base 1024). Un decimal por
 * debajo de 100 de la unidad, cero a partir de ahí (`1.5 MB`, `340 MB`).
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024,
    u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return v.toFixed(v >= 100 ? 0 : 1) + " " + units[u];
}

/**
 * Duración en segundos a texto compacto (`45s`, `3m 20s`, `2h 5m`). Devuelve
 * `"?"` para valores no finitos o negativos (una ETA que aún no se puede
 * estimar). Redondea los segundos hacia arriba para no mostrar `0s` en algo que
 * todavía corre.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

/**
 * Permisos SFTP (los 9 bits `rwx` de usuario/grupo/otros) a texto estilo `ls`
 * (`rwxr-x---`). Enmascara a `0o777`, así que ignora setuid/setgid/sticky y el
 * tipo de fichero. Devuelve `""` si el modo es nulo o no finito.
 * @param {number|null|undefined} mode
 * @returns {string}
 */
export function formatSftpPermissions(mode) {
  if (mode == null) return "";
  const m = Number(mode) & 0o777;
  if (!Number.isFinite(m)) return "";
  const parts = [m >> 6, (m >> 3) & 7, m & 7];
  return parts.map((p) => (
    (p & 4 ? "r" : "-") +
    (p & 2 ? "w" : "-") +
    (p & 1 ? "x" : "-")
  )).join("");
}

/**
 * Permisos SFTP en formato octal `"0750"` para el tooltip. Mismo enmascarado a
 * `0o777` que {@link formatSftpPermissions}. Devuelve `""` si el modo es nulo o
 * no finito.
 * @param {number|null|undefined} mode
 * @returns {string}
 */
export function formatSftpPermissionsOctal(mode) {
  if (mode == null) return "";
  const m = Number(mode) & 0o777;
  if (!Number.isFinite(m)) return "";
  return "0" + m.toString(8).padStart(3, "0");
}

/**
 * Modo de permisos a octal de tres dígitos **sin** cero de cabeza (`"750"`),
 * para el valor inicial del editor de permisos SFTP. Emparentada con
 * {@link formatSftpPermissionsOctal} pero distinta a propósito: aquella devuelve
 * cuatro caracteres (`"0750"`) para el tooltip, y aquí el guard de finitud va
 * **antes** del enmascarado, así que un modo no finito sí devuelve `""`.
 * @param {number} mode
 * @returns {string}
 */
export function formatOctalMode(mode) {
  if (!Number.isFinite(mode)) return "";
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Número a texto con un número fijo de decimales pero **sin ceros finales**
 * (`3.140` → `"3.14"`, `3.0` → `"3"`), o redondeado a entero si `precision` es 0.
 * Para inputs numéricos con paso configurable, donde los ceros de cola sobran.
 * @param {number} value
 * @param {number} precision
 * @returns {string}
 */
export function formatSteppedNumber(value, precision) {
  return precision > 0
    ? value.toFixed(precision).replace(/\.?0+$/, "")
    : String(Math.round(value));
}
