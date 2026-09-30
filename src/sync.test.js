import { describe, expect, it, vi } from "vitest";
import { applyMergedState, buildSyncState } from "./sync.js";
import { applyPrefsForm } from "./modules/prefs/sync.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const linuxTimestamp = "2026-09-01T12:00:00.000Z";
const windowsTimestamp = "2026-09-30T12:00:00.000Z";
const remotePrefs = {
  theme: "light", rightClickPaste: true,
  workspaces: [{ id: "default", name: "Personal" }, { id: "ws-work", name: "Trabajo" }],
  userFoldersByWorkspace: { "ws-work": ["Producción"] },
};
const remote = { items: { "prefs:bundle": { data: remotePrefs, updated_at: linuxTimestamp, device_id: "linux" } } };

describe("preferencias de un equipo nuevo", () => {
  it("configurar sync no antepone los defaults de Windows al bundle de Linux", async () => {
    const prefs = { theme: "dark", rightClickPaste: false, workspaces: [{ id: "default", name: "Default" }] };
    const form = { theme: "dark", rightClickPaste: false };
    applyPrefsForm(prefs, form, { ...form }, windowsTimestamp);
    const current = await buildSyncState({ profiles: [], prefs, deviceId: "windows", selective: { prefs: true }, credsCatalog: [] });
    expect(current.items["prefs:bundle"].updated_at < linuxTimestamp).toBe(true);
    const summary = await applyMergedState(structuredClone(remote), { profiles: [], prefs, prefsSnapshotTs: "" });
    expect(summary.prefsChanged).toBe(true);
    expect(prefs).toMatchObject(remotePrefs);
    // El modal seguía abierto al recibir Linux: Guardar tampoco revierte.
    applyPrefsForm(prefs, form, { ...form }, windowsTimestamp);
    expect(prefs).toMatchObject(remotePrefs);
    expect(prefs._prefsUpdatedAt).toBe(linuxTimestamp);
  });

  it("una edición durante la primera descarga se conserva aunque antes no hubiera timestamp", async () => {
    const prefs = { theme: "dark" };
    applyPrefsForm(prefs, { theme: "dark" }, { theme: "light" }, windowsTimestamp);
    const summary = await applyMergedState(structuredClone(remote), { profiles: [], prefs, prefsSnapshotTs: "" });
    expect(summary.prefsSkippedNewerLocal).toBe(true);
    expect(prefs._prefsUpdatedAt).toBe(windowsTimestamp);
  });

  it("importar o restaurar explícitamente sigue aplicando un bundle anterior", async () => {
    const prefs = { theme: "dark", _prefsUpdatedAt: windowsTimestamp };
    const summary = await applyMergedState(structuredClone(remote), { profiles: [], prefs });
    expect(summary.prefsChanged).toBe(true);
    expect(prefs).toMatchObject(remotePrefs);
  });
});
