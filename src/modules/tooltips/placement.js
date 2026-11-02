// @ts-check

/**
 * Núcleo puro de los tooltips propios de Rustty: qué texto enseñar para un
 * elemento y dónde colocar la burbuja sin salirse de la ventana.
 *
 * Existen porque el `title` nativo no aparece en el webview de Linux
 * (WebKitGTK con la ventana sin decoraciones): en Linux ningún icono decía qué
 * era hasta pulsarlo. El controlador DOM (`controller.js`) usa esto para pintar
 * una única burbuja en `<body>`, igual en las tres plataformas.
 */

/** Roles que se comportan como un botón: su `aria-label` es lo que hacen. */
const BUTTON_LIKE_ROLES = new Set(["button", "tab", "link", "menuitem", "switch", "checkbox", "radio", "option"]);
const BUTTON_LIKE_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);

/**
 * @typedef {object} TooltipSource
 * @property {string|null} [tooltip] Valor de `data-tooltip`.
 * @property {string|null} [title] Valor del atributo `title`.
 * @property {string|null} [ariaLabel] Valor de `aria-label`.
 * @property {string} [tagName] En mayúsculas, como `Element.tagName`.
 * @property {string|null} [role]
 * @property {string} [visibleText] Texto visible del elemento (recortado).
 * @property {boolean} [optOut] `data-no-tooltip`.
 */

/**
 * Texto del tooltip de un elemento, o `null` si no debe llevar.
 *
 * Orden: `data-tooltip` (el que la app compone a propósito), `title` y, solo en
 * controles de solo icono, su `aria-label`: un botón con texto ya se explica.
 * @param {TooltipSource} src
 * @returns {string|null}
 */
export function tooltipTextFor(src) {
  if (src.optOut) return null;
  const tooltip = clean(src.tooltip);
  if (tooltip) return tooltip;
  const title = clean(src.title);
  if (title) return title;
  const label = clean(src.ariaLabel);
  if (!label) return null;
  const buttonLike = BUTTON_LIKE_TAGS.has(String(src.tagName || "").toUpperCase())
    || BUTTON_LIKE_ROLES.has(String(src.role || "").toLowerCase());
  if (!buttonLike) return null;
  const visible = clean(src.visibleText);
  // Con texto visible el botón ya dice lo que hace; repetirlo en una burbuja
  // solo estorba. Si el texto es otra cosa (un contador, un valor), la
  // etiqueta sí aporta.
  if (visible && (visible === label || label.startsWith(visible))) return null;
  if (visible && visible.length > 3) return null;
  return label;
}

/** @param {string|null|undefined} value */
function clean(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Box
 * @typedef {"top"|"bottom"|"left"|"right"} Side
 */

/** Lado contrario, para darle la vuelta si el preferido no cabe. */
const OPPOSITE = /** @type {Record<Side, Side>} */ ({ top: "bottom", bottom: "top", left: "right", right: "left" });

/**
 * Coloca la burbuja junto al elemento: en el lado preferido si cabe, si no en
 * el contrario y, si tampoco, en el que más sitio tenga; siempre dentro de la
 * ventana con un margen.
 * @param {object} args
 * @param {Box} args.anchor Rectángulo del elemento (coordenadas de la ventana).
 * @param {{ width: number, height: number }} args.tip Tamaño de la burbuja.
 * @param {{ width: number, height: number }} args.viewport
 * @param {Side} [args.prefer]
 * @param {number} [args.gap] Separación con el elemento.
 * @param {number} [args.margin] Margen mínimo con el borde de la ventana.
 * @returns {{ left: number, top: number, side: Side }}
 */
export function placeTooltip({ anchor, tip, viewport, prefer = "top", gap = 6, margin = 6 }) {
  const room = {
    top: anchor.top - margin - gap,
    bottom: viewport.height - anchor.bottom - margin - gap,
    left: anchor.left - margin - gap,
    right: viewport.width - anchor.right - margin - gap,
  };
  const need = (/** @type {Side} */ side) => (side === "top" || side === "bottom" ? tip.height : tip.width);
  /** @type {Side} */
  let side = prefer;
  if (room[side] < need(side)) {
    const flipped = OPPOSITE[side];
    if (room[flipped] >= need(flipped)) side = flipped;
    else {
      side = /** @type {Side[]} */ (["top", "bottom", "right", "left"])
        .reduce((best, s) => (room[s] - need(s) > room[best] - need(best) ? s : best), side);
    }
  }
  const centerX = (anchor.left + anchor.right) / 2;
  const centerY = (anchor.top + anchor.bottom) / 2;
  let left;
  let top;
  if (side === "top" || side === "bottom") {
    left = centerX - tip.width / 2;
    top = side === "top" ? anchor.top - gap - tip.height : anchor.bottom + gap;
  } else {
    top = centerY - tip.height / 2;
    left = side === "left" ? anchor.left - gap - tip.width : anchor.right + gap;
  }
  const maxLeft = Math.max(margin, viewport.width - margin - tip.width);
  const maxTop = Math.max(margin, viewport.height - margin - tip.height);
  return {
    left: Math.round(Math.min(Math.max(left, margin), maxLeft)),
    top: Math.round(Math.min(Math.max(top, margin), maxTop)),
    side,
  };
}

/**
 * Lado preferido según `data-tooltip-pos` (el que ya usaban el rail y la
 * topbar con los tooltips de CSS). Cualquier otro valor, arriba.
 * @param {string|null|undefined} value
 * @returns {Side}
 */
export function preferredSide(value) {
  return value === "bottom" || value === "left" || value === "right" ? value : "top";
}
