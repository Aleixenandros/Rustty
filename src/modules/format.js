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
