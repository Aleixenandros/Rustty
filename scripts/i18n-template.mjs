// Lectura del tramo literal de una plantilla JS (`…${x}…`) para `check-i18n.mjs`.
//
// Una regex no basta: una interpolación puede llevar dentro cadenas, llaves y
// otras plantillas (`${ok ? `a` : "b"}`), y la primera comilla invertida que
// encontrara una regex sería la de la plantilla anidada, no la de cierre. Este
// analizador sigue los anidamientos y devuelve solo lo que la plantilla escribe
// por sí misma, que es lo que habría que traducir.

/**
 * Salta una cadena o plantilla que empieza en `src[i]` (su comilla) y devuelve
 * el índice siguiente a su cierre. Para plantillas, acumula en `parts` el texto
 * literal del nivel superior; cada interpolación cuenta como un espacio.
 * @param {string} src
 * @param {number} i
 * @param {string[] | null} parts
 * @returns {number}
 */
function skipString(src, i, parts) {
  const quote = src[i];
  let j = i + 1;
  if (quote !== "`") {
    while (j < src.length && src[j] !== quote && src[j] !== "\n") {
      j += src[j] === "\\" ? 2 : 1;
    }
    return j + 1;
  }
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      parts?.push(src.slice(j, j + 2));
      j += 2;
    } else if (c === "`") {
      return j + 1;
    } else if (c === "$" && src[j + 1] === "{") {
      parts?.push(" ");
      j = skipExpression(src, j + 2);
    } else {
      parts?.push(c);
      j += 1;
    }
  }
  return j;
}

/**
 * Salta una interpolación `${…}` desde justo después de su llave de apertura,
 * respetando llaves, cadenas y plantillas anidadas. Devuelve el índice
 * siguiente a la llave de cierre.
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function skipExpression(src, i) {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(src, j, null);
    } else if (c === "{") {
      depth += 1;
      j += 1;
    } else if (c === "}") {
      depth -= 1;
      j += 1;
      if (depth === 0) return j;
    } else {
      j += 1;
    }
  }
  return j;
}

/**
 * Cadenas y plantillas de una expresión que pueden acabar en pantalla: el
 * primer argumento de `toast(` o lo que se asigna a `.textContent`. Recorre la
 * expresión desde `start` hasta su fin (una `,`, `;` o el cierre de nivel 0) y
 * devuelve sus literales, salvo los que son argumento de `t(…)` (claves y
 * parámetros) y los que son un lado de una comparación (`x === "ok"`). Así se
 * ven las ramas de un ternario o de un `||`, que la regex de contexto no ve:
 * `toast(ok ? "Hecho" : "Falló")`.
 * @param {string} src
 * @param {number} start  Índice justo después de `toast(` o del `=`.
 * @returns {{ pos: number, text: string, template: boolean }[]}
 */
export function expressionLiterals(src, start) {
  /** @type {{ pos: number, text: string, template: boolean }[]} */
  const found = [];
  /** Por cada `(`/`[`/`{` abierto: ¿es la llamada `t(`? */
  /** @type {boolean[]} */
  const opened = [];
  let j = start;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, j, null);
      const inT = opened.includes(true);
      const compared =
        /(?:[=!]==?)\s*$/.test(src.slice(Math.max(start, j - 8), j)) ||
        /^\s*(?:[=!]==?)/.test(src.slice(end, end + 8));
      if (!inT && !compared) {
        const text = c === "`" ? templateLiteralText(src, j) : src.slice(j + 1, end - 1);
        found.push({ pos: j, text, template: c === "`" });
      }
      j = end;
    } else if (c === "/" && src[j + 1] === "/") {
      const nl = src.indexOf("\n", j);
      j = nl < 0 ? src.length : nl;
    } else if (c === "/" && src[j + 1] === "*") {
      const close = src.indexOf("*/", j + 2);
      j = close < 0 ? src.length : close + 2;
    } else if (c === "(" || c === "[" || c === "{") {
      opened.push(c === "(" && /(?:^|[^\w$.])t\s*$/.test(src.slice(Math.max(0, j - 8), j)));
      j += 1;
    } else if (c === ")" || c === "]" || c === "}") {
      if (!opened.length) break;
      opened.pop();
      j += 1;
    } else if ((c === "," || c === ";") && !opened.length) {
      break;
    } else {
      j += 1;
    }
  }
  return found;
}

/**
 * Tramo literal (sin lo interpolado y con los espacios colapsados) de la
 * plantilla cuya comilla de apertura está en `src[open]`.
 * @param {string} src
 * @param {number} open
 * @returns {string}
 */
export function templateLiteralText(src, open) {
  /** @type {string[]} */
  const parts = [];
  skipString(src, open, parts);
  return parts.join("").replace(/\s+/g, " ").trim();
}
