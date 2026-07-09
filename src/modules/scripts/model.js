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
 * Error de validación como **código estable** + parámetros de interpolación, sin
 * texto de idioma: la capa de UI lo traduce con `t("scripts.err." + code, params)`.
 * Así el módulo puro no depende de i18n y sigue siendo testeable por código.
 * @typedef {{ code: string, params?: Record<string, string|number> }} ValidationError
 */

/**
 * Valida un objetivo. Devuelve la lista de errores (vacía si es válido).
 * @param {any} target
 * @returns {ValidationError[]}
 */
function validateTarget(target) {
  if (!target || typeof target !== "object") {
    return [{ code: "target_required" }];
  }
  switch (target.kind) {
    case "profile":
      return isNonEmptyString(target.profileId) ? [] : [{ code: "profile_needs_id" }];
    case "folder": {
      /** @type {ValidationError[]} */
      const errs = [];
      if (typeof target.workspaceId !== "string") errs.push({ code: "folder_needs_workspace" });
      if (typeof target.folderPath !== "string") errs.push({ code: "folder_needs_path" });
      if (typeof target.recursive !== "boolean") errs.push({ code: "folder_needs_recursive" });
      return errs;
    }
    case "adhoc":
      if (!Array.isArray(target.profileIds) || target.profileIds.length === 0) {
        return [{ code: "adhoc_needs_profile" }];
      }
      return target.profileIds.every(isNonEmptyString) ? [] : [{ code: "adhoc_invalid_ids" }];
    default:
      return [{ code: "target_unknown", params: { kind: String(target.kind) } }];
  }
}

/**
 * Valida un paso. Devuelve la lista de errores (vacía si es válido).
 * @param {any} step
 * @returns {ValidationError[]}
 */
function validateStep(step) {
  if (!step || typeof step !== "object") {
    return [{ code: "step_not_object" }];
  }
  switch (step.type) {
    case "send":
      return typeof step.text === "string" ? [] : [{ code: "send_needs_text" }];
    case "waitPrompt":
      return [];
    case "waitRegex": {
      /** @type {ValidationError[]} */
      const errs = [];
      if (!isNonEmptyString(step.pattern)) errs.push({ code: "waitregex_needs_pattern" });
      else if (!isValidRegex(step.pattern)) errs.push({ code: "waitregex_invalid_pattern" });
      if (typeof step.timeoutMs !== "number" || !Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) {
        errs.push({ code: "waitregex_needs_timeout" });
      }
      return errs;
    }
    case "expectExit":
      return typeof step.code === "number" && Number.isInteger(step.code)
        ? []
        : [{ code: "expectexit_needs_code" }];
    case "sendPasswordFromKeyring":
      return step.profileId === null || isNonEmptyString(step.profileId)
        ? []
        : [{ code: "keyring_needs_profile" }];
    case "sendPasswordFromKeepass":
      return isNonEmptyString(step.uuid) ? [] : [{ code: "keepass_needs_uuid" }];
    case "sleep":
      return typeof step.ms === "number" && Number.isFinite(step.ms) && step.ms >= 0
        ? []
        : [{ code: "sleep_needs_ms" }];
    case "disconnect":
      return [];
    default:
      return [{ code: "step_unknown", params: { type: String(step.type) } }];
  }
}

/**
 * Valida un script completo (nombre, objetivo y cada paso). Los errores son
 * códigos ({@link ValidationError}); la UI los traduce. Los de paso llevan el
 * número de paso en `params.step`.
 * @param {unknown} script
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function validateScript(script) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (!script || typeof script !== "object") {
    return { ok: false, errors: [{ code: "not_object" }] };
  }
  const s = /** @type {any} */ (script);

  if (typeof s.name !== "string" || s.name.trim() === "") {
    errors.push({ code: "name_required" });
  }

  errors.push(...validateTarget(s.target));

  if (!Array.isArray(s.steps)) {
    errors.push({ code: "steps_must_be_list" });
  } else {
    if (s.steps.length > MAX_STEPS) {
      errors.push({ code: "too_many_steps", params: { max: MAX_STEPS } });
    }
    s.steps.forEach((/** @type {any} */ step, /** @type {number} */ i) => {
      for (const e of validateStep(step)) {
        errors.push({ code: e.code, params: { ...(e.params || {}), step: i + 1 } });
      }
    });
  }

  return { ok: errors.length === 0, errors };
}
