// Textos de `index.html` que nadie traduce, para `check-i18n.mjs`.
//
// El chasis de la interfaz vive en `index.html` y se traduce en runtime con
// `applyTranslations()` (`src/i18n.js`): `data-i18n` (y `data-i18n-html`)
// reescribe el contenido de un elemento, `data-i18n-title` el `title` (o el
// `data-tooltip` del tooltip propio), `data-i18n-placeholder` el `placeholder`
// y `data-i18n-aria-label` el `aria-label`. Lo que no lleva su `data-i18n*` se
// queda en castellano en los cinco idiomas. Este analizador recorre el HTML y
// devuelve esos textos: los nodos de texto sin un `data-i18n`/`data-i18n-html`
// en el propio elemento o en un ancestro, y los atributos visibles sin su
// equivalente. Ojo: `data-i18n-title` NO cubre `aria-label`.
//
// No decide qué es «texto de verdad»: devuelve candidatos y el llamador los
// filtra con su heurística (`isVisibleText`) y con `i18n-exempt` en la línea.
// Un texto que no se traduce a propósito (nombre propio, licencia) se marca
// con `translate="no"` en su elemento, que cubre también a sus descendientes.

/** Elementos sin etiqueta de cierre. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "source", "track", "wbr",
]);

/** Elementos cuyo contenido no es texto de la página. */
const RAW_TEXT = new Set(["script", "style"]);

/** Atributo visible → atributo `data-i18n-*` que lo rellena en runtime. */
const VISIBLE_ATTRS = {
  title: "data-i18n-title",
  "data-tooltip": "data-i18n-title",
  "aria-label": "data-i18n-aria-label",
  placeholder: "data-i18n-placeholder",
};

/** Entidades habituales; el resto cuenta como un espacio (no aportan letras). */
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  times: "×", middot: "·", mdash: "—", ndash: "–", larr: "←", rarr: "→",
  uarr: "↑", darr: "↓", copy: "©", bull: "•",
};

/**
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[name.toLowerCase()] ?? " ";
  });
}

/**
 * Lee la etiqueta de apertura que empieza en `src[start]` (`<`).
 * @param {string} src
 * @param {number} start
 * @returns {{ tag: string, attrs: Map<string, { value: string, pos: number }>, end: number, selfClosing: boolean }}
 */
function readOpenTag(src, start) {
  const nameMatch = /^[a-zA-Z][\w:-]*/.exec(src.slice(start + 1, start + 64));
  const tag = (nameMatch?.[0] ?? "").toLowerCase();
  /** @type {Map<string, { value: string, pos: number }>} */
  const attrs = new Map();
  let i = start + 1 + tag.length;
  let selfClosing = false;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === ">") { i++; break; }
    if (src[i] === "/" && src[i + 1] === ">") { selfClosing = true; i += 2; break; }
    const attrStart = i;
    while (i < src.length && !/[\s=/>]/.test(src[i])) i++;
    const name = src.slice(attrStart, i).toLowerCase();
    if (!name) { i++; continue; }
    while (i < src.length && /\s/.test(src[i])) i++;
    let value = "";
    if (src[i] === "=") {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, i + 1);
        const stop = close < 0 ? src.length : close;
        value = src.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const valueStart = i;
        while (i < src.length && !/[\s>]/.test(src[i])) i++;
        value = src.slice(valueStart, i);
      }
    }
    attrs.set(name, { value, pos: attrStart });
  }
  return { tag, attrs, end: i, selfClosing };
}

/**
 * Textos visibles de un documento HTML que no pasan por `data-i18n*`.
 * @param {string} src
 * @returns {{ line: number, context: string, text: string }[]}
 */
export function untranslatedHtmlTexts(src) {
  // Inicio de cada línea, para traducir posiciones a números de línea.
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  /** @param {number} pos */
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  /** @type {{ line: number, context: string, text: string }[]} */
  const out = [];
  /** @type {{ tag: string, covered: boolean }[]} */
  const stack = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      i = close < 0 ? src.length : close + 3;
      continue;
    }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      const close = src.indexOf(">", i);
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (src[i] === "<" && src[i + 1] === "/") {
      const close = src.indexOf(">", i);
      const tag = src.slice(i + 2, close < 0 ? src.length : close).trim().toLowerCase();
      const idx = stack.map((e) => e.tag).lastIndexOf(tag);
      if (idx >= 0) stack.length = idx;
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (src[i] === "<" && /[a-zA-Z]/.test(src[i + 1] ?? "")) {
      const { tag, attrs, end, selfClosing } = readOpenTag(src, i);
      for (const [attr, i18nAttr] of Object.entries(VISIBLE_ATTRS)) {
        const found = attrs.get(attr);
        if (found && !attrs.has(i18nAttr)) {
          out.push({ line: lineOf(found.pos), context: `attr ${attr}=`, text: decodeEntities(found.value).trim() });
        }
      }
      if (RAW_TEXT.has(tag)) {
        const close = src.toLowerCase().indexOf(`</${tag}`, end);
        i = close < 0 ? src.length : close;
        continue;
      }
      if (!VOID.has(tag) && !selfClosing) {
        // `translate="no"` es el atributo estándar de «esto no se traduce»
        // (nombres propios, licencias, glifos): cubre el texto igual que un
        // `data-i18n`, y además lo respetan los traductores del navegador.
        const covered =
          (stack.at(-1)?.covered ?? false) ||
          attrs.has("data-i18n") ||
          attrs.has("data-i18n-html") ||
          attrs.get("translate")?.value.toLowerCase() === "no";
        stack.push({ tag, covered });
      }
      i = end;
      continue;
    }
    // Nodo de texto: hasta el siguiente `<` que abra etiqueta o comentario.
    let next = i + 1;
    while (next < src.length) {
      next = src.indexOf("<", next);
      if (next < 0) { next = src.length; break; }
      if (/[a-zA-Z/!?]/.test(src[next + 1] ?? "")) break;
      next++;
    }
    const raw = src.slice(i, next);
    if (raw.trim() && !(stack.at(-1)?.covered ?? false)) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ line: lineOf(i + lead), context: "texto", text: decodeEntities(raw).replace(/\s+/g, " ").trim() });
    }
    i = next;
  }
  return out;
}
