// @ts-check
/**
 * Núcleo **puro** de la ruta de una conexión: por qué saltos SSH pasa antes de
 * llegar a su destino. Lo calcula el frontend con las mismas reglas que aplica
 * el backend (`src-tauri/src/jump_route.rs`) y se lo manda ya resuelto
 * (`jumps`), así que estas reglas son contrato: cambiarlas aquí sin tocar
 * allí dejaría a la interfaz anunciando una ruta y al backend usando otra.
 *
 * Vocabulario:
 *   - **bastión de un perfil**: `proxy_jump_profile_id` (otro perfil guardado,
 *     que se autentica con SUS credenciales) o, si no lo hay, el texto
 *     `proxy_jump` («dirección manual», con las credenciales del propio perfil).
 *   - **cadena** `chain(P)`: los perfiles-salto que hay antes de P siguiendo los
 *     `proxy_jump_profile_id`, del más cercano a este equipo al más lejano. Los
 *     bastiones de texto no entran: los inserta el backend.
 *   - **salto activo**: un perfil SSH elegido para que TODA conexión nueva salga
 *     por él (preferencia local, no se sincroniza).
 *
 * Sin DOM ni IPC: entra el catálogo de perfiles y sale la ruta o el motivo por
 * el que no se puede conectar.
 */
import { foldSearchText, searchTokens } from "./connection-search.js";

/** Saltos como mucho en una ruta, contando los de texto (espejo del backend). */
export const MAX_JUMPS = 8;
/** Saltos recientes que recuerda el equipo. */
export const MAX_RECENT_JUMPS = 5;
/** Tipos de perfil que pueden hacer de salto: los que hablan SSH. */
export const JUMP_CAPABLE_TYPES = Object.freeze(["ssh", "sftp"]);
/** Tipos que pueden ir por un salto (los demás conectan siempre directo). */
export const JUMP_SUPPORTED_TYPES = Object.freeze(["ssh", "sftp", "rdp", "vnc", "telnet"]);
/**
 * Tipos que pueden llevar un bastión de texto («dirección manual»): el salto
 * de texto entra con las credenciales del propio perfil, así que hace falta
 * una contraseña o clave que sirva para SSH. VNC y Telnet no la tienen.
 */
export const TEXT_BASTION_TYPES = Object.freeze(["ssh", "sftp", "rdp"]);
/** Qué hacer con un protocolo que no puede ir por el salto activo. */
export const JUMP_UNSUPPORTED_POLICIES = Object.freeze(["direct", "block"]);
/** Cuándo se ve la píldora de ruta en la barra lateral. */
export const ROUTE_PILL_MODES = Object.freeze(["auto", "always", "never"]);
/** Segundos de inactividad de la conexión compartida con un salto (límites). */
export const JUMP_IDLE_MIN_SECS = 5;
export const JUMP_IDLE_MAX_SECS = 3600;
export const JUMP_IDLE_DEFAULT_SECS = 60;

/**
 * @typedef {{
 *   id: string,
 *   name?: string,
 *   host?: string,
 *   port?: number,
 *   username?: string,
 *   group?: string|null,
 *   connection_type?: string,
 *   proxy_jump?: string|null,
 *   proxy_jump_profile_id?: string|null,
 *   ignore_active_jump?: boolean,
 * }} JumpProfile
 */

/**
 * Por qué no se puede conectar. `profileId` es el perfil que hay que editar
 * para arreglarlo (el que apunta a un bastión inexistente, el que cierra el
 * bucle…), o `null` si el fallo es del salto activo o del elegido a mano.
 * `via` dice de dónde venía el salto que falla.
 * @typedef {{
 *   kind: "missing"|"loop"|"not_ssh"|"too_long",
 *   via: "own"|"active"|"override"|"route",
 *   profileId: string|null,
 *   profileName: string|null,
 *   jumpId: string|null,
 *   jumpName: string|null,
 *   count?: number,
 *   max?: number,
 * }} RouteError
 */

/**
 * @typedef {{
 *   jumps: string[],
 *   source: "none"|"own"|"active"|"override",
 *   clearTextBastion: boolean,
 *   unsupported: boolean,
 *   error: RouteError|null,
 * }} RouteResult
 */

/** @typedef {{ direct?: boolean, viaProfileId?: string|null }} RouteOverride */

/**
 * @param {JumpProfile|null|undefined} profile
 * @returns {string}
 */
function typeOf(profile) {
  return String(profile?.connection_type || "ssh").toLowerCase();
}

/**
 * @param {JumpProfile[]} profiles
 * @returns {Map<string, JumpProfile>}
 */
function indexById(profiles) {
  const map = new Map();
  for (const p of profiles || []) if (p && typeof p.id === "string") map.set(p.id, p);
  return map;
}

/**
 * @param {JumpProfile|null|undefined} profile
 * @returns {string|null}
 */
function nameOf(profile) {
  if (!profile) return null;
  return profile.name || profile.host || profile.id || null;
}

/**
 * ¿Puede este perfil hacer de salto? Solo los que hablan SSH.
 * @param {JumpProfile|null|undefined} profile
 */
export function isJumpCapable(profile) {
  return !!profile && JUMP_CAPABLE_TYPES.includes(typeOf(profile));
}

/**
 * ¿Puede una conexión de este tipo ir por un salto? FTP/FTPS/WebDAV no: los
 * datos de FTP pasivo usan otros puertos y HTTPS rompería el nombre del
 * certificado.
 * @param {string|null|undefined} connectionType
 */
export function supportsJump(connectionType) {
  return JUMP_SUPPORTED_TYPES.includes(String(connectionType || "ssh").toLowerCase());
}

/**
 * ¿Se le puede poner a este tipo un bastión de texto («dirección manual»)?
 * @param {string|null|undefined} connectionType
 */
export function allowsTextBastion(connectionType) {
  return TEXT_BASTION_TYPES.includes(String(connectionType || "ssh").toLowerCase());
}

/**
 * El perfil tal como lo ve la ruta cuando «Conectar con cambios» le pone un
 * bastión de texto puntual (`overrides.proxy_jump`, también "" para quitarlo):
 * ese texto sustituye al bastión propio, perfil-bastión incluido, igual que hace
 * el backend con su copia del perfil. Sin ese override, el perfil sin tocar.
 * @template {JumpProfile} P
 * @param {P} profile
 * @param {{ proxy_jump?: string|null }|null|undefined} overrides
 * @returns {P}
 */
export function withBastionOverride(profile, overrides) {
  if (!profile || !overrides || overrides.proxy_jump === undefined || overrides.proxy_jump === null) return profile;
  const text = String(overrides.proxy_jump).trim();
  return { ...profile, proxy_jump_profile_id: null, proxy_jump: text || null };
}

/**
 * Bastión de texto que usa de verdad el perfil: el `proxy_jump` cuenta solo si
 * no hay un perfil-bastión, que manda sobre él.
 * @param {JumpProfile|null|undefined} profile
 * @returns {string}
 */
export function textBastionOf(profile) {
  if (!profile || profile.proxy_jump_profile_id) return "";
  return String(profile.proxy_jump || "").trim();
}

/**
 * @param {RouteError["kind"]} kind
 * @param {Partial<RouteError>} fields
 * @returns {RouteError}
 */
function routeError(kind, fields) {
  return {
    kind,
    via: fields.via || "own",
    profileId: fields.profileId ?? null,
    profileName: fields.profileName ?? null,
    jumpId: fields.jumpId ?? null,
    jumpName: fields.jumpName ?? null,
    ...(fields.count !== undefined ? { count: fields.count } : {}),
    ...(fields.max !== undefined ? { max: fields.max } : {}),
  };
}

/**
 * Cadena de saltos ANTES de `profile` por sus `proxy_jump_profile_id`, del más
 * cercano a este equipo al más lejano: `chain(P) = [...chain(B), B]`. Detecta
 * bastiones que ya no existen (llegados por sync), bastiones que no son SSH,
 * bucles y cadenas de más de `MAX_JUMPS`. Con error, `ids` trae lo recorrido.
 * @param {JumpProfile|null|undefined} profile
 * @param {JumpProfile[]} profiles
 * @returns {{ ids: string[], error: RouteError|null }}
 */
export function jumpChain(profile, profiles) {
  return chainWith(profile, indexById(profiles));
}

/**
 * @param {JumpProfile|null|undefined} profile
 * @param {Map<string, JumpProfile>} byId
 * @returns {{ ids: string[], error: RouteError|null }}
 */
function chainWith(profile, byId) {
  /** @type {string[]} */
  const ids = [];
  if (!profile) return { ids, error: null };
  const seen = new Set([profile.id]);
  let cur = profile;
  while (cur.proxy_jump_profile_id) {
    const nextId = String(cur.proxy_jump_profile_id);
    const next = byId.get(nextId);
    const at = { profileId: cur.id, profileName: nameOf(cur), jumpId: nextId };
    if (!next) return { ids, error: routeError("missing", at) };
    if (seen.has(nextId)) return { ids, error: routeError("loop", { ...at, jumpName: nameOf(next) }) };
    if (!isJumpCapable(next)) return { ids, error: routeError("not_ssh", { ...at, jumpName: nameOf(next) }) };
    ids.unshift(nextId);
    if (ids.length > MAX_JUMPS) {
      return { ids, error: routeError("too_long", { ...at, jumpName: nameOf(next), count: ids.length, max: MAX_JUMPS }) };
    }
    seen.add(nextId);
    cur = next;
  }
  return { ids, error: null };
}

/**
 * Saltos de la ruta contando los de texto que insertará el backend: uno por
 * cada salto con `proxy_jump` de texto (sin perfil-bastión) y otro por el del
 * destino, salvo que «Sin saltos» lo haya quitado.
 * @param {string[]} ids
 * @param {Map<string, JumpProfile>} byId
 * @param {JumpProfile} target
 * @param {boolean} clearTextBastion
 */
function hopCount(ids, byId, target, clearTextBastion) {
  let count = ids.length;
  for (const id of ids) if (textBastionOf(byId.get(id))) count += 1;
  if (!clearTextBastion && textBastionOf(target)) count += 1;
  return count;
}

/**
 * Ruta de una conexión NUEVA al perfil `target`. Reglas (contrato con el
 * backend, ver la cabecera):
 *
 *   - override `{ direct: true }` («Sin saltos»): ningún salto, ni siquiera el
 *     bastión de texto del destino (`clearTextBastion`).
 *   - override `{ viaProfileId: V }`: `prefix = [...chain(V), V]`.
 *   - sin override: `prefix = [...chain(A), A]` con el salto activo A, si el
 *     destino admite salto, no es A, no lo ignora (`ignore_active_jump`) y no
 *     está en la cadena de A; si no, `prefix = []`.
 *   - `own = [...chain(B), B]` con el perfil-bastión B del destino.
 *   - si `own` ya pasa por algún salto del `prefix`, `prefix = []`.
 *   - `jumps = [...prefix, ...own]`; un id repetido (o el propio destino) es un
 *     bucle. Como mucho `MAX_JUMPS` saltos, contando los de texto.
 *
 * Un tipo que no admite salto (FTP, WebDAV…) sale con `jumps = []` y
 * `unsupported = true` cuando le habría tocado alguno: quien llama decide si
 * conecta directo avisando o no conecta.
 * @param {JumpProfile|null|undefined} target
 * @param {{ profiles?: JumpProfile[], activeJumpId?: string|null, override?: RouteOverride|null }} [options]
 * @returns {RouteResult}
 */
export function resolveJumpRoute(target, { profiles = [], activeJumpId = null, override = null } = {}) {
  /** @type {RouteResult} */
  const result = { jumps: [], source: "none", clearTextBastion: false, unsupported: false, error: null };
  if (!target) return result;
  if (override?.direct) {
    result.source = "override";
    result.clearTextBastion = true;
    return result;
  }
  const byId = indexById(profiles);
  const canJump = supportsJump(typeOf(target));
  const viaId = override?.viaProfileId ? String(override.viaProfileId) : null;

  if (!canJump) {
    const activeApplies = !!activeJumpId && !target.ignore_active_jump;
    if (viaId || activeApplies || target.proxy_jump_profile_id) {
      result.unsupported = true;
      result.source = viaId ? "override" : activeApplies ? "active" : "own";
    }
    return result;
  }

  // Ruta propia del destino.
  /** @type {string[]} */
  let own = [];
  if (target.proxy_jump_profile_id) {
    const chain = chainWith(target, byId);
    if (chain.error) return { ...result, error: { ...chain.error, via: "own" } };
    own = chain.ids;
  }

  // Salto puesto delante: el elegido a mano o el activo.
  /** @type {string[]} */
  let prefix = [];
  /** @type {RouteResult["source"]} */
  let source = "none";
  if (viaId) {
    source = "override";
    const via = byId.get(viaId);
    if (!via) return { ...result, source, error: routeError("missing", { via: "override", jumpId: viaId }) };
    if (!isJumpCapable(via)) {
      return { ...result, source, error: routeError("not_ssh", { via: "override", jumpId: viaId, jumpName: nameOf(via) }) };
    }
    const chain = chainWith(via, byId);
    if (chain.error) return { ...result, source, error: { ...chain.error, via: "override" } };
    prefix = [...chain.ids, viaId];
  } else if (activeJumpId && target.id !== activeJumpId && !target.ignore_active_jump) {
    const active = byId.get(activeJumpId);
    if (!active) {
      return { ...result, source: "active", error: routeError("missing", { via: "active", jumpId: activeJumpId }) };
    }
    if (!isJumpCapable(active)) {
      return {
        ...result, source: "active",
        error: routeError("not_ssh", { via: "active", jumpId: activeJumpId, jumpName: nameOf(active) }),
      };
    }
    const chain = chainWith(active, byId);
    if (chain.error) return { ...result, source: "active", error: { ...chain.error, via: "active" } };
    // El destino es uno de los saltos que llevan al activo: va por su camino.
    if (!chain.ids.includes(target.id)) {
      prefix = [...chain.ids, activeJumpId];
      source = "active";
    }
  }

  // La ruta propia ya sale por ese salto (p. ej. su bastión ES el activo).
  if (prefix.length && own.some((id) => prefix.includes(id))) {
    prefix = [];
    if (source === "active") source = "none";
  }
  if (source === "none" && own.length) source = "own";

  const jumps = [...prefix, ...own];
  result.source = source;
  const seen = new Set();
  for (const id of jumps) {
    if (seen.has(id) || id === target.id) {
      const culprit = byId.get(id);
      return {
        ...result,
        error: routeError("loop", {
          via: viaOf(source),
          profileId: target.id, profileName: nameOf(target), jumpId: id, jumpName: nameOf(culprit),
        }),
      };
    }
    seen.add(id);
  }
  const count = hopCount(jumps, byId, target, false);
  if (count > MAX_JUMPS) {
    return {
      ...result,
      error: routeError("too_long", {
        via: viaOf(source),
        profileId: target.id, profileName: nameOf(target), count, max: MAX_JUMPS,
      }),
    };
  }
  result.jumps = jumps;
  return result;
}

/**
 * @param {RouteResult["source"]} source
 * @returns {RouteError["via"]}
 */
function viaOf(source) {
  return source === "none" ? "own" : source;
}

/**
 * Revalida una ruta ya usada (reconexión, panel SFTP de una sesión abierta):
 * los mismos saltos, en el mismo orden, siguen existiendo, hablan SSH, no se
 * repiten y caben en el tope. Devuelve el primer problema o `null`.
 * @param {string[]} ids
 * @param {JumpProfile|null|undefined} target
 * @param {JumpProfile[]} profiles
 * @param {{ clearTextBastion?: boolean }} [options]
 * @returns {RouteError|null}
 */
export function validateJumpIds(ids, target, profiles, { clearTextBastion = false } = {}) {
  const byId = indexById(profiles);
  const seen = new Set();
  for (const id of ids || []) {
    const p = byId.get(id);
    if (!p) return routeError("missing", { via: "route", jumpId: id });
    if (!isJumpCapable(p)) return routeError("not_ssh", { via: "route", jumpId: id, jumpName: nameOf(p) });
    if (seen.has(id) || (target && id === target.id)) {
      return routeError("loop", {
        via: "route", profileId: target?.id ?? null, profileName: nameOf(target), jumpId: id, jumpName: nameOf(p),
      });
    }
    seen.add(id);
  }
  if (target) {
    const count = hopCount(ids || [], byId, target, clearTextBastion);
    if (count > MAX_JUMPS) {
      return routeError("too_long", { via: "route", profileId: target.id, profileName: nameOf(target), count, max: MAX_JUMPS });
    }
  }
  return null;
}

/**
 * Etiquetas de cada salto de la ruta, en orden, incluidos los bastiones de
 * texto que insertará el backend (y el del destino si sigue aplicando). Un id
 * que ya no existe se enseña tal cual: es mejor que callarlo.
 * @param {string[]} ids
 * @param {JumpProfile[]} profiles
 * @param {{ target?: JumpProfile|null, clearTextBastion?: boolean }} [options]
 * @returns {string[]}
 */
export function routeHops(ids, profiles, { target = null, clearTextBastion = false } = {}) {
  const byId = indexById(profiles);
  /** @type {string[]} */
  const out = [];
  for (const id of ids || []) {
    const p = byId.get(id);
    const text = textBastionOf(p);
    if (text) out.push(text);
    out.push(nameOf(p) || id);
  }
  if (target && !clearTextBastion) {
    const text = textBastionOf(target);
    if (text) out.push(text);
  }
  return out;
}

/**
 * Ruta legible: «oficina-win → bastión-dmz».
 * @param {string[]} ids
 * @param {JumpProfile[]} profiles
 * @param {{ target?: JumpProfile|null, clearTextBastion?: boolean }} [options]
 */
export function describeRoute(ids, profiles, options = {}) {
  return routeHops(ids, profiles, options).join(" → ");
}

/**
 * ¿Sirve `candidateId` como salto para llegar a `targetId`? Tiene que existir,
 * hablar SSH, tener una cadena sana y no pasar por el propio destino (ni serlo).
 * Sin destino (salto activo), basta con lo primero.
 * @param {string} candidateId
 * @param {string|null|undefined} targetId
 * @param {JumpProfile[]} profiles
 */
export function isUsableJump(candidateId, targetId, profiles) {
  return usableWith(candidateId, targetId ?? null, indexById(profiles));
}

/**
 * @param {string} candidateId
 * @param {string|null} targetId
 * @param {Map<string, JumpProfile>} byId
 */
function usableWith(candidateId, targetId, byId) {
  const p = byId.get(candidateId);
  if (!p || !isJumpCapable(p)) return false;
  if (targetId && candidateId === targetId) return false;
  const chain = chainWith(p, byId);
  if (chain.error) return false;
  return !(targetId && chain.ids.includes(targetId));
}

/**
 * Bastiones elegibles en el formulario del perfil `editingId`: los perfiles
 * SSH/SFTP salvo él mismo y los que ya pasan por él (formarían un bucle).
 * Ordenados por nombre. Un perfil nuevo (`editingId` nulo) puede elegir
 * cualquiera.
 * @param {JumpProfile[]} profiles
 * @param {string|null|undefined} editingId
 * @returns {JumpProfile[]}
 */
export function bastionChoices(profiles, editingId) {
  const byId = indexById(profiles);
  return (profiles || [])
    .filter((p) => {
      if (!isJumpCapable(p) || p.id === editingId) return false;
      if (!editingId) return true;
      const chain = chainWith(p, byId);
      return !chain.ids.includes(editingId) && chain.error?.jumpId !== editingId;
    })
    .sort(byName);
}

/**
 * @param {JumpProfile} a
 * @param {JumpProfile} b
 */
function byName(a, b) {
  return String(nameOf(a) || "").localeCompare(String(nameOf(b) || ""), undefined, { sensitivity: "base" });
}

/**
 * Perfiles que tienen a `id` como perfil-bastión (para avisar al borrarlo).
 * @param {JumpProfile[]} profiles
 * @param {string} id
 * @returns {JumpProfile[]}
 */
export function bastionReferrers(profiles, id) {
  return (profiles || []).filter((p) => p && p.id !== id && p.proxy_jump_profile_id === id);
}

/**
 * Candidatos a salto que se ofrecen en los menús: el salto activo, los
 * recientes y los perfiles que ya hacen de bastión de alguien, en ese orden y
 * sin repetir. Fuera el propio destino (`excludeId`) y los que formarían un
 * bucle con él.
 * @param {JumpProfile[]} profiles
 * @param {{ activeJumpProfileId?: string|null, recentJumpProfileIds?: string[] }} prefs
 * @param {string|null} [excludeId]
 * @returns {{ id: string, profile: JumpProfile, active: boolean, recent: boolean, bastion: boolean }[]}
 */
export function jumpCandidates(profiles, prefs, excludeId = null) {
  const byId = indexById(profiles);
  const activeId = prefs?.activeJumpProfileId || null;
  const recent = new Set(Array.isArray(prefs?.recentJumpProfileIds) ? prefs.recentJumpProfileIds : []);
  const bastionIds = new Set();
  for (const p of profiles || []) if (p?.proxy_jump_profile_id) bastionIds.add(String(p.proxy_jump_profile_id));
  /** @type {{ id: string, profile: JumpProfile, active: boolean, recent: boolean, bastion: boolean }[]} */
  const out = [];
  const taken = new Set();
  /** @param {string} id */
  const push = (id) => {
    if (!id || taken.has(id)) return;
    taken.add(id);
    if (!usableWith(id, excludeId, byId)) return;
    const profile = /** @type {JumpProfile} */ (byId.get(id));
    out.push({ id, profile, active: id === activeId, recent: recent.has(id), bastion: bastionIds.has(id) });
  };
  if (activeId) push(activeId);
  for (const id of recent) push(id);
  const bastions = [...bastionIds]
    .map((id) => byId.get(id))
    .filter((p) => !!p)
    .sort((a, b) => byName(/** @type {JumpProfile} */ (a), /** @type {JumpProfile} */ (b)));
  for (const p of bastions) push(/** @type {JumpProfile} */ (p).id);
  return out;
}

/**
 * Pone `id` al frente de los recientes, sin repetir y con tope.
 * @param {unknown[]|null|undefined} list
 * @param {string|null|undefined} id
 * @param {number} [max]
 * @returns {string[]}
 */
export function pushRecentJump(list, id, max = MAX_RECENT_JUMPS) {
  /** @type {string[]} */
  const out = [];
  const add = (/** @type {unknown} */ x) => {
    if (typeof x === "string" && x && !out.includes(x)) out.push(x);
  };
  add(id);
  for (const x of Array.isArray(list) ? list : []) add(x);
  return out.slice(0, max);
}

/**
 * Perfiles SSH/SFTP del selector «Elegir conexión…» que casan con la consulta
 * (semántica AND por palabras sobre nombre, host, usuario y carpeta, sin
 * distinguir acentos ni mayúsculas). `excludeId` y los que formarían bucle con
 * él no salen. Ordenados por nombre.
 * @param {JumpProfile[]} profiles
 * @param {unknown} query
 * @param {{ excludeId?: string|null }} [options]
 * @returns {JumpProfile[]}
 */
export function filterJumpProfiles(profiles, query, { excludeId = null } = {}) {
  const byId = indexById(profiles);
  const tokens = searchTokens(query);
  return (profiles || [])
    .filter((p) => usableWith(p.id, excludeId, byId))
    .filter((p) => {
      if (!tokens.length) return true;
      const hay = foldSearchText([p.name, p.host, p.username, p.group].filter(Boolean).join(" "));
      return tokens.every((tok) => hay.includes(tok));
    })
    .sort(byName);
}

/**
 * ¿Se enseña la píldora de ruta? `auto`: si hay salto activo, saltos
 * recientes o algún perfil con perfil-bastión.
 * @param {{ routePill?: string, activeJumpProfileId?: string|null, recentJumpProfileIds?: string[] }} prefs
 * @param {JumpProfile[]} profiles
 */
export function shouldShowRoutePill(prefs, profiles) {
  const mode = ROUTE_PILL_MODES.includes(String(prefs?.routePill)) ? prefs.routePill : "auto";
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (prefs?.activeJumpProfileId) return true;
  if (Array.isArray(prefs?.recentJumpProfileIds) && prefs.recentJumpProfileIds.length) return true;
  return (profiles || []).some((p) => !!p?.proxy_jump_profile_id);
}

/**
 * Sanea las preferencias del salto (locales, no se sincronizan). Muta y
 * devuelve el mismo objeto.
 * @param {Record<string, any>} prefs
 * @returns {Record<string, any>}
 */
export function normalizeJumpPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return prefs;
  prefs.activeJumpProfileId = typeof prefs.activeJumpProfileId === "string" && prefs.activeJumpProfileId
    ? prefs.activeJumpProfileId
    : null;
  prefs.activeJumpKeep = prefs.activeJumpKeep === true;
  prefs.recentJumpProfileIds = pushRecentJump(prefs.recentJumpProfileIds, null);
  prefs.jumpReuse = prefs.jumpReuse !== false;
  prefs.jumpIdleSecs = clampIdleSecs(prefs.jumpIdleSecs);
  prefs.jumpUnsupported = JUMP_UNSUPPORTED_POLICIES.includes(prefs.jumpUnsupported) ? prefs.jumpUnsupported : "direct";
  prefs.routePill = ROUTE_PILL_MODES.includes(prefs.routePill) ? prefs.routePill : "auto";
  return prefs;
}

/**
 * Segundos de inactividad tras los que se cierra la conexión compartida con un
 * salto, dentro de los límites.
 * @param {unknown} value
 */
export function clampIdleSecs(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return JUMP_IDLE_DEFAULT_SECS;
  return Math.min(JUMP_IDLE_MAX_SECS, Math.max(JUMP_IDLE_MIN_SECS, n));
}

/**
 * Ajustes que recibe el backend (`jump_settings_set`), con los nombres del
 * contrato.
 * @param {Record<string, any>} prefs
 * @returns {{ reuse: boolean, idle_secs: number, active_profile_id: string|null, keep: boolean }}
 */
export function jumpSettingsPayload(prefs) {
  return {
    reuse: prefs?.jumpReuse !== false,
    idle_secs: clampIdleSecs(prefs?.jumpIdleSecs),
    active_profile_id: typeof prefs?.activeJumpProfileId === "string" && prefs.activeJumpProfileId
      ? prefs.activeJumpProfileId
      : null,
    // Sin «mantener al reiniciar», el backend retira el salto activo del
    // fichero al cerrarse: la CLI no debe seguir saliendo por él.
    keep: prefs?.activeJumpKeep === true,
  };
}

/**
 * Quita del catálogo las referencias a perfiles borrados: devuelve los perfiles
 * que se quedan sin bastión (con `proxy_jump_profile_id: null`, para guardarlos
 * por el camino normal y que sincronicen) sin tocar los originales.
 * @template {JumpProfile} P
 * @param {P[]} profiles
 * @param {Iterable<string>} deletedIds
 * @param {string} [now]
 * @returns {P[]}
 */
export function detachDeletedBastions(profiles, deletedIds, now = new Date().toISOString()) {
  const gone = new Set(deletedIds);
  return (profiles || [])
    .filter((p) => !gone.has(p.id) && p.proxy_jump_profile_id && gone.has(p.proxy_jump_profile_id))
    .map((p) => ({ ...p, proxy_jump_profile_id: null, updated_at: now }));
}

/**
 * Antes de borrar perfiles: quién se va a quedar sin bastión por cada uno de
 * ellos (fuera del propio lote), con el texto que tenía entonces, para que
 * «Deshacer» pueda volver a enlazarlos.
 * @param {JumpProfile[]} profiles
 * @param {Iterable<string>} deletedIds
 * @returns {Record<string, { id: string, proxy_jump: string|null }[]>}
 */
export function bastionLinksOf(profiles, deletedIds) {
  const gone = new Set(deletedIds);
  /** @type {Record<string, { id: string, proxy_jump: string|null }[]>} */
  const out = {};
  for (const p of profiles || []) {
    const ref = p?.proxy_jump_profile_id;
    if (!ref || !gone.has(ref) || gone.has(p.id)) continue;
    (out[ref] ||= []).push({ id: p.id, proxy_jump: p.proxy_jump ?? null });
  }
  return out;
}

/**
 * Al restaurar el perfil `restoredId` de la papelera: copias de los perfiles que
 * lo tenían de bastión y siguen sin otro (sin perfil-bastión y con el mismo
 * texto que cuando se borró), ya enlazadas de nuevo. Los que el usuario cambió
 * entre medias se dejan como estén.
 * @template {JumpProfile} P
 * @param {P[]} profiles
 * @param {string} restoredId
 * @param {{ id: string, proxy_jump?: string|null }[]|null|undefined} links
 * @param {string} [now]
 * @returns {P[]}
 */
export function relinkRestoredBastion(profiles, restoredId, links, now = new Date().toISOString()) {
  if (!restoredId || !Array.isArray(links) || !links.length) return [];
  /** @type {P[]} */
  const out = [];
  for (const link of links) {
    const p = (profiles || []).find((x) => x.id === link?.id);
    if (!p || p.proxy_jump_profile_id) continue;
    if ((p.proxy_jump ?? null) !== (link.proxy_jump ?? null)) continue;
    out.push({ ...p, proxy_jump_profile_id: restoredId, updated_at: now });
  }
  return out;
}
