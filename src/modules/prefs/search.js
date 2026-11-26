// @ts-check
/**
 * Buscador de Preferencias: núcleo puro (sin DOM).
 *
 * Cada «unidad» es una fila de ajuste (`.settings-row`, una fila de atajo…)
 * con el texto que la describe: el nombre de su sección, el subtítulo bajo el
 * que cae, su etiqueta, sus opciones y su explicación. Una unidad coincide si
 * TODOS los tokens de la consulta aparecen en ese texto (semántica AND, sin
 * mayúsculas ni acentos, como la búsqueda de conexiones). Así «terminal
 * fuente» encuentra la familia de fuente de la sección Terminal, y el nombre
 * de una sección a secas enseña todas sus filas.
 */

import { foldSearchText, matchSegments, searchTokens } from "../connection-search.js";

/**
 * @typedef {object} SearchUnit
 * @property {string} panel Sección a la que pertenece (`data-prefs-panel`).
 * @property {string} text Texto que describe la fila (sin plegar).
 */

/**
 * @typedef {object} SearchPlan
 * @property {string[]} tokens Tokens plegados de la consulta.
 * @property {boolean[]} hits Por unidad, en el mismo orden: si coincide.
 * @property {Map<string, number>} perPanel Coincidencias de cada sección (solo
 *   las secciones con alguna).
 * @property {number} total Coincidencias en total.
 */

/**
 * Tokens de la consulta. Reutiliza los de la búsqueda de conexiones (la «/»
 * separa como el espacio: «ftp/sftp» busca «ftp» y «sftp»).
 * @param {unknown} query
 * @returns {string[]}
 */
export function prefsSearchTokens(query) {
  return searchTokens(query);
}

/**
 * Si TODOS los tokens aparecen en el texto (plegado). Sin tokens no coincide
 * nada: una consulta vacía no es una búsqueda.
 * @param {string} text
 * @param {string[]} tokens Tokens ya plegados.
 */
export function matchesAllTokens(text, tokens) {
  if (!tokens.length) return false;
  const folded = foldSearchText(text);
  return tokens.every((token) => folded.includes(token));
}

/**
 * Decide qué unidades se enseñan para una consulta.
 * @param {SearchUnit[]} units
 * @param {unknown} query
 * @returns {SearchPlan}
 */
export function planPrefsSearch(units, query) {
  const tokens = prefsSearchTokens(query);
  /** @type {Map<string, number>} */
  const perPanel = new Map();
  let total = 0;
  const hits = units.map((unit) => {
    const hit = matchesAllTokens(unit.text, tokens);
    if (hit) {
      total += 1;
      perPanel.set(unit.panel, (perPanel.get(unit.panel) || 0) + 1);
    }
    return hit;
  });
  return { tokens, hits, perPanel, total };
}

/**
 * Tramos de `text` que coinciden con algún token, como pares `[inicio, fin)`
 * en unidades UTF-16 del texto ORIGINAL (lo que espera `Range.setStart`).
 * Sirve para resaltar sin tocar el DOM de la fila.
 * @param {string} text
 * @param {string[]} tokens Tokens ya plegados.
 * @returns {Array<[number, number]>}
 */
export function highlightOffsets(text, tokens) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  if (!text || !tokens.length) return ranges;
  let offset = 0;
  for (const segment of matchSegments(text, tokens)) {
    const end = offset + segment.text.length;
    if (segment.hit) ranges.push([offset, end]);
    offset = end;
  }
  return ranges;
}
