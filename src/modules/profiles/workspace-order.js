// @ts-check

/**
 * Orden de los perfiles-contenedor (workspaces). El orden es el del array
 * `prefs.workspaces`: así lo pintan el selector, la vista «Todos», la bandeja
 * y los selectores de alcance, y así viaja en la sincronización. Estas
 * funciones devuelven un array nuevo y no tocan los objetos.
 */

/**
 * @template {{ id: string }} W
 * @param {W[]} workspaces
 * @param {string} id
 * @param {number} delta -1 sube, +1 baja.
 * @returns {W[]} El mismo array si no hay nada que mover.
 */
export function moveWorkspace(workspaces, id, delta) {
  const from = workspaces.findIndex((w) => w.id === id);
  const to = from + delta;
  if (from < 0 || !delta || to < 0 || to >= workspaces.length) return workspaces;
  const next = workspaces.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Coloca un workspace antes o después de otro (arrastrar y soltar).
 * @template {{ id: string }} W
 * @param {W[]} workspaces
 * @param {string} id
 * @param {string} targetId
 * @param {"before"|"after"} place
 * @returns {W[]} El mismo array si no cambia nada.
 */
export function moveWorkspaceTo(workspaces, id, targetId, place) {
  if (id === targetId) return workspaces;
  const item = workspaces.find((w) => w.id === id);
  if (!item || !workspaces.some((w) => w.id === targetId)) return workspaces;
  const rest = workspaces.filter((w) => w.id !== id);
  const at = rest.findIndex((w) => w.id === targetId) + (place === "after" ? 1 : 0);
  rest.splice(at, 0, item);
  return rest.every((w, i) => w === workspaces[i]) ? workspaces : rest;
}

/**
 * Qué movimientos admite un workspace en su posición actual.
 * @param {{ id: string }[]} workspaces
 * @param {string} id
 */
export function workspaceMoves(workspaces, id) {
  const index = workspaces.findIndex((w) => w.id === id);
  return { up: index > 0, down: index >= 0 && index < workspaces.length - 1 };
}
