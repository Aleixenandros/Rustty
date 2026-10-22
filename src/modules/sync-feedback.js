// @ts-check
/**
 * Mensajes de la pestaña de sincronización que dependen del tipo de fallo o
 * del estado de la cuenta OAuth: qué punto de color y qué texto mostrar, qué
 * aviso dar tras «Desconectar» y cómo contar un fallo sin culpar al paso
 * equivocado. Puro: recibe `t` en vez de importar el i18n.
 */

import { ipcErrorText, isKeyringUnavailableError, keyringFailureDetail } from "./ipc/errors.js";

/**
 * Estados de cuenta que devuelve `sync_oauth_status`. Espejo de
 * `OAuthAccountState` en `src-tauri/src/sync.rs` (un test de cada lado fija
 * los valores).
 */
export const OAUTH_ACCOUNT_STATE = Object.freeze({
  connected: "connected",
  disconnected: "disconnected",
  tokenMissing: "token_missing",
});

/** Un fallo del keyring trae un texto largo con el detalle técnico: más tiempo en pantalla. */
const KEYRING_TOAST_MS = 12000;

/**
 * Punto de color y texto del estado de la cuenta.
 * @param {string|null} state  Lo que devolvió `sync_oauth_status`, o `null` si falló.
 * @param {unknown} [error]  El rechazo de la consulta, si lo hubo.
 * @returns {{ dot: "success"|"idle"|"error", textKey: string }}
 */
export function oauthStatusView(state, error) {
  if (error != null && isKeyringUnavailableError(error)) {
    return { dot: "error", textKey: "prefs_sync.oauth_keyring_unavailable" };
  }
  if (state === OAUTH_ACCOUNT_STATE.connected) {
    return { dot: "success", textKey: "prefs_sync.oauth_connected" };
  }
  if (state === OAUTH_ACCOUNT_STATE.tokenMissing) {
    return { dot: "error", textKey: "prefs_sync.oauth_token_missing" };
  }
  return { dot: "idle", textKey: "prefs_sync.oauth_disconnected" };
}

/**
 * Aviso tras pulsar «Desconectar»: el botón nunca calla, aunque no hubiera nada
 * que desconectar.
 * @param {boolean} hadAccount  Lo que devolvió `sync_oauth_disconnect`.
 * @returns {{ type: "success"|"info", textKey: string }}
 */
export function oauthDisconnectFeedback(hadAccount) {
  return hadAccount
    ? { type: "success", textKey: "prefs_sync.oauth_disconnect_done" }
    : { type: "info", textKey: "prefs_sync.oauth_disconnect_nothing" };
}

/**
 * Aviso de un fallo de la pestaña. Si el culpable es el keyring del SO, lo
 * nombra a él y no lleva el prefijo del paso («OAuth», «Backend», «Sync»), que
 * en ese caso apuntaría al sitio equivocado.
 * @param {unknown} err
 * @param {string} step  Prefijo técnico del paso, p. ej. "OAuth".
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 * @param {number} ms  Duración del aviso si no es un fallo del keyring.
 * @returns {{ message: string, ms: number }}
 */
export function syncFailureToast(err, step, t, ms) {
  if (isKeyringUnavailableError(err)) {
    return {
      message: t("prefs_sync.keyring_unavailable", { detail: keyringFailureDetail(err) }),
      ms: Math.max(ms, KEYRING_TOAST_MS),
    };
  }
  return { message: `${step}: ${ipcErrorText(err)}`, ms };
}
