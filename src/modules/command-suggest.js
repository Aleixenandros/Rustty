// @ts-check
//
// Autocompletado por historial de sesión. Núcleo puro y testeable: no toca el
// DOM ni xterm. Dada la lista de comandos escritos (en orden cronológico, el
// más reciente al final) y lo que el usuario lleva tecleado, propone los
// candidatos más útiles.
//
// Criterio de orden:
//   1. Coincidencias por prefijo (lo tecleado inicia el comando), de más
//      reciente a más antiguo.
//   2. Coincidencias por subcadena (lo tecleado aparece más adelante), de más
//      reciente a más antiguo.
// Todo case-insensitive. Se descartan duplicados (conservando la aparición más
// reciente) y el comando idéntico a lo ya tecleado (no aporta nada sugerirlo).
// Con la consulta vacía devuelve simplemente los más recientes.

/**
 * @typedef {object} SuggestOptions
 * @property {number} [limit] Máximo de sugerencias a devolver (por defecto 40).
 */

/**
 * Ordena y filtra el historial de comandos para autocompletar.
 * @param {readonly string[]} history Comandos en orden cronológico (reciente al final).
 * @param {string} query Texto tecleado hasta ahora.
 * @param {SuggestOptions} [options]
 * @returns {string[]} Candidatos, del más relevante al menos.
 */
export function rankCommandSuggestions(history, query, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : 40;
  if (!Array.isArray(history) || limit === 0) return [];

  // Deduplicar conservando la ocurrencia más reciente: recorrer de atrás
  // hacia delante y quedarnos con la primera vez que vemos cada comando.
  /** @type {string[]} */
  const recentFirst = [];
  const seen = new Set();
  for (let i = history.length - 1; i >= 0; i--) {
    const cmd = history[i];
    if (typeof cmd !== "string") continue;
    const trimmed = cmd.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    recentFirst.push(trimmed);
  }

  const q = (query || "").trim().toLowerCase();
  if (!q) return recentFirst.slice(0, limit);

  /** @type {string[]} */
  const prefix = [];
  /** @type {string[]} */
  const substring = [];
  for (const cmd of recentFirst) {
    const lower = cmd.toLowerCase();
    if (lower === q) continue; // idéntico a lo tecleado: no sugerir
    if (lower.startsWith(q)) prefix.push(cmd);
    else if (lower.includes(q)) substring.push(cmd);
  }
  return prefix.concat(substring).slice(0, limit);
}
