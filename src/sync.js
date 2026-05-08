// ═══════════════════════════════════════════════════════════════════
//  Sincronización en la nube — frontend
//
//  Responsabilidades:
//   1. Construir un `SyncState` con los items locales (perfiles, prefs,
//      temas, atajos) que el usuario haya marcado como sincronizables.
//   2. Llamar al comando Tauri `sync_run` con la passphrase + WebDAV pwd
//      leídas del keyring del SO.
//   3. Aplicar el `SyncState` resultante (merge LWW): guardar perfiles,
//      mezclar prefs, registrar temas custom, aplicar atajos.
//
//  Las claves del estado siguen el patrón:
//    profile:<uuid>, prefs:bundle, theme:<id>, shortcut:<actionId>
//
//  Las contraseñas del keyring del SO solo se incluyen en exports/backups
//  cuando el usuario lo confirma explícitamente.
// ═══════════════════════════════════════════════════════════════════

import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";

const KEYRING_SERVICE = "rustty";
const KEY_PASSPHRASE = "sync:passphrase";
const KEY_WEBDAV_PASS = "sync:webdav_password";

// Subset de prefs que se sincroniza (excluimos rutas locales; los secretos
// viajan como items `secret:*` solo si el usuario activa esa opción).
const SYNCED_PREF_KEYS = [
  "theme", "terminalTheme", "copyOnSelect", "rightClickPaste",
  "fontFamily", "fontSize", "lineHeight", "letterSpacing",
  "cursorStyle", "cursorBlink", "scrollback", "bell", "lang",
  "userFolders", "userFoldersByWorkspace",
  "workspaces", "favorites",
  "folderColors", "highlightRules",
];

// Estado local de navegación. No debe viajar ni re-aplicarse desde otra
// máquina porque hace que la sidebar cambie o se repliegue al terminar sync.
const LOCAL_UI_PREF_KEYS = new Set(["activeWorkspaceId", "sidebarViewMode"]);
const SYNC_FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function stableTimestamp(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || SYNC_FALLBACK_TIMESTAMP;
}

function normalizeForCompare(value) {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = normalizeForCompare(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function sameValue(a, b) {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

/* ───────────────────────────── Construcción del estado ─────────────────── */

/**
 * Construye el SyncState a partir del estado local actual del frontend.
 * @param {object} ctx { profiles, prefs, snippets, deviceId, selective }
 */
async function readProfileSecret(key) {
  try {
    return await invoke("keyring_get", {
      service: KEYRING_SERVICE,
      key,
    });
  } catch {
    return null;
  }
}

async function addProfileSecretItems(items, profiles, prefs, deviceId) {
  const secretTs = prefs._secretsTs || {};
  for (const profile of profiles || []) {
    const pairs = [
      [`password:${profile.id}`, `secret:password:${profile.id}`],
      [`passphrase:${profile.id}`, `secret:passphrase:${profile.id}`],
    ];
    for (const [key, itemKey] of pairs) {
      const secret = await readProfileSecret(key);
      if (!secret) continue;
      items[itemKey] = {
        data: { key, secret },
        updated_at: stableTimestamp(secretTs[key], profile.updated_at, profile.created_at),
        device_id: deviceId,
      };
    }
  }
}

export async function buildSyncState(ctx) {
  const { profiles, prefs, deviceId, selective } = ctx;
  const items = {};
  const tombstones = {};
  const now = new Date().toISOString();

  if (selective.profiles) {
    for (const p of profiles) {
      items[`profile:${p.id}`] = {
        data: p,
        updated_at: stableTimestamp(p.updated_at, p.created_at),
        device_id: deviceId,
      };
    }
    Object.entries(prefs.tombstones?.profiles || {}).forEach(([id, ts]) => {
      tombstones[`profile:${id}`] = ts;
    });
  }

  if (selective.prefs) {
    const bundle = {};
    for (const k of SYNCED_PREF_KEYS) bundle[k] = prefs[k];
    items["prefs:bundle"] = {
      data: bundle,
      updated_at: stableTimestamp(prefs._prefsUpdatedAt),
      device_id: deviceId,
    };
  }

  if (selective.themes) {
    for (const t of prefs.customThemes || []) {
      items[`theme:${t.id}`] = {
        data: t,
        updated_at: stableTimestamp(t.updatedAt),
        device_id: deviceId,
      };
    }
    Object.entries(prefs.tombstones?.themes || {}).forEach(([id, ts]) => {
      tombstones[`theme:${id}`] = ts;
    });
  }

  if (selective.shortcuts) {
    const sc = prefs.shortcuts || {};
    const ts = prefs._shortcutsTs || {};
    for (const [id, accel] of Object.entries(sc)) {
      items[`shortcut:${id}`] = {
        data: accel,            // string o null (desactivado)
        updated_at: stableTimestamp(ts[id]),
        device_id: deviceId,
      };
    }
    Object.entries(prefs.tombstones?.shortcuts || {}).forEach(([id, ts]) => {
      tombstones[`shortcut:${id}`] = ts;
    });
  }

  if (selective.snippets) {
    for (const snippet of ctx.snippets || []) {
      if (!snippet?.id) continue;
      items[`snippet:${snippet.id}`] = {
        data: snippet,
        updated_at: stableTimestamp(snippet.updated_at, snippet.updatedAt),
        device_id: deviceId,
      };
    }
    Object.entries(prefs.tombstones?.snippets || {}).forEach(([id, ts]) => {
      tombstones[`snippet:${id}`] = ts;
    });
  }

  if (selective.secrets) {
    await addProfileSecretItems(items, profiles, prefs, deviceId);
  }

  const exportedSecrets = ctx.exportedSecrets?.entries;
  if (exportedSecrets && typeof exportedSecrets === "object" && !Array.isArray(exportedSecrets)) {
    const exportedAt = ctx.exportedSecrets.exportedAt || now;
    for (const [profileId, secrets] of Object.entries(exportedSecrets)) {
      if (!secrets || typeof secrets !== "object") continue;
      if (secrets.password) {
        items[`secret:password:${profileId}`] = {
          data: { key: `password:${profileId}`, secret: secrets.password },
          updated_at: ctx.exportedSecrets.timestamps?.[`password:${profileId}`] || exportedAt,
          device_id: deviceId,
        };
      }
      if (secrets.passphrase) {
        items[`secret:passphrase:${profileId}`] = {
          data: { key: `passphrase:${profileId}`, secret: secrets.passphrase },
          updated_at: ctx.exportedSecrets.timestamps?.[`passphrase:${profileId}`] || exportedAt,
          device_id: deviceId,
        };
      }
    }
  }

  return { version: 1, items, tombstones };
}

/* ─────────────────────────── Aplicación del estado ───────────────────── */

/**
 * Aplica al estado local los cambios resultantes del merge.
 * Devuelve { addedProfiles, deletedProfiles, prefsChanged, themesChanged, shortcutsChanged }
 * para que el caller decida qué refrescar en la UI.
 */
export async function applyMergedState(merged, ctx) {
  const { profiles, prefs } = ctx;
  const allowSecrets = !!ctx.allowSecrets;
  let addedProfiles = 0, deletedProfiles = 0, prefsChanged = false;
  let themesChanged = 0, shortcutsChanged = 0;
  let secretsChanged = 0;

  const localProfileIds = new Set(profiles.map((p) => p.id));
  const localProfilesById = new Map(profiles.map((p) => [p.id, p]));

  // Items
  for (const [key, item] of Object.entries(merged.items || {})) {
    if (key.startsWith("profile:")) {
      const id = key.slice(8);
      const profile = { ...(item.data || {}) };
      // Asegura los campos requeridos
      if (!profile.id) profile.id = id;
      if (!profile.created_at) profile.created_at = new Date().toISOString();
      profile.updated_at = item.updated_at;
      const existing = localProfilesById.get(id);
      if (existing && sameValue(existing, profile)) continue;
      try {
        await invoke("save_profile", { profile });
        if (!localProfileIds.has(id)) addedProfiles++;
      } catch (err) {
        console.error("[sync] save_profile", id, err);
      }
    } else if (key === "prefs:bundle") {
      let bundleChanged = false;
      let bundleDataChanged = false;
      for (const [prefKey, value] of Object.entries(item.data || {})) {
        if (LOCAL_UI_PREF_KEYS.has(prefKey)) continue;
        if (sameValue(prefs[prefKey], value)) continue;
        prefs[prefKey] = value;
        bundleChanged = true;
        bundleDataChanged = true;
      }
      if (prefs._prefsUpdatedAt !== item.updated_at) {
        prefs._prefsUpdatedAt = item.updated_at;
        bundleChanged = true;
      }
      if (bundleChanged) prefsChanged = bundleDataChanged;
    } else if (key.startsWith("theme:")) {
      const id = key.slice(6);
      const theme = { ...(item.data || {}) };
      theme.updatedAt = item.updated_at;
      const list = prefs.customThemes || (prefs.customThemes = []);
      const idx = list.findIndex((t) => t.id === id);
      if (idx >= 0 && sameValue(list[idx], theme)) continue;
      if (idx >= 0) list[idx] = theme; else list.push(theme);
      themesChanged++;
    } else if (key.startsWith("shortcut:")) {
      const id = key.slice(9);
      prefs.shortcuts = prefs.shortcuts || {};
      prefs._shortcutsTs = prefs._shortcutsTs || {};
      const valueChanged = !sameValue(prefs.shortcuts[id], item.data);
      const timestampChanged = prefs._shortcutsTs[id] !== item.updated_at;
      if (!valueChanged && !timestampChanged) continue;
      prefs.shortcuts[id] = item.data;
      prefs._shortcutsTs[id] = item.updated_at;
      if (valueChanged) shortcutsChanged++;
    } else if (key.startsWith("snippet:")) {
      const id = key.slice(8);
      const snippet = { ...(item.data || {}) };
      snippet.id = snippet.id || id;
      snippet.updated_at = item.updated_at;
      const existing = loadLocalSnippets().find((entry) => entry.id === id);
      if (existing && sameValue(existing, snippet)) continue;
      upsertLocalSnippet(snippet);
    } else if (key.startsWith("secret:") && allowSecrets) {
      const secretKey = item.data?.key || key.slice(7);
      const secret = item.data?.secret;
      if (secretKey && secret) {
        if (prefs._secretsTs?.[secretKey] === item.updated_at) continue;
        try {
          await invoke("keyring_set", {
            service: KEYRING_SERVICE,
            key: secretKey,
            secret,
          });
          prefs._secretsTs = prefs._secretsTs || {};
          prefs._secretsTs[secretKey] = item.updated_at;
          secretsChanged++;
        } catch (err) {
          console.error("[sync] keyring_set", secretKey, err);
        }
      }
    }
  }

  // Tombstones
  for (const [key, ts] of Object.entries(merged.tombstones || {})) {
    if (key.startsWith("profile:")) {
      const id = key.slice(8);
      if (localProfileIds.has(id)) {
        try {
          await invoke("delete_profile", { id });
          deletedProfiles++;
        } catch (err) {
          console.error("[sync] delete_profile", id, err);
        }
      }
    } else if (key.startsWith("theme:")) {
      const id = key.slice(6);
      if (prefs.customThemes) {
        prefs.customThemes = prefs.customThemes.filter((t) => t.id !== id);
        themesChanged++;
      }
    } else if (key.startsWith("shortcut:")) {
      const id = key.slice(9);
      if (prefs.shortcuts && id in prefs.shortcuts) {
        delete prefs.shortcuts[id];
        shortcutsChanged++;
      }
    } else if (key.startsWith("snippet:")) {
      deleteLocalSnippet(key.slice(8));
    }
  }

  return { addedProfiles, deletedProfiles, prefsChanged, themesChanged, shortcutsChanged, secretsChanged };
}

function stateHasSecrets(state) {
  return Object.keys(state?.items || {}).some((key) => key.startsWith("secret:"));
}

const SNIPPETS_STORAGE_KEY = "rustty-snippets";

export function loadLocalSnippets() {
  try {
    const value = JSON.parse(localStorage.getItem(SNIPPETS_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveLocalSnippets(snippets) {
  localStorage.setItem(SNIPPETS_STORAGE_KEY, JSON.stringify(snippets));
}

function upsertLocalSnippet(snippet) {
  const snippets = loadLocalSnippets();
  const idx = snippets.findIndex((item) => item.id === snippet.id);
  if (idx >= 0) snippets[idx] = snippet;
  else snippets.push(snippet);
  saveLocalSnippets(snippets);
}

function deleteLocalSnippet(id) {
  saveLocalSnippets(loadLocalSnippets().filter((snippet) => snippet.id !== id));
}

/* ─────────────────────────── Helpers de keyring ────────────────────── */

export async function getStoredPassphrase() {
  try {
    return await invoke("keyring_get", {
      service: KEYRING_SERVICE,
      key: KEY_PASSPHRASE,
    });
  } catch { return null; }
}

export async function setStoredPassphrase(value) {
  if (value === null || value === "") {
    await invoke("keyring_delete", {
      service: KEYRING_SERVICE,
      key: KEY_PASSPHRASE,
    }).catch(() => {});
    return;
  }
  await invoke("keyring_set", {
    service: KEYRING_SERVICE,
    key: KEY_PASSPHRASE,
    secret: value,
  });
}

export async function getStoredWebDavPassword() {
  try {
    return await invoke("keyring_get", {
      service: KEYRING_SERVICE,
      key: KEY_WEBDAV_PASS,
    });
  } catch { return null; }
}

export async function setStoredWebDavPassword(value) {
  if (value === null || value === "") {
    await invoke("keyring_delete", {
      service: KEYRING_SERVICE,
      key: KEY_WEBDAV_PASS,
    }).catch(() => {});
    return;
  }
  await invoke("keyring_set", {
    service: KEYRING_SERVICE,
    key: KEY_WEBDAV_PASS,
    secret: value,
  });
}

/* ─────────────────────────── Comandos de alto nivel ────────────────── */

export async function getConfig() {
  return await invoke("sync_get_config");
}

export async function saveConfig(config) {
  await invoke("sync_save_config", { config });
}

export async function getDeviceId() {
  return await invoke("sync_get_device_id");
}

export async function oauthStatus(provider) {
  return await invoke("sync_oauth_status", { provider });
}

export async function oauthDisconnect(provider) {
  return await invoke("sync_oauth_disconnect", { provider });
}

export async function oauthConnect(provider) {
  const flow = await invoke("sync_oauth_begin", { provider });
  await invoke("plugin:opener|open_url", { url: flow.auth_url });
  return await invoke("sync_oauth_complete", { flowId: flow.flow_id });
}

export async function testBackend() {
  const webdavPassword = await getStoredWebDavPassword();
  return await invoke("sync_test_backend", { webdavPassword });
}

/**
 * Ejecuta un ciclo completo pull → merge → push y aplica el resultado.
 * Devuelve el desglose de cambios.
 */
export async function runSync(ctx) {
  const passphrase = await getStoredPassphrase();
  if (!passphrase) throw new Error("no_passphrase");
  const config = await getConfig();
  const webdavPassword =
    config.backend === "webdav" ? await getStoredWebDavPassword() : null;

  const current = await buildSyncState({
    profiles: ctx.profiles,
    prefs: ctx.prefs,
    deviceId: ctx.deviceId,
    selective: {
      profiles: !!config.selective?.profiles,
      prefs: !!config.selective?.prefs,
      themes: !!config.selective?.themes,
      shortcuts: !!config.selective?.shortcuts,
      snippets: !!config.selective?.snippets,
      secrets: !!config.selective?.secrets,
    },
    snippets: loadLocalSnippets(),
  });

  const merged = await invoke("sync_run", {
    current,
    passphrase,
    webdavPassword,
  });

  const summary = await applyMergedState(merged, {
    ...ctx,
    allowSecrets: !!config.selective?.secrets,
  });
  return summary;
}

/* ─────────────────────────── Backup cifrado a fichero ─────────────── */

export async function exportToFile(ctx) {
  const path = await saveDialog({
    title: "Exportar backup cifrado de Rustty",
    defaultPath: `rustty-sync-${new Date().toISOString().slice(0, 10)}.bin`,
    filters: [{ name: "Rustty sync", extensions: ["bin"] }],
  });
  if (!path) return null;

  // Pide passphrase al usuario
  const passphrase = window.prompt(
    "Passphrase para cifrar el fichero (no la pierdas):"
  );
  if (!passphrase) return null;

  const state = await buildSyncState({
    profiles: ctx.profiles,
    prefs: ctx.prefs,
    deviceId: ctx.deviceId,
    selective: { profiles: true, prefs: true, themes: true, shortcuts: true, snippets: true },
    snippets: loadLocalSnippets(),
    exportedSecrets: ctx.exportedSecrets,
  });

  await invoke("sync_export_file", { path, passphrase, state });
  return path;
}

export async function importFromFile(ctx) {
  const path = await openDialog({
    title: "Importar backup cifrado de Rustty",
    multiple: false,
    filters: [{ name: "Rustty sync", extensions: ["bin"] }],
  });
  if (!path) return null;

  const passphrase = window.prompt("Passphrase del fichero:");
  if (!passphrase) return null;

  const state = await invoke("sync_import_file", { path, passphrase });
  if (!window.confirm(
    "¿Importar el backup? Se fusionará con el estado actual (last-write-wins por item)."
  )) {
    return null;
  }
  const allowSecrets = stateHasSecrets(state)
    ? window.confirm("El backup contiene contraseñas/passphrases cifradas. ¿Guardarlas en el keyring local?")
    : false;
  const summary = await applyMergedState(state, { ...ctx, allowSecrets });
  return summary;
}

/* ─────────────────────────── Snapshots históricos ────────────────── */

export async function listSnapshots() {
  const webdavPassword = await getStoredWebDavPassword();
  return await invoke("sync_list_snapshots", { webdavPassword });
}

export async function restoreSnapshot(snapshotId, ctx) {
  const passphrase = await getStoredPassphrase();
  if (!passphrase) {
    throw new Error("Configura la passphrase de sync antes de restaurar");
  }
  const webdavPassword = await getStoredWebDavPassword();
  const state = await invoke("sync_read_snapshot", {
    snapshotId,
    passphrase,
    webdavPassword,
  });
  const allowSecrets = stateHasSecrets(state)
    ? window.confirm("La copia contiene contraseñas/passphrases cifradas. ¿Guardarlas en el keyring local?")
    : false;
  return await applyMergedState(state, { ...ctx, allowSecrets });
}

/* ─────────────────────────── Tracking de tombstones ──────────────── */

export function recordTombstone(prefs, kind, id) {
  prefs.tombstones = prefs.tombstones || {};
  prefs.tombstones[kind] = prefs.tombstones[kind] || {};
  prefs.tombstones[kind][id] = new Date().toISOString();
}
