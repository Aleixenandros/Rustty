// @ts-check

/**
 * Estado de una pestaña de sesión en palabras, para los lectores de pantalla.
 *
 * La barra de pestañas cuenta el estado solo con color (el punto verde o
 * rojo, el brillo de actividad, el candado): aquí se traduce ese estado a
 * claves del catálogo (`tab_state.*`) que `main.js` pone, ya traducidas, en
 * la descripción accesible de la pestaña. Sin DOM: recibe las clases que la
 * pestaña y su punto de estado ya tienen.
 */

/**
 * @typedef {object} TabStateInput
 * @property {string} [status] `connecting`, `connected`, `reconnecting`, `error` o `closed`.
 * @property {"activity"|"important"|"disconnect"|null} [unread] Aviso sin ver en una pestaña que no es la activa.
 * @property {boolean} [readOnly] Solo lectura.
 * @property {boolean} [broadcast] Recibe la entrada difundida a varias panes.
 * @property {boolean} [isPrivate] Sesión privada.
 * @property {boolean} [pinned] Anclada al principio de la barra.
 */

/** @type {Record<string, string>} */
const STATUS_KEYS = {
  connected: "tab_state.connected",
  connecting: "tab_state.connecting",
  reconnecting: "tab_state.reconnecting",
  error: "tab_state.disconnected",
  closed: "tab_state.disconnected",
};

/**
 * Claves del catálogo que describen la pestaña, por orden de lectura: estado
 * de la conexión, aviso sin ver y marcas (solo lectura, difusión, privada,
 * anclada). Una pestaña desconectada con el aviso rojo no repite «desconectada».
 * @param {TabStateInput} input
 * @returns {string[]}
 */
export function tabStateKeys(input) {
  const keys = [];
  const status = input.status ? STATUS_KEYS[input.status] : undefined;
  if (status) keys.push(status);
  if (input.unread === "important") keys.push("tab_state.important");
  else if (input.unread === "activity") keys.push("tab_state.activity");
  else if (input.unread === "disconnect" && status !== "tab_state.disconnected") keys.push("tab_state.disconnected");
  if (input.readOnly) keys.push("tab_state.read_only");
  if (input.broadcast) keys.push("tab_state.broadcast");
  if (input.isPrivate) keys.push("tab_state.private");
  if (input.pinned) keys.push("tab_state.pinned");
  return keys;
}

/**
 * Lee el estado de las clases que ya llevan la pestaña (`.tab`) y su punto
 * (`.tab-dot`), que son las que pintan el color.
 * @param {Iterable<string>} tabClasses
 * @param {Iterable<string>} dotClasses
 * @returns {TabStateInput}
 */
export function tabStateFromClasses(tabClasses, dotClasses) {
  const tab = new Set(tabClasses);
  const dot = new Set(dotClasses);
  const status = ["connected", "connecting", "reconnecting", "error", "closed"].find((s) => dot.has(s));
  /** @type {TabStateInput["unread"]} */
  let unread = null;
  if (tab.has("has-unread-disconnect")) unread = "disconnect";
  else if (tab.has("has-unread-important")) unread = "important";
  else if (tab.has("has-unread-activity")) unread = "activity";
  return {
    status,
    unread,
    readOnly: tab.has("is-read-only"),
    broadcast: tab.has("is-broadcasting"),
    isPrivate: tab.has("is-private"),
    pinned: tab.has("is-pinned"),
  };
}
