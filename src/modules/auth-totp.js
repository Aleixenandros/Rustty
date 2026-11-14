// @ts-check
/**
 * Segundo factor TOTP desde KeePass: la parte de la interfaz.
 *
 * El código y la semilla **no pasan por aquí**. El backend los calcula y los
 * entrega al intercambio SSH (`auth_totp.rs`, `auth_prompt.rs`); a la interfaz
 * solo le llega que una pregunta *puede* contestarse con el TOTP de KeePass
 * (`totpKeepass` en el evento `ssh-auth-prompt`) y, tras pedirlo con
 * `ssh_auth_prompt_totp`, un estado de {@link TOTP_REPLY}. Este módulo decide
 * qué hace el diálogo con ese estado y qué guarda el formulario del perfil;
 * no toca el DOM ni invoca nada.
 */

import { sanitizeTerminalText } from "./terminal/osc.js";

/**
 * Regex por defecto de la pregunta del código de verificación. Espejo de
 * `auth_totp::DEFAULT_PROMPT_PATTERN`: la aplica el backend (motor de Rust) y
 * aquí solo se enseña en el formulario. Un test de Rust exige que coincidan.
 */
export const DEFAULT_TOTP_PROMPT_PATTERN = String.raw`(?i)(verification|one[- ]?time|\botp\b|\btotp\b|token|authenticator|2fa|c[oó]digo|\bcode\b)`;

/** Largo máximo de la regex del perfil (espejo de `auth_totp::MAX_PATTERN_LEN`). */
export const MAX_TOTP_PROMPT_PATTERN_LEN = 256;

/** Tope del texto de una pregunta del servidor al pintarla en el diálogo. */
export const MAX_PROMPT_LABEL_CHARS = 200;

/**
 * Estados que devuelve `ssh_auth_prompt_totp` (espejo de
 * `auth_prompt::TotpReply`; un test de Rust exige la paridad).
 */
export const TOTP_REPLY = Object.freeze({
  sent: "sent",
  scheduled: "scheduled",
  locked: "locked",
  noEntry: "no_entry",
  noSeed: "no_seed",
  unsupported: "unsupported",
  clock: "clock",
  expired: "expired",
  notOffered: "not_offered",
});

/**
 * @typedef {object} TotpReply
 * @property {string} status Uno de {@link TOTP_REPLY}.
 * @property {number} [waitSecs] Con `scheduled`: segundos hasta el envío.
 */

/**
 * Avisos que el diálogo puede enseñar sobre el TOTP de KeePass.
 * @typedef {"auto_rejected" | "locked" | "no_entry" | "no_seed" | "unsupported"
 *   | "clock" | "failed"} TotpNotice
 */

/**
 * Qué hacer tras pedir el código a KeePass.
 * @typedef {{ kind: "done" }
 *   | { kind: "scheduled", seconds: number }
 *   | { kind: "unlock" }
 *   | { kind: "manual", notice: TotpNotice }
 *   | { kind: "expired" }} TotpAction
 */

/** Clave i18n de cada aviso. */
const NOTICE_KEYS = Object.freeze({
  auto_rejected: "modal_auth_prompt.totp_auto_rejected",
  locked: "modal_auth_prompt.totp_locked",
  no_entry: "modal_auth_prompt.totp_no_entry",
  no_seed: "modal_auth_prompt.totp_no_seed",
  unsupported: "modal_auth_prompt.totp_unsupported",
  clock: "modal_auth_prompt.totp_clock",
  failed: "modal_auth_prompt.totp_failed",
});

/**
 * Clave i18n del aviso, o `null` si no hay aviso.
 * @param {TotpNotice | null | undefined} notice
 * @returns {string | null}
 */
export function totpNoticeKey(notice) {
  return notice && Object.hasOwn(NOTICE_KEYS, notice) ? NOTICE_KEYS[notice] : null;
}

/**
 * Segundos de espera que anuncia el backend, listos para enseñarse: enteros y
 * nunca menos de uno (sin un dato fiable no se promete un «0 s»).
 * @param {unknown} value
 * @returns {number}
 */
export function totpWaitSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 1;
}

/**
 * Texto de una pregunta del servidor listo para pintarse. La escribe el
 * servidor: se le quitan controles y marcas de dirección y se corta, que un
 * servidor hostil puede mandar megas. (Se pinta con `textContent`, así que el
 * HTML ya llega escapado; esto es para que el diálogo siga siendo legible.)
 * @param {unknown} text
 * @returns {string}
 */
export function promptLabel(text) {
  return sanitizeTerminalText(text, MAX_PROMPT_LABEL_CHARS);
}

/**
 * ¿Ofrece esta pregunta el TOTP de KeePass? Solo las rondas de **una**
 * pregunta: es lo único que el backend contesta, y con varias no se sabría a
 * cuál. Desconfía de la forma del payload (viene por IPC).
 * @param {{ prompts?: unknown, totpKeepass?: unknown } | null | undefined} payload
 * @returns {{ autoRejected: boolean, locked: boolean } | null}
 */
export function totpOffer(payload) {
  const offer = /** @type {{ autoRejected?: unknown, locked?: unknown } | null | undefined} */ (payload?.totpKeepass);
  if (!offer || typeof offer !== "object") return null;
  if (!Array.isArray(payload?.prompts) || payload.prompts.length !== 1) return null;
  return { autoRejected: offer.autoRejected === true, locked: offer.locked === true };
}

/**
 * Estado del TOTP de KeePass mientras dura **una** pregunta del servidor.
 *
 * Reglas (espejo, en pequeño, de las del backend):
 * - Un motivo que no se arregla volviendo a pulsar (la entrada no existe, no
 *   tiene semilla, no es un TOTP estándar) **retira el botón**: el diálogo
 *   queda en manual, con el motivo a la vista. Nada reintenta solo.
 * - Con la base bloqueada se ofrece desbloquearla; si el usuario no quiere, el
 *   botón sigue ahí (puede desbloquear más tarde) y se avisa.
 * - Una respuesta que no se entiende cuenta como fallo, nunca como éxito.
 *
 * @param {{ prompts?: unknown, totpKeepass?: unknown } | null | undefined} payload
 */
export function createTotpPromptState(payload) {
  const offer = totpOffer(payload);
  let offered = !!offer;
  // De entrada se explica por qué se pregunta: el automático fue rechazado
  // (lo más importante) o la base está bloqueada.
  /** @type {TotpNotice | null} */
  let notice = null;
  if (offer?.autoRejected) notice = "auto_rejected";
  else if (offer?.locked) notice = "locked";

  /**
   * @param {TotpNotice} reason
   * @returns {TotpAction}
   */
  const giveUp = (reason) => {
    offered = false;
    notice = reason;
    return { kind: "manual", notice: reason };
  };

  return {
    /** ¿Se enseña «Usar código de KeePass»? */
    get offered() {
      return offered;
    },
    /** Aviso que acompaña a la pregunta, si lo hay. */
    get notice() {
      return notice;
    },
    /**
     * Digiere la respuesta de `ssh_auth_prompt_totp` (o `null` si la llamada
     * falló) y dice qué hace el diálogo.
     * @param {TotpReply | null | undefined} reply
     * @returns {TotpAction}
     */
    resolve(reply) {
      switch (reply?.status) {
        case TOTP_REPLY.sent:
          return { kind: "done" };
        case TOTP_REPLY.scheduled:
          return { kind: "scheduled", seconds: totpWaitSeconds(reply.waitSecs) };
        case TOTP_REPLY.locked:
          return { kind: "unlock" };
        case TOTP_REPLY.expired:
          offered = false;
          return { kind: "expired" };
        case TOTP_REPLY.noEntry:
          return giveUp("no_entry");
        case TOTP_REPLY.noSeed:
          return giveUp("no_seed");
        case TOTP_REPLY.unsupported:
          return giveUp("unsupported");
        case TOTP_REPLY.clock:
          return giveUp("clock");
        default:
          return giveUp("failed");
      }
    },
    /** El usuario no desbloqueó la base: se sigue en manual, con el botón. */
    unlockDeclined() {
      notice = "locked";
    },
  };
}

/**
 * Los cuatro campos del TOTP de KeePass tal como los guarda el perfil. Con la
 * opción apagada no queda nada activado por debajo: el modo automático se
 * apaga con ella (volver a activarla es volver a elegirlo), y la entrada y la
 * regex se conservan para no hacer reescribirlas.
 * @param {{ enabled?: boolean, auto?: boolean, entryUuid?: string | null, regex?: string | null }} form
 */
export function totpProfileFields(form) {
  const enabled = form?.enabled === true;
  return {
    totp_keepass: enabled,
    totp_keepass_auto: enabled && form?.auto === true,
    totp_keepass_entry_uuid: String(form?.entryUuid ?? "").trim() || null,
    totp_keepass_prompt_regex: String(form?.regex ?? "").trim() || null,
  };
}

/**
 * Por qué no se puede guardar el formulario, o `null` si está bien.
 * - `need_entry`: activado sin entrada propia y sin que la contraseña salga
 *   de KeePass: no habría de dónde sacar la semilla.
 * - `regex_too_long` / `regex_invalid`: la regex no sirve. `regexValid` es el
 *   veredicto del backend (`totp_prompt_pattern_check`), que es quien la
 *   aplica.
 *
 * Con la opción apagada no se exige nada: sus campos están ocultos y un aviso
 * que no se ve no se puede corregir. (Una regex inválida guardada así es
 * inofensiva: el backend no ofrece el TOTP con ella.)
 * @param {{ enabled?: boolean, entryUuid?: string | null,
 *   passwordEntryUuid?: string | null, regex?: string | null,
 *   regexValid?: boolean }} form
 * @returns {{ field: "entry" | "regex", code: "need_entry" | "regex_too_long" | "regex_invalid" } | null}
 */
export function totpFormIssue(form) {
  if (form?.enabled !== true) return null;
  const entry = String(form?.entryUuid ?? "").trim() || String(form?.passwordEntryUuid ?? "").trim();
  if (!entry) return { field: "entry", code: "need_entry" };
  const regex = String(form?.regex ?? "").trim();
  if (regex.length > MAX_TOTP_PROMPT_PATTERN_LEN) return { field: "regex", code: "regex_too_long" };
  if (regex && form?.regexValid === false) return { field: "regex", code: "regex_invalid" };
  return null;
}

/**
 * @typedef {object} KeepassEntryLike
 * @property {string} uuid
 * @property {string} [title]
 * @property {string} [username]
 * @property {string} [group]
 * @property {boolean} [has_totp]
 */

/**
 * Entradas que el selector de «entrada con la semilla» ofrece: las que traen
 * semilla TOTP y, además, la que el perfil ya tiene guardada aunque no esté
 * entre ellas (base bloqueada, entrada borrada o sin semilla), para que abrir
 * y guardar el formulario no la pierda.
 * @param {KeepassEntryLike[] | null | undefined} entries
 * @param {string | null | undefined} selectedUuid
 * @returns {Array<{ uuid: string, entry: KeepassEntryLike | null, hasTotp: boolean }>}
 */
export function totpEntryChoices(entries, selectedUuid) {
  const list = Array.isArray(entries) ? entries : [];
  /** @type {Array<{ uuid: string, entry: KeepassEntryLike | null, hasTotp: boolean }>} */
  const choices = list
    .filter((entry) => entry && entry.has_totp === true)
    .map((entry) => ({ uuid: entry.uuid, entry, hasTotp: true }));
  const selected = String(selectedUuid ?? "").trim();
  if (selected && !choices.some((choice) => choice.uuid === selected)) {
    const entry = list.find((candidate) => candidate && candidate.uuid === selected) || null;
    choices.unshift({ uuid: selected, entry, hasTotp: false });
  }
  return choices;
}

/**
 * Estado de la entrada de la que saldría el código, para el aviso del
 * formulario: `none` (no hay entrada), `locked` (no se puede comprobar),
 * `missing` (no está en la base abierta), `no_seed` (no trae campo `otp`) u
 * `ok`.
 * @param {{ entryUuid?: string | null, passwordEntryUuid?: string | null,
 *   entries?: KeepassEntryLike[] | null, unlocked?: boolean }} input
 * @returns {"none" | "locked" | "missing" | "no_seed" | "ok"}
 */
export function totpEntryStatus(input) {
  const uuid = String(input?.entryUuid ?? "").trim() || String(input?.passwordEntryUuid ?? "").trim();
  if (!uuid) return "none";
  if (input?.unlocked !== true) return "locked";
  const entry = (Array.isArray(input?.entries) ? input.entries : []).find((candidate) => candidate?.uuid === uuid);
  if (!entry) return "missing";
  return entry.has_totp === true ? "ok" : "no_seed";
}
