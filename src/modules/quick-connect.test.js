import { describe, expect, it } from "vitest";
import {
  QUICK_DEFAULT_USER,
  buildQuickProfile,
  findQuickTargetProfile,
  formatQuickTarget,
  paletteQuickTarget,
  parseQuickTarget,
} from "./quick-connect.js";

describe("parseQuickTarget", () => {
  it("lee usuario, host y puerto", () => {
    expect(parseQuickTarget("admin@web01.example.com:2222"))
      .toEqual({ username: "admin", host: "web01.example.com", port: 2222, userGiven: true, portGiven: true });
  });

  it("sin usuario usa el de siempre del primer inicio y sin puerto el 22", () => {
    expect(QUICK_DEFAULT_USER).toBe("root");
    expect(parseQuickTarget("  10.0.0.5 "))
      .toEqual({ username: "root", host: "10.0.0.5", port: 22, userGiven: false, portGiven: false });
    expect(parseQuickTarget("srv", { defaultUser: "yo" })?.username).toBe("yo");
  });

  it("acepta IPv6 entre corchetes y le quita los corchetes", () => {
    expect(parseQuickTarget("ops@[fe80::1]:22")).toMatchObject({ username: "ops", host: "fe80::1", port: 22 });
  });

  it("rechaza puertos fuera de rango, espacios y vacíos", () => {
    expect(parseQuickTarget("host:0")).toBeNull();
    expect(parseQuickTarget("host:65536")).toBeNull();
    expect(parseQuickTarget("dos palabras")).toBeNull();
    expect(parseQuickTarget("")).toBeNull();
    expect(parseQuickTarget(undefined)).toBeNull();
  });
});

describe("formatQuickTarget", () => {
  it("escribe el destino completo y devuelve los corchetes a una IPv6", () => {
    expect(formatQuickTarget({ username: "root", host: "srv", port: 22 })).toBe("root@srv:22");
    expect(formatQuickTarget({ username: "ops", host: "fe80::1", port: 2200 })).toBe("ops@[fe80::1]:2200");
  });
});

describe("paletteQuickTarget", () => {
  it("una consulta con forma de destino es explícita", () => {
    for (const q of ["admin@srv", "srv:2222", "192.168.1.10", "[::1]", "localhost"]) {
      expect(paletteQuickTarget(q)?.explicit, q).toBe(true);
    }
  });

  it("un nombre con punto se ofrece, pero no como explícito: puede ser lo que se buscaba", () => {
    for (const q of ["web01.example.com", "deploy.sh", "notes.md"]) {
      expect(paletteQuickTarget(q)?.explicit, q).toBe(false);
    }
  });

  it("una palabra suelta no se ofrece: Intro crearía un perfil que nadie pidió", () => {
    expect(paletteQuickTarget("tunnels")).toBeNull();
    expect(paletteQuickTarget("grafna")).toBeNull();
    expect(paletteQuickTarget("nas:22")?.explicit).toBe(true);
  });

  it("no ofrece números sueltos ni IPv4 a medias, ni hosts con puntos o guiones de sobra", () => {
    for (const q of ["22", "1.5", "300.1.1.1", "-v", "srv.", ".srv", "a..b", "nuevo perfil"]) {
      expect(paletteQuickTarget(q), q).toBeNull();
    }
  });
});

describe("findQuickTargetProfile", () => {
  const profiles = [
    { id: "a", connection_type: "ssh", host: "Web01", port: 22, username: "root" },
    { id: "b", connection_type: "sftp", host: "web01", port: 22, username: "deploy" },
    { id: "c", host: "web01", port: 2222, username: "deploy" },
  ];

  it("encuentra el perfil SSH del mismo destino sin distinguir mayúsculas del host", () => {
    expect(findQuickTargetProfile(profiles, { username: "root", host: "web01", port: 22 })?.id).toBe("a");
    expect(findQuickTargetProfile(profiles, { username: "deploy", host: "WEB01", port: 2222 })?.id).toBe("c");
  });

  it("no confunde otro usuario, otro puerto ni otro protocolo", () => {
    expect(findQuickTargetProfile(profiles, { username: "deploy", host: "web01", port: 22 })).toBeNull();
    expect(findQuickTargetProfile(profiles, { username: "root", host: "web01", port: 2222 })).toBeNull();
  });

  it("sin usuario ni puerto escritos, reutiliza el perfil de ese host que ya se tiene", () => {
    const solo = [{ id: "d", connection_type: "ssh", host: "db1.example.com", port: 2222, username: "admin" }];
    expect(findQuickTargetProfile(solo, parseQuickTarget("db1.example.com"))?.id).toBe("d");
    expect(findQuickTargetProfile(solo, parseQuickTarget("admin@db1.example.com"))?.id).toBe("d");
    expect(findQuickTargetProfile(solo, parseQuickTarget("db1.example.com:22"))).toBeNull();
    expect(findQuickTargetProfile(solo, parseQuickTarget("otro@db1.example.com"))).toBeNull();
    // Con el exacto disponible, gana el exacto.
    expect(findQuickTargetProfile(profiles, parseQuickTarget("web01"))?.id).toBe("a");
  });
});

describe("buildQuickProfile", () => {
  it("arma un perfil SSH de contraseña en el workspace indicado", () => {
    expect(buildQuickProfile({ username: "ops", host: "srv", port: 2200 }, {
      id: "id-1", now: "2026-10-24T00:00:00.000Z", workspaceId: "ws-2",
    })).toEqual({
      id: "id-1", name: "srv", host: "srv", port: 2200, username: "ops",
      connection_type: "ssh", auth_type: "password", follow_cwd: true,
      workspace_id: "ws-2", updated_at: "2026-10-24T00:00:00.000Z",
    });
  });
});
