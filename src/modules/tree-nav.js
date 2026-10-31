// @ts-check
/**
 * Navegación por teclado del árbol de conexiones (patrón «tree» de las APG
 * de WAI-ARIA, con tabindex itinerante).
 *
 * Núcleo puro: recibe el modelo del árbol en el MISMO orden en que se pinta la
 * barra lateral (carpetas y conexiones; los workspaces en la vista «Todos»;
 * las secciones de una búsqueda) y el conjunto de carpetas abiertas, y
 * responde a cada tecla con qué nodo enfocar, cuál plegar o desplegar y cuál
 * activar. Sin DOM: el llamador traduce las claves a filas y aplica el
 * resultado. La búsqueda tecleando usa la misma normalización que el buscador
 * de conexiones (`foldSearchText`): «pro» encuentra «Producción».
 */
import { foldSearchText } from "./connection-search.js";

/**
 * @typedef {object} TreeModelNode
 * @property {string} key Identidad estable de la fila (id de la conexión, carpeta con su workspace, `__ws__/<id>`).
 * @property {string} label Texto visible, para la búsqueda tecleando.
 * @property {string} [kind] Tipo libre que el llamador quiera arrastrar ("connection", "folder", "workspace"…).
 * @property {string} [openKey] Clave con la que el nodo figura en el conjunto de abiertos cuando no es `key` (las carpetas se abren por su ruta, compartida entre workspaces).
 * @property {TreeModelNode[]} [children] Solo en los nodos desplegables, aunque estén vacíos.
 */

/**
 * @typedef {object} VisibleNode
 * @property {string} key
 * @property {string|null} parentKey
 * @property {number} level Profundidad desde 1 (el valor de `aria-level`).
 * @property {boolean} expandable
 * @property {boolean} expanded
 * @property {string} label
 * @property {string|undefined} kind
 */

/**
 * @typedef {object} TreeKeyResult
 * @property {string|null} focus Nodo que debe recibir el foco.
 * @property {string|null} toggle Nodo desplegable que se pliega o se despliega.
 * @property {string[]} expand Nodos a desplegar de golpe (tecla `*`: los hermanos cerrados).
 * @property {string|null} activate Nodo que se activa (Enter o Espacio).
 */

/**
 * Lista plana de los nodos visibles: los de la raíz y, de cada desplegable
 * abierto, sus hijos, en orden de pintado.
 *
 * @param {TreeModelNode[]} roots
 * @param {Set<string>} openFolders Claves abiertas (`openKey` o, en su defecto, `key`).
 * @returns {VisibleNode[]}
 */
export function visibleNodes(roots, openFolders) {
  /** @type {VisibleNode[]} */
  const out = [];
  /**
   * @param {TreeModelNode[]} nodes
   * @param {string|null} parentKey
   * @param {number} level
   */
  const walk = (nodes, parentKey, level) => {
    for (const node of nodes) {
      const expandable = Array.isArray(node.children);
      const expanded = expandable && openFolders.has(node.openKey ?? node.key);
      out.push({ key: node.key, parentKey, level, expandable, expanded, label: node.label, kind: node.kind });
      if (expanded) walk(node.children ?? [], node.key, level + 1);
    }
  };
  walk(roots ?? [], null, 1);
  return out;
}

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft", "Enter", " ", "*"]);

/**
 * Qué hacer ante una tecla sobre el nodo `currentKey`. Devuelve `null` si la
 * tecla no es del árbol (el llamador no debe consumirla). Las flechas no dan la
 * vuelta: en el último nodo, ↓ se queda donde está.
 *
 * @param {VisibleNode[]} nodes Lo que devuelve `visibleNodes`.
 * @param {string|null} currentKey Nodo enfocado, o `null` si ninguno.
 * @param {string} key `KeyboardEvent.key`.
 * @returns {TreeKeyResult|null}
 */
export function treeKey(nodes, currentKey, key) {
  if (!NAV_KEYS.has(key)) return null;
  /** @type {TreeKeyResult} */
  const result = { focus: null, toggle: null, expand: [], activate: null };
  if (!nodes.length) return result;
  const index = nodes.findIndex((n) => n.key === currentKey);
  const current = index >= 0 ? nodes[index] : null;
  const first = nodes[0].key;
  switch (key) {
    case "ArrowDown":
      result.focus = nodes[Math.min(index + 1, nodes.length - 1)].key;
      break;
    case "ArrowUp":
      result.focus = nodes[Math.max(index - 1, 0)].key;
      break;
    case "Home":
      result.focus = first;
      break;
    case "End":
      result.focus = nodes[nodes.length - 1].key;
      break;
    case "ArrowRight":
      if (!current) result.focus = first;
      else if (current.expandable && !current.expanded) result.toggle = current.key;
      else if (current.expandable) {
        const child = nodes[index + 1];
        if (child && child.parentKey === current.key) result.focus = child.key;
      }
      break;
    case "ArrowLeft":
      if (!current) result.focus = first;
      else if (current.expandable && current.expanded) result.toggle = current.key;
      else if (current.parentKey) result.focus = current.parentKey;
      break;
    case "Enter":
    case " ":
      if (current) result.activate = current.key;
      break;
    case "*":
      if (current) {
        result.expand = nodes
          .filter((n) => n.parentKey === current.parentKey && n.expandable && !n.expanded)
          .map((n) => n.key);
      }
      break;
    default:
      break;
  }
  return result;
}

/**
 * Búsqueda tecleando: el siguiente nodo (a partir del actual, dando la vuelta)
 * cuyo nombre empiece por lo tecleado, sin distinguir mayúsculas ni acentos.
 * Repetir una misma letra («aaa») salta entre los nodos que empiezan por ella.
 *
 * @param {VisibleNode[]} nodes
 * @param {string|null} currentKey
 * @param {string} text Lo tecleado hasta ahora.
 * @returns {string|null} Clave del nodo encontrado, o `null`.
 */
export function typeAhead(nodes, currentKey, text) {
  const needle = foldSearchText(text);
  const count = nodes.length;
  if (!needle || !count) return null;
  const start = nodes.findIndex((n) => n.key === currentKey);
  /** @param {string} prefix */
  const find = (prefix) => {
    for (let i = 1; i <= count; i++) {
      const node = nodes[(start + i) % count];
      if (foldSearchText(node.label).startsWith(prefix)) return node.key;
    }
    return null;
  };
  const hit = find(needle);
  if (hit) return hit;
  if (needle.length > 1 && [...needle].every((c) => c === needle[0])) return find(needle[0]);
  return null;
}

/**
 * Qué fila lleva el único `tabindex="0"` del árbol: la última enfocada si
 * sigue visible; si no, la conexión activa; si no, la primera.
 *
 * @param {VisibleNode[]} nodes
 * @param {string|null} lastFocusedKey
 * @param {string|null} activeKey
 * @returns {string|null}
 */
export function rovingKey(nodes, lastFocusedKey, activeKey) {
  /** @param {string|null} key */
  const present = (key) => key != null && nodes.some((n) => n.key === key);
  if (present(lastFocusedKey)) return lastFocusedKey;
  if (present(activeKey)) return activeKey;
  return nodes[0]?.key ?? null;
}
