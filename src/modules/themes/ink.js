// @ts-check
/**
 * Tinta sobre rellenos de acento: el color del texto de un botón primario, un
 * aviso o el ítem resaltado de un menú. Hasta ahora era siempre `--crust`, que
 * en los temas oscuros es el tono más oscuro (buen contraste) pero en los
 * claros es casi blanco: «Guardar» quedaba a 3,7:1 y un aviso amarillo a 2:1.
 *
 * Núcleo puro (sin DOM): lo usan el registro de temas en runtime (bundle y
 * personalizados) y `scripts/check-contrast.mjs`, que comprueba cada par.
 */

/** Acentos que se usan como relleno con texto encima (`--on-<acento>`). */
export const INK_FILLS = Object.freeze(["blue", "green", "yellow", "red", "peach"]);

/** Contraste mínimo del texto sobre un relleno (WCAG AA, texto normal). */
export const INK_MIN_RATIO = 4.5;

/** Contraste mínimo del anillo de foco con el fondo (WCAG 1.4.11 y 2.4.11). */
export const RING_MIN_RATIO = 3;

/**
 * `#rgb` o `#rrggbb` → `[r, g, b]` (0–255), o `null` si no es un hex.
 * @param {unknown} value
 * @returns {[number, number, number]|null}
 */
export function parseHex(value) {
  if (typeof value !== "string") return null;
  let hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/**
 * Luminancia relativa WCAG 2.x.
 * @param {[number, number, number]} rgb
 */
function luminance([r, g, b]) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Ratio de contraste WCAG entre dos hex, o `null` si alguno no lo es.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number|null}
 */
export function contrastRatio(a, b) {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * La primera tinta candidata que alcanza el mínimo sobre `fill` (el orden
 * expresa la preferencia: conservar el aspecto del tema si ya se lee bien);
 * si ninguna llega, la de mayor contraste.
 *
 * @param {string} fill
 * @param {ReadonlyArray<string|undefined>} candidates
 * @returns {string|null}
 */
export function pickInk(fill, candidates) {
  /** @type {{ ink: string, ratio: number }|null} */
  let best = null;
  for (const ink of candidates) {
    if (!ink) continue;
    const ratio = contrastRatio(ink, fill);
    if (ratio == null) continue;
    if (ratio >= INK_MIN_RATIO) return ink;
    if (!best || ratio > best.ratio) best = { ink, ratio };
  }
  return best?.ink ?? null;
}

/**
 * Tintas de un tema a partir de su paleta de chrome. Candidatas, por orden:
 * `crust` (lo de siempre), `base`, `text` y, como último recurso, negro y
 * blanco puros (un acento de tono medio puede no admitir otra cosa).
 *
 * @param {Record<string, string|undefined>} ui Tokens del tema sin el `--` (`blue`, `crust`…).
 * @returns {Record<string, string>} `{ blue: "#…", … }` solo de los rellenos con hex válido.
 */
export function inkTokens(ui) {
  /** @type {Record<string, string>} */
  const out = {};
  const candidates = [ui.crust, ui.base, ui.text, "#000000", "#ffffff"];
  for (const fill of INK_FILLS) {
    const color = ui[fill];
    if (!parseHex(color)) continue;
    const ink = pickInk(/** @type {string} */ (color), candidates);
    if (ink) out[fill] = ink;
  }
  return out;
}

/**
 * Color del anillo de foco de un tema: el primer acento que se distingue
 * (3:1) del fondo de la ventana (`base`) y del de los paneles y modales
 * (`mantle`); si ninguno llega, el de más contraste con el peor de los dos.
 * Por orden: `blue` (el de siempre), `lavender`, `sky` y `text`.
 *
 * @param {Record<string, string|undefined>} ui
 * @returns {string|null}
 */
export function ringColor(ui) {
  const backs = [ui.base, ui.mantle ?? ui.base].filter((b) => parseHex(b));
  if (!backs.length) return null;
  /** @type {{ color: string, ratio: number }|null} */
  let best = null;
  for (const color of [ui.blue, ui.lavender, ui.sky, ui.text]) {
    if (!parseHex(color)) continue;
    const worst = Math.min(...backs.map((b) => contrastRatio(color, b) ?? 0));
    if (worst >= RING_MIN_RATIO) return /** @type {string} */ (color);
    if (!best || worst > best.ratio) best = { color: /** @type {string} */ (color), ratio: worst };
  }
  return best?.color ?? null;
}
