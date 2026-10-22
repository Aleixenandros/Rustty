// @ts-check
import { describe, it, expect } from "vitest";
import {
  IPC_ERROR_KIND,
  KEYRING_UNAVAILABLE_MARKER,
  ipcErrorKind,
  ipcErrorText,
  isHostKeyError,
  isKeyringUnavailableError,
  isRetryableIpcError,
  keyringFailureDetail,
} from "./errors.js";

describe("contrato de kinds", () => {
  it("cubre exactamente los discriminantes de ipc_error.rs", () => {
    // Espejo literal de `IpcErrorKind` en src-tauri/src/ipc_error.rs.
    expect(Object.keys(IPC_ERROR_KIND).sort()).toEqual(
      [
        "authFailed",
        "hostKeyUnknown",
        "hostKeyMismatch",
        "networkUnreachable",
        "timeout",
        "permissionDenied",
        "conflict",
        "badPassphrase",
        "offline",
        "notFound",
        "protocol",
        "internal",
      ].sort(),
    );
  });

  it("cada clave es igual a su valor (el JSON del backend llega tal cual)", () => {
    for (const [key, value] of Object.entries(IPC_ERROR_KIND)) {
      expect(value).toBe(key);
    }
  });
});

describe("ipcErrorKind", () => {
  it("lee el discriminante de un rechazo estructurado", () => {
    expect(ipcErrorKind({ kind: "authFailed", message: "x" })).toBe("authFailed");
  });

  it("una cadena o un kind desconocido no tienen discriminante", () => {
    expect(ipcErrorKind("Error de E/S")).toBe(null);
    expect(ipcErrorKind({ kind: "inventado", message: "x" })).toBe(null);
    expect(ipcErrorKind(null)).toBe(null);
  });
});

describe("ipcErrorText", () => {
  it("prefiere el mensaje del objeto y cae a String() si no lo hay", () => {
    expect(ipcErrorText({ kind: "timeout", message: "no responde" })).toBe("no responde");
    expect(ipcErrorText("fallo suelto")).toBe("fallo suelto");
    expect(ipcErrorText(new Error("boom"))).toBe("boom");
  });

  it("nunca devuelve [object Object] para un rechazo estructurado", () => {
    expect(ipcErrorText({ kind: "internal", message: "detalle" })).not.toContain("[object");
  });
});

describe("clasificación de conveniencia", () => {
  it("distingue los fallos de host key de los de credenciales", () => {
    expect(isHostKeyError({ kind: "hostKeyMismatch", message: "" })).toBe(true);
    expect(isHostKeyError({ kind: "hostKeyUnknown", message: "" })).toBe(true);
    expect(isHostKeyError({ kind: "authFailed", message: "" })).toBe(false);
  });

  it("solo son reintentables los fallos de red", () => {
    expect(isRetryableIpcError({ kind: "networkUnreachable", message: "" })).toBe(true);
    expect(isRetryableIpcError({ kind: "timeout", message: "" })).toBe(true);
    expect(isRetryableIpcError({ kind: "offline", message: "" })).toBe(true);
    expect(isRetryableIpcError({ kind: "authFailed", message: "" })).toBe(false);
    expect(isRetryableIpcError("cadena suelta")).toBe(false);
  });
});

describe("fallos del keyring del SO", () => {
  // Tal como los manda el backend hoy: `keyring_set` rechaza con cadena; los
  // comandos de sync, dentro de «Error de sincronización: <paso>: …».
  const fromCommand =
    `${KEYRING_UNAVAILABLE_MARKER} Platform secure storage failure: Password too short: 2.`;
  const fromSync =
    `Error de sincronización: keyring set: ${KEYRING_UNAVAILABLE_MARKER} Platform secure storage failure: x`;

  it("los reconoce por el marcador, en cadena o en un IpcError", () => {
    expect(isKeyringUnavailableError(fromCommand)).toBe(true);
    expect(isKeyringUnavailableError(fromSync)).toBe(true);
    expect(isKeyringUnavailableError({ kind: "permissionDenied", message: fromSync })).toBe(true);
  });

  it("no culpa al keyring de lo que no es suyo", () => {
    expect(isKeyringUnavailableError("Error de E/S: permission denied")).toBe(false);
    // Un permiso denegado de fichero tiene el mismo kind, pero no el marcador.
    expect(isKeyringUnavailableError({ kind: "permissionDenied", message: "Acceso denegado" }))
      .toBe(false);
    expect(isKeyringUnavailableError(null)).toBe(false);
  });

  it("el detalle es lo que dijo el servicio de secretos, sin marcador ni prefijos", () => {
    expect(keyringFailureDetail(fromCommand)).toBe("Platform secure storage failure: Password too short: 2.");
    expect(keyringFailureDetail(fromSync)).toBe("Platform secure storage failure: x");
    expect(keyringFailureDetail("otro fallo")).toBe("otro fallo");
  });
});
