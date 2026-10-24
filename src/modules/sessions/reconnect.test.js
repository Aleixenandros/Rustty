import { describe, expect, it } from "vitest";
import { reconnectRoute, runReconnectOnce } from "./reconnect.js";

const term = {};

describe("reconnectRoute", () => {
  it("las sesiones externas cerradas van por su propio camino, nunca por SSH", () => {
    for (const type of ["rdp", "vnc", "telnet"]) {
      expect(reconnectRoute({ type, status: "closed", terminal: null, profileId: "p" })).toBe("external");
      expect(reconnectRoute({ type, status: "error", terminal: null, profileId: "p" })).toBe("external");
    }
  });

  it("SSH cerrada con terminal → ssh; consola local → local", () => {
    expect(reconnectRoute({ type: "ssh", status: "closed", terminal: term, profileId: "p" })).toBe("ssh");
    expect(reconnectRoute({ type: "ssh", status: "error", terminal: term, profileId: "p" })).toBe("ssh");
    expect(reconnectRoute({
      type: "ssh", status: "closed", terminal: term, profileId: "local-1", _closeOverride: () => {},
    })).toBe("local");
  });

  it("no reconecta lo que no está cerrado, lo que ya está en curso ni lo que no tiene terminal", () => {
    expect(reconnectRoute({ type: "ssh", status: "connecting", terminal: term, profileId: "p" })).toBe(null);
    expect(reconnectRoute({ type: "ssh", status: "connected", terminal: term, profileId: "p" })).toBe(null);
    expect(reconnectRoute({ type: "ssh", status: "closed", terminal: term, profileId: "p", _reconnecting: true })).toBe(null);
    expect(reconnectRoute({ type: "rdp", status: "closed", profileId: "p", _reconnecting: true })).toBe(null);
    // Pestaña-ventana de tmux: sin terminal ni perfil propio.
    expect(reconnectRoute({ type: "tmux-window", status: "closed", terminal: null })).toBe(null);
    // FTP/SFTP sin terminal.
    expect(reconnectRoute({ type: "ftp", status: "closed", terminal: null, profileId: "p" })).toBe(null);
    expect(reconnectRoute(null)).toBe(null);
  });
});

describe("runReconnectOnce", () => {
  it("dos llamadas con la primera aún pendiente ejecutan la tarea una sola vez", async () => {
    const s = { status: "closed" };
    let runs = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = runReconnectOnce(s, async () => { runs++; await gate; });
    expect(s._reconnecting).toBe(true); // marcado antes del primer await
    expect(reconnectRoute({ ...s, type: "ssh", terminal: term, profileId: "p" })).toBe(null);
    const second = runReconnectOnce(s, async () => { runs++; });
    expect(await second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
    expect(s._reconnecting).toBe(false);
  });

  it("la marca se retira aunque la tarea falle", async () => {
    const s = { status: "closed" };
    await expect(runReconnectOnce(s, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(s._reconnecting).toBe(false);
    expect(await runReconnectOnce(s, () => {})).toBe(true);
  });
});
