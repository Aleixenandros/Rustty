// @ts-check
/**
 * Núcleo **puro** del formato de documento de tema (export/import JSON v2): la
 * lista de tokens válidos, el filtrado de tokens y la construcción/validación
 * del documento. No toca DOM ni estado; la unicidad del id y el reloj se
 * **inyectan** en {@link normalizeThemeDocument}.
 *
 * Primera pieza extraída del dominio `themes/` en el troceo de `main.js`; el
 * registro runtime (inyección de CSS vars, swatches, pickers) se queda en
 * `main.js` porque toca DOM.
 */

import { baseSlugifyThemeId } from "../text.js";

/** Versión del formato de tema exportable. Documentos con otra versión se rechazan. */
export const THEME_FORMAT_VERSION = 2;

/** Tokens de color de la interfaz (chrome) que un tema puede definir. */
export const UI_THEME_TOKENS = [
  "base", "mantle", "crust",
  "surface0", "surface1", "surface2",
  "overlay0", "overlay1",
  "text", "subtext0", "subtext1",
  "blue", "red", "green", "yellow",
  "mauve", "peach", "teal", "sky", "lavender",
];

/** Tokens de color del terminal (paleta ANSI + cursor/selección) de un tema. */
export const TERMINAL_THEME_TOKENS = [
  "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

/**
 * Copia de `source` **solo** los `keys` cuyo valor sea una cadena no vacía, ya
 * recortada. Descarta claves desconocidas, valores no string y vacíos. Devuelve
 * `{}` si `source` no es un objeto.
 * @param {unknown} source
 * @param {readonly string[]} keys
 * @returns {Record<string, string>}
 */
export function pickThemeTokens(source, keys) {
  if (!source || typeof source !== "object") return {};
  const out = /** @type {Record<string, string>} */ ({});
  const src = /** @type {Record<string, unknown>} */ (source);
  for (const key of keys) {
    const value = src[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * Documento de tema exportable (formato v2) a partir de sus partes, quedándose
 * solo con los tokens válidos. No valida —lo hace {@link normalizeThemeDocument}
 * al importar—.
 * @param {{ id: string, name: string, ui: unknown, terminal: unknown }} theme
 */
export function buildThemeDocument({ id, name, ui, terminal }) {
  return {
    formatVersion: THEME_FORMAT_VERSION,
    id,
    name,
    ui: pickThemeTokens(ui, UI_THEME_TOKENS),
    terminal: pickThemeTokens(terminal, TERMINAL_THEME_TOKENS),
  };
}

/**
 * Valida y normaliza un documento de tema importado (v2): comprueba versión,
 * nombre (obligatorio, recortado a 60), y presencia de los tokens mínimos
 * (`ui.base`, `ui.text`, `terminal.background`, `terminal.foreground`). Lanza un
 * `Error` con un código estable (`unsupported_theme_format`,
 * `theme_name_required`, `theme_required_tokens_missing`) que el llamador
 * traduce.
 *
 * El id se deriva con `slugify` (por defecto el slug puro; la app inyecta el que
 * garantiza unicidad frente a los temas existentes) y la marca de tiempo con
 * `now` (inyectable para los tests).
 * @param {any} data
 * @param {{ slugify?: (name: string) => string, now?: () => string }} [opts]
 */
export function normalizeThemeDocument(data, { slugify = baseSlugifyThemeId, now = () => new Date().toISOString() } = {}) {
  if (!data || data.formatVersion !== THEME_FORMAT_VERSION) {
    throw new Error("unsupported_theme_format");
  }
  const name = String(data.name || "").trim().slice(0, 60);
  if (!name) throw new Error("theme_name_required");

  const ui = pickThemeTokens(data.ui, UI_THEME_TOKENS);
  const terminal = pickThemeTokens(data.terminal, TERMINAL_THEME_TOKENS);
  if (!ui.base || !ui.text || !terminal.background || !terminal.foreground) {
    throw new Error("theme_required_tokens_missing");
  }

  return {
    formatVersion: THEME_FORMAT_VERSION,
    id: slugify(data.id || name),
    name,
    ui,
    terminal,
    updatedAt: now(),
  };
}
