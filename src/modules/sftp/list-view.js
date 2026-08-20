// @ts-check
/**
 * Núcleo **puro** de la lista de ficheros del panel SFTP.
 *
 * Hasta ahora el panel recibía el listado completo, lo ordenaba y lo escupía en
 * un único `innerHTML` con cinco escuchadores por fila. Con un directorio de
 * decenas de miles de entradas eso son cientos de miles de nodos y
 * escuchadores: la WebView se congela y el panel deja de responder. Aquí vive
 * la aritmética que permite pintar **solo las filas visibles**, sin tocar el
 * DOM ni el estado de la app, para poder probarla de verdad.
 *
 * Tres piezas independientes:
 *
 * - `visibleRange` — qué tramo del listado cae dentro del viewport y cuánto
 *   relleno hay que dejar arriba y abajo para que la barra de scroll siga
 *   midiendo el listado entero.
 * - `filterEntries` — el filtro por subcadena de la caja de búsqueda, que antes
 *   se aplicaba marcando clases sobre filas ya pintadas (imposible cuando la
 *   fila no existe).
 * - `selectionAfter*` — las reglas de selección, que dejan de vivir en las
 *   clases del DOM para poder sobrevivir a que una fila se despinte al salir
 *   del viewport.
 */

/**
 * A partir de cuántas entradas se pinta virtualizado. Por debajo se pinta el
 * listado entero: es el caso de siempre (decenas de ficheros), no cuesta nada y
 * así el comportamiento conocido —incluido el scroll del navegador— no cambia.
 */
export const VIRTUAL_THRESHOLD = 200;

/** Filas de más que se pintan por encima y por debajo del viewport. */
export const OVERSCAN = 12;

/** Altura de fila supuesta cuando todavía no se ha podido medir una real. */
export const FALLBACK_ROW_HEIGHT = 28;

/**
 * @typedef {object} VisibleRange
 * @property {number} start Índice de la primera fila a pintar (incluido).
 * @property {number} end Índice de la última fila a pintar (excluido).
 * @property {number} padTop Píxeles de relleno por encima de la primera fila.
 * @property {number} padBottom Píxeles de relleno por debajo de la última.
 */

/**
 * Tramo de filas a pintar para un scroll dado.
 *
 * `padTop`/`padBottom` sustituyen a las filas que no se pintan, de modo que la
 * altura total del contenedor —y por tanto la barra de scroll— sea la misma que
 * si estuvieran todas. El overscan evita que un scroll rápido enseñe hueco.
 *
 * @param {object} opts
 * @param {number} opts.scrollTop Desplazamiento actual del contenedor.
 * @param {number} opts.viewportHeight Altura visible del contenedor.
 * @param {number} opts.rowHeight Altura de una fila, en píxeles.
 * @param {number} opts.total Entradas del listado.
 * @param {number} [opts.overscan]
 * @returns {VisibleRange}
 */
export function visibleRange({ scrollTop, viewportHeight, rowHeight, total, overscan = OVERSCAN }) {
  const count = Math.max(0, Math.trunc(total) || 0);
  if (count === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  // Una altura de fila no positiva (panel oculto, medida imposible) haría una
  // división por cero y un rango absurdo: se pinta todo, que siempre es válido.
  const h = rowHeight > 0 ? rowHeight : 0;
  if (!h) return { start: 0, end: count, padTop: 0, padBottom: 0 };

  const top = Math.max(0, scrollTop || 0);
  const height = Math.max(0, viewportHeight || 0);
  const pad = Math.max(0, Math.trunc(overscan) || 0);

  const first = Math.max(0, Math.floor(top / h) - pad);
  const visible = Math.ceil(height / h) + pad * 2 + 1;
  const start = Math.min(first, count);
  const end = Math.min(count, start + visible);

  return {
    start,
    end,
    padTop: start * h,
    padBottom: (count - end) * h,
  };
}

/**
 * Filtra el listado por subcadena, sin distinguir mayúsculas ni acentos de
 * caja. Un término vacío devuelve **el mismo array** (no una copia): el filtro
 * inactivo no debe costar una copia de decenas de miles de elementos.
 *
 * @template {{ name?: string }} T
 * @param {T[]} entries
 * @param {string} term
 * @returns {T[]}
 */
export function filterEntries(entries, term) {
  const list = Array.isArray(entries) ? entries : [];
  const needle = String(term || "").trim().toLocaleLowerCase();
  if (!needle) return list;
  return list.filter((e) => String(e?.name || "").toLocaleLowerCase().includes(needle));
}

/**
 * Selección resultante de pulsar sobre una fila.
 *
 * `toggle` (Ctrl/Cmd/Alt) suma o resta esa fila; sin modificador la selección
 * pasa a ser solo esa fila. Devuelve un `Set` nuevo — el llamador decide si
 * repinta, y comparar identidades es más barato que comparar contenidos.
 *
 * @param {Set<string>} selected Claves seleccionadas ahora.
 * @param {string} key Clave de la fila pulsada.
 * @param {boolean} toggle
 * @returns {Set<string>}
 */
export function selectionAfterClick(selected, key, toggle) {
  if (!toggle) return new Set([key]);
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Selección resultante de una acción que necesita a la fila dentro (menú
 * contextual, arrastre): si ya estaba seleccionada se respeta la selección
 * múltiple; si no, pasa a ser la única.
 *
 * @param {Set<string>} selected
 * @param {string} key
 * @returns {Set<string>}
 */
export function selectionForRowAction(selected, key) {
  if (selected.has(key)) return selected;
  return new Set([key]);
}

/**
 * Poda de la selección tras cambiar el listado (navegar, refrescar, filtrar):
 * sobrevive lo que sigue existiendo. Sin esto, borrar un fichero seleccionado y
 * refrescar dejaría su clave dentro para siempre, y una operación posterior
 * actuaría sobre algo que ya no está.
 *
 * @param {Set<string>} selected
 * @param {Iterable<string>} keys Claves presentes en el listado nuevo.
 * @returns {Set<string>}
 */
export function pruneSelection(selected, keys) {
  const alive = keys instanceof Set ? keys : new Set(keys);
  const next = new Set();
  for (const key of selected) if (alive.has(key)) next.add(key);
  return next;
}
