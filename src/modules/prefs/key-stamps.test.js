import { describe, expect, it } from "vitest";
import { capturePrefKeyHashes, markPrefKeyApplied, prefValueHash, refreshPrefKeyStamps } from "./key-stamps.js";
import { hasLocalSyncData } from "./first-sync.js";

describe("fechas por clave de las preferencias", () => {
  it("un equipo recién instalado fecha sus claves en 1970: la nube gana", () => {
    const prefs = { theme: "dark", fontSize: 13 };
    refreshPrefKeyStamps(prefs);
    expect(prefs._prefsKeyTs.theme).toBe("1970-01-01T00:00:00.000Z");
    expect(prefs._prefsKeyTs.fontSize).toBe("1970-01-01T00:00:00.000Z");
  });

  it("solo la clave que cambió toma la fecha de la última edición", () => {
    const prefs = { theme: "dark", fontSize: 13, _prefsUpdatedAt: "2026-09-01T00:00:00.000Z" };
    refreshPrefKeyStamps(prefs);
    prefs.fontSize = 15;
    prefs._prefsUpdatedAt = "2026-10-01T00:00:00.000Z";
    refreshPrefKeyStamps(prefs);
    expect(prefs._prefsKeyTs.fontSize).toBe("2026-10-01T00:00:00.000Z");
    expect(prefs._prefsKeyTs.theme).toBe("2026-09-01T00:00:00.000Z");
    // Idempotente: sin cambios no se mueve nada.
    prefs._prefsUpdatedAt = "2026-11-01T00:00:00.000Z";
    refreshPrefKeyStamps(prefs);
    expect(prefs._prefsKeyTs.fontSize).toBe("2026-10-01T00:00:00.000Z");
  });

  it("un valor llegado de fuera no cuenta como edición local", () => {
    const prefs = { theme: "dark", _prefsUpdatedAt: "2026-09-01T00:00:00.000Z" };
    refreshPrefKeyStamps(prefs);
    prefs.theme = "nord";
    markPrefKeyApplied(prefs, "theme", "2026-08-01T00:00:00.000Z");
    prefs._prefsUpdatedAt = "2026-10-01T00:00:00.000Z";
    refreshPrefKeyStamps(prefs);
    expect(prefs._prefsKeyTs.theme).toBe("2026-08-01T00:00:00.000Z");
  });

  it("la huella no depende del orden de las claves de un objeto", () => {
    expect(prefValueHash({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(prefValueHash({ b: [2, { d: 4, c: 3 }], a: 1 }));
    expect(prefValueHash(undefined)).not.toBe(prefValueHash(null));
    expect(capturePrefKeyHashes({ theme: "x" }).theme).toBe(prefValueHash("x"));
  });

  it("los items pref: no convierten un equipo nuevo en uno con datos", () => {
    const state = {
      items: {
        "prefs:bundle": { data: { workspaces: [{ id: "default", name: "Default" }] } },
        "pref:theme": { data: { value: "dark" } },
        "device:a": { data: {} },
      },
      tombstones: {},
    };
    expect(hasLocalSyncData(state)).toBe(false);
  });
});
