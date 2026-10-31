// @ts-check
import { describe, expect, it } from "vitest";
import { tabStateFromClasses, tabStateKeys } from "./tab-state.js";

describe("tabStateKeys", () => {
  it("traduce el estado de la conexión", () => {
    expect(tabStateKeys({ status: "connected" })).toEqual(["tab_state.connected"]);
    expect(tabStateKeys({ status: "connecting" })).toEqual(["tab_state.connecting"]);
    expect(tabStateKeys({ status: "reconnecting" })).toEqual(["tab_state.reconnecting"]);
    expect(tabStateKeys({ status: "error" })).toEqual(["tab_state.disconnected"]);
    expect(tabStateKeys({ status: "closed" })).toEqual(["tab_state.disconnected"]);
    expect(tabStateKeys({})).toEqual([]);
  });

  it("añade el aviso sin ver según su gravedad", () => {
    expect(tabStateKeys({ status: "connected", unread: "activity" })).toEqual(["tab_state.connected", "tab_state.activity"]);
    expect(tabStateKeys({ status: "connected", unread: "important" })).toEqual(["tab_state.connected", "tab_state.important"]);
  });

  it("una pestaña caída con el aviso rojo no repite «desconectada»", () => {
    expect(tabStateKeys({ status: "error", unread: "disconnect" })).toEqual(["tab_state.disconnected"]);
    expect(tabStateKeys({ status: "connected", unread: "disconnect" })).toEqual(["tab_state.connected", "tab_state.disconnected"]);
  });

  it("lee las marcas en un orden fijo", () => {
    expect(tabStateKeys({ status: "connected", readOnly: true, broadcast: true, isPrivate: true, pinned: true })).toEqual([
      "tab_state.connected", "tab_state.read_only", "tab_state.broadcast", "tab_state.private", "tab_state.pinned",
    ]);
  });
});

describe("tabStateFromClasses", () => {
  it("saca el estado de las clases de la pestaña y del punto", () => {
    expect(tabStateFromClasses(["tab", "active", "is-read-only"], ["tab-dot", "connected"])).toEqual({
      status: "connected", unread: null, readOnly: true, broadcast: false, isPrivate: false, pinned: false,
    });
  });

  it("la desconexión sin ver gana al aviso y a la actividad", () => {
    const tab = ["tab", "has-unread-activity", "has-unread-important", "has-unread-disconnect"];
    expect(tabStateFromClasses(tab, ["tab-dot", "error"]).unread).toBe("disconnect");
    expect(tabStateFromClasses(["tab", "has-unread-activity", "has-unread-important"], []).unread).toBe("important");
    expect(tabStateFromClasses(["tab", "has-unread-activity"], []).unread).toBe("activity");
  });

  it("sin clases de estado no inventa nada", () => {
    expect(tabStateFromClasses(["tab"], ["tab-dot"])).toEqual({
      status: undefined, unread: null, readOnly: false, broadcast: false, isPrivate: false, pinned: false,
    });
    expect(tabStateKeys(tabStateFromClasses(["tab"], ["tab-dot"]))).toEqual([]);
  });
});
