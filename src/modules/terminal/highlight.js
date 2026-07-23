// @ts-check
/**
 * Núcleo **puro** del resaltado de la salida del terminal por reglas: la lista
 * de reglas por defecto, el mapa de colores a códigos SGR, y la compilación y
 * aplicación de reglas. No toca DOM ni estado; la **caché** por snapshot (que
 * lee `prefs.highlightRules`) se queda en `main.js`, sobre estas funciones.
 *
 * Primera pieza extraída del dominio `terminal/` en el troceo de `main.js`.
 */

/** Reglas de resaltado por defecto (niveles de log habituales). */
export const DEFAULT_HIGHLIGHT_RULES = [
  { pattern: "ERROR|ERR|FATAL|FAIL|FAILED|EXCEPTION", color: "red", bold: true },
  { pattern: "WARN|WARNING|DEPRECATED", color: "yellow", bold: true },
  { pattern: "INFO|NOTICE", color: "cyan", bold: false },
  { pattern: "SUCCESS|OK|DONE", color: "green", bold: false },
  { pattern: "DEBUG|TRACE", color: "magenta", bold: false },
];

/**
 * Nombre de color de una regla → código de color SGR (foreground brillante).
 * @type {Record<string, string>}
 */
export const HIGHLIGHT_COLORS = {
  red:     "91",
  yellow:  "93",
  green:   "92",
  blue:    "94",
  magenta: "95",
  cyan:    "96",
  white:   "97",
};

/**
 * Copia profunda de las reglas por defecto (objetos nuevos), para no compartir
 * referencias con la constante al sembrar `prefs.highlightRules`.
 * @returns {Array<{ pattern: string, color: string, bold: boolean }>}
 */
export function defaultHighlightRules() {
  return DEFAULT_HIGHLIGHT_RULES.map((rule) => ({ ...rule }));
}

/**
 * @typedef {{ re: RegExp, prefix: string, suffix: string }} CompiledHighlightRule
 */

/**
 * Compila reglas (`{pattern, color, bold}`) a `{re, prefix, suffix}` listos para
 * aplicar. Colores desconocidos caen a amarillo; reglas sin patrón o con un
 * patrón de regex inválido se **ignoran** en silencio (no rompen el resaltado).
 * @param {Array<{ pattern?: string, color?: string, bold?: boolean }>} rules
 * @returns {CompiledHighlightRule[]}
 */
export function compileHighlightRules(rules) {
  const compiled = [];
  for (const rule of rules) {
    if (!rule?.pattern) continue;
    const color = (rule.color && HIGHLIGHT_COLORS[rule.color]) || HIGHLIGHT_COLORS.yellow;
    const bold = rule.bold ? "1;" : "";
    try {
      compiled.push({
        re: new RegExp(rule.pattern, "g"),
        prefix: `\x1b[${bold}${color}m`,
        suffix: "\x1b[0m",
      });
    } catch {
      // patrón inválido → ignorar la regla
    }
  }
  return compiled;
}

/**
 * Envuelve cada coincidencia de las reglas ya compiladas con sus códigos SGR.
 * Se aplica por chunk (no por línea): una coincidencia que cruce un límite de
 * chunk no se resalta —limitación aceptable para reglas típicas (`ERROR`,
 * `WARN`, IPs…)—. Si no hay reglas, devuelve el texto tal cual.
 * @param {string} text
 * @param {CompiledHighlightRule[]} compiled
 * @returns {string}
 */
export function applyHighlightRules(text, compiled) {
  if (!compiled.length) return text;
  let out = text;
  for (const r of compiled) {
    out = out.replace(r.re, (m) => `${r.prefix}${m}${r.suffix}`);
  }
  return out;
}
