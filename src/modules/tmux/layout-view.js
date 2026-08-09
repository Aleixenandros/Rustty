// @ts-check
/**
 * Traducción **pura** del layout de tmux (payload `tmux-layout`, espejo de
 * `LayoutNode` del backend) al árbol de panes de `modules/panes/tree.js` y a
 * las medidas por pane (F4.1). Los tamaños vienen en celdas de terminal y los
 * dicta tmux: la UI acata, no negocia — los ratios solo reparten el espacio en
 * la misma proporción que las celdas.
 *
 * @typedef {object} TmuxLayoutNode
 * @property {number} width Ancho en celdas.
 * @property {number} height Alto en celdas.
 * @property {number} x Columna de origen.
 * @property {number} y Fila de origen.
 * @property {number} [pane] Id numérico de pane (hoja).
 * @property {"row"|"column"} [dir] Dirección del split (rama).
 * @property {TmuxLayoutNode[]} [children] Hijos del split (rama).
 */

import { normalizeTree } from "../panes/tree.js";

/**
 * Convierte el layout de tmux en un árbol de panes (`PaneNode`), con los ids
 * de hoja formados por `logicalId(pane)`. Los ratios salen del tamaño en
 * celdas de cada hijo sobre el eje del split. Devuelve `null` ante un nodo
 * ilegible (el llamador avisa, nunca pinta a ciegas).
 *
 * @param {TmuxLayoutNode|null|undefined} node
 * @param {(pane: number) => string} logicalId
 * @returns {import("../panes/tree.js").PaneNode|null}
 */
export function layoutToTree(node, logicalId) {
  const tree = convert(node, logicalId);
  return tree ? normalizeTree(tree) : null;
}

/**
 * @param {TmuxLayoutNode|null|undefined} node
 * @param {(pane: number) => string} logicalId
 * @returns {import("../panes/tree.js").PaneNode|null}
 */
function convert(node, logicalId) {
  if (!node || typeof node !== "object") return null;
  if (typeof node.pane === "number") {
    return { type: "leaf", id: logicalId(node.pane) };
  }
  if (!Array.isArray(node.children) || node.children.length === 0) return null;
  const dir = node.dir === "column" ? "column" : "row";
  const sizes = node.children.map((child) =>
    Math.max(1, dir === "row" ? child.width : child.height)
  );
  const total = sizes.reduce((a, b) => a + b, 0);
  const children = [];
  const ratios = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = convert(node.children[i], logicalId);
    if (!child) return null;
    children.push(child);
    ratios.push(sizes[i] / total);
  }
  if (children.length === 1) return children[0];
  return { type: "split", dir, ratios, children };
}

/**
 * Medidas en celdas de cada pane del layout: el tamaño que hay que fijar en
 * su xterm (`terminal.resize(cols, rows)`).
 *
 * @param {TmuxLayoutNode|null|undefined} node
 * @returns {Map<number, { cols: number, rows: number }>}
 */
export function paneDims(node) {
  /** @type {Map<number, { cols: number, rows: number }>} */
  const dims = new Map();
  walk(node, dims);
  return dims;
}

/**
 * @param {TmuxLayoutNode|null|undefined} node
 * @param {Map<number, { cols: number, rows: number }>} dims
 */
function walk(node, dims) {
  if (!node || typeof node !== "object") return;
  if (typeof node.pane === "number") {
    dims.set(node.pane, {
      cols: Math.max(1, node.width),
      rows: Math.max(1, node.height),
    });
    return;
  }
  for (const child of node.children || []) walk(child, dims);
}

/**
 * Tamaño total de la ventana según el layout (celdas). Para detectar que otro
 * cliente más pequeño está mandando sobre la sesión (F6.2): si el layout es
 * claramente menor que el tamaño que declaramos, alguien más está attachado.
 *
 * @param {TmuxLayoutNode|null|undefined} node
 * @returns {{ cols: number, rows: number }|null}
 */
export function layoutSize(node) {
  if (!node || typeof node !== "object" || typeof node.width !== "number") return null;
  return { cols: node.width, rows: node.height };
}
