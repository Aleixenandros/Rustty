import { describe, expect, it } from "vitest";
import { connectionTunnelOwners } from "./lifecycle.js";

const isLive = (s) => ["connecting", "connected", "reconnecting"].includes(s.status);

const sessions = (rootStatus = "connected") => new Map([
  ["r", { status: rootStatus }],
  ["h1", { status: "connected", _parentSessionId: "r" }],
  ["h2", { status: "connected", _parentSessionId: "r" }],
  ["o", { status: "connected" }],
  ["oh", { status: "connected", _parentSessionId: "o" }],
]);

describe("connectionTunnelOwners", () => {
  it("si cae una raíz, sus túneles y los de sus hijas, y ninguno ajeno", () => {
    expect(connectionTunnelOwners(sessions("closed"), "r", isLive)).toEqual(["r", "h1", "h2"]);
  });

  it("una hija que se cierra sola con la raíz viva conserva sus túneles", () => {
    expect(connectionTunnelOwners(sessions(), "h1", isLive)).toEqual([]);
    // Orden real del backend al caer la raíz: primero el cierre de las hijas
    // (la raíz aún figura viva) y luego el de la raíz, que las limpia a todas.
    expect(connectionTunnelOwners(sessions("connected"), "h2", isLive)).toEqual([]);
  });

  it("una hija cuya raíz ya murió o se retiró olvida los suyos", () => {
    expect(connectionTunnelOwners(sessions("closed"), "h1", isLive)).toEqual(["h1"]);
    const noRoot = sessions();
    noRoot.delete("r");
    expect(connectionTunnelOwners(noRoot, "h2", isLive)).toEqual(["h2"]);
  });

  it("un id desconocido no toca nada", () => {
    expect(connectionTunnelOwners(sessions(), "x", isLive)).toEqual([]);
  });
});
