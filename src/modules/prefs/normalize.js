// @ts-check
/**
 * Normalización y migraciones **puras** de las preferencias al cargarlas.
 *
 * Núcleo extraído de `loadPrefs()` (troceo de `main.js`): recibe el objeto de
 * prefs ya mezclado con los defaults y lo deja consistente — workspaces,
 * migración de carpetas legacy a por-workspace, listas saneadas, siembra de
 * reglas de highlight e idioma válido. Sin DOM ni localStorage: lo que
 * dependía del entorno llega inyectado en `deps`, y el ORDEN de pasos es el
 * histórico de `loadPrefs` (las migraciones de colores corren entre el saneo
 * de workspaces y el de carpetas, como siempre).
 *
 * OJO (trampa de sync ya corregida una vez): aquí NUNCA se toca
 * `_prefsUpdatedAt`. Inicializar defaults no es una edición del usuario; si lo
 * fuera, un equipo nuevo pisaría los workspaces remotos (ver memoria).
 *
 * @param {any} prefs Objeto de prefs a sanear (se muta y se devuelve).
 * @param {any} stored Lo leído de localStorage tal cual (o null), para las
 *   migraciones que necesitan distinguir «no existía» de «vacío».
 * @param {object} deps
 * @param {() => void} [deps.migrateFolderColors] Migración de colores legacy.
 * @param {() => void} [deps.normalizeWorkspaceColors] Saneo del mapa de colores.
 * @param {() => any[]} deps.defaultHighlightRules Reglas de highlight de fábrica.
 * @param {string[]} deps.supportedLangs Idiomas soportados.
 * @param {() => string} deps.detectLanguage Idioma del sistema como fallback.
 * @returns {any} El mismo objeto `prefs`, ya saneado.
 */
export function normalizePrefs(prefs, stored, deps) {
  const {
    migrateFolderColors = () => {},
    normalizeWorkspaceColors = () => {},
    defaultHighlightRules,
    supportedLangs,
    detectLanguage,
  } = deps;

  if (!Array.isArray(prefs.workspaces) || prefs.workspaces.length === 0) {
    prefs.workspaces = [{ id: "default", name: "Default" }];
  }
  if (!prefs.workspaces.some((/** @type {any} */ w) => w.id === prefs.activeWorkspaceId)) {
    prefs.activeWorkspaceId = prefs.workspaces[0].id;
  }
  migrateFolderColors();
  normalizeWorkspaceColors();

  // Migración de carpetas globales → por workspace.
  if (!prefs.userFoldersByWorkspace || typeof prefs.userFoldersByWorkspace !== "object") {
    prefs.userFoldersByWorkspace = {};
  }
  const legacy = stored && Array.isArray(stored.userFolders)
    ? stored.userFolders.filter((/** @type {unknown} */ f) => typeof f === "string" && f.trim())
    : [];
  if (legacy.length && !prefs.userFoldersByWorkspace[prefs.activeWorkspaceId]) {
    prefs.userFoldersByWorkspace[prefs.activeWorkspaceId] = [...legacy];
  }
  prefs.userFolders = []; // legacy vacío tras migración
  for (const w of prefs.workspaces) {
    if (!Array.isArray(prefs.userFoldersByWorkspace[w.id])) {
      prefs.userFoldersByWorkspace[w.id] = [];
    }
  }

  if (!Array.isArray(prefs.favorites)) prefs.favorites = [];
  if (!["current", "all", "favorites"].includes(prefs.sidebarViewMode)) {
    prefs.sidebarViewMode = "current";
  }
  prefs.searchAllWorkspaces = prefs.searchAllWorkspaces !== false;
  prefs.sidebarCompact = Boolean(prefs.sidebarCompact);
  if (typeof prefs.foldersFirst !== "boolean") prefs.foldersFirst = true;

  if (!Array.isArray(prefs.highlightRules)) {
    prefs.highlightRules = defaultHighlightRules();
  }
  if (stored && !stored._highlightRulesSeeded && prefs.highlightRules.length === 0) {
    prefs.highlightRules = defaultHighlightRules();
  }
  prefs._highlightRulesSeeded = true;

  if (!prefs.lang || !supportedLangs.includes(prefs.lang)) {
    prefs.lang = detectLanguage();
  }
  return prefs;
}
