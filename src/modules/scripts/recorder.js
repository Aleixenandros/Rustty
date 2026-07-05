// @ts-check
/**
 * Grabadora de scripts (Fase 3): materializa una sesión de terminal en curso
 * como lista de pasos estructurados, para que el mismo runner que ejecuta los
 * scripts escritos a mano reproduzca lo grabado.
 *
 * Módulo **puro** (sin DOM ni `invoke`): recibe el flujo de pulsaciones del
 * usuario (`feedInput`) y el de salida del servidor (`feedOutput`) y va
 * acumulando pasos. La capa de UI lo alimenta desde el terminal activo.
 *
 * Reglas del autómata:
 * - Cada línea de comando (hasta Intro) genera un paso `send`. Entre comando y
 *   comando se inserta un `waitPrompt` (esperar el fin del comando anterior);
 *   es equivalente a detectar el prompt con OSC 133 pero sin depender de él.
 * - **Eco apagado**: si en el momento de pulsar Intro la última línea de salida
 *   es un prompt de contraseña (`sudo`, login SSH, `su`…), la línea NO se
 *   guarda literal: se emite un paso `sendPasswordFromKeyring` con hueco
 *   (`profileId: null`) para que el usuario elija keyring o KeePass al editar.
 *   El `waitPrompt` del comando se pospone hasta después de la contraseña.
 * - Tope de `MAX_STEPS` pasos: a partir de ahí se deja de acumular
 *   (`truncated = true`) para no exceder el límite del modelo.
 *
 * Línea roja: la grabadora nunca conserva el texto tecleado en un prompt de
 * contraseña; solo emite la referencia (igual que el resto del motor).
 */

import { makeStep, MAX_STEPS } from "./model.js";

/**
 * Prompt de contraseña con eco apagado. Debe casar al **final** de la salida
 * acumulada (el usuario teclea justo después) para no dispararse con un
 * «password:» que aparezca en mitad de la salida de un comando.
 */
const PASSWORD_PROMPT_RE =
  /(?:password|contrase(?:ñ|n)a|passphrase|mot de passe|passwort|senha)[^\n]*:\s*$/i;

/** Tamaño máximo de la cola de salida que se conserva para la heurística. */
const OUTPUT_TAIL_MAX = 512;

/**
 * @typedef {object} RecorderState
 * @property {import("./model.js").Step[]} steps Pasos acumulados.
 * @property {string} line Línea de comando reconstruida en curso.
 * @property {string} outputTail Cola reciente de salida (sin ANSI).
 * @property {boolean} passwordPrompt Hay un prompt de contraseña activo.
 * @property {boolean} awaitingPrompt Falta cerrar el último comando con waitPrompt.
 * @property {number} commandCount Nº de comandos (pasos `send`) capturados.
 * @property {boolean} truncated Se alcanzó `MAX_STEPS` y se descartó el resto.
 */

/**
 * Crea un estado de grabación vacío.
 * @returns {RecorderState}
 */
export function createRecorder() {
  return {
    steps: [],
    line: "",
    outputTail: "",
    passwordPrompt: false,
    awaitingPrompt: false,
    commandCount: 0,
    truncated: false,
  };
}

/**
 * Quita las secuencias de escape ANSI/OSC de un texto para poder analizar la
 * cola de salida (prompts coloreados, títulos de ventana, etc.).
 * @param {string} s
 * @returns {string}
 */
function stripAnsi(s) {
  return String(s)
    // OSC: ESC ] … BEL | ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ … letra
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Otras secuencias de un carácter tras ESC
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/**
 * Alimenta la grabadora con la salida del servidor. Solo se usa para la
 * heurística de detección de prompt de contraseña; no genera pasos.
 * @param {RecorderState} state
 * @param {string} text
 */
export function feedOutput(state, text) {
  if (!text) return;
  const clean = stripAnsi(text);
  if (!clean) {
    // Aun sin texto imprimible puede haber llegado un salto de línea real.
    if (/[\r\n]/.test(String(text))) state.passwordPrompt = false;
    return;
  }
  state.outputTail = (state.outputTail + clean).slice(-OUTPUT_TAIL_MAX);
  // La cola relevante es lo que hay tras el último salto de línea.
  const lastLine = state.outputTail.split(/\r?\n/).pop() || "";
  state.passwordPrompt = PASSWORD_PROMPT_RE.test(lastLine);
}

/**
 * Cierra el comando pendiente insertando un `waitPrompt` si hace falta.
 * @param {RecorderState} state
 */
function closePendingCommand(state) {
  if (state.awaitingPrompt && !state.truncated) {
    pushStep(state, makeStep("waitPrompt"));
    state.awaitingPrompt = false;
  }
}

/**
 * Añade un paso respetando el tope `MAX_STEPS`.
 * @param {RecorderState} state
 * @param {import("./model.js").Step} step
 */
function pushStep(state, step) {
  if (state.steps.length >= MAX_STEPS) {
    state.truncated = true;
    return;
  }
  state.steps.push(step);
}

/**
 * Confirma la línea reconstruida al pulsar Intro y genera los pasos.
 * @param {RecorderState} state
 */
function commitLine(state) {
  const wasPassword = state.passwordPrompt;
  const cmd = state.line;
  state.line = "";
  // El prompt de contraseña se consume al enviarla (el servidor responderá
  // luego); si era eco normal, un Intro también abandona la zona de prompt.
  state.passwordPrompt = false;

  if (wasPassword) {
    // Eco apagado: nunca guardamos el texto tecleado, solo la referencia. El
    // `waitPrompt` del comando se pospone (sigue `awaitingPrompt`).
    pushStep(state, makeStep("sendPasswordFromKeyring", { profileId: null }));
    return;
  }

  const trimmed = cmd.replace(/\s+$/, "");
  if (trimmed === "") return; // Intro en un prompt vacío: se ignora.

  // Cierra el comando anterior antes de empezar el nuevo.
  closePendingCommand(state);
  pushStep(state, makeStep("send", { text: trimmed }));
  if (!state.truncated) {
    state.commandCount += 1;
    state.awaitingPrompt = true;
  }
}

/**
 * Alimenta la grabadora con las pulsaciones del usuario (lo que se escribe en
 * el terminal). Reconstruye la línea de comando y confirma en cada Intro.
 * @param {RecorderState} state
 * @param {string} data
 */
export function feedInput(state, data) {
  if (typeof data !== "string" || data.length === 0) return;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === "\r" || ch === "\n") {
      commitLine(state);
    } else if (ch === "\x7f" || ch === "\b") {
      state.line = state.line.slice(0, -1); // backspace
    } else if (code === 0x1b) {
      break; // secuencia de escape (flechas, etc.): ignora el resto del chunk
    } else if (code === 0x03 || code === 0x15) {
      state.line = ""; // Ctrl+C / Ctrl+U: descarta la línea
    } else if (code >= 0x20) {
      state.line += ch; // imprimible
    }
    // Otros controles (Tab, etc.) no rompen la línea.
  }
}

/**
 * Nº de pasos acumulados hasta ahora (para el indicador de grabación).
 * @param {RecorderState} state
 * @returns {number}
 */
export function stepCount(state) {
  // Incluye el `waitPrompt` de cierre que añadirá `finish()`.
  return state.steps.length + (state.awaitingPrompt ? 1 : 0);
}

/**
 * Cierra la grabación y devuelve la lista de pasos materializada. Añade el
 * `waitPrompt` final del último comando si quedaba pendiente. No muta más allá
 * de cerrar el comando abierto, así que puede llamarse una sola vez.
 * @param {RecorderState} state
 * @returns {import("./model.js").Step[]}
 */
export function finish(state) {
  closePendingCommand(state);
  return state.steps.map((s) => makeStep(s.type, s));
}
