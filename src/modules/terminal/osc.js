// @ts-check
/**
 * Protocolos modernos del terminal: portapapeles (OSC 52), avisos (OSC 9 y
 * OSC 777;notify), progreso (OSC 9;4, el de ConEmu) y título (OSC 0/2).
 * Núcleo **puro**: decide qué significa cada secuencia y la sanea; el
 * cableado con xterm, el portapapeles y las pestañas vive en `main.js`.
 *
 * Todo lo que llega aquí lo escribe el servidor (o un `cat` de un fichero
 * cualquiera): es entrada hostil. Por eso el portapapeles es solo de
 * escritura —la consulta `?` no se contesta nunca: devolvería al servidor lo
 * que el usuario tenga copiado—, el base64 tiene tope antes de decodificarse y
 * los textos pierden los caracteres de control y los de dirección (un U+202E
 * puede dar la vuelta a un título para que parezca otro).
 */

/** Tope de lo que el servidor puede copiar al portapapeles, ya decodificado. */
export const OSC52_MAX_BYTES = 256 * 1024;
/** Longitud máxima del texto de un aviso (OSC 9 / OSC 777). */
export const NOTIFY_MAX_CHARS = 200;
/** Longitud máxima del título de un aviso OSC 777. */
export const NOTIFY_TITLE_MAX_CHARS = 80;
/** Longitud máxima del título que fija el servidor (OSC 0/2). */
export const TITLE_MAX_CHARS = 120;

/** Política del portapapeles: el valor por defecto es el más cerrado. */
export const CLIPBOARD_POLICIES = ["off", "ask", "allow"];
/** Dónde se enseña el título remoto: nada, el tooltip o junto al nombre. */
export const REMOTE_TITLE_MODES = ["off", "tooltip", "tab"];

// C0, DEL y C1: ninguno tiene sentido en un texto que se pinta en la interfaz.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// Marcas y anulaciones de dirección (RLO, LRI…): invierten o reordenan el texto.
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * Texto de una secuencia listo para la interfaz: sin controles ni marcas de
 * dirección, con los espacios colapsados y cortado a `maxChars` caracteres
 * (por puntos de código: nunca parte un emoji en dos).
 * @param {unknown} text
 * @param {number} maxChars
 * @returns {string}
 */
export function sanitizeTerminalText(text, maxChars) {
  // Recorte previo: el servidor puede mandar hasta el tope de xterm (10 MB) y
  // sanear la cadena entera costaba casi un segundo y cien megas por secuencia.
  // Ocho unidades por carácter visible bastan aunque haya espacios que colapsar.
  const clean = String(text ?? "")
    .slice(0, Math.max(0, maxChars) * 8)
    .replace(CONTROL_RE, " ")
    .replace(BIDI_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}…`;
}

/**
 * @typedef {{ kind: "write", text: string, bytes: number }
 *   | { kind: "query" }
 *   | { kind: "invalid", reason: "syntax" | "empty" | "too_large" }} Osc52Request
 */

/**
 * Interpreta la carga de un OSC 52 (`Pc;Pd`): `Pc` son los destinos (`c`, `p`,
 * `s`, `0`-`7`, o vacío) y `Pd` el texto en base64, o `?` para consultarlo.
 * El tamaño se comprueba sobre el base64, **antes** de decodificar nada.
 * @param {unknown} data
 * @param {{ maxBytes?: number }} [options]
 * @returns {Osc52Request}
 */
export function parseOsc52(data, { maxBytes = OSC52_MAX_BYTES } = {}) {
  const raw = String(data ?? "");
  const sep = raw.indexOf(";");
  if (sep < 0) return { kind: "invalid", reason: "syntax" };
  const targets = raw.slice(0, sep);
  if (!/^[cpqs0-7]*$/.test(targets)) return { kind: "invalid", reason: "syntax" };
  const payload = raw.slice(sep + 1);
  if (payload === "?") return { kind: "query" };
  const b64 = payload.replace(/\s+/g, "");
  // Un `Pd` vacío (o que no es base64) pide en xterm borrar la selección: aquí
  // no se toca el portapapeles del usuario para eso.
  if (!b64) return { kind: "invalid", reason: "empty" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { kind: "invalid", reason: "syntax" };
  const digits = b64.replace(/=+$/, "").length;
  if (digits % 4 === 1) return { kind: "invalid", reason: "syntax" };
  const bytes = Math.floor((digits * 3) / 4);
  if (bytes > maxBytes) return { kind: "invalid", reason: "too_large" };
  let binary;
  try {
    binary = atob(b64);
  } catch {
    return { kind: "invalid", reason: "syntax" };
  }
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  const text = new TextDecoder("utf-8").decode(buf);
  if (!text) return { kind: "invalid", reason: "empty" };
  return { kind: "write", text, bytes: buf.length };
}

/**
 * Política efectiva del portapapeles para una sesión. Una sesión privada, como
 * mucho, pregunta: ni «Permitir» ni un «Permitir en esta sesión» la saltan. En
 * las demás, el «Permitir en esta sesión» del diálogo salta la pregunta, nunca
 * un «Desactivado».
 * @param {unknown} pref
 * @param {{ isPrivate?: boolean, sessionAllowed?: boolean }} [context]
 * @returns {"off" | "ask" | "allow"}
 */
export function effectiveClipboardPolicy(pref, { isPrivate = false, sessionAllowed = false } = {}) {
  const policy = normalizeClipboardPolicy(pref);
  if (policy === "off") return "off";
  if (isPrivate) return "ask";
  if (sessionAllowed) return "allow";
  return policy;
}

/**
 * @param {unknown} value
 * @returns {"off" | "ask" | "allow"}
 */
export function normalizeClipboardPolicy(value) {
  return value === "ask" || value === "allow" ? value : "off";
}

/**
 * Extracto de lo que el servidor quiere copiar, para enseñarlo en la pregunta:
 * las primeras líneas, con los caracteres de control a la vista en vez de
 * interpretados.
 * @param {string} text
 * @param {{ maxChars?: number, maxLines?: number }} [options]
 * @returns {{ excerpt: string, chars: number, lines: number, truncated: boolean }}
 */
export function clipboardExcerpt(text, { maxChars = 200, maxLines = 4 } = {}) {
  const all = String(text ?? "");
  const lines = all.split(/\r\n|\r|\n/);
  const codepoints = Array.from(all);
  let excerpt = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  const excerptChars = Array.from(excerpt);
  if (excerptChars.length > maxChars) {
    excerpt = excerptChars.slice(0, maxChars).join("");
    truncated = true;
  }
  excerpt = excerpt
    .replace(/\t/g, "→")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (ch) => (ch === "\x1b" ? "␛" : "·"))
    .replace(BIDI_RE, "·");
  if (truncated) excerpt += "\n…";
  return { excerpt, chars: codepoints.length, lines: lines.length, truncated };
}

/**
 * @typedef {"normal" | "error" | "indeterminate" | "paused"} ProgressState
 * @typedef {{ kind: "notify", title: string, body: string }
 *   | { kind: "progress", state: ProgressState | "remove", value: number | null }
 *   | { kind: "ignore" }} OscEvent
 */

/**
 * Interpreta un OSC 9, al estilo de Ghostty: si empieza por un subcomando de
 * ConEmu (`N;…` o `N` solo, con N de 1 a 12) es de ConEmu —y de esos solo se
 * atiende el 4, el progreso—; cualquier otro texto es un aviso de escritorio
 * (iTerm2). «3 ficheros copiados» es un aviso; «4;1;50» es progreso.
 * @param {unknown} data
 * @param {{ maxChars?: number }} [options]
 * @returns {OscEvent}
 */
export function parseOsc9(data, { maxChars = NOTIFY_MAX_CHARS } = {}) {
  const raw = String(data ?? "");
  const sub = /^(\d{1,2})(?:;|$)/.exec(raw);
  if (sub) {
    const n = Number(sub[1]);
    if (n === 4) return parseConEmuProgress(raw.slice(sub[0].length));
    if (n >= 1 && n <= 12) return { kind: "ignore" };
  }
  const body = sanitizeTerminalText(raw, maxChars);
  return body ? { kind: "notify", title: "", body } : { kind: "ignore" };
}

/**
 * Parámetros de un OSC 9;4 (`estado;porcentaje`): 0 quita la barra, 1 progreso
 * normal, 2 error, 3 indeterminado y 4 en pausa. En error y pausa el
 * porcentaje es opcional (se conserva el anterior: ver `nextProgress`).
 * @param {string} params
 * @returns {OscEvent}
 */
export function parseConEmuProgress(params) {
  const [stRaw = "", prRaw = ""] = String(params ?? "").split(";");
  if (!/^\d$/.test(stRaw)) return { kind: "ignore" };
  const value = /^\d{1,3}$/.test(prRaw) ? Math.min(100, Number(prRaw)) : null;
  switch (Number(stRaw)) {
    case 0: return { kind: "progress", state: "remove", value: null };
    case 1: return { kind: "progress", state: "normal", value: value ?? 0 };
    case 2: return { kind: "progress", state: "error", value };
    case 3: return { kind: "progress", state: "indeterminate", value: null };
    case 4: return { kind: "progress", state: "paused", value };
    default: return { kind: "ignore" };
  }
}

/**
 * Estado de la barra tras una actualización; `null` = sin barra. Error y
 * pausa sin porcentaje conservan el último conocido (una barra de error sin
 * ninguno se pinta llena: «ha fallado», sin más).
 * @param {{ state: ProgressState, value: number | null } | null} prev
 * @param {{ state: ProgressState | "remove", value: number | null }} update
 * @returns {{ state: ProgressState, value: number | null } | null}
 */
export function nextProgress(prev, update) {
  if (update.state === "remove") return null;
  if (update.state === "indeterminate") return { state: "indeterminate", value: null };
  if (update.value != null) return { state: update.state, value: update.value };
  const last = prev?.value ?? null;
  if (update.state === "error") return { state: "error", value: last ?? 100 };
  return { state: update.state, value: last ?? 0 };
}

/**
 * Interpreta un OSC 777. Solo se atiende `notify;título;texto` (urxvt, foot,
 * Ghostty); los demás subcomandos se ignoran. El texto puede llevar `;`.
 * @param {unknown} data
 * @returns {OscEvent}
 */
export function parseOsc777(data) {
  const raw = String(data ?? "");
  if (!raw.startsWith("notify;")) return { kind: "ignore" };
  const rest = raw.slice("notify;".length);
  const cut = rest.indexOf(";");
  const title = sanitizeTerminalText(cut < 0 ? rest : rest.slice(0, cut), NOTIFY_TITLE_MAX_CHARS);
  const body = sanitizeTerminalText(cut < 0 ? "" : rest.slice(cut + 1), NOTIFY_MAX_CHARS);
  if (!title && !body) return { kind: "ignore" };
  // Solo título: se enseña como texto del aviso, que es lo que se lee.
  return body ? { kind: "notify", title, body } : { kind: "notify", title: "", body: title };
}

/**
 * Título remoto (OSC 0/2) saneado.
 * @param {unknown} title
 * @returns {string}
 */
export function sanitizeRemoteTitle(title) {
  return sanitizeTerminalText(title, TITLE_MAX_CHARS);
}

/**
 * @param {unknown} value
 * @returns {"off" | "tooltip" | "tab"}
 */
export function normalizeRemoteTitleMode(value) {
  return value === "off" || value === "tab" ? value : "tooltip";
}

/**
 * Dónde se ve el título remoto de una pestaña. El alias manual manda: con
 * alias, el título remoto no entra en la pestaña (sí en el tooltip).
 * @param {{ alias?: string, remoteTitle?: string, mode?: unknown }} input
 * @returns {{ inTab: string, inTooltip: string }}
 */
export function remoteTitleView({ alias = "", remoteTitle = "", mode }) {
  const view = normalizeRemoteTitleMode(mode);
  const title = String(remoteTitle || "");
  if (!title || view === "off") return { inTab: "", inTooltip: "" };
  if (view === "tab" && !String(alias || "").trim()) return { inTab: title, inTooltip: title };
  return { inTab: "", inTooltip: title };
}

/**
 * Tooltip de la pestaña con la línea del título remoto puesta al día: quita la
 * que añadió la vez anterior (si sigue al final) y pone la nueva. El resto del
 * tooltip no se rehace: puede llevar sufijos que solo conoce quien lo creó.
 * @param {string} tooltip Tooltip actual de la pestaña.
 * @param {string} prevLine Línea de título remoto añadida antes ("" si ninguna).
 * @param {string} nextLine Línea a añadir ahora ("" para quitarla).
 * @returns {string}
 */
export function tooltipWithRemoteTitle(tooltip, prevLine, nextLine) {
  let base = String(tooltip || "");
  if (prevLine && base.endsWith(`\n${prevLine}`)) base = base.slice(0, -(prevLine.length + 1));
  return nextLine ? `${base}\n${nextLine}` : base;
}

/**
 * Limitador de avisos por sesión: como mucho `max` en cada ventana de
 * `windowMs`. Un bucle que emita un OSC 9 por línea no puede inundar la
 * pantalla ni el centro de notificaciones del sistema.
 * @param {{ max?: number, windowMs?: number, now?: () => number }} [options]
 * @returns {{ allow: () => boolean }}
 */
export function createNotifyLimiter({ max = 3, windowMs = 10000, now = () => Date.now() } = {}) {
  /** @type {number[]} */
  const stamps = [];
  return {
    allow() {
      const at = now();
      while (stamps.length && at - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length >= max) return false;
      stamps.push(at);
      return true;
    },
  };
}
