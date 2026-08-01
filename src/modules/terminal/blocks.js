// @ts-check
/**
 * Núcleo **puro** de bloques de comando OSC 133 (prompt + comando + salida).
 *
 * Los shells modernos (bash/zsh/fish con sus hooks) emiten secuencias
 * semánticas `OSC 133;A` (empieza el prompt), `;B` (empieza el comando),
 * `;C` (empieza la salida) y `;D[;exit]` (terminó el comando). Este módulo
 * mantiene la lista de bloques a partir de esos marcadores y responde a las
 * consultas de navegación; el wiring con xterm (registrar el handler OSC,
 * traducir marcadores a líneas del buffer, colapsar/copiar) llega aparte.
 *
 * Sin DOM ni estado global: el `line` lo aporta el llamador (línea absoluta
 * del buffer en el momento del marcador). Tolerante a shells imperfectos:
 * un `A` con un bloque aún abierto lo cierra implícitamente (exit desconocido),
 * y `B`/`C`/`D` sin bloque abierto se ignoran sin romper nada.
 */

/**
 * @typedef {object} CommandBlock
 * @property {number} id Identificador estable del bloque (creciente).
 * @property {number} promptLine Línea donde empezó el prompt (`A`).
 * @property {number|null} commandLine Línea donde empezó el comando (`B`).
 * @property {number|null} outputLine Línea donde empezó la salida (`C`).
 * @property {number|null} endLine Línea del fin de comando (`D`), o null si sigue abierto.
 * @property {number|null} exitCode Código de salida del `D;exit`, si lo dio.
 */

/**
 * @typedef {object} BlockTracker
 * @property {CommandBlock[]} blocks Bloques en orden de aparición.
 * @property {number} nextId
 * @property {number} maxBlocks
 */

/**
 * @param {number} [maxBlocks] Tope de bloques retenidos (los más antiguos caen).
 * @returns {BlockTracker}
 */
export function createBlockTracker(maxBlocks = 1000) {
  return { blocks: [], nextId: 1, maxBlocks: Math.max(1, maxBlocks) };
}

/** Último bloque sin cerrar, si lo hay. @param {BlockTracker} state */
function openBlock(state) {
  const last = state.blocks[state.blocks.length - 1];
  return last && last.endLine === null ? last : null;
}

/**
 * Procesa el payload de una secuencia OSC 133 (`"A"`, `"B"`, `"C"`,
 * `"D"`/`"D;0"`, con parámetros extra tras `;` que se ignoran).
 * @param {BlockTracker} state
 * @param {string} data Payload tras `133;` (p. ej. `"A"` o `"D;127"`).
 * @param {number} line Línea absoluta del buffer en la que llega el marcador.
 * @returns {boolean} `true` si el marcador se ha entendido.
 */
export function handleOsc133(state, data, line) {
  const parts = String(data || "").split(";");
  const kind = parts[0];
  switch (kind) {
    case "A": {
      const open = openBlock(state);
      if (open) {
        // Shell imperfecto o comando interrumpido: cierre implícito justo
        // antes del prompt nuevo, sin código de salida.
        open.endLine = Math.max(open.promptLine, line - 1);
      }
      state.blocks.push({
        id: state.nextId++,
        promptLine: line,
        commandLine: null,
        outputLine: null,
        endLine: null,
        exitCode: null,
      });
      if (state.blocks.length > state.maxBlocks) {
        state.blocks.splice(0, state.blocks.length - state.maxBlocks);
      }
      return true;
    }
    case "B": {
      const open = openBlock(state);
      if (open && open.commandLine === null) open.commandLine = line;
      return open !== null;
    }
    case "C": {
      const open = openBlock(state);
      if (open && open.outputLine === null) open.outputLine = line;
      return open !== null;
    }
    case "D": {
      const open = openBlock(state);
      if (!open) return false;
      open.endLine = line;
      const exit = parts.length > 1 ? Number.parseInt(parts[1], 10) : NaN;
      open.exitCode = Number.isFinite(exit) ? exit : null;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Bloque que contiene la línea dada (un bloque abierto llega hasta el final).
 * @param {BlockTracker} state
 * @param {number} line
 * @returns {CommandBlock|null}
 */
export function blockAt(state, line) {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    const end = b.endLine === null ? Infinity : b.endLine;
    if (line >= b.promptLine && line <= end) return b;
  }
  return null;
}

/**
 * Bloque siguiente/anterior respecto a una línea (navegación Alt+↑/Alt+↓).
 * @param {BlockTracker} state
 * @param {number} fromLine
 * @param {1|-1} dir `1` = hacia abajo (más reciente), `-1` = hacia arriba.
 * @returns {CommandBlock|null} `null` en el extremo (sin vuelta circular).
 */
export function nextBlock(state, fromLine, dir) {
  if (dir === 1) {
    for (const b of state.blocks) {
      if (b.promptLine > fromLine) return b;
    }
    return null;
  }
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    if (state.blocks[i].promptLine < fromLine) return state.blocks[i];
  }
  return null;
}

/**
 * Retira los bloques que terminaron por encima de `line` (líneas ya expulsadas
 * del scrollback). Un bloque abierto nunca se poda.
 * @param {BlockTracker} state
 * @param {number} line Primera línea aún viva del buffer.
 * @returns {number} Bloques eliminados.
 */
export function pruneBlocksBefore(state, line) {
  const before = state.blocks.length;
  state.blocks = state.blocks.filter((b) => b.endLine === null || b.endLine >= line);
  return before - state.blocks.length;
}
