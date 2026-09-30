import { describe, expect, it } from "vitest";
import { firstSyncUpload, hasLocalSyncData } from "./first-sync.js";

const fresh = () => ({ version: 1, items: {
  "prefs:bundle": { data: { theme: "light", workspaces: [{ id: "default", name: "Default" }], userFoldersByWorkspace: { default: [] } }, updated_at: "2026-10-01T12:00:00Z" },
  "device:windows": { data: { platform: "windows" } },
}, tombstones: {} });

describe("primera sincronización", () => {
  it("cambiar ajustes en una instalación nueva sigue permitiendo recuperar la nube", () => {
    expect(hasLocalSyncData(fresh())).toBe(false);
  });

  it.each(["profile:p", "theme:t", "shortcut:s", "note:n", "snippet:s", "cred:c"])("%s requiere combinar los datos propios", (key) => {
    const state = fresh();
    state.items[key] = { data: {} };
    expect(hasLocalSyncData(state)).toBe(true);
  });

  it("los workspaces y carpetas vacíos propios también cuentan", () => {
    const state = fresh();
    state.items["prefs:bundle"].data.workspaces.push({ id: "work", name: "Trabajo" });
    expect(hasLocalSyncData(state)).toBe(true);
    const folders = fresh();
    folders.items["prefs:bundle"].data.userFoldersByWorkspace.default.push("Producción");
    expect(hasLocalSyncData(folders)).toBe(true);
  });

  it("los borrados pendientes no se confunden con una instalación nueva", () => {
    const state = fresh();
    state.tombstones["profile:deleted"] = "2026-09-01T00:00:00Z";
    expect(hasLocalSyncData(state)).toBe(true);
  });

  it("recuperar no publica preferencias ni borrados locales", () => {
    const state = fresh();
    state.tombstones["profile:deleted"] = "2026-09-01T00:00:00Z";
    const original = structuredClone(state);
    expect(firstSyncUpload(state, "download")).toEqual({ version: 1, items: { "device:windows": state.items["device:windows"] }, tombstones: {} });
    expect(state).toEqual(original);
    expect(firstSyncUpload(state, "merge")).toBe(state);
  });
});
