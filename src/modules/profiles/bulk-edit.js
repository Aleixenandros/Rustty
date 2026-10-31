// @ts-check
/**
 * Edición en lote de perfiles de conexión: núcleo **puro**.
 *
 * Entra una lista de perfiles y un *parche* con solo los campos que el usuario
 * ha marcado como «Cambiar»; sale la lista de perfiles que de verdad cambian
 * (copias nuevas, con `updated_at` fresco para que la sync LWW los propague),
 * cuántos se saltan por tipo incompatible y un resumen para enseñar antes de
 * aplicar. Lo que no está en el parche no se toca; un perfil cuyo valor ya
 * coincide tampoco cambia (ni se fecha: fecharlo haría que la sync lo tomara
 * por una edición nueva).
 *
 * Cada campo se aplica solo a los tipos que lo admiten, con las mismas reglas
 * que el formulario de una conexión (`updateConnTypeFields` en main.js):
 *   - a todos: usuario, puerto, distintivo de entorno, carpeta y el reemplazo
 *     en el host;
 *   - solo SSH: autenticación y clave, keepalive, reconexión, algoritmos
 *     legacy, grabación de sesión y «abrir en solo lectura»;
 *   - credencial maestra: quien entre por contraseña (SSH con contraseña y los
 *     tipos que no tienen otra cosa: RDP, VNC, Telnet, FTP, FTPS);
 *   - bastión: los tipos que admiten salto (`supportsJump`); la dirección
 *     manual, solo los que admiten bastión de texto (`allowsTextBastion`); y
 *     un perfil-bastión nunca se asigna a sí mismo ni formando un bucle.
 *
 * Los secretos NO pasan por aquí: para cambiar contraseñas en lote se asigna
 * una credencial maestra (que ya vive en el keyring), nunca un campo de
 * contraseña. Sin DOM ni IPC.
 */
import { allowsTextBastion, isUsableJump, supportsJump } from "../jump-route.js";

/**
 * @typedef {Record<string, any> & { id: string, connection_type?: string|null, host?: string }} BulkProfile
 *
 * @typedef {object} BulkPatch
 * @property {string} [username]
 * @property {number} [port]
 * @property {{ auth_type: string, key_path?: string|null }} [auth] Con `public_key` y ruta vacía, cada perfil conserva la suya.
 * @property {string|null} [master_credential] Id de credencial maestra; `null` vuelve a la contraseña propia.
 * @property {{ profile_id: string }|{ text: string }|null} [bastion] `null` quita el bastión.
 * @property {number|null} [keep_alive_secs]
 * @property {number|null} [auto_reconnect]
 * @property {string|null} [environment]
 * @property {boolean} [legacy] Permitir algoritmos antiguos (al activarlo, cada perfil conserva su subconjunto).
 * @property {boolean} [session_log]
 * @property {boolean} [open_read_only]
 * @property {string|null} [group] Carpeta; `null` la raíz.
 * @property {{ from: string, to: string }} [host_replace] Subcadena literal, sin regex.
 *
 * @typedef {object} FieldStats
 * @property {number} applied Perfiles en los que el campo cambia de verdad.
 * @property {number} skipped Perfiles que no admiten el campo (tipo incompatible o bucle de salto).
 * @property {number} unchanged Perfiles que lo admiten pero ya tenían ese valor.
 *
 * @typedef {object} BulkSummary
 * @property {number} fields Campos marcados en el parche.
 * @property {number} total Perfiles de entrada.
 * @property {number} changed Perfiles que cambian al menos en un campo.
 * @property {number} skippedProfiles Perfiles que se saltan en al menos un campo.
 * @property {Record<string, number>} skipped Por campo: perfiles que lo saltan.
 * @property {Record<string, FieldStats>} perField
 * @property {Array<{ id: string, name: string, before: string, after: string }>} hostPreview Solo con `host_replace`.
 *
 * @typedef {object} BulkResult
 * @property {BulkProfile[]} profiles Solo los que cambian, ya con `updated_at`.
 * @property {number} changed
 * @property {Record<string, number>} skipped
 * @property {BulkSummary} summary
 *
 * @typedef {object} BulkUndo
 * @property {string[]} ids
 * @property {BulkProfile[]} snapshot Copias de los perfiles tal como estaban antes.
 */

/** Orden de aplicación: la autenticación va antes que la credencial maestra (depende de ella). */
export const BULK_FIELD_KEYS = Object.freeze([
  "username", "port", "auth", "master_credential", "bastion", "keep_alive_secs",
  "auto_reconnect", "environment", "legacy", "session_log", "open_read_only", "group", "host_replace",
]);

export const AUTH_TYPES = Object.freeze(["password", "public_key", "agent", "keyboard_interactive"]);
export const ENVIRONMENTS = Object.freeze(["prod", "stage", "dev"]);
export const KEEP_ALIVE_MAX_SECS = 3600;
export const AUTO_RECONNECT_MAX = 20;

/** @param {BulkProfile} p */
function typeOf(p) {
  return String(p?.connection_type || "ssh").toLowerCase();
}

/** @param {BulkProfile} p */
function isSsh(p) {
  return typeOf(p) === "ssh";
}

/** Tipos que entran siempre por contraseña (el formulario fuerza `auth_type: "password"`). */
/** @param {BulkProfile} p */
function isPasswordOnlyType(p) {
  return ["rdp", "vnc", "telnet", "ftp", "ftps"].includes(typeOf(p));
}

/** @param {unknown} v */
function nz(v) {
  return v === undefined ? null : v;
}

/**
 * Igualdad de un valor de perfil: `null`/`undefined` cuentan lo mismo y los
 * arrays (algoritmos legacy) se comparan por contenido.
 * @param {unknown} a
 * @param {unknown} b
 */
function sameValue(a, b) {
  const x = nz(a);
  const y = nz(b);
  if (Array.isArray(x) || Array.isArray(y)) return JSON.stringify(x) === JSON.stringify(y);
  return x === y;
}

/**
 * Carpeta normalizada: sin espacios ni barras sobrantes; vacía = raíz.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeFolder(value) {
  if (value === null || value === undefined) return null;
  const parts = String(value).split("/").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts.join("/") : null;
}

/**
 * Reemplazo literal (sin regex) de `from` por `to` en el host; todas las
 * apariciones, distinguiendo mayúsculas. Sin `from`, el host no cambia.
 * @param {string|null|undefined} host
 * @param {string} from
 * @param {string} to
 */
export function replaceHost(host, from, to) {
  const h = host == null ? "" : String(host);
  if (!from) return h;
  return h.split(from).join(to == null ? "" : String(to));
}

/**
 * @typedef {object} FieldDef
 * @property {(p: BulkProfile, value: any, ctx: { catalog: BulkProfile[] }) => boolean} admits
 * @property {(p: BulkProfile, value: any) => Record<string, any>} mods Valores a poner (se compara con lo que hay).
 */

/** @type {Record<string, FieldDef>} */
const FIELDS = {
  username: {
    admits: () => true,
    mods: (_p, value) => ({ username: String(value ?? "").trim() }),
  },
  port: {
    admits: () => true,
    mods: (_p, value) => ({ port: value }),
  },
  auth: {
    admits: (p) => isSsh(p),
    mods: (p, value) => {
      const authType = value.auth_type;
      /** @type {Record<string, any>} */
      const out = { auth_type: authType };
      if (authType === "public_key") {
        const path = String(value.key_path ?? "").trim();
        out.key_path = path || nz(p.key_path);
      } else {
        out.key_path = null;
      }
      // Como el formulario: sin contraseña no hay origen de contraseña.
      if (authType !== "password") {
        out.password_source = "own";
        out.master_credential_id = null;
        out.keepass_entry_uuid = null;
        out.keepass_property = null;
      }
      return out;
    },
  },
  master_credential: {
    // Se evalúa sobre el perfil ya con la autenticación aplicada.
    admits: (p) => isPasswordOnlyType(p) || (isSsh(p) && (p.auth_type || "password") === "password"),
    mods: (_p, value) => (value
      ? { password_source: "master", master_credential_id: value, keepass_entry_uuid: null, keepass_property: null }
      : { password_source: "own", master_credential_id: null, keepass_entry_uuid: null, keepass_property: null }),
  },
  bastion: {
    admits: (p, value, { catalog }) => {
      if (!supportsJump(typeOf(p))) return false;
      if (value === null) return true;
      if ("text" in value) return allowsTextBastion(typeOf(p));
      return isUsableJump(value.profile_id, p.id, /** @type {any} */ (catalog));
    },
    mods: (_p, value) => {
      if (value === null) return { proxy_jump: null, proxy_jump_profile_id: null };
      if ("text" in value) return { proxy_jump: String(value.text).trim(), proxy_jump_profile_id: null };
      return { proxy_jump: null, proxy_jump_profile_id: value.profile_id };
    },
  },
  keep_alive_secs: {
    admits: (p) => isSsh(p),
    mods: (_p, value) => ({ keep_alive_secs: value }),
  },
  auto_reconnect: {
    admits: (p) => isSsh(p),
    mods: (_p, value) => ({ auto_reconnect: value }),
  },
  environment: {
    admits: () => true,
    mods: (_p, value) => ({ environment: value || null }),
  },
  legacy: {
    admits: (p) => isSsh(p),
    mods: (p, value) => ({
      allow_legacy_algorithms: !!value,
      legacy_algorithms: value ? nz(p.legacy_algorithms) : null,
    }),
  },
  session_log: {
    admits: (p) => isSsh(p),
    mods: (_p, value) => ({ session_log: !!value }),
  },
  open_read_only: {
    admits: (p) => isSsh(p),
    mods: (_p, value) => ({ open_read_only: !!value }),
  },
  group: {
    admits: () => true,
    mods: (_p, value) => ({ group: normalizeFolder(value) }),
  },
  host_replace: {
    admits: () => true,
    mods: (p, value) => ({ host: replaceHost(p.host, value.from, value.to) }),
  },
};

/**
 * Claves del parche que son campos conocidos, en orden de aplicación.
 * @param {BulkPatch|null|undefined} patch
 */
export function markedFields(patch) {
  if (!patch) return [];
  return BULK_FIELD_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

/**
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 */
function isIntBetween(v, min, max) {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Campos del parche con un valor inválido (vacío = todo bien). La interfaz
 * normaliza antes (números desde texto, 0 → null…); aquí solo se comprueba.
 * @param {BulkPatch|null|undefined} patch
 * @returns {string[]}
 */
export function validateBulkPatch(patch) {
  /** @type {string[]} */
  const bad = [];
  if (!patch) return bad;
  /** @param {string} k */
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("username") && typeof patch.username !== "string") bad.push("username");
  if (has("port") && !isIntBetween(patch.port, 1, 65535)) bad.push("port");
  if (has("auth")) {
    const a = patch.auth;
    if (!a || !AUTH_TYPES.includes(a.auth_type)) bad.push("auth");
    else if (a.key_path != null && typeof a.key_path !== "string") bad.push("auth");
  }
  if (has("master_credential") && patch.master_credential !== null
    && !(typeof patch.master_credential === "string" && patch.master_credential.length)) bad.push("master_credential");
  if (has("bastion")) {
    const b = patch.bastion;
    const okProfile = !!b && typeof b === "object" && "profile_id" in b && typeof b.profile_id === "string" && b.profile_id.length > 0;
    const okText = !!b && typeof b === "object" && "text" in b && typeof b.text === "string" && b.text.trim().length > 0;
    if (!(b === null || okProfile || okText)) bad.push("bastion");
  }
  if (has("keep_alive_secs") && patch.keep_alive_secs !== null && !isIntBetween(patch.keep_alive_secs, 1, KEEP_ALIVE_MAX_SECS)) bad.push("keep_alive_secs");
  if (has("auto_reconnect") && patch.auto_reconnect !== null && !isIntBetween(patch.auto_reconnect, 1, AUTO_RECONNECT_MAX)) bad.push("auto_reconnect");
  if (has("environment") && patch.environment !== null && !ENVIRONMENTS.includes(String(patch.environment))) bad.push("environment");
  for (const k of ["legacy", "session_log", "open_read_only"]) {
    if (has(k) && typeof (/** @type {Record<string, unknown>} */ (patch))[k] !== "boolean") bad.push(k);
  }
  if (has("group") && patch.group !== null && typeof patch.group !== "string") bad.push("group");
  if (has("host_replace")) {
    const r = patch.host_replace;
    if (!r || typeof r.from !== "string" || !r.from.length || (r.to != null && typeof r.to !== "string")) bad.push("host_replace");
  }
  return bad;
}

/**
 * Un parche solo con los campos marcados y bien formados (lo que la interfaz
 * lee de los controles, ya tipado). Es el núcleo de `applyBulkEdit` y de
 * `summarizeBulkEdit`: el mismo recorrido, con o sin fecha.
 * @param {BulkProfile[]} profiles
 * @param {BulkPatch} patch
 * @param {{ now?: string|null, catalog?: BulkProfile[] }} [options]
 * @returns {BulkResult}
 */
function plan(profiles, patch, { now = null, catalog } = {}) {
  const fields = markedFields(patch);
  const ctx = { catalog: catalog || profiles || [] };
  /** @type {Record<string, FieldStats>} */
  const perField = {};
  for (const key of fields) perField[key] = { applied: 0, skipped: 0, unchanged: 0 };
  /** @type {BulkProfile[]} */
  const changedProfiles = [];
  /** @type {BulkSummary["hostPreview"]} */
  const hostPreview = [];
  let skippedProfiles = 0;

  for (const original of profiles || []) {
    if (!original || typeof original.id !== "string") continue;
    /** @type {BulkProfile} */
    const working = { ...original };
    let changed = false;
    let skippedHere = false;
    for (const key of fields) {
      const def = FIELDS[key];
      const value = /** @type {any} */ (patch)[key];
      if (!def.admits(working, value, ctx)) {
        perField[key].skipped++;
        skippedHere = true;
        continue;
      }
      const mods = def.mods(working, value);
      let touched = false;
      for (const [k, v] of Object.entries(mods)) {
        if (sameValue(working[k], v)) continue;
        working[k] = v;
        touched = true;
      }
      if (touched) {
        perField[key].applied++;
        changed = true;
        if (key === "host_replace") {
          hostPreview.push({ id: original.id, name: String(original.name || original.host || original.id), before: String(original.host ?? ""), after: String(working.host ?? "") });
        }
      } else {
        perField[key].unchanged++;
      }
    }
    if (skippedHere) skippedProfiles++;
    if (changed) {
      if (now) working.updated_at = now;
      changedProfiles.push(working);
    }
  }

  /** @type {Record<string, number>} */
  const skipped = {};
  for (const key of fields) skipped[key] = perField[key].skipped;
  const summary = {
    fields: fields.length,
    total: (profiles || []).length,
    changed: changedProfiles.length,
    skippedProfiles,
    skipped,
    perField,
    hostPreview,
  };
  return { profiles: changedProfiles, changed: changedProfiles.length, skipped, summary };
}

/**
 * Aplica el parche. Devuelve solo los perfiles que cambian, como copias nuevas
 * con `updated_at = now`; los de entrada no se mutan.
 * @param {BulkProfile[]} profiles Perfiles seleccionados.
 * @param {BulkPatch} patch
 * @param {{ now: string, catalog?: BulkProfile[] }} options `catalog`: todo el
 *   catálogo, para comprobar bucles de salto (por defecto, los seleccionados).
 * @returns {BulkResult}
 */
export function applyBulkEdit(profiles, patch, { now, catalog } = { now: new Date().toISOString() }) {
  return plan(profiles, patch, { now: now || new Date().toISOString(), catalog });
}

/**
 * Vista previa sin fechar nada: «se cambiarán N campos en M conexiones» y
 * cuántas se saltan por campo.
 * @param {BulkProfile[]} profiles
 * @param {BulkPatch} patch
 * @param {{ catalog?: BulkProfile[] }} [options]
 * @returns {BulkSummary}
 */
export function summarizeBulkEdit(profiles, patch, { catalog } = {}) {
  return plan(profiles, patch, { now: null, catalog }).summary;
}

/**
 * Foto anterior de los perfiles que cambian, para el «Deshacer» del aviso.
 * @param {BulkProfile[]} before Los perfiles tal como estaban (los seleccionados).
 * @param {BulkResult} result
 * @returns {BulkUndo}
 */
export function buildUndo(before, result) {
  const ids = new Set((result?.profiles || []).map((p) => p.id));
  const snapshot = (before || [])
    .filter((p) => p && ids.has(p.id))
    .map((p) => JSON.parse(JSON.stringify(p)));
  return { ids: snapshot.map((p) => p.id), snapshot };
}

/**
 * Perfiles a guardar para deshacer: la foto anterior tal cual, salvo
 * `updated_at`, que se refresca (la sync LWW debe ver el deshacer como la
 * edición más reciente, igual que al restaurar desde la papelera). Los ids
 * que ya no existen (borrados entre medias) no se resucitan.
 * @param {BulkUndo} undo
 * @param {{ now: string, existingIds?: Iterable<string> }} options
 * @returns {BulkProfile[]}
 */
export function applyUndo(undo, { now, existingIds }) {
  const alive = existingIds ? new Set(existingIds) : null;
  return (undo?.snapshot || [])
    .filter((p) => !alive || alive.has(p.id))
    .map((p) => ({ ...JSON.parse(JSON.stringify(p)), updated_at: now }));
}

/**
 * ¿Admite este perfil el campo? Para que la interfaz enseñe, por campo, cuántos
 * de los seleccionados se saltarían antes incluso de elegir un valor.
 * @param {string} key
 * @param {BulkProfile} profile
 */
export function fieldAdmits(key, profile) {
  const def = FIELDS[key];
  if (!def) return false;
  if (key === "bastion") return supportsJump(typeOf(profile));
  if (key === "master_credential") return FIELDS.master_credential.admits(profile, null, { catalog: [] });
  return def.admits(profile, null, { catalog: [] });
}
