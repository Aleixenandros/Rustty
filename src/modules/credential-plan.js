// @ts-check
/**
 * Qué hace el frontend con la contraseña de una identidad antes de conectar
 * por SFTP/FTP/FTPS. Puro: la decisión, sin keyring ni diálogos.
 *
 * Dos cosas que el frontend no debe confundir: «el usuario canceló» y «la
 * contraseña la resuelve el backend». Con KeePass (desbloqueada) o con una
 * credencial maestra, el backend (`resolve_profile_password`) la saca de ahí e
 * ignora la que reciba; tratar ese caso como una cancelación dejaba los perfiles
 * FTP/FTPS sin conectar en silencio, y no reconocerlo al abrir el panel SFTP
 * pedía una contraseña que se descartaba (y se guardaba con «Recordar»).
 */

/**
 * @typedef {"locked"|"backend"|"override"|"ask"} PasswordPlan
 *   - `locked`: KeePass bloqueada; no se puede conectar hasta desbloquearla.
 *   - `backend`: KeePass o credencial maestra; no se pide nada.
 *   - `override`: ya llega una contraseña (formulario, resolución previa).
 *   - `ask`: contraseña propia; keyring y, si falta, diálogo.
 */

/**
 * @param {{ passwordSource?: string|null, keepassEntryUuid?: string|null }|null|undefined} view
 *   Identidad normalizada (`identityView` de main.js): la principal o una adicional.
 * @param {{ keepassUnlocked?: boolean, passwordOverride?: string|null }} [options]
 * @returns {PasswordPlan}
 */
export function passwordPlan(view, { keepassUnlocked = false, passwordOverride = null } = {}) {
  // KeePass y maestra primero: el backend ignora la contraseña recibida en esos
  // dos casos, así que un override no salva una KeePass bloqueada.
  if (view?.keepassEntryUuid) return keepassUnlocked ? "backend" : "locked";
  if ((view?.passwordSource || "own") === "master") return "backend";
  if (passwordOverride) return "override";
  return "ask";
}
