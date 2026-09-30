import { describe, expect, it } from "vitest";
import { applyPrefsForm } from "./sync.js";

const earlier = "2026-09-01T12:00:00.000Z";
const now = "2026-09-30T12:00:00.000Z";

describe("guardar preferencias mientras se configura o recibe la sincronización", () => {
  it("un equipo nuevo no convierte sus defaults en una edición por pulsar Guardar", () => {
    const prefs = { theme: "dark", rightClickPaste: false, workspaces: [{ id: "default", name: "Default" }] };
    const form = { theme: "dark", rightClickPaste: false };
    applyPrefsForm(prefs, form, { ...form }, now);
    expect(prefs._prefsUpdatedAt).toBeUndefined();
  });

  it("un ajuste local no da prioridad al bundle antiguo", () => {
    const prefs = { theme: "dark", localShellCwd: "", _prefsUpdatedAt: earlier };
    applyPrefsForm(prefs, { theme: "dark", localShellCwd: "" }, { theme: "dark", localShellCwd: "C:\\work" }, now);
    expect(prefs.localShellCwd).toBe("C:\\work");
    expect(prefs._prefsUpdatedAt).toBe(earlier);
  });

  it("guardar el formulario antiguo conserva lo recibido de Linux y los metadatos locales", () => {
    const form = { theme: "dark", rightClickPaste: false, highlightRules: [] };
    const remote = {
      theme: "light", rightClickPaste: true, highlightRules: [{ pattern: "error", color: "red" }],
      workspaces: [{ id: "ws-work", name: "Trabajo" }],
      userFoldersByWorkspace: { "ws-work": ["Producción"] },
      _prefsUpdatedAt: earlier, _secretsTs: { "password:test": earlier },
      syncDeviceName: "Windows", sidebarCompact: true,
    };
    const prefs = structuredClone(remote);
    applyPrefsForm(prefs, form, structuredClone(form), now);
    expect(prefs).toEqual(remote);
  });

  it("una edición explícita conserva los demás ajustes recibidos y fecha el bundle", () => {
    const prefs = { theme: "light", rightClickPaste: true, fontSize: 16, _prefsUpdatedAt: earlier };
    applyPrefsForm(prefs,
      { theme: "dark", rightClickPaste: false, fontSize: 14 },
      { theme: "dark", rightClickPaste: false, fontSize: 18 }, now);
    expect(prefs).toEqual({ theme: "light", rightClickPaste: true, fontSize: 18, _prefsUpdatedAt: now });
  });

  it("fecha una edición de tipografía aunque el preview ya esté aplicado", () => {
    const prefs = { fontSize: 18, _prefsUpdatedAt: earlier };
    applyPrefsForm(prefs, { fontSize: 14 }, { fontSize: 18 }, now);
    expect(prefs._prefsUpdatedAt).toBe(now);
  });

  it("mantiene el objeto que usa una sincronización en vuelo", () => {
    const prefs = { theme: "dark" };
    const inFlight = prefs;
    applyPrefsForm(prefs, { theme: "dark" }, { theme: "light" }, now);
    expect(inFlight.theme).toBe("light");
    expect(inFlight._prefsUpdatedAt).toBe(now);
  });
});
