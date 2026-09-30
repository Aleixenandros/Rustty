// @ts-check

// Una sola lista para construir el bundle y fechar las ediciones del formulario.
export const SYNCED_PREF_KEYS = [
  "theme", "terminalTheme", "copyOnSelect", "rightClickPaste",
  "fontFamily", "fontSize", "lineHeight", "letterSpacing",
  "cursorStyle", "cursorBlink", "scrollback", "bell", "lang",
  "userFolders", "userFoldersByWorkspace",
  "workspaces", "favorites", "searchAllWorkspaces",
  "folderColors", "workspaceColors", "highlightRules",
];

/**
 * Aplica solo las ediciones hechas en el formulario desde que se abrió.
 * Los controles sin tocar pueden estar desfasados por una sincronización:
 * se conserva el valor vivo, incluidos sus metadatos y campos ajenos al modal.
 * Guardar la configuración de Drive o un ajuste local no fecha el bundle.
 * Se muta el mismo objeto para que una sync en vuelo siga viendo las ediciones.
 * @param {Record<string, any>} prefs
 * @param {Record<string, any>} initial Valores leídos del formulario al abrir.
 * @param {Record<string, any>} edited Valores leídos al guardar.
 * @param {string} [now]
 */
export function applyPrefsForm(prefs, initial, edited, now = new Date().toISOString()) {
  let syncedChanged = false;
  for (const [key, value] of Object.entries(edited)) {
    if (JSON.stringify(value) === JSON.stringify(initial[key])) continue;
    prefs[key] = value;
    // La tipografía y el tema del terminal pueden estar ya en prefs por el
    // preview: comparar con el formulario inicial, no con ese valor temporal.
    if (SYNCED_PREF_KEYS.includes(key)) syncedChanged = true;
  }
  if (syncedChanged) prefs._prefsUpdatedAt = now;
}
