// @ts-check
import { describe, it, expect } from "vitest";
import {
  OAUTH_ACCOUNT_STATE,
  oauthDisconnectFeedback,
  oauthStatusView,
  syncFailureToast,
} from "./sync-feedback.js";
import { KEYRING_UNAVAILABLE_MARKER } from "./ipc/errors.js";

/**
 * `t` de prueba: devuelve la clave y sus parámetros para poder comprobarlos.
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
const t = (key, params = {}) =>
  `${key}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ""}`;

const keyringError =
  `Error de sincronización: keyring set: ${KEYRING_UNAVAILABLE_MARKER} Platform secure storage failure: Password too short: 2.`;

describe("estados de cuenta", () => {
  it("son los que serializa OAuthAccountState en sync.rs", () => {
    expect(Object.values(OAUTH_ACCOUNT_STATE).sort()).toEqual(
      ["connected", "disconnected", "token_missing"].sort(),
    );
  });
});

describe("oauthStatusView", () => {
  it("conectada, desconectada y token desaparecido tienen cada uno su texto", () => {
    expect(oauthStatusView("connected")).toEqual({ dot: "success", textKey: "prefs_sync.oauth_connected" });
    expect(oauthStatusView("disconnected")).toEqual({ dot: "idle", textKey: "prefs_sync.oauth_disconnected" });
    // El caso del cambio de servicio de secretos: estaba conectada y el token
    // ya no está. No puede leerse igual que «nunca conectada».
    expect(oauthStatusView("token_missing")).toEqual({ dot: "error", textKey: "prefs_sync.oauth_token_missing" });
  });

  it("si el keyring no responde, lo dice en vez de dar la cuenta por desconectada", () => {
    expect(oauthStatusView(null, keyringError))
      .toEqual({ dot: "error", textKey: "prefs_sync.oauth_keyring_unavailable" });
    expect(oauthStatusView(null, { kind: "permissionDenied", message: keyringError }).textKey)
      .toBe("prefs_sync.oauth_keyring_unavailable");
  });

  it("cualquier otro fallo de la consulta conserva el «no conectado» de siempre", () => {
    expect(oauthStatusView(null, "Proveedor OAuth no soportado: x").textKey)
      .toBe("prefs_sync.oauth_disconnected");
  });
});

describe("oauthDisconnectFeedback", () => {
  it("el botón nunca calla, haya o no algo que desconectar", () => {
    expect(oauthDisconnectFeedback(true))
      .toEqual({ type: "success", textKey: "prefs_sync.oauth_disconnect_done" });
    expect(oauthDisconnectFeedback(false))
      .toEqual({ type: "info", textKey: "prefs_sync.oauth_disconnect_nothing" });
  });
});

describe("syncFailureToast", () => {
  it("un fallo del keyring lo nombra a él, sin el prefijo del paso y con el detalle", () => {
    const toast = syncFailureToast(keyringError, "OAuth", t, 8000);
    expect(toast.message).toBe(
      `prefs_sync.keyring_unavailable ${JSON.stringify({ detail: "Platform secure storage failure: Password too short: 2." })}`,
    );
    expect(toast.message).not.toContain("OAuth");
    // Es largo: más tiempo en pantalla, nunca menos del pedido.
    expect(toast.ms).toBe(12000);
    expect(syncFailureToast(keyringError, "Sync", t, 20000).ms).toBe(20000);
  });

  it("cualquier otro fallo conserva el prefijo del paso y su duración", () => {
    expect(syncFailureToast("401 Unauthorized", "Backend", t, 6000))
      .toEqual({ message: "Backend: 401 Unauthorized", ms: 6000 });
  });

  it("un rechazo estructurado nunca sale como [object Object]", () => {
    const toast = syncFailureToast({ kind: "internal", message: "fallo del merge" }, "Sync", t, 6000);
    expect(toast.message).toBe("Sync: fallo del merge");
  });
});
