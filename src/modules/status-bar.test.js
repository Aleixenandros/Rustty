// @ts-check
import { describe, it, expect } from "vitest";
import { localUserHost, statusBarModel } from "./status-bar.js";

describe("statusBarModel", () => {
  it("una sesión SSH lleva la barra completa", () => {
    const m = statusBarModel({ local: false, profile: { connection_type: "ssh" } });
    expect(m).toMatchObject({
      kind: "ssh", latency: true, tunnels: true, route: true, env: true,
      rec: true, connectionLog: true, metrics: true, killProcess: true, cwdNavigates: true,
    });
    // Perfil antiguo sin tipo: es SSH.
    expect(statusBarModel({ local: false, profile: {} })?.kind).toBe("ssh");
  });

  it("una pestaña hija no tiene monitor propio", () => {
    const m = statusBarModel({ local: false, profile: { connection_type: "ssh" }, childShell: true });
    expect(m?.metrics).toBe(false);
    expect(m?.latency).toBe(true);
  });

  it("sin perfil SSH no hay barra", () => {
    expect(statusBarModel({ local: false, profile: null })).toBeNull();
    expect(statusBarModel({ local: false, profile: { connection_type: "rdp" } })).toBeNull();
  });

  it("la consola local oculta lo que es de una conexión remota", () => {
    const m = statusBarModel({ local: true, profile: null, localMetrics: true });
    expect(m).toEqual({
      kind: "local", latency: false, tunnels: false, route: false, env: false,
      rec: false, connectionLog: false, metrics: true, killProcess: false, cwdNavigates: false,
    });
  });

  it("el monitor local solo donde el backend sabe muestrear", () => {
    expect(statusBarModel({ local: true, profile: null, localMetrics: false })?.metrics).toBe(false);
    expect(statusBarModel({ local: true, profile: null })?.metrics).toBe(false);
  });

  it("la preferencia apaga la barra de la consola local, y por defecto está encendida", () => {
    expect(statusBarModel({ local: true, profile: null, localBarEnabled: false })).toBeNull();
    expect(statusBarModel({ local: true, profile: null })?.kind).toBe("local");
    // Una consola local nunca cae en la rama SSH aunque traiga perfil.
    expect(statusBarModel({ local: true, profile: { connection_type: "ssh" }, localBarEnabled: false })).toBeNull();
  });
});

describe("localUserHost", () => {
  it("usuario@equipo, sin puerto", () => {
    expect(localUserHost("ana", "portatil")).toBe("ana@portatil");
    expect(localUserHost(" ana ", " portatil ")).toBe("ana@portatil");
  });

  it("con un solo dato, ese; sin ninguno, localhost", () => {
    expect(localUserHost(null, "portatil")).toBe("portatil");
    expect(localUserHost("ana", "")).toBe("ana");
    expect(localUserHost(undefined, undefined)).toBe("localhost");
    expect(localUserHost("  ", null)).toBe("localhost");
  });
});
