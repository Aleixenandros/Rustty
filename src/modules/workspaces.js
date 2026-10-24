// @ts-check
/**
 * Reglas puras de los workspaces de la barra lateral (lista `{id, name}` de
 * las prefs). Sin DOM ni estado global: `main.js` decide cuándo persistir y
 * si una operación fecha el bundle de sync.
 */

/**
 * Workspace activo válido: el pedido si sigue en la lista; si no (otro equipo
 * lo borró), el primero. Elegirlo es navegación local: nunca fecha el bundle.
 * @param {any} workspaces
 * @param {unknown} activeId
 * @returns {string}
 */
export function resolveActiveWorkspaceId(workspaces, activeId) {
  const list = Array.isArray(workspaces) ? workspaces : [];
  if (typeof activeId === "string" && list.some((w) => w?.id === activeId)) return activeId;
  return typeof list[0]?.id === "string" && list[0].id ? list[0].id : "default";
}

/**
 * Nombres `{id → name}` de una lista de workspaces que viene de fuera (un
 * fichero exportado, la papelera): solo entradas con id y nombre de texto.
 * @param {unknown} list
 * @returns {Map<string, string>}
 */
export function workspaceNameMap(list) {
  const names = new Map();
  if (!Array.isArray(list)) return names;
  for (const w of list) {
    const id = typeof w?.id === "string" ? w.id.trim() : "";
    const name = typeof w?.name === "string" ? w.name.trim() : "";
    if (id && name && !names.has(id)) names.set(id, name);
  }
  return names;
}

/**
 * Workspaces que nombra un export de conexiones (los de sus perfiles y los de
 * sus carpetas), para que el equipo que lo importe no los llame «Workspace N».
 * @param {any} workspaces Lista de las prefs.
 * @param {any[]} profiles Perfiles exportados.
 * @param {Record<string, unknown>|null} [foldersByWorkspace]
 * @returns {{id: string, name: string}[]}
 */
export function workspacesForExport(workspaces, profiles, foldersByWorkspace = null) {
  const used = new Set((profiles || []).map((p) => p?.workspace_id || "default"));
  for (const wsId of Object.keys(foldersByWorkspace || {})) used.add(wsId);
  return (Array.isArray(workspaces) ? workspaces : [])
    .filter((w) => used.has(w?.id))
    .map((w) => ({ id: String(w.id), name: String(w.name ?? "") }));
}
