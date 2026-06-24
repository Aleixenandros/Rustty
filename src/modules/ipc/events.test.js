import { describe, it, expect } from "vitest";
import { EVENT, EVENT_PREFIX, eventName } from "./events.js";

describe("eventName", () => {
  it("concatena prefijo + sufijo", () => {
    expect(eventName("sshConnected", "abc")).toBe("ssh-connected-abc");
    expect(eventName("sftpProgress", "t-1")).toBe("sftp-progress-t-1");
    expect(eventName("sshTunnelTraffic", "s9")).toBe("ssh-tunnel-traffic-s9");
  });

  it("lanza ante una familia desconocida", () => {
    // @ts-expect-error: comprobación en runtime de clave inválida
    expect(() => eventName("noExiste", "x")).toThrow();
  });
});

describe("contrato de prefijos", () => {
  it("todos los prefijos por sesión terminan en guion", () => {
    for (const prefix of Object.values(EVENT_PREFIX)) {
      expect(prefix.endsWith("-")).toBe(true);
    }
  });

  it("cubre exactamente las familias del contrato (espejo de ipc.rs)", () => {
    expect(Object.keys(EVENT_PREFIX).sort()).toEqual(
      [
        "rdpClosed",
        "vncClosed",
        "telnetClosed",
        "sftpLog",
        "sftpProgress",
        "shellClosed",
        "sshClosed",
        "sshConnected",
        "sshError",
        "sshLog",
        "sshReconnecting",
        "sshTunnelTraffic",
      ].sort()
    );
  });

  it("el evento global tray-action es estable", () => {
    expect(EVENT.trayAction).toBe("tray-action");
  });

  it("los catálogos son inmutables (Object.freeze)", () => {
    expect(Object.isFrozen(EVENT_PREFIX)).toBe(true);
    expect(Object.isFrozen(EVENT)).toBe(true);
  });
});
