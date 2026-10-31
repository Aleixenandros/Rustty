// Núcleo puro del guardián del sistema de tokens (`check-tokens.mjs`): recorre
// una hoja CSS y devuelve los hallazgos fuera del sistema. Sin E/S, para que
// `tokens-css.test.mjs` lo pruebe con fragmentos.
//
// Qué caza, declaración a declaración (los comentarios se vacían antes, los
// selectores no se miran):
// - `hex`: un `#rrggbb` suelto.
// - `rgb` / `hsl`: un `rgb()`/`rgba()`/`hsl()`/`hsla()` que NO es neutro. Las
//   sombras y velos negros o blancos translúcidos (`rgba(0, 0, 0, .3)`) son
//   neutros —valen igual en los 233 temas— y no avisan; un `rgba(137, 180,
//   250, .28)` es un azul congelado y sí.
// - `named`: un color CSS con nombre (`red`, `white`, `orange`…). Se permiten
//   `transparent`, `currentColor` y las palabras clave de herencia.
// - `z-index`: una capa (≥ `zLayerMin`) en literal, fuera de la escala `--z-*`.
// - `undefined-var`: un `var(--x)` que la hoja no define (ni el código en runtime).
// - `transition`: una duración literal (`0.15s`, `120ms`) o `all` en una
//   `transition`, fuera de los tokens `--motion-*`.
//
// Exenciones: la **definición** de un token (`--algo: …`, también multilínea)
// es la fuente del sistema y puede llevar literales; y los selectores de
// `exemptSelector` (las muestras de la galería de temas) pintan temas ajenos
// al activo.

/** Los 148 colores con nombre de CSS Color 4 (en minúsculas), incluidos los alias `gray`/`grey`. */
export const NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
  "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse",
  "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta",
  "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
  "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey",
  "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush",
  "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow",
  "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen",
  "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow", "lime",
  "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid",
  "mediumpurple", "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise",
  "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite", "navy",
  "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
  "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum",
  "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown",
  "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue",
  "slategray", "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato",
  "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
]);

/** Palabras clave de color que no congelan nada: siguen al tema o al contexto. */
export const ALLOWED_COLOR_KEYWORDS = new Set([
  "transparent", "currentcolor", "inherit", "initial", "unset", "revert", "revert-layer", "none",
]);

/**
 * Diferencia máxima entre componentes (0–255) para considerar un `rgb()`
 * neutro: gris puro con un pelo de redondeo, nada que tiña.
 */
export const NEUTRAL_TOLERANCE = 8;

/**
 * Vacía los comentarios `/* … *\/` conservando los saltos de línea, para que
 * los números de línea de los hallazgos sigan siendo los de la hoja.
 * @param {string} css
 */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * Si un `rgb()` es neutro: sus componentes no se separan más de
 * {@link NEUTRAL_TOLERANCE}.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 */
export function isNeutralRgb(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b) <= NEUTRAL_TOLERANCE;
}

/**
 * Componentes `[r, g, b]` (0–255) de los argumentos de un `rgb()`/`rgba()`,
 * con comas o espacios y porcentajes; `null` si no se entienden (p. ej. un
 * `var()` dentro).
 * @param {string} args Lo que hay entre los paréntesis.
 * @returns {[number, number, number]|null}
 */
export function parseRgbArgs(args) {
  const parts = args.split("/")[0].trim().split(/\s*,\s*|\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const out = [];
  for (const part of parts.slice(0, 3)) {
    const m = /^(-?\d*\.?\d+)(%?)$/.exec(part);
    if (!m) return null;
    out.push(m[2] ? Number(m[1]) * 2.55 : Number(m[1]));
  }
  return /** @type {[number, number, number]} */ (out);
}

/**
 * Si un `hsl()`/`hsla()` es neutro: saturación 0. `null` si no se entiende.
 * @param {string} args
 * @returns {boolean|null}
 */
export function isNeutralHslArgs(args) {
  const parts = args.split("/")[0].trim().split(/\s*,\s*|\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const m = /^(-?\d*\.?\d+)%?$/.exec(parts[1]);
  if (!m) return null;
  return Number(m[1]) === 0;
}

/** @typedef {{ line: number, kind: string, value: string, text: string }} Finding */

/**
 * Hallazgos fuera del sistema de tokens de una hoja CSS.
 *
 * @param {string} css Texto de la hoja.
 * @param {object} [options]
 * @param {RegExp} [options.exemptSelector] Selectores cuyos colores describen un tema ajeno al activo.
 * @param {Iterable<string>} [options.runtimeVars] Variables que pone el código, no la hoja.
 * @param {number} [options.zLayerMin] `z-index` a partir del cual es una capa de la app.
 * @returns {Finding[]} Ordenados por línea.
 */
export function scanTokens(css, { exemptSelector = /^$/, runtimeVars = [], zLayerMin = 100 } = {}) {
  const clean = stripComments(css);
  const lines = clean.split("\n");
  const defined = new Set([...clean.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  const runtime = new Set(runtimeVars);
  /** @type {Finding[]} */
  const findings = [];

  let depth = 0;
  let selector = "";
  /** Declaración abierta cuyo valor sigue en la línea siguiente. */
  let open = /** @type {{ prop: string }|null} */ (null);

  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const line = raw.trim();
    if (!line) continue;

    let declarations = null;
    if (line.includes("{")) {
      const cut = line.lastIndexOf("{");
      // El selector de la regla que se abre: lo que hay entre la llave y la
      // anterior frontera (`{` o `}` de un bloque exterior en la misma línea).
      const head = line.slice(0, cut);
      selector = head.slice(Math.max(head.lastIndexOf("{"), head.lastIndexOf("}")) + 1).trim();
      declarations = line.slice(cut + 1);
      open = null;
    } else if (depth > 0) {
      declarations = line;
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    if (declarations == null) continue;

    declarations = declarations.replace(/}/g, " ");
    const exempt = exemptSelector.test(selector);
    const segments = declarations.split(";");
    const terminated = declarations.trimEnd().endsWith(";");

    segments.forEach((segment, i) => {
      const last = i === segments.length - 1;
      let prop;
      let value;
      if (open) {
        prop = open.prop;
        value = segment;
      } else {
        const colon = segment.indexOf(":");
        if (colon === -1) return;
        prop = segment.slice(0, colon).trim().toLowerCase();
        value = segment.slice(colon + 1);
      }
      // Última porción sin `;`: el valor sigue en la línea siguiente.
      open = last && !terminated && segment.trim() ? { prop } : null;
      if (!value.trim()) return;
      inspectDeclaration({ prop, value, lineNo, text: line, exempt, isToken: prop.startsWith("--") });
    });
  }

  /**
   * @param {{ prop: string, value: string, lineNo: number, text: string, exempt: boolean, isToken: boolean }} d
   */
  function inspectDeclaration({ prop, value, lineNo, text, exempt, isToken }) {
    const push = (kind, v, note = text) => findings.push({ line: lineNo, kind, value: v, text: note.slice(0, 100) });

    // `var(--x)` sin definición (también dentro de un token o de una muestra).
    for (const m of value.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
      if (!defined.has(m[1]) && !runtime.has(m[1])) push("undefined-var", m[1], "variable sin definir");
    }

    if (prop === "z-index") {
      const m = /^\s*(-?\d+)\s*(!important)?\s*$/.exec(value);
      if (m && Math.abs(Number(m[1])) >= zLayerMin) push("z-index", `z-index ${m[1]}`, "usa la escala var(--z-*) de :root");
    }

    if (prop === "transition" || prop === "transition-duration" || prop === "transition-property") {
      const body = value.replace(/var\([^)]*\)/g, " ");
      if (/(^|[\s,])all([\s,]|$)/.test(body)) push("transition", "transition: all", "enumera las propiedades que cambian");
      for (const m of body.matchAll(/(?<![\w.-])(\d*\.?\d+)(m?s)(?![\w-])/g)) {
        // Un cero o un cuasi-cero (`0.001ms`, el «apagado» de reducir movimiento) no es una duración de diseño.
        const ms = Number(m[1]) * (m[2] === "s" ? 1000 : 1);
        if (ms <= 1) continue;
        push("transition", m[1] + m[2], "usa var(--motion-fast|normal|slow)");
      }
    }

    if (isToken || exempt) return;

    for (const hex of value.match(/#[0-9a-fA-F]{3,8}\b/g) || []) push("hex", hex);

    for (const m of value.matchAll(/\b(rgba?|hsla?)\(([^()]*)\)/gi)) {
      const fn = m[1].toLowerCase();
      if (fn.startsWith("rgb")) {
        const rgb = parseRgbArgs(m[2]);
        if (rgb && !isNeutralRgb(...rgb)) push("rgb", m[0]);
      } else {
        const neutral = isNeutralHslArgs(m[2]);
        if (neutral === false) push("hsl", m[0]);
      }
    }

    const plain = value
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ")
      .replace(/url\([^)]*\)/gi, " ")
      .replace(/--[a-zA-Z0-9-]+/g, " ");
    for (const m of plain.matchAll(/(?<![\w.#@-])([a-zA-Z]+)(?![\w(-])/g)) {
      const word = m[1].toLowerCase();
      if (ALLOWED_COLOR_KEYWORDS.has(word) || !NAMED_COLORS.has(word)) continue;
      push("named", m[1]);
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}
