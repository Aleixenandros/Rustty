// @ts-check
import { createDefaultPrefs } from "./defaults.js";
import { normalizePrefs } from "./normalize.js";
import { defaultHighlightRules } from "../terminal/highlight.js";

const PREFS_KEY = "rustty-prefs";

/**
 * Carga y migra las preferencias sin escribir ni fechar cambios de usuario.
 * Las dependencias de idioma y colores llegan del entorno; aquí no hay DOM.
 * @param {Pick<Storage, "getItem">} storage
 * @param {object} deps
 * @param {(prefs: any) => void} [deps.migrateFolderColors]
 * @param {(prefs: any) => void} [deps.normalizeWorkspaceColors]
 * @param {string[]} deps.supportedLangs
 * @param {() => string} deps.detectLanguage
 * @returns {Record<string, any>}
 */
export function loadPrefs(storage, deps) {
  let stored = null;
  try {
    const parsed = JSON.parse(storage.getItem(PREFS_KEY) || "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
    // Mantener el arranque posible aunque el almacenamiento no esté disponible.
  }
  const prefs = { ...createDefaultPrefs(), ...stored };
  return normalizePrefs(prefs, stored, {
    ...deps,
    defaultHighlightRules,
    migrateFolderColors: () => deps.migrateFolderColors?.(prefs),
    normalizeWorkspaceColors: () => deps.normalizeWorkspaceColors?.(prefs),
  });
}

/**
 * Persiste el objeto completo: los metadatos de sync también deben sobrevivir.
 * Los efectos en la UI y el índice de la CLI pertenecen al llamador.
 * @param {Pick<Storage, "setItem">} storage
 * @param {Record<string, any>} prefs
 */
export function savePrefs(storage, prefs) {
  storage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
