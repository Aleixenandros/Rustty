import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { applyMergedState, applySnapshotState, backupSelective, buildSyncState, runSync, summarizeSyncChanges } from "./sync.js";
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

// ── Ciclos completos contra un remoto simulado ─────────────────────────────
// Réplica de `SyncState::merge` (sync.rs): LWW estricto por item y tombstone,
// empezando por el estado que envía el equipo.
function backendMerge(current, remote) {
  const merged = structuredClone(current);
  merged.tombstones = merged.tombstones || {};
  const after = (a, b) => Date.parse(a) > Date.parse(b);
  for (const [key, item] of Object.entries(remote.items || {})) {
    const local = merged.items[key];
    const tomb = merged.tombstones[key];
    if ((!local || after(item.updated_at, local.updated_at)) && (tomb === undefined || after(item.updated_at, tomb))) {
      merged.items[key] = item;
      delete merged.tombstones[key];
    }
  }
  for (const [key, ts] of Object.entries(remote.tombstones || {})) {
    const local = merged.items[key];
    const tomb = merged.tombstones[key];
    if ((!local || after(ts, local.updated_at)) && (tomb === undefined || after(ts, tomb))) {
      delete merged.items[key];
      merged.tombstones[key] = ts;
    }
  }
  return merged;
}

// Catálogo de perfiles del backend: `save_profiles`/`delete_profiles` lo
// cambian y el frontend lo recarga tras una sync con cambios (`get_profiles`).
function profileStore(initial = []) {
  const store = { list: structuredClone(initial), deletes: [], saves: [] };
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "save_profiles") {
      store.saves.push(structuredClone(args.profiles));
      for (const p of args.profiles) {
        const idx = store.list.findIndex((x) => x.id === p.id);
        if (idx >= 0) store.list[idx] = p; else store.list.push(p);
      }
    } else if (cmd === "delete_profiles") {
      store.deletes.push([...args.ids]);
      store.list = store.list.filter((p) => !args.ids.includes(p.id));
    }
    return undefined;
  });
  return store;
}

async function syncCycle(store, prefs, remote, selective = { profiles: true, shortcuts: true, prefs: true }) {
  const current = await buildSyncState({ profiles: store.list, prefs, deviceId: "a", selective, credsCatalog: [] });
  delete current.items["device:a"];
  const merged = backendMerge(current, remote);
  const summary = await applyMergedState(structuredClone(merged), {
    profiles: store.list, prefs, deviceId: "a", prefsSnapshotTs: prefs._prefsUpdatedAt || "", credsCatalog: [],
  });
  return { merged, summary };
}

const deletedAt = "2026-09-10T08:00:00.000Z";
const restoredAt = "2026-09-10T08:00:05.000Z";
const web1 = { id: "web-1", name: "web-1", host: "10.0.0.1", created_at: linuxTimestamp };

describe("un borrado deshecho no se vuelve a borrar", () => {
  beforeEach(() => invoke.mockReset());

  it("Deshacer deja el perfil aunque su tombstone siga en el espejo local", async () => {
    // Deshacer guardó el perfil con fecha nueva; el remoto ya tenía el borrado.
    const store = profileStore([{ ...web1, updated_at: restoredAt }]);
    const prefs = { tombstones: { profiles: { "web-1": deletedAt } } };
    let remote = { items: {}, tombstones: { "profile:web-1": deletedAt } };
    for (let cycle = 0; cycle < 3; cycle++) {
      const { merged } = await syncCycle(store, prefs, remote);
      remote = merged;
    }
    expect(store.deletes).toEqual([]);
    expect(store.list.map((p) => p.id)).toEqual(["web-1"]);
    expect(prefs.tombstones.profiles["web-1"]).toBeUndefined();
    expect(remote.tombstones["profile:web-1"]).toBeUndefined();
  });

  it("un perfil borrado aquí y editado después en otro equipo vuelve y se queda", async () => {
    const store = profileStore([]);
    const prefs = { tombstones: { profiles: { "web-1": deletedAt } } };
    let remote = {
      items: { "profile:web-1": { data: { ...web1, name: "web-01" }, updated_at: restoredAt, device_id: "b" } },
      tombstones: {},
    };
    for (let cycle = 0; cycle < 3; cycle++) {
      const { merged } = await syncCycle(store, prefs, remote);
      remote = merged;
    }
    expect(store.deletes).toEqual([]);
    expect(store.list.map((p) => p.name)).toEqual(["web-01"]);
    expect(prefs.tombstones.profiles["web-1"]).toBeUndefined();
  });

  it("un atajo restablecido aquí y redefinido en otro equipo no parpadea", async () => {
    const store = profileStore([]);
    const prefs = { shortcuts: {}, _shortcutsTs: {}, tombstones: { shortcuts: { new_connection: deletedAt } } };
    let remote = {
      items: { "shortcut:new_connection": { data: "Alt+K", updated_at: restoredAt, device_id: "b" } },
      tombstones: {},
    };
    const changes = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const { merged, summary } = await syncCycle(store, prefs, remote);
      changes.push(summary.shortcutsChanged);
      expect(prefs.shortcuts.new_connection).toBe("Alt+K");
      remote = merged;
    }
    expect(changes).toEqual([1, 0, 0]);
  });

  it("si el tombstone es más nuevo que el item del mismo estado, sigue borrando", async () => {
    const store = profileStore([{ ...web1, updated_at: deletedAt }]);
    const merged = {
      items: { "profile:web-1": { data: { ...web1 }, updated_at: deletedAt, device_id: "a" } },
      tombstones: { "profile:web-1": restoredAt },
    };
    const summary = await applyMergedState(merged, { profiles: store.list, prefs: {}, prefsSnapshotTs: "" });
    expect(store.deletes).toEqual([["web-1"]]);
    expect(store.saves).toEqual([]);
    expect(summary.deletedProfiles).toBe(1);
  });
});

describe("restaurar un snapshot o un backup cuenta como una edición", () => {
  beforeEach(() => invoke.mockReset());
  const dialogs = { confirm: async () => true, promptSecret: async () => null };
  const snapshotAt = "2026-09-09T08:00:00.000Z";
  const remoteEditAt = "2026-09-20T08:00:00.000Z";

  it("lo restaurado sobrevive a la siguiente sync aunque el remoto sea más nuevo", async () => {
    const web2 = { id: "web-2", name: "web-2", host: "10.0.0.2", created_at: linuxTimestamp };
    // Hoy: web-1 borrada (tombstone ya subido) y web-2 creada después del snapshot.
    const store = profileStore([{ ...web2, updated_at: remoteEditAt }]);
    const prefs = { theme: "light", _prefsUpdatedAt: remoteEditAt, tombstones: { profiles: { "web-1": deletedAt } } };
    const remote = {
      items: {
        "profile:web-2": { data: { ...web2 }, updated_at: remoteEditAt, device_id: "b" },
        "prefs:bundle": { data: { theme: "light" }, updated_at: remoteEditAt, device_id: "b" },
      },
      tombstones: { "profile:web-1": deletedAt },
    };
    const snapshot = {
      items: {
        "profile:web-1": { data: { ...web1 }, updated_at: snapshotAt, device_id: "a" },
        "prefs:bundle": { data: { theme: "nord" }, updated_at: snapshotAt, device_id: "a" },
      },
      tombstones: { "profile:web-2": snapshotAt },
    };
    const summary = await applySnapshotState(structuredClone(snapshot), { profiles: store.list, prefs, deviceId: "a", dialogs });
    expect(summary).toMatchObject({ addedProfiles: 1, deletedProfiles: 1, prefsChanged: true });
    expect(prefs.tombstones.profiles["web-1"]).toBeUndefined();
    expect(Date.parse(prefs.tombstones.profiles["web-2"])).toBeGreaterThan(Date.parse(remoteEditAt));

    await syncCycle(store, prefs, remote);
    expect(store.list.map((p) => p.id)).toEqual(["web-1"]);
    expect(prefs.theme).toBe("nord");
  });

  it("lo que solo difiere en la fecha no se reescribe ni gana al remoto", async () => {
    const store = profileStore([{ ...web1, updated_at: remoteEditAt }]);
    const prefs = { theme: "nord", _prefsUpdatedAt: remoteEditAt };
    const snapshot = {
      items: {
        "profile:web-1": { data: { ...web1 }, updated_at: snapshotAt, device_id: "a" },
        "prefs:bundle": { data: { theme: "nord" }, updated_at: snapshotAt, device_id: "a" },
      },
      tombstones: {},
    };
    const summary = await applySnapshotState(snapshot, { profiles: store.list, prefs, deviceId: "a", dialogs });
    expect(store.saves).toEqual([]);
    expect(summary.updatedProfiles).toBe(0);
    expect(prefs._prefsUpdatedAt).toBe(remoteEditAt);
  });
});

describe("una edición con la sync en vuelo no se pierde", () => {
  beforeEach(() => invoke.mockReset());

  function mockSyncRun(onFlight, respond = (current) => current) {
    const base = invoke.getMockImplementation();
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "keyring_get") return "frase";
      if (cmd === "sync_get_config") return { backend: "local", selective: { profiles: true, shortcuts: true } };
      if (cmd === "note_export_all" || cmd === "master_cred_list") return [];
      if (cmd === "sync_run") {
        onFlight();
        return { state: respond(structuredClone(args.current)), uploaded: {} };
      }
      return base(cmd, args);
    });
  }

  it("renombrar un perfil mientras vuela la sync conserva el nombre nuevo", async () => {
    const store = profileStore([{ ...web1, updated_at: deletedAt }]);
    const profiles = store.list;
    mockSyncRun(() => {
      // F2 durante la sync: la edición reemplaza el perfil en el mismo array.
      profiles[0] = { ...profiles[0], name: "web-01", updated_at: restoredAt };
    });
    const summary = await runSync({ profiles, prefs: {}, deviceId: "a" });
    expect(store.saves).toEqual([]);
    expect(summary.updatedProfiles).toBe(0);
    expect(summary.skippedNewerLocal).toBe(true);
    expect(profiles[0].name).toBe("web-01");
  });

  it("un atajo cambiado mientras vuela la sync no vuelve al valor anterior", async () => {
    profileStore([]);
    const prefs = {};
    setShortcut(prefs, "new_connection", "Alt+N", deletedAt);
    mockSyncRun(() => setShortcut(prefs, "new_connection", "Alt+M", restoredAt));
    const summary = await runSync({ profiles: [], prefs, deviceId: "a" });
    expect(prefs.shortcuts.new_connection).toBe("Alt+M");
    expect(summary.skippedNewerLocal).toBe(true);
  });

  it("sin ediciones en vuelo, la versión remota más nueva se sigue aplicando", async () => {
    const store = profileStore([{ ...web1, updated_at: deletedAt }]);
    mockSyncRun(() => {}, (state) => {
      state.items["profile:web-1"] = { data: { ...web1, name: "web-remota" }, updated_at: restoredAt, device_id: "b" };
      return state;
    });
    const summary = await runSync({ profiles: store.list, prefs: {}, deviceId: "a" });
    expect(summary.updatedProfiles).toBe(1);
    expect(summary.skippedNewerLocal).toBe(false);
    expect(store.list[0].name).toBe("web-remota");
  });
});

describe("backup manual con contraseñas", () => {
  const catalog = [
    { id: "m1", kind: "master", name: "Root", updated_at: linuxTimestamp },
    { id: "s1", kind: "secret", name: "Token", updated_at: linuxTimestamp },
    { id: "v1", kind: "var", name: "Dominio", value: "example.org", updated_at: linuxTimestamp },
  ];
  const keyring = {
    "master:m1": "pw-maestra", "secret:s1": "tok-secreto",
    "password:p1": "pw-perfil", "password:p1:u2": "pw-usuario-extra",
  };
  const profiles = [{ id: "p1", name: "web", extra_credentials: [{ id: "u2" }], updated_at: linuxTimestamp }];

  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "keyring_get") return keyring[args.key] ?? null;
      if (cmd === "note_export_all") return [];
      return null;
    });
  });

  it("con el opt-in incluye los valores del catálogo y los usuarios adicionales", async () => {
    const state = await buildSyncState({
      profiles, prefs: {}, deviceId: "linux", credsCatalog: catalog,
      selective: backupSelective(true),
    });
    expect(state.items["secret:master:m1"]?.data).toEqual({ key: "master:m1", secret: "pw-maestra" });
    expect(state.items["secret:secret:s1"]?.data).toEqual({ key: "secret:s1", secret: "tok-secreto" });
    expect(state.items["secret:password:p1:u2"]?.data.secret).toBe("pw-usuario-extra");
    expect(state.items["secret:password:p1"]?.data.secret).toBe("pw-perfil");
  });

  it("sin el opt-in el catálogo viaja solo con metadatos", async () => {
    const state = await buildSyncState({
      profiles, prefs: {}, deviceId: "linux", credsCatalog: catalog,
      selective: backupSelective(false),
    });
    expect(Object.keys(state.items).filter((k) => k.startsWith("secret:"))).toEqual([]);
    expect(state.items["cred:m1"]?.data.value).toBeNull();
    expect(state.items["cred:v1"]?.data.value).toBe("example.org");
  });
});

describe("scripts en la sincronización", () => {
  const base = {
    id: "sc1", name: "Reinicio", target: { kind: "adhoc", profileIds: [] },
    steps: [{ kind: "send", text: "uptime" }],
    createdAt: linuxTimestamp, updatedAt: linuxTimestamp,
  };
  let local;
  let calls;

  beforeEach(() => {
    local = [];
    calls = [];
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "scripts_get_all") return local.map((s) => ({ ...s }));
      if (cmd === "note_export_all" || cmd === "master_cred_list") return [];
      return null;
    });
  });

  it("viajan como script:<id> con su fecha y sus tombstones", async () => {
    const prefs = { tombstones: { scripts: { viejo: windowsTimestamp } } };
    const state = await buildSyncState({
      profiles: [], prefs, deviceId: "linux", credsCatalog: [],
      selective: { scripts: true }, scriptsList: [base],
    });
    expect(state.items["script:sc1"]).toMatchObject({ data: base, updated_at: linuxTimestamp });
    expect(state.tombstones["script:viejo"]).toBe(windowsTimestamp);
  });

  it("se importan conservando la fecha y no se reescriben si son idénticos", async () => {
    const remote = { items: { "script:sc1": { data: base, updated_at: windowsTimestamp, device_id: "win" } } };
    let summary = await applyMergedState(remote, { profiles: [], prefs: {}, scriptsList: [] });
    const imported = calls.find(([cmd]) => cmd === "scripts_import");
    expect(imported?.[1].script.updatedAt).toBe(windowsTimestamp);
    expect(summary.scriptsChanged).toBe(1);

    local = [{ ...base, updatedAt: windowsTimestamp }];
    calls = [];
    summary = await applyMergedState(remote, { profiles: [], prefs: {}, scriptsList: local });
    expect(calls.some(([cmd]) => cmd === "scripts_import")).toBe(false);
    expect(summary.scriptsChanged).toBe(0);
  });

  it("no pisa un script editado mientras la sync estaba en vuelo", async () => {
    const atBuild = [{ ...base }];
    local = [{ ...base, name: "Editado ahora", updatedAt: "2026-10-01T00:00:00.000Z" }];
    const remote = { items: { "script:sc1": { data: { ...base, name: "Remoto" }, updated_at: windowsTimestamp } } };
    const summary = await applyMergedState(remote, { profiles: [], prefs: {}, scriptsList: atBuild });
    expect(calls.some(([cmd]) => cmd === "scripts_import")).toBe(false);
    expect(summary.skippedNewerLocal).toBe(true);
  });

  it("un tombstone remoto borra el script local, y solo una vez", async () => {
    local = [{ ...base }];
    const remote = { items: {}, tombstones: { "script:sc1": windowsTimestamp } };
    const summary = await applyMergedState(remote, { profiles: [], prefs: {}, scriptsList: local });
    expect(calls.some(([cmd, args]) => cmd === "scripts_delete" && args.id === "sc1")).toBe(true);
    expect(summary.scriptsChanged).toBe(1);

    local = [];
    calls = [];
    const again = await applyMergedState(remote, { profiles: [], prefs: {}, scriptsList: [] });
    expect(calls.some(([cmd]) => cmd === "scripts_delete")).toBe(false);
    expect(again.scriptsChanged).toBe(0);
  });

  it("el backup manual los incluye", () => {
    expect(backupSelective(false).scripts).toBe(true);
  });
});

describe("preferencias resueltas por clave", () => {
  const T5 = "2026-10-05T00:00:00.000Z";
  const T6 = "2026-10-06T00:00:00.000Z";
  const T7 = "2026-10-07T00:00:00.000Z";
  const keyed = (id) => ({ [`device:${id}`]: { data: { keyed_prefs: true }, updated_at: T5, device_id: id } });

  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("viajan como pref:<clave> con su propia fecha además del bundle", async () => {
    const prefs = { theme: "nord", fontSize: 13, _prefsUpdatedAt: T5 };
    const state = await buildSyncState({ profiles: [], prefs, deviceId: "a", selective: { prefs: true }, credsCatalog: [] });
    expect(state.items["pref:theme"]).toMatchObject({ data: { value: "nord" }, updated_at: T5 });
    expect(state.items["prefs:bundle"].data.theme).toBe("nord");
    expect(state.items["device:a"].data.keyed_prefs).toBe(true);
  });

  it("dos equipos que editan claves distintas conservan las dos ediciones", async () => {
    // A cambió el tema (T5); B, el tamaño de letra (T6). El bundle ganador
    // es el de B, que aún lleva el tema viejo: no puede revertir el de A.
    const merged = {
      items: {
        ...keyed("a"), ...keyed("b"),
        "pref:theme": { data: { value: "nord" }, updated_at: T5, device_id: "a" },
        "pref:fontSize": { data: { value: 16 }, updated_at: T6, device_id: "b" },
        "prefs:bundle": { data: { theme: "light", fontSize: 16 }, updated_at: T6, device_id: "b" },
      },
    };
    const prefs = { theme: "nord", fontSize: 13, _prefsUpdatedAt: T5 };
    const summary = await applyMergedState(merged, { profiles: [], prefs, deviceId: "a" });
    expect(prefs.theme).toBe("nord");
    expect(prefs.fontSize).toBe(16);
    expect(summary.prefsChanged).toBe(true);
    expect(prefs._prefsUpdatedAt).toBe(T6);
  });

  it("el bundle de un equipo antiguo gana en las claves donde es más nuevo", async () => {
    const merged = {
      items: {
        ...keyed("a"),
        "pref:theme": { data: { value: "nord" }, updated_at: T5, device_id: "a" },
        "pref:fontSize": { data: { value: 13 }, updated_at: T7, device_id: "a" },
        // Equipo «viejo» sin keyed_prefs, editó en T6.
        "prefs:bundle": { data: { theme: "light", fontSize: 20 }, updated_at: T6, device_id: "viejo" },
      },
    };
    const prefs = { theme: "nord", fontSize: 13, _prefsUpdatedAt: T7 };
    await applyMergedState(merged, { profiles: [], prefs, deviceId: "a" });
    expect(prefs.theme).toBe("light"); // bundle T6 > pref:theme T5
    expect(prefs.fontSize).toBe(13);   // pref:fontSize T7 > bundle T6
  });

  it("no revierte una clave editada con la sync en vuelo", async () => {
    const prefs = { theme: "nord", fontSize: 13, _prefsUpdatedAt: T5 };
    const { capturePrefKeyHashes } = await import("./modules/prefs/key-stamps.js");
    const prefKeyHashes = capturePrefKeyHashes(prefs);
    prefs.fontSize = 18; // edición durante la sync
    const merged = {
      items: {
        ...keyed("b"),
        "pref:fontSize": { data: { value: 16 }, updated_at: T6, device_id: "b" },
        "pref:theme": { data: { value: "light" }, updated_at: T6, device_id: "b" },
      },
    };
    const summary = await applyMergedState(merged, { profiles: [], prefs, deviceId: "a", prefKeyHashes });
    expect(prefs.fontSize).toBe(18);
    expect(prefs.theme).toBe("light");
    expect(summary.prefsSkippedNewerLocal).toBe(true);
  });

  it("un estado sin items pref: (backup antiguo) aplica el bundle entero", async () => {
    const prefs = { theme: "nord", fontSize: 13 };
    await applyMergedState(
      { items: { "prefs:bundle": { data: { theme: "light", fontSize: 20 }, updated_at: T6, device_id: "x" } } },
      { profiles: [], prefs, deviceId: "a" },
    );
    expect(prefs).toMatchObject({ theme: "light", fontSize: 20 });
  });
});
