// @ts-check

/**
 * ¿Hay datos propios que combinar, además de los ajustes de una instalación?
 * Cambiar tema/idioma no convierte un equipo recién instalado en un catálogo.
 * @param {{items: Record<string, any>, tombstones?: Record<string, string>}} state
 */
export function hasLocalSyncData(state) {
  if (Object.keys(state.tombstones || {}).length) return true;
  if (Object.keys(state.items).some((key) => key !== "prefs:bundle" && !key.startsWith("device:"))) return true;
  const prefs = state.items["prefs:bundle"]?.data || {};
  return (prefs.workspaces || []).some((/** @type {any} */ w) => w.id !== "default" || w.name !== "Default")
    || (prefs.favorites || []).length > 0
    || (prefs.userFolders || []).length > 0
    || Object.values(prefs.userFoldersByWorkspace || {}).some((folders) => Array.isArray(folders) && folders.length > 0);
}

/**
 * En una recuperación inicial, solo se anuncia el equipo: sus ajustes no
 * compiten con lo que ya había en la nube, aunque tengan una fecha más reciente.
 * El backend lee el remoto al ejecutar, no una copia de la vista previa.
 * @param {{version: number, items: Record<string, any>, tombstones: Record<string, string>}} current
 * @param {string} mode
 */
export function firstSyncUpload(current, mode) {
  if (mode !== "download") return current;
  return {
    version: current.version,
    items: Object.fromEntries(Object.entries(current.items).filter(([key]) => key.startsWith("device:"))),
    tombstones: {},
  };
}
