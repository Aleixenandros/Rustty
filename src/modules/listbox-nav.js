// @ts-check
import { foldSearchText } from "./connection-search.js";

/**
 * Teclado de un desplegable de solo selección (patrón APG «select-only
 * combobox»): qué hace cada tecla según la lista esté abierta o cerrada.
 *
 * Sin DOM: recibe el estado, la tecla y las etiquetas de las opciones y
 * devuelve el estado nuevo y la acción que el llamador debe ejecutar. Así se
 * prueba la vuelta a los extremos, los saltos de página, la búsqueda tecleando
 * (con su plazo) y las opciones desactivadas sin montar un documento.
 *
 * Las flechas no dan la vuelta en los extremos: igual que un `<select>` nativo,
 * Inicio y Fin son la forma de ir al principio y al final.
 */

/** Plazo entre teclas para que cuenten como una sola búsqueda (ms). */
export const TYPEAHEAD_TIMEOUT_MS = 500;
/** Opciones que saltan RePág y AvPág. */
export const DEFAULT_PAGE_SIZE = 10;

/**
 * @typedef {object} ListboxState
 * @property {boolean} open La lista está desplegada.
 * @property {number} index Opción resaltada (con la lista cerrada, la seleccionada).
 * @property {string} search Texto tecleado para buscar una opción.
 * @property {number} searchAt Instante de la última tecla de búsqueda.
 */

/**
 * @typedef {"none"|"open"|"close"|"move"|"commit"} ListboxAction
 * `open` despliega la lista resaltando `state.index`; `move` cambia el
 * resaltado; `commit` elige `state.index` y cierra; `close` cierra sin elegir.
 */

/**
 * @typedef {object} ListboxKeyOptions
 * @property {string[]} labels Etiquetas de las opciones, en orden.
 * @property {boolean[]} [disabled] Opciones que no se pueden elegir.
 * @property {number} [now] Instante actual (para el plazo de la búsqueda).
 * @property {number} [pageSize] Salto de RePág/AvPág.
 * @property {boolean} [altKey] Alt pulsado (Alt+↓ abre, Alt+↑ elige).
 * @property {number} [selected] Índice de la opción elegida ahora mismo.
 */

/**
 * Estado inicial, con la lista cerrada sobre la opción elegida.
 * @param {number} [selected]
 * @returns {ListboxState}
 */
export function createListboxState(selected = 0) {
  return { open: false, index: selected, search: "", searchAt: 0 };
}

/**
 * @param {number} i
 * @param {boolean[]} disabled
 */
function isEnabled(i, disabled) {
  return !disabled[i];
}

/**
 * Primera (o última) opción elegible.
 * @param {number} count
 * @param {boolean[]} disabled
 * @param {boolean} [fromEnd]
 * @returns {number} -1 si no hay ninguna.
 */
export function edgeEnabled(count, disabled, fromEnd = false) {
  if (fromEnd) {
    for (let i = count - 1; i >= 0; i--) if (isEnabled(i, disabled)) return i;
  } else {
    for (let i = 0; i < count; i++) if (isEnabled(i, disabled)) return i;
  }
  return -1;
}

/**
 * Siguiente opción elegible en una dirección, sin dar la vuelta. Si no hay
 * ninguna más allá, se queda donde está (o, sin resaltado, va al extremo).
 * @param {number} from
 * @param {1|-1} dir
 * @param {number} count
 * @param {boolean[]} disabled
 * @returns {number}
 */
export function stepEnabled(from, dir, count, disabled) {
  if (from < 0 || from >= count) return edgeEnabled(count, disabled, dir < 0);
  for (let i = from + dir; i >= 0 && i < count; i += dir) {
    if (isEnabled(i, disabled)) return i;
  }
  return from;
}

/**
 * Salto de página: avanza `size` opciones (acotado) y, si cae en una
 * desactivada, se acerca a la elegible más próxima en esa dirección; si no la
 * hay, retrocede hasta la última elegible antes del salto.
 * @param {number} from
 * @param {1|-1} dir
 * @param {number} size
 * @param {number} count
 * @param {boolean[]} disabled
 * @returns {number}
 */
export function pageEnabled(from, dir, size, count, disabled) {
  if (count === 0) return -1;
  if (from < 0 || from >= count) return edgeEnabled(count, disabled, dir < 0);
  const target = Math.max(0, Math.min(count - 1, from + dir * size));
  for (let i = target; i >= 0 && i < count; i += dir) if (isEnabled(i, disabled)) return i;
  for (let i = target - dir; i !== from && i >= 0 && i < count; i -= dir) if (isEnabled(i, disabled)) return i;
  return from;
}

/**
 * Opción que empieza por lo tecleado, buscando desde la siguiente a `from` y
 * dando la vuelta. Con la misma letra repetida («p», «pp») se recorren las
 * opciones que empiezan por esa letra, como en un `<select>` nativo. La
 * comparación pliega mayúsculas y diacríticos igual que el buscador de
 * conexiones. Las opciones desactivadas no cuentan.
 * @param {string[]} labels
 * @param {string} search
 * @param {number} from
 * @param {boolean[]} [disabled]
 * @returns {number} -1 si nada coincide.
 */
export function typeaheadIndex(labels, search, from, disabled = []) {
  const needle = foldSearchText(search);
  if (!needle) return -1;
  const count = labels.length;
  const find = (/** @type {string} */ prefix) => {
    for (let k = 1; k <= count; k++) {
      const i = (from + k + count) % count;
      if (!isEnabled(i, disabled)) continue;
      if (foldSearchText(labels[i]).startsWith(prefix)) return i;
    }
    return -1;
  };
  const direct = find(needle);
  if (direct >= 0) return direct;
  const sameLetter = needle.length > 1 && [...needle].every((c) => c === needle[0]);
  return sameLetter ? find(needle[0]) : -1;
}

/**
 * @param {ListboxState} state
 * @param {string} key
 * @param {number} now
 * @param {string[]} labels
 * @param {boolean[]} disabled
 * @returns {ListboxState}
 */
function withTypeahead(state, key, now, labels, disabled) {
  const fresh = now - state.searchAt > TYPEAHEAD_TIMEOUT_MS;
  const search = (fresh ? "" : state.search) + key;
  const hit = typeaheadIndex(labels, search, state.index, disabled);
  return { ...state, search, searchAt: now, index: hit >= 0 ? hit : state.index };
}

/**
 * Resuelve una tecla (`KeyboardEvent.key`) sobre el desplegable.
 *
 * Cerrado: ↓, ↑, Alt+↓, Enter y Espacio abren sobre la opción elegida; Inicio
 * y Fin abren sobre la primera o la última; una letra abre y busca. Abierto:
 * ↑/↓ mueven, Inicio/Fin van a los extremos, RePág/AvPág saltan una página,
 * las letras buscan (Espacio continúa una búsqueda en curso), Enter, Espacio y
 * Alt+↑ eligen, Tab elige sin consumir la tecla (el foco sigue su camino) y
 * Escape cierra sin cambiar nada. `prevent` dice si el llamador debe parar el
 * evento: con Escape cerrado o teclas ajenas no se toca nada, para que el
 * diálogo de debajo reciba lo suyo.
 *
 * @param {ListboxState} state
 * @param {string} key
 * @param {ListboxKeyOptions} options
 * @returns {{ state: ListboxState, action: ListboxAction, prevent: boolean }}
 */
export function listboxKey(state, key, options) {
  const labels = options.labels ?? [];
  const disabled = options.disabled ?? [];
  const now = options.now ?? 0;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const count = labels.length;
  const selected = Number.isInteger(options.selected) ? /** @type {number} */ (options.selected) : state.index;
  const none = { state, action: /** @type {ListboxAction} */ ("none"), prevent: false };
  if (count === 0) return none;
  const printable = key.length === 1 && key !== " ";

  if (!state.open) {
    const base = { ...state, open: true, search: "", searchAt: 0, index: selected };
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
      const index = isEnabled(selected, disabled) && selected >= 0 && selected < count
        ? selected : edgeEnabled(count, disabled);
      return { state: { ...base, index }, action: "open", prevent: true };
    }
    if (key === "Home") return { state: { ...base, index: edgeEnabled(count, disabled) }, action: "open", prevent: true };
    if (key === "End") return { state: { ...base, index: edgeEnabled(count, disabled, true) }, action: "open", prevent: true };
    if (printable) {
      const next = withTypeahead({ ...base, search: "", searchAt: 0 }, key, now, labels, disabled);
      return { state: next, action: "open", prevent: true };
    }
    return none;
  }

  const moved = (/** @type {number} */ index) => ({
    state: { ...state, index, search: "", searchAt: 0 },
    action: /** @type {ListboxAction} */ (index === state.index ? "none" : "move"),
    prevent: true,
  });
  switch (key) {
    case "Escape":
      return { state: { ...state, open: false, index: selected, search: "", searchAt: 0 }, action: "close", prevent: true };
    case "Tab":
      return { state: { ...state, open: false, search: "", searchAt: 0 }, action: "commit", prevent: false };
    case "Enter":
      return { state: { ...state, open: false, search: "", searchAt: 0 }, action: "commit", prevent: true };
    case " ": {
      const searching = state.search !== "" && now - state.searchAt <= TYPEAHEAD_TIMEOUT_MS;
      if (searching) {
        const next = withTypeahead(state, " ", now, labels, disabled);
        return { state: next, action: next.index === state.index ? "none" : "move", prevent: true };
      }
      return { state: { ...state, open: false, search: "", searchAt: 0 }, action: "commit", prevent: true };
    }
    case "ArrowUp":
      if (options.altKey) return { state: { ...state, open: false, search: "", searchAt: 0 }, action: "commit", prevent: true };
      return moved(stepEnabled(state.index, -1, count, disabled));
    case "ArrowDown":
      return moved(stepEnabled(state.index, 1, count, disabled));
    case "Home":
      return moved(edgeEnabled(count, disabled));
    case "End":
      return moved(edgeEnabled(count, disabled, true));
    case "PageUp":
      return moved(pageEnabled(state.index, -1, pageSize, count, disabled));
    case "PageDown":
      return moved(pageEnabled(state.index, 1, pageSize, count, disabled));
    default:
      if (printable) {
        const next = withTypeahead(state, key, now, labels, disabled);
        return { state: next, action: next.index === state.index ? "none" : "move", prevent: true };
      }
      return none;
  }
}
