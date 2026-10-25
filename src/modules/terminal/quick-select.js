// @ts-check
/**
 * Núcleo **puro** de la selección rápida del terminal (al estilo del Quick
 * Select de WezTerm o de los hints de kitty): lee la pantalla visible de un
 * buffer con la forma del de xterm, busca coincidencias que no se solapan
 * —primero los patrones del usuario y luego los de serie, por prioridad—, les
 * pone etiquetas de una o dos letras sin prefijos ambiguos y resuelve la tecla
 * pulsada. Sin DOM: la capa que pinta las etiquetas y escucha el teclado vive
 * en `quick-select-ui.js`.
 *
 * Los patrones de serie no usan *lookbehind* (`(?<=…)`): el bundle apunta a
 * Safari 16 y WebKit no lo entiende hasta la 16.4; un literal así rompería el
 * módulo entero al cargarlo. Los bordes de cada coincidencia se comprueban
 * en código (`accept`).
 */

/**
 * Alfabeto de las etiquetas, en el orden de WezTerm: primero las letras que
 * caen bajo la mano izquierda. Solo minúsculas: la mayúscula significa
 * «copiar y además pegar».
 */
export const QUICK_SELECT_ALPHABET = "asdfqwerzxcvjklmiuopghtybn";

/** Topes de los patrones propios: cuántos se usan y cuánto puede medir cada uno. */
export const QUICK_SELECT_MAX_PATTERNS = 20;
export const QUICK_SELECT_MAX_PATTERN_LENGTH = 256;
/** Caracteres de cada línea que ve un patrón propio (ver `findQuickSelectMatches`). */
export const QUICK_SELECT_CUSTOM_MAX_LINE = 512;

/**
 * Tope de caracteres de una línea lógica (filas envueltas ya unidas): acota lo
 * que recorre cada expresión, también la de un patrón propio mal escrito.
 */
export const QUICK_SELECT_MAX_LINE = 2048;

/**
 * Presupuesto del escaneo en milisegundos. Se comprueba entre línea y patrón:
 * un patrón lento deja de buscar en el resto de la pantalla en vez de alargar
 * la espera (lo ya encontrado se queda). No puede cortar una sola búsqueda
 * catastrófica: eso lo acotan el largo de línea y el del patrón.
 */
export const QUICK_SELECT_BUDGET_MS = 150;

/** Filas que se leen más allá de cada borde para completar una línea envuelta. */
const WRAP_CONTEXT_ROWS = 8;

/**
 * Lo que se lee del buffer de xterm (`terminal.buffer.active`): basta su forma.
 * `getCell` acepta una celda para reutilizarla, como el de xterm.
 * @typedef {{ getChars(): string, getWidth(): number }} QsCell
 * @typedef {{ readonly isWrapped: boolean, readonly length: number, getCell(x: number, cell?: any): QsCell | undefined }} QsLine
 * @typedef {{ readonly viewportY: number, readonly length: number, getLine(y: number): QsLine | undefined }} QsBuffer
 */

/**
 * Línea lógica: las filas envueltas unidas en un texto, con la celda de cada
 * unidad UTF-16 del texto. `row` es relativa a la pantalla (negativa por
 * encima de la primera fila visible); `width` es 2 en un carácter ancho.
 * @typedef {{ text: string, row: number[], col: number[], width: number[] }} QsLogicalLine
 */

/**
 * @typedef {{ row: number, col: number, width: number }} QsSegment
 * @typedef {{ text: string, kind: string, row: number, col: number, segments: QsSegment[] }} QsMatch
 * @typedef {{ label: string, text: string, occurrences: QsMatch[] }} QsTarget
 */

/**
 * Regla de búsqueda. `needs`: alguno de esos textos tiene que aparecer en la
 * línea para que merezca la pena buscar; `trim` recorta el final (puntuación
 * de la frase); `accept` valida la coincidencia ya recortada en su contexto
 * (los bordes). Si la expresión lleva un grupo (patrones propios, con la
 * bandera `d`), lo seleccionado es el primer grupo.
 * @typedef {{ kind: string, re: RegExp, needs?: string[], trim?: (s: string) => string, accept?: (text: string, start: number, end: number) => boolean }} QsRule
 */

// ─── Lectura de la pantalla ────────────────────────────────────────────────

/**
 * Lee la pantalla visible como líneas lógicas. Una línea que llega envuelta
 * desde arriba o sigue por debajo se completa con hasta `WRAP_CONTEXT_ROWS`
 * filas de fuera: así una URL partida en la última fila no se copia a medias,
 * y el trozo de una que empieza más arriba no se confunde con una ruta suelta.
 * @param {QsBuffer} buffer
 * @param {number} rows Filas visibles (`terminal.rows`).
 * @param {number} [maxLine]
 * @returns {QsLogicalLine[]}
 */
export function readViewportLines(buffer, rows, maxLine = QUICK_SELECT_MAX_LINE) {
  const top = buffer.viewportY;
  const bottom = Math.min(top + rows, buffer.length) - 1;
  let y = top;
  for (let n = 0; n < WRAP_CONTEXT_ROWS && y > 0 && buffer.getLine(y)?.isWrapped; n++) y--;
  /** @type {QsLogicalLine[]} */
  const lines = [];
  while (y <= bottom) {
    let end = y;
    while (end + 1 < buffer.length && end + 1 - bottom <= WRAP_CONTEXT_ROWS && buffer.getLine(end + 1)?.isWrapped) end++;
    lines.push(readLogicalLine(buffer, y, end, top, maxLine));
    y = end + 1;
  }
  return lines;
}

/**
 * Une las filas `from..to` en un texto con su mapa de celdas.
 * @param {QsBuffer} buffer
 * @param {number} from
 * @param {number} to
 * @param {number} top Primera fila visible (origen de `row`).
 * @param {number} maxLine
 * @returns {QsLogicalLine}
 */
function readLogicalLine(buffer, from, to, top, maxLine) {
  let text = "";
  /** @type {number[]} */ const row = [];
  /** @type {number[]} */ const col = [];
  /** @type {number[]} */ const width = [];
  /** @type {any} */ let cell;
  for (let y = from; y <= to && text.length < maxLine; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    // Las celdas vacías del final no son texto. En una fila envuelta las deja
    // un carácter ancho que no cabía en la última columna y saltó de fila:
    // contarlas como espacio partiría en dos lo que en pantalla va seguido.
    let last = line.length - 1;
    for (; last >= 0; last--) {
      cell = line.getCell(last, cell);
      if (cell?.getChars()) break;
    }
    for (let x = 0; x <= last && text.length < maxLine; x++) {
      cell = line.getCell(x, cell);
      if (!cell) continue;
      const w = cell.getWidth();
      if (w === 0) continue; // segunda mitad de un carácter ancho
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) {
        row.push(y - top);
        col.push(x);
        width.push(w);
      }
      text += chars;
    }
  }
  return { text, row, col, width };
}

// ─── Patrones de serie ─────────────────────────────────────────────────────

const WORD = /[\p{L}\p{N}_]/u;
const DIGIT = /\d/;

/**
 * @param {string|undefined} ch
 * @param {RegExp} cls
 */
const is = (ch, cls) => ch !== undefined && cls.test(ch);

/**
 * Ni el carácter de antes ni el de después pueden ser de `before`/`after`:
 * la coincidencia tiene que ser un token entero, no un trozo de otro.
 * @param {RegExp} before
 * @param {RegExp} [after]
 * @returns {(text: string, start: number, end: number) => boolean}
 */
function bounded(before, after = before) {
  return (text, start, end) => !is(text[start - 1], before) && !is(text[end], after);
}

/** Puntuación de la frase que cierra un token y no forma parte de él. */
const TRAILING_PUNCT = /[.,;:!?]+$/;
/** @param {string} s */
const trimPunct = (s) => s.replace(TRAILING_PUNCT, "");

/**
 * @param {string} s
 * @param {string} ch
 */
const countOf = (s, ch) => s.split(ch).length - 1;

/**
 * Final de una URL: fuera la puntuación de la frase y los cierres sin pareja
 * (`(https://ejemplo.es/a)` → sin el paréntesis; `…/wiki/A_(b)` → con él).
 * @param {string} s
 */
function trimUrl(s) {
  let out = s;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    if (".,;:!?".includes(last)) { out = out.slice(0, -1); continue; }
    const open = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : null;
    if (open && countOf(out, last) > countOf(out, open)) { out = out.slice(0, -1); continue; }
    return out;
  }
}

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_SOURCE = `(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}`;
const IPV4_EXACT = new RegExp(`^${IPV4_SOURCE}$`);

/**
 * @param {string} s
 * @returns {boolean}
 */
export function isIpv4(s) {
  return IPV4_EXACT.test(s);
}

/**
 * Dirección IPv6 válida (sin corchetes, zona ni puerto): ocho grupos, o
 * menos con un único `::`, y opcionalmente una IPv4 al final.
 * @param {string} addr
 * @returns {boolean}
 */
export function isIpv6(addr) {
  if (!addr.includes(":")) return false;
  let s = addr;
  let extra = 0;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIpv4(tail)) return false;
    // La IPv4 final ocupa dos grupos: se cambia por uno y se cuenta el otro.
    s = `${s.slice(0, lastColon + 1)}0`;
    extra = 1;
  }
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
  if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  const count = groups.length + extra;
  return halves.length === 2 ? count <= 7 : count === 8;
}

/**
 * @param {string} port
 * @returns {boolean}
 */
const validPort = (port) => /^\d{1,5}$/.test(port) && Number(port) <= 65535;

/**
 * Quita un puerto imposible (`:99999`) en vez de descartar la dirección.
 * @param {string} s
 */
function trimBadPort(s) {
  const i = s.lastIndexOf(":");
  return i > 0 && !validPort(s.slice(i + 1)) ? s.slice(0, i) : s;
}

const PATH_CHARS = "[\\p{L}\\p{N}_.@%+~-]";
const PATH_BEFORE = /[\p{L}\p{N}_.@%+~/\\-]/u;
const WIN_PATH_PART = '[^\\\\\\s<>:"|?*]';
const HAS_LETTER = /\p{L}/u;
/** Alfabeto de los sufijos que pone Kubernetes a sus pods (sin vocales ni 0/1/3). */
const K8S_SAFE = "[bcdfghjklmnpqrstvwxz2456789]";

/**
 * Patrones de serie, **por prioridad**: cuando dos se solapan gana el
 * primero (la URL a su ruta y a su dominio; la ruta a la IP de una ruta).
 * @type {readonly QsRule[]}
 */
export const BUILTIN_QUICK_SELECT_RULES = Object.freeze([
  {
    kind: "url",
    re: /[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/[^\s<>"'`]+/g,
    needs: ["://"],
    trim: trimUrl,
    accept: (text, start, end) => !is(text[start - 1], /[\p{L}\p{N}_+.-]/u) && !text.slice(start, end).endsWith("://"),
  },
  {
    kind: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}/g,
    needs: ["@"],
    accept: (text, start, end) => !is(text[start - 1], /[A-Za-z0-9._%+-]/)
      && !is(text[end], /[\p{L}\p{N}_-]/u) && !(text[end] === "." && is(text[end + 1], WORD)),
  },
  {
    // Absoluta, relativa a `~`, `.` o `..`, o con al menos dos componentes
    // (`src/main.js`, `origin/main`). Sin letras no es una ruta: «1/2»,
    // «25/10/2026» o la máscara de «10.0.0.0/8».
    kind: "path",
    re: new RegExp(`${PATH_CHARS}*(?:\\/${PATH_CHARS}+)+\\/?`, "gu"),
    needs: ["/"],
    trim: trimPunct,
    accept: (text, start, end) => !is(text[start - 1], PATH_BEFORE) && HAS_LETTER.test(text.slice(start, end)),
  },
  {
    kind: "path",
    re: new RegExp(`(?:[A-Za-z]:|\\\\\\\\${WIN_PATH_PART}+)\\\\(?:${WIN_PATH_PART}+(?:\\\\${WIN_PATH_PART}+)*\\\\?)?`, "g"),
    needs: ["\\"],
    trim: trimPunct,
    accept: (text, start) => !is(text[start - 1], WORD),
  },
  {
    kind: "uuid",
    re: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    needs: ["-"],
    accept: bounded(WORD),
  },
  {
    // Entre corchetes, con puerto opcional: `[::1]:8080`, `[::]:22`.
    kind: "ipv6",
    re: /\[[0-9A-Fa-f:.]{2,45}(?:%[\w.-]{1,32})?\](?::\d{1,5})?/g,
    needs: ["["],
    accept: (text, start, end) => {
      const s = text.slice(start, end);
      const close = s.indexOf("]");
      const port = s.slice(close + 2);
      return isIpv6(s.slice(1, close).replace(/%.*/, "")) && (!port || validPort(port)) && !is(text[end], WORD);
    },
  },
  {
    // Suelta, con zona opcional (`fe80::1%eth0`). Una hora (`12:34:56`), una
    // MAC o el `::` de C++ no pasan la validación.
    kind: "ipv6",
    re: /(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f.]*(?:%[\w.-]{1,32})?/g,
    needs: [":"],
    trim: (s) => {
      const out = s.replace(/\.+$/, "");
      return out.endsWith(":") && !out.endsWith("::") ? out.slice(0, -1) : out;
    },
    accept: (text, start, end) => {
      const addr = text.slice(start, end).replace(/%.*/, "");
      return !is(text[start - 1], /[\p{L}\p{N}_:.]/u) && !is(text[end], /[\p{L}\p{N}_:]/u)
        && /[0-9A-Fa-f]/.test(addr) && isIpv6(addr);
    },
  },
  {
    kind: "ipv4",
    re: new RegExp(`${IPV4_SOURCE}(?::\\d{1,5})?`, "g"),
    needs: ["."],
    trim: trimBadPort,
    accept: (text, start, end) => !is(text[start - 1], /[\p{L}\p{N}_.]/u)
      && !is(text[end], WORD) && !(text[end] === "." && is(text[end + 1], DIGIT)),
  },
  {
    // ID completo de un contenedor o de una imagen (64 hex); el corto de
    // `docker ps` (12) ya lo coge el de los hashes.
    kind: "container",
    re: /[0-9a-f]{64}/g,
    accept: bounded(WORD),
  },
  {
    // Pod de un Deployment: `web-7c5ddbdf54-x2k9p`.
    kind: "container",
    re: new RegExp(`[a-z0-9](?:[a-z0-9-]{0,200}[a-z0-9])?-${K8S_SAFE}{8,10}-${K8S_SAFE}{5}`, "g"),
    needs: ["-"],
    accept: bounded(/[\p{L}\p{N}_-]/u),
  },
  {
    kind: "fqdn",
    re: /(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63}/gu,
    needs: ["."],
    accept: (text, start, end) => !is(text[start - 1], /[\p{L}\p{N}_.@-]/u)
      && !is(text[end], /[\p{L}\p{N}_-]/u) && !(text[end] === "." && is(text[end + 1], WORD)),
  },
  {
    // SHA de git (7 a 40). Con al menos un dígito: así no se marcan palabras
    // que solo tienen letras de la a a la f («defaced»); uno de solo dígitos
    // lo coge el patrón de números.
    kind: "sha",
    re: /[0-9a-f]{7,40}/g,
    accept: (text, start, end) => bounded(WORD)(text, start, end) && DIGIT.test(text.slice(start, end)),
  },
  {
    // Números largos (PID, puertos, tamaños), no los trozos de un decimal.
    kind: "number",
    re: /\d{4,}/g,
    accept: (text, start, end) => !is(text[start - 1], /[\p{L}\p{N}_.,]/u)
      && !is(text[end], WORD) && !((text[end] === "." || text[end] === ",") && is(text[end + 1], DIGIT)),
  },
]);

// ─── Patrones propios ──────────────────────────────────────────────────────

/**
 * ¿Repite el patrón un grupo que ya repite algo (`(a+)+`, `(\w+\s?)*`,
 * `((ab)*)+`)? Es la forma típica de retroceso exponencial: con 40 caracteres
 * de la salida del servidor, un `exec` no termina en horas, y el presupuesto de
 * tiempo del escaneo solo se mira entre reglas. Repetir con `?` o `{n}` (acotados)
 * no cuenta.
 * @param {string} source
 * @returns {boolean}
 */
export function hasNestedQuantifier(source) {
  /** @type {boolean[]} por grupo abierto: ¿repite algo dentro? */
  const stack = [];
  const unbounded = (/** @type {number} */ i) => {
    const c = source[i];
    if (c === "+" || c === "*") return true;
    return c === "{" && /^\{\d*,\d*\}/.test(source.slice(i));
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") {
      // Clase de caracteres: su contenido no tiene cuantificadores ni grupos.
      i++;
      if (source[i] === "^") i++;
      if (source[i] === "]") i++;
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "(") { stack.push(false); continue; }
    if (c === ")") {
      const repeatsInside = stack.pop() ?? false;
      if (repeatsInside && unbounded(i + 1)) return true;
      if (repeatsInside && stack.length) stack[stack.length - 1] = true;
      if (unbounded(i + 1) && stack.length) stack[stack.length - 1] = true;
      continue;
    }
    if (unbounded(i) && stack.length) stack[stack.length - 1] = true;
  }
  return false;
}

/**
 * Por qué no se usaría un patrón propio (`null` = vale). Compila igual que el
 * resaltado por regex (`new RegExp(patrón)`, sin la bandera `u`), y además se
 * rechazan las repeticiones anidadas (`hasNestedQuantifier`), que podrían
 * colgar la interfaz con un texto del servidor.
 * @param {unknown} pattern
 * @returns {null | "empty" | "too_long" | "invalid" | "nested_quantifier"}
 */
export function quickSelectPatternError(pattern) {
  if (typeof pattern !== "string" || !pattern.trim()) return "empty";
  if (pattern.length > QUICK_SELECT_MAX_PATTERN_LENGTH) return "too_long";
  try {
    new RegExp(pattern, "gd");
  } catch {
    return "invalid";
  }
  if (hasNestedQuantifier(pattern)) return "nested_quantifier";
  return null;
}

/**
 * Compila `prefs.quickSelectPatterns` (`{ pattern }` o cadenas). Los vacíos,
 * los inválidos y los demasiado largos se ignoran sin romper nada; solo se
 * usan los primeros `QUICK_SELECT_MAX_PATTERNS`. La bandera `d` da la
 * posición del primer grupo, que es lo que se selecciona si lo hay.
 * @param {unknown} raw
 * @returns {QsRule[]}
 */
export function compileQuickSelectPatterns(raw) {
  /** @type {QsRule[]} */
  const rules = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (rules.length >= QUICK_SELECT_MAX_PATTERNS) break;
    const source = typeof item === "string" ? item : item?.pattern;
    if (quickSelectPatternError(source) !== null) continue;
    rules.push({ kind: "custom", re: new RegExp(/** @type {string} */ (source), "gd") });
  }
  return rules;
}

// ─── Búsqueda ──────────────────────────────────────────────────────────────

/**
 * @param {Uint8Array} taken
 * @param {number} start
 * @param {number} end
 */
function isFree(taken, start, end) {
  for (let i = start; i < end; i++) if (taken[i]) return false;
  return true;
}

/**
 * Busca una regla en el texto y apunta lo que no pisa a reglas anteriores.
 * Una coincidencia rechazada (por sus bordes o por solaparse) se reintenta
 * desde el carácter siguiente: dentro puede haber otra buena.
 * @param {string} text
 * @param {QsRule} rule
 * @param {Uint8Array} taken
 * @param {{ start: number, end: number, text: string, kind: string }[]} found
 */
function scanRule(text, rule, taken, found) {
  const { re } = rule;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex = m.index + 1; continue; }
    let start = m.index;
    let value = m[0];
    const group = m.indices?.[1];
    if (group) {
      start = group[0];
      value = text.slice(group[0], group[1]);
    }
    if (rule.trim) value = rule.trim(value);
    const end = start + value.length;
    if (value && isFree(taken, start, end) && (!rule.accept || rule.accept(text, start, end))) {
      taken.fill(1, start, end);
      found.push({ start, end, text: value, kind: rule.kind });
    } else {
      re.lastIndex = m.index + 1;
    }
  }
}

/**
 * Tramos de pantalla (uno por fila) que ocupa `[start, end)` de la línea.
 * @param {QsLogicalLine} line
 * @param {number} start
 * @param {number} end
 * @returns {QsSegment[]}
 */
function segmentsOf(line, start, end) {
  /** @type {QsSegment[]} */
  const segments = [];
  for (let i = start; i < end; i++) {
    const row = line.row[i];
    const col = line.col[i];
    const last = segments.at(-1);
    if (last && last.row === row) last.width = Math.max(last.width, col + line.width[i] - last.col);
    else segments.push({ row, col, width: line.width[i] });
  }
  return segments;
}

/**
 * Coincidencias de las reglas en las líneas leídas, sin solapes: dentro de
 * cada línea, una regla anterior gana a una posterior. Solo cuentan las que
 * **empiezan** en pantalla (la etiqueta va en su primera celda).
 * @param {QsLogicalLine[]} lines
 * @param {object} opts
 * @param {readonly QsRule[]} opts.rules Por prioridad: primero los propios.
 * @param {number} opts.rows Filas visibles.
 * @param {() => number} [opts.now]
 * @param {number} [opts.budgetMs]
 * @returns {{ matches: QsMatch[], truncated: boolean }}
 */
export function findQuickSelectMatches(lines, { rules, rows, now = () => Date.now(), budgetMs = QUICK_SELECT_BUDGET_MS }) {
  const started = now();
  /** @type {QsMatch[]} */
  const matches = [];
  let truncated = false;
  for (const line of lines) {
    if (truncated) break;
    if (!line.text.trim()) continue;
    const taken = new Uint8Array(line.text.length);
    /** @type {{ start: number, end: number, text: string, kind: string }[]} */
    const found = [];
    for (const rule of rules) {
      if (now() - started > budgetMs) { truncated = true; break; }
      if (rule.needs && !rule.needs.some((needle) => line.text.includes(needle))) continue;
      // Un patrón propio solo ve los primeros caracteres de cada línea: aunque
      // las repeticiones anidadas ya se rechazan, otras formas (`\w*\w*\w*x`)
      // crecen con el cubo de la longitud, y un `exec` no se puede interrumpir.
      const text = rule.kind === "custom" ? line.text.slice(0, QUICK_SELECT_CUSTOM_MAX_LINE) : line.text;
      scanRule(text, rule, taken, found);
    }
    for (const f of found) {
      const row = line.row[f.start];
      if (row < 0 || row >= rows) continue;
      matches.push({ text: f.text, kind: f.kind, row, col: line.col[f.start], segments: segmentsOf(line, f.start, f.end) });
    }
  }
  return { matches, truncated };
}

// ─── Etiquetas ─────────────────────────────────────────────────────────────

/**
 * `count` etiquetas sin prefijos ambiguos: si caben, de una letra; si no, las
 * últimas letras del alfabeto pasan a ser prefijo de etiquetas de dos y
 * ninguna de ellas queda como etiqueta suelta (tecleada la primera letra,
 * siempre falta la segunda). Como mucho `alfabeto²`.
 * @param {number} count
 * @param {string} [alphabet]
 * @returns {string[]}
 */
export function quickSelectLabels(count, alphabet = QUICK_SELECT_ALPHABET) {
  const letters = [...alphabet];
  const n = letters.length;
  const total = Math.min(Math.max(0, Math.floor(count)), n * n);
  if (total <= n) return letters.slice(0, total);
  // (n − k) sueltas + k·n dobles ≥ total, con el menor número de prefijos k.
  const k = Math.min(n, Math.ceil((total - n) / (n - 1)));
  const labels = letters.slice(0, n - k);
  for (const prefix of letters.slice(n - k)) {
    for (const letter of letters) {
      if (labels.length >= total) return labels;
      labels.push(prefix + letter);
    }
  }
  return labels;
}

/**
 * Agrupa las coincidencias por texto (el mismo texto en dos sitios lleva la
 * misma etiqueta) y reparte las etiquetas de abajo arriba: lo más reciente,
 * junto al prompt, recibe las de una letra.
 * @param {QsMatch[]} matches
 * @param {string} [alphabet]
 * @returns {{ targets: QsTarget[], truncated: boolean }}
 */
export function assignQuickSelectLabels(matches, alphabet = QUICK_SELECT_ALPHABET) {
  const ordered = [...matches].sort((a, b) => b.row - a.row || a.col - b.col);
  /** @type {Map<string, { text: string, occurrences: QsMatch[] }>} */
  const byText = new Map();
  for (const match of ordered) {
    const group = byText.get(match.text);
    if (group) group.occurrences.push(match);
    else byText.set(match.text, { text: match.text, occurrences: [match] });
  }
  const groups = [...byText.values()];
  const labels = quickSelectLabels(groups.length, alphabet);
  return {
    targets: labels.map((label, i) => ({ label, ...groups[i] })),
    truncated: groups.length > labels.length,
  };
}

// ─── Teclado ───────────────────────────────────────────────────────────────

/**
 * @typedef {{ type: "cancel" } | { type: "ignore" }
 *   | { type: "pending", typed: string, paste: boolean }
 *   | { type: "select", label: string, paste: boolean }} QsKeyResult
 */

/**
 * Qué hace una tecla con la selección rápida activa. Escape cancela; una
 * letra completa o empieza una etiqueta; con Mayúsculas (en cualquiera de
 * las dos letras) además se pega. Se mira `shiftKey`, no si la letra llega en
 * mayúscula: con Bloq Mayús activo una letra no pega. Retroceso borra la
 * primera letra tecleada. Lo demás se ignora, pero no llega al terminal.
 * @param {readonly string[]} labels
 * @param {{ typed: string, paste: boolean }} state
 * @param {{ key: string, shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean }} event
 * @returns {QsKeyResult}
 */
export function resolveQuickSelectKey(labels, state, event) {
  const { key } = event;
  if (key === "Escape") return { type: "cancel" };
  if (event.ctrlKey || event.altKey || event.metaKey) return { type: "ignore" };
  if (key === "Backspace") return state.typed ? { type: "pending", typed: "", paste: false } : { type: "ignore" };
  if (typeof key !== "string" || [...key].length !== 1) return { type: "ignore" };
  const lower = key.toLowerCase();
  if (lower === key.toUpperCase()) return { type: "ignore" }; // no es una letra
  const typed = state.typed + lower;
  const shifted = typeof event.shiftKey === "boolean" ? event.shiftKey : key !== lower;
  const paste = state.paste || shifted;
  if (labels.includes(typed)) return { type: "select", label: typed, paste };
  if (labels.some((label) => label.startsWith(typed))) return { type: "pending", typed, paste };
  return { type: "ignore" };
}

/**
 * Dónde va el aviso del modo: abajo (`"bottom"`), arriba si abajo tapa alguna
 * etiqueta (`"top"`), o nada (`"hidden"`) si tapa en los dos sitios. Arriba
 * fijo tapaba la primera línea, que en una salida larga es justo la que se
 * quiere copiar; abajo está el prompt, donde se concentran las etiquetas.
 * @param {{ left: number, right: number, top: number, bottom: number }[]} labels
 * @param {{ left: number, right: number, top: number, bottom: number }} atBottom
 * @param {{ left: number, right: number, top: number, bottom: number }} atTop
 * @returns {"bottom"|"top"|"hidden"}
 */
export function quickSelectHintPlacement(labels, atBottom, atTop) {
  const hits = (/** @type {typeof atBottom} */ h) => labels.some((r) =>
    r.left < h.right && r.right > h.left && r.top < h.bottom && r.bottom > h.top);
  if (!hits(atBottom)) return "bottom";
  if (!hits(atTop)) return "top";
  return "hidden";
}
