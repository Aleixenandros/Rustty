// @ts-check

/**
 * Alcance de los buscadores de conexiones (barra lateral e inicio): el perfil
 * activo, uno concreto o todos.
 *
 * Se guarda en `prefs.searchScope` como `"current"`, `"all"` o
 * `"ws:<id del workspace>"`. Sustituye al antiguo `searchAllWorkspaces`
 * (booleano), que se sigue escribiendo para las versiones anteriores que
 * sincronizan con esta: `true` = todos, `false` = el activo.
 */

/** @typedef {"current"|"all"|`ws:${string}`} SearchScope */
/** @typedef {{ kind: "all" } | { kind: "workspace", id: string }} ResolvedScope */

const WS_PREFIX = "ws:";

/**
 * Valor válido del alcance. Sin valor propio, lo deduce del booleano antiguo.
 * @param {unknown} value
 * @param {unknown} [legacyAll] `searchAllWorkspaces` de versiones anteriores.
 * @returns {SearchScope}
 */
export function normalizeSearchScope(value, legacyAll) {
  if (value === "current" || value === "all") return value;
  if (typeof value === "string" && value.startsWith(WS_PREFIX) && value.length > WS_PREFIX.length) {
    return /** @type {SearchScope} */ (value);
  }
  return legacyAll === false ? "current" : "all";
}

/**
 * Alcance de un workspace concreto.
 * @param {string} workspaceId
 * @returns {SearchScope}
 */
export function workspaceScope(workspaceId) {
  return /** @type {SearchScope} */ (`${WS_PREFIX}${workspaceId}`);
}

/**
 * Traduce el alcance guardado al conjunto real: «actual» es el workspace
 * activo; un workspace que ya no existe (borrado, o de otro equipo aún sin
 * sincronizar) cae también al activo en vez de no encontrar nada.
 * @param {unknown} scope
 * @param {{ activeId: string, workspaceIds: string[] }} ctx
 * @returns {ResolvedScope}
 */
export function resolveSearchScope(scope, { activeId, workspaceIds }) {
  const value = normalizeSearchScope(scope);
  if (value === "all") return { kind: "all" };
  if (value.startsWith(WS_PREFIX)) {
    const id = value.slice(WS_PREFIX.length);
    if (workspaceIds.includes(id)) return { kind: "workspace", id };
  }
  return { kind: "workspace", id: activeId };
}

/**
 * @param {ResolvedScope} resolved
 * @param {string} workspaceId
 */
export function scopeIncludesWorkspace(resolved, workspaceId) {
  return resolved.kind === "all" || resolved.id === workspaceId;
}

/**
 * Opciones de los selectores de alcance: el perfil activo, todos y, debajo,
 * cada workspace por su nombre (el activo incluido, para que el valor
 * guardado «ws:<activo>» tenga dónde mostrarse).
 * @param {{ id: string, label: string }[]} workspaces
 * @param {{ current: string, all: string }} labels
 * @returns {{ value: SearchScope, label: string, group: "base"|"workspaces" }[]}
 */
export function searchScopeOptions(workspaces, labels) {
  /** @type {{ value: SearchScope, label: string, group: "base"|"workspaces" }[]} */
  const options = [
    { value: "current", label: labels.current, group: "base" },
    { value: "all", label: labels.all, group: "base" },
  ];
  // Con un solo workspace, elegirlo por nombre es lo mismo que «actual».
  if (workspaces.length > 1) {
    for (const ws of workspaces) options.push({ value: workspaceScope(ws.id), label: ws.label, group: "workspaces" });
  }
  return options;
}
