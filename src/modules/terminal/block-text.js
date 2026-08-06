// @ts-check
/**
 * Texto de un bloque de comando OSC 133: extracción desde el buffer y
 * serialización a Markdown.
 *
 * El tracker (`blocks.js`) solo guarda coordenadas; aquí se convierten en el
 * **comando** y la **salida** de ese bloque leyendo el buffer a través de un
 * `readLine(n)` que aporta el llamador (en la app, `terminal.buffer.active`).
 * Sin DOM ni xterm: el módulo es puro y testeable con un array de líneas.
 *
 * El Markdown se escribe con **etiquetas neutras en inglés** (`**Host:**`,
 * `**Exit code:**`), igual que el runbook de los scripts: es formato de
 * intercambio —se pega en un ticket, un post-mortem o un chat— y no debe
 * cambiar de forma según el idioma de la interfaz de quien lo exportó.
 */

/**
 * @typedef {import("./blocks.js").CommandBlock} CommandBlock
 */

/**
 * @typedef {object} ExtractOptions
 * @property {number} [lastLine] Última línea legible del buffer. Acota los
 *   bloques aún abiertos (sin `D`), que si no llegarían hasta el infinito.
 * @property {(line: number) => boolean} [isWrapped] `true` si esa línea es la
 *   continuación visual de la anterior (xterm parte las líneas largas en filas).
 *   Sin ella, un comando o una línea de salida más ancha que el terminal
 *   aparecería troceada con saltos que el shell nunca envió.
 */

/**
 * Une filas del buffer respetando el ajuste de línea.
 * @param {{ line: number, text: string }[]} rows
 * @param {((line: number) => boolean)|undefined} isWrapped
 * @returns {string}
 */
function joinRows(rows, isWrapped) {
  let out = "";
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) out += isWrapped?.(rows[i].line) ? "" : "\n";
    out += rows[i].text;
  }
  return out;
}

/**
 * Texto entre dos posiciones del buffer, `[startLine,startCol)` → `(endLine,endCol]`
 * (fin exclusivo).
 * @param {(line: number) => (string|null|undefined)} readLine
 * @param {number} startLine
 * @param {number} startCol
 * @param {number} endLine
 * @param {number} endCol
 * @param {((line: number) => boolean)|undefined} isWrapped
 * @returns {string}
 */
function sliceRange(readLine, startLine, startCol, endLine, endCol, isWrapped) {
  if (endLine < startLine) return "";
  const rows = [];
  for (let line = startLine; line <= endLine; line++) {
    const raw = readLine(line);
    if (raw === null || raw === undefined) break;
    let text = String(raw);
    if (line === endLine) text = text.slice(0, Math.max(0, endCol));
    if (line === startLine) text = text.slice(Math.max(0, startCol));
    rows.push({ line, text });
  }
  return joinRows(rows, isWrapped).replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

/**
 * Comando y salida de un bloque.
 *
 * Un bloque sin `B` no sabe dónde empieza el comando (shell que solo emite
 * parte de la secuencia): devuelve comando vacío en vez de inventarse el
 * recorte del prompt.
 *
 * @param {CommandBlock} block
 * @param {(line: number) => (string|null|undefined)} readLine
 * @param {ExtractOptions} [options]
 * @returns {{ command: string, output: string }}
 */
export function extractBlockText(block, readLine, options = {}) {
  const { lastLine, isWrapped } = options;
  const fallbackEnd = Number.isFinite(lastLine) ? Number(lastLine) : block.promptLine;
  const commandStart = block.commandLine;
  const outputStart = block.outputLine;
  const end = block.endLine === null || block.endLine === undefined ? fallbackEnd : block.endLine;
  const endCol = block.endLine === null || block.endLine === undefined
    ? Number.MAX_SAFE_INTEGER
    : (block.endCol || 0);

  let command = "";
  if (commandStart !== null && commandStart !== undefined) {
    const stopLine = outputStart ?? end;
    const stopCol = outputStart === null || outputStart === undefined ? endCol : (block.outputCol || 0);
    command = sliceRange(readLine, commandStart, block.commandCol || 0, stopLine, stopCol, isWrapped);
  }

  let output = "";
  if (outputStart !== null && outputStart !== undefined) {
    output = sliceRange(readLine, outputStart, block.outputCol || 0, end, endCol, isWrapped);
  }
  return { command, output };
}

/**
 * Vallado de código Markdown que no puede romperse por el contenido: si la
 * salida ya trae una valla de acentos graves (un README, otro bloque de
 * código), la nuestra crece hasta superar la más larga que haya dentro.
 * @param {string} body
 * @returns {string}
 */
function fenceFor(body) {
  let longest = 0;
  for (const run of String(body).matchAll(/`{3,}/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * @typedef {object} BlockMarkdownInput
 * @property {string} command
 * @property {string} output
 * @property {string} [host] Destino legible (`usuario@host`, «Shell local»…).
 * @property {string} [cwd] Directorio de trabajo, si se conoce.
 * @property {number|null} [exitCode]
 * @property {string} [timestamp] ISO-8601 del momento de la exportación.
 * @property {number|null} [durationMs]
 */

/**
 * Serializa un bloque a Markdown autocontenido (comando + contexto + salida).
 * @param {BlockMarkdownInput} input
 * @returns {string}
 */
export function blockToMarkdown(input) {
  const command = String(input.command || "").trim();
  const output = String(input.output || "");
  const lines = [];
  lines.push(`## \`${command || "(unknown command)"}\``);
  lines.push("");
  const meta = [];
  if (input.host) meta.push(`- **Host:** ${input.host}`);
  if (input.cwd) meta.push(`- **Directory:** ${input.cwd}`);
  if (input.timestamp) meta.push(`- **Date:** ${input.timestamp}`);
  if (Number.isFinite(input.durationMs)) {
    meta.push(`- **Duration:** ${formatDurationMs(Number(input.durationMs))}`);
  }
  if (input.exitCode !== null && input.exitCode !== undefined && Number.isFinite(input.exitCode)) {
    meta.push(`- **Exit code:** ${input.exitCode}`);
  }
  if (meta.length) {
    lines.push(...meta);
    lines.push("");
  }
  const fence = fenceFor(output);
  lines.push(`${fence}console`);
  lines.push(`$ ${command}`.trimEnd());
  if (output) lines.push(output);
  lines.push(fence);
  lines.push("");
  return lines.join("\n");
}

/**
 * Duración compacta para la cabecera del Markdown (formato neutro).
 * @param {number} ms
 * @returns {string}
 */
function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

/**
 * Nombre de fichero sugerido al exportar un bloque. Sin caracteres reservados
 * en ningún SO y acotado, porque el comando puede ser larguísimo.
 * @param {string} command
 * @param {Date} [now]
 * @returns {string}
 */
export function blockFileName(command, now = new Date()) {
  const slug = String(command || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug || "command"}-${stamp}.md`;
}
