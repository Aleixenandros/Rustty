import { describe, expect, it, vi } from "vitest";
import { applyMergedState, buildSyncState, summarizeSyncChanges } from "./sync.js";
import { applyPrefsForm } from "./modules/prefs/sync.js";
import { setShortcut } from "./modules/shortcuts/model.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const linuxTimestamp = "2026-09-01T12:00:00.000Z";
const windowsTimestamp = "2026-09-30T12:00:00.000Z";
const remotePrefs = {
  theme: "light", rightClickPaste: true,
  workspaces: [{ id: "default", name: "Personal" }, { id: "ws-work", name: "Trabajo" }],
  userFoldersByWorkspace: { "ws-work": ["Producción"] },
};
const remote = { items: { "prefs:bundle": { data: remotePrefs, updated_at: linuxTimestamp, device_id: "linux" } } };

describe("resumen bidireccional de sincronización", () => {
  it("cuenta una carpeta y dos conexiones enviadas aunque nada cambie aquí", () => {
    const result = summarizeSyncChanges({ uploaded: { prefs: 1, profiles: 2 } });
    expect(result).toMatchObject({ uploaded: 3, downloaded: 0, total: 3, counts: { profiles: 2, prefs: 1 } });
  });

  it("separa lo recibido de lo enviado para no refrescar la UI por una subida", () => {
    const result = summarizeSyncChanges({ uploaded: { profiles: 2 }, updatedProfiles: 1, prefsChanged: true });
    expect(result).toMatchObject({ uploaded: 2, downloaded: 2, total: 4, counts: { profiles: 3, prefs: 1 } });
  });

  it("un ciclo vacío no vuelve a contar cambios ni metadatos del dispositivo", () => {
    expect(summarizeSyncChanges({ uploaded: { device: 1 } })).toMatchObject({ uploaded: 0, downloaded: 0, total: 0 });
  });
});

it("editar, desactivar y restablecer un atajo viaja sin alterar las preferencias", async () => {
  const source = { theme: "nord", _prefsUpdatedAt: linuxTimestamp };
  const target = { theme: "light" };
  for (const value of ["Alt+N", null, "Ctrl+Shift+N"]) {
    setShortcut(source, "new_connection", value, windowsTimestamp);
    const state = await buildSyncState({ profiles: [], prefs: source, deviceId: "linux", selective: { shortcuts: true }, credsCatalog: [] });
    await applyMergedState(state, { profiles: [], prefs: target });
    expect(target.shortcuts?.new_connection).toBe(value === "Ctrl+Shift+N" ? undefined : value);
    expect(target.theme).toBe("light");
    expect(source._prefsUpdatedAt).toBe(linuxTimestamp);
  }
});

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
