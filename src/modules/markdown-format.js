// @ts-check
/**
 * Formato Markdown sobre la selección de un campo de texto, en **puro**: recibe
 * el texto y la selección y devuelve la edición a aplicar, sin tocar el DOM.
 * Lo usan la barra del editor de notas y el submenú «Formato» del menú
 * contextual del campo.
 *
 * La edición se devuelve como «sustituye `[start, end)` por `text` y deja
 * seleccionado `[selStart, selEnd)`» para que quien la aplique pueda hacerlo con
 * `execCommand("insertText")` y conservar el deshacer del navegador.
 *
 * Dos familias:
 * - **En línea** (negrita, cursiva, código, enlace): envuelven la selección; si
 *   ya está envuelta con esa marca, la quitan.
 * - **De línea** (encabezado, listas, casilla, cita): actúan sobre las líneas
 *   enteras que toca la selección, aunque el cursor esté a mitad de línea; si
 *   todas las líneas ya la llevan, la quitan.
 */

/** Acciones de formato disponibles, en el orden en que se ofrecen. */
export const MARKDOWN_FORMATS = Object.freeze([
  "bold", "italic", "code", "codeblock", "link",
  "h", "ul", "ol", "task", "quote",
]);

/**
 * @typedef {object} FormatEdit
 * @property {number} start inicio del tramo a sustituir.
 * @property {number} end fin (exclusivo) del tramo a sustituir.
 * @property {string} text texto que lo sustituye.
 * @property {number} selStart selección resultante (absoluta en el texto nuevo).
 * @property {number} selEnd
 */

/**
 * @typedef {object} FormatPlaceholders
 * @property {string} [bold]
 * @property {string} [italic]
 * @property {string} [code]
 * @property {string} [link]
 * @property {string} [heading]
 * @property {string} [item]
 * @property {string} [task]
 * @property {string} [quote]
 */

/** Marcas de las acciones de línea y el patrón que reconoce cada una. */
const LINE_FORMATS = {
  h: { re: /^## /, prefix: () => "## ", placeholder: "heading" },
  ul: { re: /^[-*+] (?!\[[ xX]\] )/, prefix: () => "- ", placeholder: "item" },
  ol: { re: /^\d+\. /, prefix: (/** @type {number} */ i) => `${i + 1}. `, placeholder: "item" },
  task: { re: /^[-*+] \[[ xX]\] /, prefix: () => "- [ ] ", placeholder: "task" },
  quote: { re: /^> ?/, prefix: () => "> ", placeholder: "quote" },
};

/**
 * Marca de encabezado o de lista que se cambia por la nueva al convertir una
 * línea (de lista a casilla, de casilla a numerada…). La cita no entra: una
 * lista dentro de una cita es Markdown válido y se respeta.
 */
const REPLACEABLE_MARKER = /^(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+\. )/;

/**
 * Longitud de la racha de `ch` que acaba justo antes de `pos`.
 * @param {string} value
 * @param {number} pos
 * @param {string} ch
 */
function runBefore(value, pos, ch) {
  let n = 0;
  while (pos - n - 1 >= 0 && value[pos - n - 1] === ch) n++;
  return n;
}

/**
 * Longitud de la racha de `ch` que empieza en `pos`.
 * @param {string} value
 * @param {number} pos
 * @param {string} ch
 */
function runAfter(value, pos, ch) {
  let n = 0;
  while (pos + n < value.length && value[pos + n] === ch) n++;
  return n;
}

/**
 * ¿La selección `[s, e)` ya está envuelta por la marca de `action`? Devuelve
 * el ancho de la marca a quitar a cada lado, o 0 si no lo está. Cuenta las
 * rachas de `*` para distinguir cursiva (`*x*`), negrita (`**x**`) y ambas
 * (`***x***`).
 * @param {string} value
 * @param {number} s
 * @param {number} e
 * @param {string} action
 */
function wrappedWidth(value, s, e, action) {
  if (s === e) return 0;
  if (action === "code") {
    return value[s - 1] === "`" && value[e] === "`" ? 1 : 0;
  }
  const before = runBefore(value, s, "*");
  const after = runAfter(value, e, "*");
  if (action === "bold") return before >= 2 && after >= 2 ? 2 : 0;
  if (action === "italic") return before % 2 === 1 && after % 2 === 1 ? 1 : 0;
  return 0;
}

/**
 * Edición de las acciones en línea.
 * @param {string} value
 * @param {number} s
 * @param {number} e
 * @param {string} action
 * @param {FormatPlaceholders} ph
 * @returns {FormatEdit}
 */
function inlineEdit(value, s, e, action, ph) {
  const sel = value.slice(s, e);
  if (action === "link") {
    if (/^(https?:\/\/|mailto:)\S+$/i.test(sel.trim())) {
      // Lo seleccionado ya es la dirección: se usa de destino y se deja
      // seleccionado el texto del enlace para escribirlo.
      const label = ph.link || "";
      const text = `[${label}](${sel.trim()})`;
      return { start: s, end: e, text, selStart: s + 1, selEnd: s + 1 + label.length };
    }
    const label = sel || ph.link || "";
    const url = "https://";
    const text = `[${label}](${url})`;
    // Con texto ya escrito lo que falta es la dirección; sin él, el texto.
    if (sel) {
      const at = s + label.length + 3;
      return { start: s, end: e, text, selStart: at, selEnd: at + url.length };
    }
    return { start: s, end: e, text, selStart: s + 1, selEnd: s + 1 + label.length };
  }
  const mark = action === "bold" ? "**" : action === "italic" ? "*" : "`";
  const width = wrappedWidth(value, s, e, action);
  if (width) {
    // Ya envuelta: quitar la marca y dejar el texto seleccionado.
    return { start: s - width, end: e + width, text: sel, selStart: s - width, selEnd: e - width };
  }
  /** @type {"bold" | "italic" | "code"} */
  const key = action === "bold" ? "bold" : action === "italic" ? "italic" : "code";
  const inner = sel || ph[key] || "";
  return {
    start: s,
    end: e,
    text: mark + inner + mark,
    selStart: s + mark.length,
    selEnd: s + mark.length + inner.length,
  };
}

/**
 * Líneas completas que toca la selección `[s, e)`.
 * @param {string} value
 * @param {number} s
 * @param {number} e
 */
function lineRange(value, s, e) {
  const start = value.lastIndexOf("\n", s - 1) + 1;
  // Una selección que acaba justo al principio de una línea no la incluye.
  const last = e > s && value[e - 1] === "\n" ? e - 1 : e;
  const nl = value.indexOf("\n", last);
  const end = nl === -1 ? value.length : Math.max(nl, start);
  return { start, end };
}

/**
 * Edición del bloque de código cercado.
 * @param {string} value
 * @param {number} s
 * @param {number} e
 * @param {FormatPlaceholders} ph
 * @returns {FormatEdit}
 */
function codeBlockEdit(value, s, e, ph) {
  const { start, end } = s === e ? { start: s, end: e } : lineRange(value, s, e);
  const inner = s === e ? (ph.code || "") : value.slice(start, end);
  const lead = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const trail = end < value.length && value[end] !== "\n" ? "\n" : "";
  const text = `${lead}\`\`\`\n${inner}\n\`\`\`${trail}`;
  const innerAt = start + lead.length + 4;
  return { start, end, text, selStart: innerAt, selEnd: innerAt + inner.length };
}

/**
 * Edición de las acciones de línea.
 * @param {string} value
 * @param {number} s
 * @param {number} e
 * @param {string} action
 * @param {FormatPlaceholders} ph
 * @returns {FormatEdit}
 */
function lineEdit(value, s, e, action, ph) {
  const fmt = LINE_FORMATS[/** @type {keyof typeof LINE_FORMATS} */ (action)];
  const { start, end } = lineRange(value, s, e);
  const lines = value.slice(start, end).split("\n");
  const filled = lines.filter((/** @type {string} */ l) => l.trim() !== "");
  const allHave = filled.length > 0 && filled.every((/** @type {string} */ l) => fmt.re.test(l));

  let out;
  if (allHave) {
    out = lines.map((/** @type {string} */ l) => l.replace(fmt.re, ""));
  } else if (filled.length === 0) {
    // Línea vacía: la marca y un texto de ejemplo que queda seleccionado.
    const prefix = fmt.prefix(0);
    const placeholder = ph[/** @type {keyof FormatPlaceholders} */ (fmt.placeholder)] || "";
    const text = prefix + placeholder;
    return {
      start, end, text,
      selStart: start + prefix.length,
      selEnd: start + text.length,
    };
  } else {
    let n = 0;
    out = lines.map((/** @type {string} */ l) => {
      if (l.trim() === "") return l;
      const body = action === "quote" ? l : l.replace(REPLACEABLE_MARKER, "");
      return fmt.prefix(n++) + body;
    });
  }
  const text = out.join("\n");
  // Sin selección, el cursor sigue al final de la línea; con ella, el bloque
  // entero queda seleccionado para encadenar otro formato.
  if (s === e) {
    return { start, end, text, selStart: start + text.length, selEnd: start + text.length };
  }
  return { start, end, text, selStart: start, selEnd: start + text.length };
}

/**
 * Edición que aplica la acción de formato `action` sobre la selección
 * `[selStart, selEnd)` de `value`, o `null` si la acción no existe.
 * @param {string} value
 * @param {number} selStart
 * @param {number} selEnd
 * @param {string} action una de {@link MARKDOWN_FORMATS}.
 * @param {FormatPlaceholders} [placeholders] textos de ejemplo (traducidos).
 * @returns {FormatEdit | null}
 */
export function markdownFormatEdit(value, selStart, selEnd, action, placeholders = {}) {
  const text = String(value ?? "");
  const s = Math.max(0, Math.min(selStart, selEnd, text.length));
  const e = Math.min(text.length, Math.max(selStart, selEnd));
  switch (action) {
    case "bold":
    case "italic":
    case "code":
    case "link":
      return inlineEdit(text, s, e, action, placeholders);
    case "codeblock":
      return codeBlockEdit(text, s, e, placeholders);
    case "h":
    case "ul":
    case "ol":
    case "task":
    case "quote":
      return lineEdit(text, s, e, action, placeholders);
    default:
      return null;
  }
}

/**
 * Aplica una edición a un texto (útil en tests y como respaldo cuando el
 * campo no admite `execCommand`).
 * @param {string} value
 * @param {FormatEdit} edit
 */
export function applyFormatEdit(value, edit) {
  return value.slice(0, edit.start) + edit.text + value.slice(edit.end);
}
