// @ts-check
/**
 * Diff por líneas entre dos salidas de terminal (bloques OSC 133).
 *
 * Núcleo **puro**: dos textos entran, una lista de filas sale. No hay
 * dependencia externa a propósito —`diff-match-patch` resuelve un problema más
 * grande (diff de caracteres con semántica de prosa) del que aquí hace falta, y
 * la app es local-first con CSP estricta: un algoritmo de ~80 líneas evita
 * arrastrar un paquete al bundle.
 *
 * El coste de un LCS es O(n·m), así que antes se recortan el prefijo y el
 * sufijo comunes (que en dos ejecuciones consecutivas de `df -h` o `ps aux` son
 * casi todo) y solo el centro pasa por la tabla. Si aun así el centro es
 * enorme, se degrada a «bloque sustituido» **avisando** (`truncated`), nunca en
 * silencio.
 */

/** Celdas máximas de la tabla LCS antes de degradar a bloque sustituido. */
export const MAX_LCS_CELLS = 4_000_000;

/**
 * @typedef {object} DiffRow
 * @property {"same"|"add"|"del"} type
 * @property {string} text
 * @property {number|null} leftLine Nº de línea (1-based) en el texto de la izquierda.
 * @property {number|null} rightLine Nº de línea (1-based) en el texto de la derecha.
 */

/**
 * @typedef {object} DiffResult
 * @property {DiffRow[]} rows
 * @property {number} added
 * @property {number} removed
 * @property {number} unchanged
 * @property {boolean} truncated `true` si el centro fue demasiado grande para
 *   el LCS y se emitió como sustitución en bloque.
 */

/**
 * Parte un texto en líneas comparables. Un texto vacío no tiene líneas (y no
 * una línea vacía, que falsearía el conteo).
 * @param {string} text
 * @returns {string[]}
 */
export function splitDiffLines(text) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return value === "" ? [] : value.split("\n");
}

/**
 * Diff por líneas de dos textos.
 * @param {string} left Texto anterior (bloque de referencia).
 * @param {string} right Texto nuevo.
 * @param {{ maxCells?: number }} [options]
 * @returns {DiffResult}
 */
export function diffLines(left, right, options = {}) {
  const maxCells = options.maxCells ?? MAX_LCS_CELLS;
  const a = splitDiffLines(left);
  const b = splitDiffLines(right);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  /** @type {DiffRow[]} */
  const rows = [];
  let leftLine = 1;
  let rightLine = 1;
  for (let i = 0; i < head; i++) {
    rows.push({ type: "same", text: a[i], leftLine: leftLine++, rightLine: rightLine++ });
  }

  let truncated = false;
  if (midA.length * midB.length > maxCells) {
    truncated = true;
    for (const text of midA) rows.push({ type: "del", text, leftLine: leftLine++, rightLine: null });
    for (const text of midB) rows.push({ type: "add", text, leftLine: null, rightLine: rightLine++ });
  } else {
    for (const op of lcsDiff(midA, midB)) {
      if (op.type === "same") {
        rows.push({ type: "same", text: op.text, leftLine: leftLine++, rightLine: rightLine++ });
      } else if (op.type === "del") {
        rows.push({ type: "del", text: op.text, leftLine: leftLine++, rightLine: null });
      } else {
        rows.push({ type: "add", text: op.text, leftLine: null, rightLine: rightLine++ });
      }
    }
  }

  for (let i = a.length - tail; i < a.length; i++) {
    rows.push({ type: "same", text: a[i], leftLine: leftLine++, rightLine: rightLine++ });
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const row of rows) {
    if (row.type === "add") added++;
    else if (row.type === "del") removed++;
    else unchanged++;
  }
  return { rows, added, removed, unchanged, truncated };
}

/**
 * LCS clásico con tabla de longitudes, reconstruido de atrás hacia delante.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{ type: "same"|"add"|"del", text: string }[]}
 */
function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: /** @type {const} */ ("add"), text }));
  if (m === 0) return a.map((text) => ({ type: /** @type {const} */ ("del"), text }));

  // Tabla (n+1)×(m+1) plana: una sola asignación en vez de n arrays.
  const table = new Uint32Array((n + 1) * (m + 1));
  const width = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: /** @type {const} */ ("same"), text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      out.push({ type: /** @type {const} */ ("del"), text: a[i] });
      i++;
    } else {
      out.push({ type: /** @type {const} */ ("add"), text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: /** @type {const} */ ("del"), text: a[i++] });
  while (j < m) out.push({ type: /** @type {const} */ ("add"), text: b[j++] });
  return out;
}

/**
 * Empareja las filas del diff en dos columnas alineadas: un bloque de
 * eliminaciones seguido de otro de adiciones se muestra en paralelo (como hace
 * un diff lado a lado de Git) en vez de en escalera.
 * @param {DiffRow[]} rows
 * @returns {{ left: DiffRow|null, right: DiffRow|null }[]}
 */
export function pairDiffRows(rows) {
  /** @type {{ left: DiffRow|null, right: DiffRow|null }[]} */
  const pairs = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type === "same") {
      pairs.push({ left: row, right: row });
      i++;
      continue;
    }
    const dels = [];
    while (i < rows.length && rows[i].type === "del") dels.push(rows[i++]);
    const adds = [];
    while (i < rows.length && rows[i].type === "add") adds.push(rows[i++]);
    const height = Math.max(dels.length, adds.length);
    for (let k = 0; k < height; k++) {
      pairs.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return pairs;
}

/**
 * Diff en formato unificado (para copiar al portapapeles o pegar en un ticket).
 * @param {DiffResult} result
 * @param {{ leftLabel?: string, rightLabel?: string }} [labels]
 * @returns {string}
 */
export function diffToUnifiedText(result, labels = {}) {
  const lines = [];
  if (labels.leftLabel) lines.push(`--- ${labels.leftLabel}`);
  if (labels.rightLabel) lines.push(`+++ ${labels.rightLabel}`);
  for (const row of result.rows) {
    const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
    lines.push(`${sign}${row.text}`);
  }
  return lines.join("\n") + "\n";
}
