// @ts-check
/**
 * Tono de un tema —claro u oscuro— como **dato**, no como lista de nombres.
 *
 * Hasta ahora «tema claro» era `html.theme-light` o `html.theme-solarized-light`
 * en la hoja: los 221 temas del bundle y los personalizados heredaban las
 * sombras negras del tema oscuro, y ningún tema declaraba `color-scheme`, así
 * que WebKit pintaba en esquema claro los controles nativos (casillas, barras
 * de desplazamiento del sistema, el aspa de `input[type=search]`) sobre un
 * tema oscuro. Aquí se decide el tono midiendo los colores del tema; de
 * `html[data-tone]` cuelgan en la hoja `color-scheme`, las sombras suaves y el
 * resto de ajustes por tono.
 *
 * Núcleo puro (sin DOM): lo usan `applyTheme()` en `main.js` (sobre los tokens
 * ya aplicados al `<html>`), `scripts/check-contrast.mjs` (informe) y, por
 * copia mínima, `public/boot.js` (script clásico sin módulos: solo la
 * expresión por id, comprobada igual en el test).
 */

import { parseHex } from "./ink.js";

/**
 * Ids de tema que anuncian tono claro. Es el **recurso de reserva**: en el
 * arranque (`boot.js`) aún no hay CSS de temas ni JSON que medir, y vale para
 * un tema del que no se guardó el tono (primer arranque, tema elegido en otro
 * equipo). No pretende ser exhaustivo: los temas claros sin pista en el id
 * (p. ej. `papercolor`) se pintan bien en cuanto `main.js` mide el color; lo
 * que sí exige el test es que ningún tema oscuro del bundle case con ella.
 * COPIA en `public/boot.js` (`LIGHT_THEME_ID`): un test comprueba que siguen
 * siendo la misma expresión.
 */
export const LIGHT_THEME_ID = /light|latte|day|dawn|lotus/;

/**
 * Ids (o nombres) de tema de alto contraste. Depende de la intención del
 * autor del tema, no de un umbral de luminancia, así que se lee del id.
 */
export const HIGH_CONTRAST_THEME_ID = /(^|-)hc($|-)|high[-_ ]?contrast|alto[-_ ]?contraste/;

/**
 * Luminancia relativa en la que el negro y el blanco contrastan igual con el
 * fondo (WCAG: (L + 0,05) / 0,05 = 1,05 / (L + 0,05) → L ≈ 0,179). Por encima,
 * el texto oscuro lee mejor: tono claro.
 */
export const TONE_LUMINANCE_SPLIT = 0.1791;

/**
 * `#rgb`, `#rrggbb`, `rgb(r, g, b)`, `rgba(r, g, b, a)` o `rgb(r g b / a)` →
 * `[r, g, b]` en 0–255, o `null` si no es ninguno de esos (p. ej. `var(--x)`).
 * Cubre lo que devuelve `getComputedStyle` y lo que escriben los temas.
 * @param {unknown} value
 * @returns {[number, number, number]|null}
 */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const hex = parseHex(text);
  if (hex) return hex;
  const m = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(text);
  if (!m) return null;
  const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (rgb.some((c) => c > 255)) return null;
  return /** @type {[number, number, number]} */ (rgb);
}

/**
 * Luminancia relativa WCAG 2.x (0 negro – 1 blanco).
 * @param {[number, number, number]} rgb
 */
export function relativeLuminance([r, g, b]) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Luminancia de un color CSS, o `NaN` si no se puede leer.
 * @param {unknown} color
 */
export function colorLuminance(color) {
  const rgb = parseColor(color);
  return rgb ? relativeLuminance(rgb) : NaN;
}

/**
 * Tono por el id del tema, sin medir nada (reserva para cuando no hay color).
 * @param {unknown} themeId
 * @returns {"light"|"dark"}
 */
export function toneForId(themeId) {
  return LIGHT_THEME_ID.test(String(themeId ?? "").toLowerCase()) ? "light" : "dark";
}

/**
 * Si el id o el nombre del tema anuncian alto contraste.
 * @param {unknown} idOrName
 */
export function isHighContrastThemeId(idOrName) {
  return HIGH_CONTRAST_THEME_ID.test(String(idOrName ?? "").toLowerCase());
}

/**
 * Tono de un tema a partir de su fondo (`--base`) y, si se conoce, de su texto
 * (`--text`):
 *
 * - Con los dos colores, manda su relación: texto más oscuro que el fondo es
 *   un tema claro. Es lo que distingue un fondo de tono medio con texto blanco
 *   (oscuro) de uno rosa con texto negro (claro): la luminancia del fondo sola
 *   no lo sabe.
 * - Solo con el fondo, el umbral {@link TONE_LUMINANCE_SPLIT}.
 * - Sin color legible, el id ({@link toneForId}).
 *
 * @param {unknown} baseColor Valor de `--base` (hex o `rgb()`).
 * @param {unknown} themeId Id efectivo del tema (`light`, `dracula`, `github-light`…).
 * @param {unknown} [textColor] Valor de `--text`, si se conoce.
 * @returns {"light"|"dark"}
 */
export function toneFor(baseColor, themeId, textColor) {
  const base = colorLuminance(baseColor);
  if (Number.isNaN(base)) return toneForId(themeId);
  const text = colorLuminance(textColor);
  if (!Number.isNaN(text)) return text < base ? "light" : "dark";
  return base > TONE_LUMINANCE_SPLIT ? "light" : "dark";
}
