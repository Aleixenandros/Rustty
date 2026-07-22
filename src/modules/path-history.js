// @ts-check
/**
 * Historial de navegación de un panel de ficheros: la pila Atrás/Adelante que
 * espera cualquiera que haya usado un explorador o un navegador.
 *
 * Módulo **puro**: no toca el DOM ni el IPC. El panel SFTP mantiene un historial
 * por lado (local y remoto), independientes entre sí, y llama aquí para decidir
 * a dónde va cada botón. Todas las funciones devuelven un estado nuevo en vez de
 * mutar el que reciben, para que un fallo a mitad de navegación no deje el
 * historial a medio actualizar.
 *
 * @typedef {object} PathHistory
 * @property {string[]} entries Rutas visitadas, de la más antigua a la más reciente.
 * @property {number} index Posición actual dentro de `entries`; -1 si está vacío.
 */

/**
 * Tope de rutas recordadas por lado. Pasado ese punto se olvidan las más
 * antiguas: el historial es una comodidad de sesión, no un registro.
 */
export const MAX_HISTORY = 100;

/**
 * Crea un historial, opcionalmente ya posicionado en una ruta inicial.
 * @param {string|null} [initial]
 * @returns {PathHistory}
 */
export function createPathHistory(initial = null) {
  return initial ? { entries: [initial], index: 0 } : { entries: [], index: -1 };
}

/**
 * Ruta actual, o `null` si el historial está vacío.
 * @param {PathHistory} h
 * @returns {string|null}
 */
export function currentPath(h) {
  return h.index >= 0 && h.index < h.entries.length ? h.entries[h.index] : null;
}

/** @param {PathHistory} h */
export function canGoBack(h) {
  return h.index > 0;
}

/** @param {PathHistory} h */
export function canGoForward(h) {
  return h.index >= 0 && h.index < h.entries.length - 1;
}

/**
 * Registra una ruta recién visitada.
 *
 * Refrescar la carpeta actual **no** crea una entrada: repetir la ruta en la que
 * ya estamos dejaría el botón Atrás sin efecto aparente. Navegar a un sitio
 * nuevo desde el medio del historial descarta lo que hubiera «hacia adelante»,
 * igual que en un navegador.
 *
 * @param {PathHistory} h
 * @param {string} path
 * @returns {PathHistory}
 */
export function pushPath(h, path) {
  if (!path || path === currentPath(h)) return h;
  const entries = h.entries.slice(0, h.index + 1);
  entries.push(path);
  // Al recortar por el principio, el índice se desplaza con él.
  const excess = Math.max(0, entries.length - MAX_HISTORY);
  return { entries: entries.slice(excess), index: entries.length - excess - 1 };
}

/**
 * Retrocede un paso. Devuelve el mismo estado y `path: null` si no hay a dónde,
 * para que el llamador no tenga que preguntar antes.
 * @param {PathHistory} h
 * @returns {{ history: PathHistory, path: string|null }}
 */
export function goBack(h) {
  if (!canGoBack(h)) return { history: h, path: null };
  const index = h.index - 1;
  return { history: { entries: h.entries, index }, path: h.entries[index] };
}

/**
 * Avanza un paso.
 * @param {PathHistory} h
 * @returns {{ history: PathHistory, path: string|null }}
 */
export function goForward(h) {
  if (!canGoForward(h)) return { history: h, path: null };
  const index = h.index + 1;
  return { history: { entries: h.entries, index }, path: h.entries[index] };
}

/**
 * Saca del historial una ruta que ya no se puede visitar (borrada, desmontada o
 * sin permisos). Sin esto, el botón Atrás llevaría una y otra vez al mismo
 * error. Si la ruta retirada era la actual, la posición se queda en la entrada
 * anterior, que es a donde el usuario querría volver.
 * @param {PathHistory} h
 * @param {string} path
 * @returns {PathHistory}
 */
export function dropPath(h, path) {
  const entries = h.entries.filter((p) => p !== path);
  if (entries.length === h.entries.length) return h;
  if (entries.length === 0) return createPathHistory();
  // Cuántas de las eliminadas estaban en la posición actual o antes.
  const removedBefore = h.entries
    .slice(0, h.index + 1)
    .filter((p) => p === path).length;
  const index = Math.min(Math.max(h.index - removedBefore, 0), entries.length - 1);
  return { entries, index };
}

/**
 * Parte una ruta absoluta en los segmentos clicables de la barra de navegación.
 * Cada segmento lleva la ruta completa hasta él, que es lo que hay que abrir al
 * pulsarlo. El primero es siempre la raíz.
 *
 * Acepta rutas POSIX (`/home/ada`) y de Windows (`C:\Users\Ada`), porque el lado
 * local del panel es el del equipo donde corre Rustty.
 *
 * @param {string} path
 * @returns {{ label: string, path: string }[]}
 */
export function pathSegments(path) {
  if (!path) return [];
  const windows = /^[a-zA-Z]:[\\/]/.test(path);
  const sep = windows ? "\\" : "/";
  const normalized = windows ? path.replace(/\//g, "\\") : path;
  const root = windows ? normalized.slice(0, 2) : "/";
  const rest = normalized.slice(windows ? 3 : 1);

  const out = [{ label: root, path: windows ? `${root}${sep}` : "/" }];
  let acc = windows ? `${root}${sep}` : "";
  for (const part of rest.split(windows ? /\\+/ : /\/+/)) {
    if (!part) continue;
    acc = acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}
