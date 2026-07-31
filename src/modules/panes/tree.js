// @ts-check
/**
 * Árbol de panes **puro** (F0.1 del plan de multiplexado): el modelo que
 * sustituirá al layout plano de splits y donde volcará `%layout-change` el
 * modo control de tmux. Sin DOM ni estado: transformaciones inmutables con
 * compartición estructural, listas para persistir (JSON plano).
 *
 * Convención de dirección como en CSS flex: `"row"` = hojas lado a lado
 * (el `{…}` / LEFTRIGHT de tmux), `"column"` = una encima de otra (el `[…]` /
 * TOPBOTTOM). Los `ratios` son fracciones que suman 1, paralelas a `children`.
 *
 * Invariantes que mantienen los helpers: un split tiene siempre ≥ 2 hijos
 * (con uno solo colapsa a ese hijo), y nunca queda un split anidado con la
 * misma dirección que su padre (se fusiona repartiendo su ratio).
 */

/** @typedef {{ type: "leaf", id: string }} PaneLeaf */
/** @typedef {{ type: "split", dir: "row" | "column", ratios: number[], children: PaneNode[] }} PaneSplit */
/** @typedef {PaneLeaf | PaneSplit} PaneNode */

/**
 * Hoja nueva (una sesión lógica).
 * @param {string} id
 * @returns {PaneLeaf}
 */
export function leaf(id) {
  return { type: "leaf", id };
}

/**
 * Ids de las hojas en orden de lectura (izquierda→derecha, arriba→abajo).
 * @param {PaneNode | null} root
 * @returns {string[]}
 */
export function leafIds(root) {
  if (!root) return [];
  if (root.type === "leaf") return [root.id];
  return root.children.flatMap(leafIds);
}

/**
 * Ratios saneados: exactamente `count` números finitos y positivos,
 * reescalados para sumar 1. Cualquier entrada inválida cae al reparto
 * uniforme (predecible; nunca una pane de tamaño 0).
 * @param {number[] | undefined} list
 * @param {number} count
 * @returns {number[]}
 */
export function normalizeRatios(list, count) {
  if (count <= 0) return [];
  const valid =
    Array.isArray(list) &&
    list.length === count &&
    list.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (!valid) return new Array(count).fill(1 / count);
  const src = /** @type {number[]} */ (list);
  const sum = src.reduce((a, b) => a + b, 0);
  return src.map((v) => v / sum);
}

/**
 * Divide la hoja `targetId` en dirección `dir`, colocando la hoja nueva
 * `newId` a su derecha/debajo. Si el split padre ya va en esa dirección, la
 * hoja nueva entra como hermana (repartiendo el ratio de la original) en vez
 * de anidar un split redundante. Id inexistente → árbol sin cambios.
 * @param {PaneNode | null} root
 * @param {string} targetId
 * @param {"row" | "column"} dir
 * @param {string} newId
 * @returns {PaneNode | null}
 */
export function splitLeaf(root, targetId, dir, newId) {
  if (!root) return root;
  return splitNode(root, targetId, dir, newId) ?? root;
}

/**
 * @param {PaneNode} node
 * @param {string} targetId
 * @param {"row" | "column"} dir
 * @param {string} newId
 * @returns {PaneNode | null} árbol nuevo, o `null` si la hoja no está aquí
 */
function splitNode(node, targetId, dir, newId) {
  if (node.type === "leaf") {
    if (node.id !== targetId) return null;
    return { type: "split", dir, ratios: [0.5, 0.5], children: [node, leaf(newId)] };
  }
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === "leaf" && child.id === targetId && node.dir === dir) {
      const ratios = node.ratios.slice();
      const half = ratios[i] / 2;
      ratios.splice(i, 1, half, half);
      const children = node.children.slice();
      children.splice(i + 1, 0, leaf(newId));
      return { ...node, ratios, children };
    }
    const replaced = splitNode(child, targetId, dir, newId);
    if (replaced) {
      const children = node.children.slice();
      children[i] = replaced;
      return { ...node, children };
    }
  }
  return null;
}

/**
 * Quita la hoja `id`. Un split que queda con un solo hijo colapsa a ese hijo,
 * y si el hijo colapsado es un split de la misma dirección que donde aterriza,
 * se fusiona repartiendo su ratio. Última hoja → `null` (árbol vacío);
 * id inexistente → árbol sin cambios.
 * @param {PaneNode | null} root
 * @param {string} id
 * @returns {PaneNode | null}
 */
export function removeLeaf(root, id) {
  if (!root) return null;
  const result = removeNode(root, id);
  return result === undefined ? root : result;
}

/**
 * @param {PaneNode} node
 * @param {string} id
 * @returns {PaneNode | null | undefined} `undefined` = no está en este
 * subárbol; `null` = el subárbol queda vacío; nodo = subárbol nuevo
 */
function removeNode(node, id) {
  if (node.type === "leaf") return node.id === id ? null : undefined;
  for (let i = 0; i < node.children.length; i++) {
    const res = removeNode(node.children[i], id);
    if (res === undefined) continue;
    const children = node.children.slice();
    const ratios = node.ratios.slice();
    if (res === null) {
      children.splice(i, 1);
      ratios.splice(i, 1);
      if (children.length === 1) return children[0];
      return { ...node, ratios: normalizeRatios(ratios, children.length), children };
    }
    if (res.type === "split" && res.dir === node.dir) {
      // El hijo colapsó a un split de nuestra misma dirección: fusionar.
      const share = ratios[i];
      children.splice(i, 1, ...res.children);
      ratios.splice(i, 1, ...res.ratios.map((r) => r * share));
      return { ...node, ratios: normalizeRatios(ratios, children.length), children };
    }
    children[i] = res;
    return { ...node, children };
  }
  return undefined;
}

/**
 * Id de la hoja a `delta` pasos de `fromId` en orden de lectura, con vuelta
 * circular (`delta` negativo retrocede). `fromId` desconocido → primera hoja;
 * árbol vacío → `null`. Es el ciclo de foco Alt+↑/↓ entre panes.
 * @param {PaneNode | null} root
 * @param {string} fromId
 * @param {number} [delta]
 * @returns {string | null}
 */
export function nextLeaf(root, fromId, delta = 1) {
  const ids = leafIds(root);
  if (ids.length === 0) return null;
  const idx = ids.indexOf(fromId);
  if (idx === -1) return ids[0];
  return ids[(((idx + delta) % ids.length) + ids.length) % ids.length];
}

/**
 * Camino de índices de hijo desde la raíz hasta la hoja `id` (`[]` si la raíz
 * es la propia hoja), o `null` si no está. Sirve para localizar el split de
 * una hoja (arrastre de divisores, foco).
 * @param {PaneNode | null} root
 * @param {string} id
 * @returns {number[] | null}
 */
export function pathToLeaf(root, id) {
  if (!root) return null;
  if (root.type === "leaf") return root.id === id ? [] : null;
  for (let i = 0; i < root.children.length; i++) {
    const sub = pathToLeaf(root.children[i], id);
    if (sub) return [i, ...sub];
  }
  return null;
}

/**
 * Fija los ratios del split que hay al final de `path` (camino de índices
 * desde la raíz; `[]` = la raíz). Los ratios se sanean con
 * {@link normalizeRatios}. Camino inválido → árbol sin cambios.
 * @param {PaneNode | null} root
 * @param {number[]} path
 * @param {number[]} ratios
 * @returns {PaneNode | null}
 */
export function setRatiosAt(root, path, ratios) {
  if (!root || root.type !== "split" || !Array.isArray(path)) return root;
  if (path.length === 0) {
    return { ...root, ratios: normalizeRatios(ratios, root.children.length) };
  }
  const child = root.children[path[0]];
  if (!child) return root;
  const updated = setRatiosAt(child, path.slice(1), ratios);
  if (!updated || updated === child) return root;
  const children = root.children.slice();
  children[path[0]] = updated;
  return { ...root, children };
}

/**
 * Restaura los invariantes en un árbol de origen externo (persistido, o
 * traducido de un layout de tmux): colapsa splits de un solo hijo, fusiona
 * splits anidados de la misma dirección y sanea los ratios.
 * @param {PaneNode | null} root
 * @returns {PaneNode | null}
 */
export function normalizeTree(root) {
  if (!root) return null;
  if (root.type === "leaf") return root;
  const baseRatios = normalizeRatios(root.ratios, root.children.length);
  /** @type {PaneNode[]} */
  const children = [];
  /** @type {number[]} */
  const ratios = [];
  root.children.forEach((child, i) => {
    const norm = normalizeTree(child);
    if (!norm) return;
    if (norm.type === "split" && norm.dir === root.dir) {
      norm.children.forEach((sub, j) => {
        children.push(sub);
        ratios.push(norm.ratios[j] * baseRatios[i]);
      });
    } else {
      children.push(norm);
      ratios.push(baseRatios[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { type: "split", dir: root.dir, ratios: normalizeRatios(ratios, children.length), children };
}
