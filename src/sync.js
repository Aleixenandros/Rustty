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
//  Las contraseñas del keyring del SO **nunca** se incluyen en el state.
// ═══════════════════════════════════════════════════════════════════

import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";

const KEYRING_SERVICE = "rustty";
const KEY_PASSPHRASE = "sync:passphrase";
const KEY_WEBDAV_PASS = "sync:webdav_password";

// Subset de prefs que se sincroniza (excluimos rutas locales y secretos)
const SYNCED_PREF_KEYS = [
  "theme", "terminalTheme", "copyOnSelect", "rightClickPaste",
  "fontFamily", "fontSize", "lineHeight", "letterSpacing",
  "cursorStyle", "cursorBlink", "scrollback", "bell", "lang",
];

/* ───────────────────────────── Construcción del estado ─────────────────── */

/**
 * Construye el SyncState a partir del estado local actual del frontend.
 * @param {object} ctx { profiles, prefs, deviceId, selective }
 */
export function buildSyncState(ctx) {
  const { profiles, prefs, deviceId, selective } = ctx;
  const items = {};
  const tombstones = {};
  const now = new Date().toISOString();

  if (selective.profiles) {
    for (const p of profiles) {
      items[`profile:${p.id}`] = {
        data: p,
        updated_at: p.updated_at || p.created_at || now,
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
      updated_at: prefs._prefsUpdatedAt || now,
      device_id: deviceId,
    };
  }

  if (selective.themes) {
    for (const t of prefs.customThemes || []) {
      items[`theme:${t.id}`] = {
        data: t,
        updated_at: t.updatedAt || now,
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
        updated_at: ts[id] || new Date().toISOString(),
        device_id: deviceId,
      };
    }
    Object.entries(prefs.tombstones?.shortcuts || {}).forEach(([id, ts]) => {
      tombstones[`shortcut:${id}`] = ts;
    });
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
  let addedProfiles = 0, deletedProfiles = 0, prefsChanged = false;
  let themesChanged = 0, shortcutsChanged = 0;

  const localProfileIds = new Set(profiles.map((p) => p.id));

  // Items
  for (const [key, item] of Object.entries(merged.items || {})) {
    if (key.startsWith("profile:")) {
      const id = key.slice(8);
      const profile = item.data;
      // Asegura los campos requeridos
      if (!profile.id) profile.id = id;
      if (!profile.created_at) profile.created_at = new Date().toISOString();
      profile.updated_at = item.updated_at;
      try {
        await invoke("save_profile", { profile });
        if (!localProfileIds.has(id)) addedProfiles++;
      } catch (err) {
        console.error("[sync] save_profile", id, err);
      }
    } else if (key === "prefs:bundle") {
      Object.assign(prefs, item.data);
      prefs._prefsUpdatedAt = item.updated_at;
      prefsChanged = true;
    } else if (key.startsWith("theme:")) {
      const id = key.slice(6);
      const theme = item.data;
      const list = prefs.customThemes || (prefs.customThemes = []);
      const idx = list.findIndex((t) => t.id === id);
      if (idx >= 0) list[idx] = theme; else list.push(theme);
      themesChanged++;
    } else if (key.startsWith("shortcut:")) {
      const id = key.slice(9);
      prefs.shortcuts = prefs.shortcuts || {};
      prefs.shortcuts[id] = item.data;
      prefs._shortcutsTs = prefs._shortcutsTs || {};
      prefs._shortcutsTs[id] = item.updated_at;
      shortcutsChanged++;
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
    }
  }

  return { addedProfiles, deletedProfiles, prefsChanged, themesChanged, shortcutsChanged };
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

  const current = buildSyncState({
    profiles: ctx.profiles,
    prefs: ctx.prefs,
    deviceId: ctx.deviceId,
    selective: {
      profiles: !!config.selective?.profiles,
      prefs: !!config.selective?.prefs,
      themes: !!config.selective?.themes,
      shortcuts: !!config.selective?.shortcuts,
    },
  });

  const merged = await invoke("sync_run", {
    current,
    passphrase,
    webdavPassword,
  });

  const summary = await applyMergedState(merged, ctx);
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

  const state = buildSyncState({
    profiles: ctx.profiles,
    prefs: ctx.prefs,
    deviceId: ctx.deviceId,
    selective: { profiles: true, prefs: true, themes: true, shortcuts: true },
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
  const summary = await applyMergedState(state, ctx);
  return summary;
}

/* ─────────────────────────── Tracking de tombstones ──────────────── */

export function recordTombstone(prefs, kind, id) {
  prefs.tombstones = prefs.tombstones || {};
  prefs.tombstones[kind] = prefs.tombstones[kind] || {};
  prefs.tombstones[kind][id] = new Date().toISOString();
}
