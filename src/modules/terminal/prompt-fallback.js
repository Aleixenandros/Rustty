// @ts-check
/**
 * Fallback de bloques de comando por **regex de prompt**, para shells que no
 * emiten OSC 133. Segmenta el buffer en pseudo-bloques con la misma forma que
 * los `CommandBlock` del tracker (ids negativos para no chocar con los suyos):
 * cada línea que casa con la regex es un prompt; el comando es el resto de esa
 * línea y la salida llega hasta el prompt siguiente.
 *
 * Es un heurístico de lectura bajo demanda (panel de bloques): no toca el
 * camino caliente del terminal ni compite con el tracker cuando el shell sí
 * emite OSC 133.
 */

/**
 * Patrón por defecto: un prefijo corto opcional que termina en un cierre de
 * prompt habitual (`$`, `#`, `%`, `❯`) seguido de espacio. Cubre los prompts
 * clásicos `user@host:~/dir$ ` y los minimalistas `❯ `. No incluye `>` a
 * propósito: casaría con los `->` de los symlinks en `ls -l`; un prompt de
 * PowerShell (`PS C:\> `) se cubre con el patrón por perfil.
 */
export const DEFAULT_PROMPT_PATTERN = String.raw`(?:[^\s].{0,118}?)?[$#%❯]\s`;

/**
 * Compila el patrón anclándolo al inicio de línea. Un patrón inválido (o
 * vacío) devuelve `null`: quien llama decide si cae al patrón por defecto.
 * @param {string|null|undefined} pattern
 * @returns {RegExp|null}
 */
export function compilePromptRegex(pattern) {
  const src = typeof pattern === "string" ? pattern.trim() : "";
  if (!src) return null;
  try {
    return new RegExp(`^(?:${src})`);
  } catch {
    return null;
  }
}

/**
 * Segmenta el buffer en pseudo-bloques compatibles con `CommandBlock`.
 *
 * @param {(line: number) => string|null} readLine Lector de línea absoluta del buffer.
 * @param {number} firstLine Primera línea a examinar.
 * @param {number} lastLine Última línea a examinar (incluida).
 * @param {RegExp} regex Regex de prompt ya compilada (ver `compilePromptRegex`).
 * @param {number} [maxBlocks] Tope de bloques (se conservan los más recientes).
 * @returns {Array<import("./blocks.js").CommandBlock & { synthetic: true }>}
 */
export function segmentByPrompt(readLine, firstLine, lastLine, regex, maxBlocks = 1000) {
  /** @type {Array<import("./blocks.js").CommandBlock & { synthetic: true }>} */
  const blocks = [];
  for (let line = firstLine; line <= lastLine; line++) {
    const text = readLine(line);
    if (typeof text !== "string") continue;
    const match = regex.exec(text);
    if (!match) continue;
    const commandCol = match[0].length;
    const prev = blocks[blocks.length - 1];
    if (prev) prev.endLine = line - 1;
    blocks.push({
      id: -(blocks.length + 1),
      promptLine: line,
      promptCol: 0,
      commandLine: line,
      commandCol,
      outputLine: line + 1 <= lastLine ? line + 1 : null,
      outputCol: 0,
      endLine: null,
      endCol: 0,
      exitCode: null,
      synthetic: true,
    });
    if (blocks.length > maxBlocks) {
      blocks.shift();
    }
  }
  return blocks;
}
