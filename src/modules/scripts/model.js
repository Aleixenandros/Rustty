// @ts-check
/**
 * Modelo puro de la feature de scripts (recetas interactivas pequeñas).
 *
 * Capa de lógica sin DOM ni `invoke`: solo el esquema de datos, sus
 * constructores y su validación. La UI y el puente IPC los cablea otro módulo.
 *
 * Contrato (idéntico al backend, camelCase): un `Script` describe una receta
 * secuencial de `Step`s que se ejecutan contra un `TargetSpec` (un perfil, una
 * carpeta o una selección ad-hoc). Línea roja del producto: recetas pequeñas,
 * no orquestación tipo Ansible, y **nunca** contraseñas en claro — los pasos de
 * contraseña solo llevan referencias (perfil de keyring / uuid de KeePass).
 */

/**
 * @typedef {{kind:"profile", profileId:string}} ProfileTarget
 * @typedef {{kind:"folder", workspaceId:string, folderPath:string, recursive:boolean}} FolderTarget
 * @typedef {{kind:"adhoc", profileIds:string[]}} AdhocTarget
 * @typedef {ProfileTarget|FolderTarget|AdhocTarget} TargetSpec
 */

/**
 * @typedef {{type:"send", text:string}} SendStep
 * @typedef {{type:"waitPrompt"}} WaitPromptStep
 * @typedef {{type:"waitRegex", pattern:string, timeoutMs:number}} WaitRegexStep
 * @typedef {{type:"expectExit", code:number}} ExpectExitStep
 * @typedef {{type:"sendPasswordFromKeyring", profileId:string|null}} SendPasswordFromKeyringStep
 * @typedef {{type:"sendPasswordFromKeepass", uuid:string}} SendPasswordFromKeepassStep
 * @typedef {{type:"sleep", ms:number}} SleepStep
 * @typedef {{type:"disconnect"}} DisconnectStep
 * @typedef {SendStep|WaitPromptStep|WaitRegexStep|ExpectExitStep|SendPasswordFromKeyringStep|SendPasswordFromKeepassStep|SleepStep|DisconnectStep} Step
 */

/**
 * @typedef {object} Script
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {TargetSpec} target
 * @property {Step[]} steps
 * @property {string} createdAt ISO 8601.
 * @property {string} updatedAt ISO 8601.
 */

/**
 * Credenciales alternativas de una tirada: todos los hosts se autentican con
 * este usuario/contraseña en lugar de los suyos. Nunca se persisten en el
 * `Script` (la variante `manual` vive solo en memoria durante el run).
 * @typedef {{kind:"master", id:string, username:string|null}} MasterRunCredentials
 * @typedef {{kind:"keepass", uuid:string, username:string|null}} KeepassRunCredentials
 * @typedef {{kind:"manual", username:string|null, password:string}} ManualRunCredentials
 * @typedef {MasterRunCredentials|KeepassRunCredentials|ManualRunCredentials} RunCredentials
 */

/**
 * Opciones de ejecución de una tirada (no se persisten en el `Script`).
 * @typedef {object} RunOptions
 * @property {number} concurrency Máximo de hosts en paralelo.
 * @property {"parallel"|"canary"} mode `canary` = primero uno, luego el resto.
 * @property {boolean} stopOnError Aborta la tirada al primer host que falle.
 * @property {Record<string,string>} params Parámetros `${...}` de la sustitución.
 * @property {RunCredentials|null} [credentials] Credenciales alternativas del run.
 */

/**
 * Previsualización por host de lo que se enviará (no sensible).
 * @typedef {object} HostPreview
 * @property {string} profileId
 * @property {string} host
 * @property {string} name
 * @property {string[]} commands
 */

/** Tope de pasos por receta (línea roja histórica: recetas pequeñas). */
export const MAX_STEPS = 50;

/**
 * Catálogo de los tipos de paso válidos con sus campos requeridos. Fuente única
 * para la UI (qué campos pintar) y para {@link validateScript}.
 * @satisfies {Record<string, { required: readonly string[] }>}
 */
export const STEP_TYPES = Object.freeze({
  send: Object.freeze({ required: Object.freeze(["text"]) }),
  waitPrompt: Object.freeze({ required: Object.freeze([]) }),
  waitRegex: Object.freeze({ required: Object.freeze(["pattern", "timeoutMs"]) }),
  expectExit: Object.freeze({ required: Object.freeze(["code"]) }),
  sendPasswordFromKeyring: Object.freeze({ required: Object.freeze(["profileId"]) }),
  sendPasswordFromKeepass: Object.freeze({ required: Object.freeze(["uuid"]) }),
  sleep: Object.freeze({ required: Object.freeze(["ms"]) }),
  disconnect: Object.freeze({ required: Object.freeze([]) }),
});

/**
 * Identificador aleatorio para un script nuevo (UUID si el entorno lo ofrece).
 * @returns {string}
 */
function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * `v` si es string; en caso contrario el valor por defecto.
 * @param {unknown} v
 * @param {string} d
 * @returns {string}
 */
function str(v, d) {
  return typeof v === "string" ? v : d;
}

/**
 * `v` como número finito; en caso contrario el valor por defecto.
 * @param {unknown} v
 * @param {number} d
 * @returns {number}
 */
function toNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Construye un `Step` bien formado del tipo indicado, tomando los campos de
 * `fields` y rellenando con valores por defecto los que falten.
 * @param {Step["type"]} type Tipo de paso (clave de {@link STEP_TYPES}).
 * @param {Record<string, unknown>} [fields] Campos del paso.
 * @returns {Step}
 */
export function makeStep(type, fields = {}) {
  const f = fields || {};
  switch (type) {
    case "send":
      return { type: "send", text: str(f.text, "") };
    case "waitPrompt":
      return { type: "waitPrompt" };
    case "waitRegex":
      return { type: "waitRegex", pattern: str(f.pattern, ""), timeoutMs: toNum(f.timeoutMs, 30000) };
    case "expectExit":
      return { type: "expectExit", code: toNum(f.code, 0) };
    case "sendPasswordFromKeyring":
      return { type: "sendPasswordFromKeyring", profileId: f.profileId == null ? null : String(f.profileId) };
    case "sendPasswordFromKeepass":
      return { type: "sendPasswordFromKeepass", uuid: str(f.uuid, "") };
    case "sleep":
      return { type: "sleep", ms: toNum(f.ms, 0) };
    case "disconnect":
      return { type: "disconnect" };
    default:
      throw new Error(`makeStep: tipo de paso desconocido: ${String(type)}`);
  }
}

/**
 * Script vacío listo para editar, con id y marcas de tiempo frescas.
 * @param {TargetSpec} [target] Objetivo inicial (por defecto, selección vacía).
 * @returns {Script}
 */
export function emptyScript(target = /** @type {TargetSpec} */ ({ kind: "adhoc", profileIds: [] })) {
  const now = new Date().toISOString();
  return {
    id: newId(),
    name: "",
    description: "",
    target,
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * `true` si es una cadena con contenido tras recortar espacios.
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * `true` si `pattern` compila como expresión regular.
 * @param {string} pattern
 * @returns {boolean}
 */
function isValidRegex(pattern) {
  try {
    void new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida un objetivo. Devuelve la lista de errores (vacía si es válido).
 * @param {any} target
 * @returns {string[]}
 */
function validateTarget(target) {
  if (!target || typeof target !== "object") {
    return ["El objetivo es obligatorio."];
  }
  switch (target.kind) {
    case "profile":
      return isNonEmptyString(target.profileId)
        ? []
        : ["El objetivo de tipo perfil necesita `profileId`."];
    case "folder": {
      /** @type {string[]} */
      const errs = [];
      if (typeof target.workspaceId !== "string") errs.push("La carpeta necesita `workspaceId` (cadena).");
      if (typeof target.folderPath !== "string") errs.push("La carpeta necesita `folderPath` (cadena).");
      if (typeof target.recursive !== "boolean") errs.push("La carpeta necesita `recursive` (booleano).");
      return errs;
    }
    case "adhoc":
      if (!Array.isArray(target.profileIds) || target.profileIds.length === 0) {
        return ["La selección ad-hoc necesita al menos un perfil."];
      }
      return target.profileIds.every(isNonEmptyString)
        ? []
        : ["La selección ad-hoc contiene ids inválidos."];
    default:
      return [`Tipo de objetivo desconocido: ${String(target.kind)}.`];
  }
}

/**
 * Valida un paso. Devuelve la lista de errores (vacía si es válido).
 * @param {any} step
 * @returns {string[]}
 */
function validateStep(step) {
  if (!step || typeof step !== "object") {
    return ["no es un objeto."];
  }
  switch (step.type) {
    case "send":
      return typeof step.text === "string" ? [] : ["`send` necesita `text` (cadena)."];
    case "waitPrompt":
      return [];
    case "waitRegex": {
      /** @type {string[]} */
      const errs = [];
      if (!isNonEmptyString(step.pattern)) errs.push("`waitRegex` necesita `pattern`.");
      else if (!isValidRegex(step.pattern)) errs.push("`waitRegex` tiene un `pattern` inválido.");
      if (typeof step.timeoutMs !== "number" || !Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) {
        errs.push("`waitRegex` necesita `timeoutMs` > 0.");
      }
      return errs;
    }
    case "expectExit":
      return typeof step.code === "number" && Number.isInteger(step.code)
        ? []
        : ["`expectExit` necesita `code` entero."];
    case "sendPasswordFromKeyring":
      return step.profileId === null || isNonEmptyString(step.profileId)
        ? []
        : ["`sendPasswordFromKeyring` necesita `profileId` (cadena o null)."];
    case "sendPasswordFromKeepass":
      return isNonEmptyString(step.uuid) ? [] : ["`sendPasswordFromKeepass` necesita `uuid`."];
    case "sleep":
      return typeof step.ms === "number" && Number.isFinite(step.ms) && step.ms >= 0
        ? []
        : ["`sleep` necesita `ms` >= 0."];
    case "disconnect":
      return [];
    default:
      return [`tipo de paso desconocido: ${String(step.type)}.`];
  }
}

/**
 * Valida un script completo (nombre, objetivo y cada paso).
 * @param {unknown} script
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateScript(script) {
  /** @type {string[]} */
  const errors = [];
  if (!script || typeof script !== "object") {
    return { ok: false, errors: ["El script no es un objeto."] };
  }
  const s = /** @type {any} */ (script);

  if (typeof s.name !== "string" || s.name.trim() === "") {
    errors.push("El nombre es obligatorio.");
  }

  errors.push(...validateTarget(s.target));

  if (!Array.isArray(s.steps)) {
    errors.push("Los pasos deben ser una lista.");
  } else {
    if (s.steps.length > MAX_STEPS) {
      errors.push(`Demasiados pasos (máximo ${MAX_STEPS}).`);
    }
    s.steps.forEach((/** @type {any} */ step, /** @type {number} */ i) => {
      for (const e of validateStep(step)) {
        errors.push(`Paso ${i + 1}: ${e}`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}
