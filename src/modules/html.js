// @ts-check
/**
 * Utilidades puras de HTML para construir marcado seguro por interpolación.
 *
 * Parte del troceo de `main.js` (>23k líneas): funciones **puras** sin estado ni
 * DOM, sacadas a `src/modules/` con tests vitest. Mismo patrón que `format`,
 * `subst`, `markdown`, etc.
 */

/**
 * Escapa un valor para interpolarlo con seguridad en una plantilla HTML
 * (`innerHTML`, template strings). Neutraliza los cuatro caracteres que pueden
 * romper el marcado o inyectar nodos/atributos: `&`, `<`, `>` y `"`. El `&` va
 * primero para no re-escapar las entidades que introducen los demás.
 *
 * No escapa la comilla simple: los atributos de la app se entrecomillan siempre
 * con comillas dobles. Basta para el marcado que se genera aquí, no pretende ser
 * un sanitizador general.
 * @param {unknown} str
 * @returns {string}
 */
export function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
