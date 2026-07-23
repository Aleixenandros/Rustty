// @ts-check
/**
 * Utilidades de texto puras (slugs, normalización) sin estado ni DOM.
 *
 * Parte del troceo de `main.js` (>23k líneas): funciones **puras** con tests
 * vitest, mismo patrón que `format`, `html`, `num`, etc.
 */

/**
 * Convierte un nombre en un identificador de tema estable estilo slug:
 * minúsculas, sin diacríticos (NFD + tira los combinantes `U+0300–U+036F`),
 * caracteres no `[a-z0-9]` colapsados a guiones y sin guiones sobrantes en los
 * extremos; recortado a 40 caracteres. Cae a `"custom"` si el nombre es vacío o
 * queda vacío tras normalizar.
 *
 * Es solo la parte **pura**: la unicidad frente a los temas existentes la añade
 * `uniqueThemeId` en `main.js`, que depende del estado de temas.
 * @param {string} name
 * @returns {string}
 */
export function baseSlugifyThemeId(name) {
  return (name || "custom").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 40) || "custom";
}
