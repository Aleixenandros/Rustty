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

// Espejo de los marcadores estables de error de `sync.rs`: permiten al caller
// clasificar el fallo sin parsear texto libre.
export const SYNC_OFFLINE_MARKER = "sync-offline:";
export const SYNC_BAD_PASSPHRASE_MARKER = "sync-passphrase:";

/** ¿El error es un fallo de conectividad (DNS/connect/timeout)? */
export function isOfflineError(err) {
  return String(err).includes(SYNC_OFFLINE_MARKER);
}

/** ¿El error es «el blob remoto no descifra» (passphrase rotada/incorrecta)? */
export function isBadPassphraseError(err) {
  return String(err).includes(SYNC_BAD_PASSPHRASE_MARKER);
}

// Subset de prefs que se sincroniza (excluimos rutas locales; los secretos
// viajan como items `secret:*` solo si el usuario activa esa opción).
const SYNCED_PREF_KEYS = [
  "theme", "terminalTheme", "copyOnSelect", "rightClickPaste",
  "fontFamily", "fontSize", "lineHeight", "letterSpacing",
  "cursorStyle", "cursorBlink", "scrollback", "bell", "lang",
  "userFolders", "userFoldersByWorkspace",
  "workspaces", "favorites", "searchAllWorkspaces",
  "folderColors", "workspaceColors", "highlightRules",
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
    // Contraseñas de las identidades adicionales (usuarios extra).
    for (const c of profile.extra_credentials || []) {
      pairs.push([
        `password:${profile.id}:${c.id}`,
        `secret:password:${profile.id}:${c.id}`,
      ]);
    }
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

async function readCredentialCatalog() {
  try {
    const list = await invoke("master_cred_list");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function readAllNotes() {
  try {
    const docs = await invoke("note_export_all");
    return Array.isArray(docs) ? docs : [];
  } catch {
    return [];
  }
}

// Añade los metadatos del catálogo de credenciales (siempre) y, solo con el
// opt-in de secretos, los valores de master/secret leídos del keyring. Sigue
// el mismo patrón que `addProfileSecretItems` para los secretos de perfil.
async function addCredentialItems(items, prefs, deviceId, includeSecrets, catalogHint) {
  const secretTs = prefs._secretsTs || {};
  const catalog = catalogHint ?? (await readCredentialCatalog());
  for (const meta of catalog) {
    if (!meta?.id) continue;
    // Metadatos: siempre. Para `var` el `value` no es secreto y viaja aquí;
    // para `master`/`secret` el meta no contiene valor (queda None en backend).
    const data = { ...meta };
    if (meta.kind !== "var") data.value = null;
    items[`cred:${meta.id}`] = {
      data,
      updated_at: stableTimestamp(meta.updated_at, meta.created_at),
      device_id: deviceId,
    };

    if (!includeSecrets) continue;
    // Valores secretos: solo con el opt-in, claves `secret:master:<id>` /
    // `secret:secret:<id>`, análogo a `secret:password:<id>`.
    const keyringKey =
      meta.kind === "master" ? `master:${meta.id}`
      : meta.kind === "secret" ? `secret:${meta.id}`
      : null;
    if (!keyringKey) continue;
    const secret = await readProfileSecret(keyringKey);
    if (!secret) continue;
    items[`secret:${keyringKey}`] = {
      data: { key: keyringKey, secret },
      updated_at: stableTimestamp(secretTs[keyringKey], meta.updated_at, meta.created_at),
      device_id: deviceId,
    };
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

  if (selective.notes) {
    const docs = ctx.notesDocs ?? (await readAllNotes());
    for (const doc of docs) {
      if (!doc?.profile_id) continue;
      items[`note:${doc.profile_id}`] = {
        data: doc,
        updated_at: stableTimestamp(doc.updated_at, doc.created_at),
        device_id: deviceId,
      };
    }
    Object.entries(prefs.tombstones?.notes || {}).forEach(([id, ts]) => {
      tombstones[`note:${id}`] = ts;
    });
  }

  if (selective.secrets) {
    await addProfileSecretItems(items, profiles, prefs, deviceId);
  }

  // Identidad de este equipo (`device:<id>`): nombre editable, plataforma y
  // last_seen. El last_seen es grueso (por día) a propósito: un timestamp
  // fino cambiaría el CONTENIDO en cada ciclo y rompería el gating de push
  // por `content_eq` (un push + snapshot por ciclo sin cambios reales).
  if (deviceId && deviceId !== "—") {
    items[`device:${deviceId}`] = {
      data: {
        name: (ctx.deviceName || "").trim() || null,
        platform: ctx.devicePlatform || null,
        last_seen: now.slice(0, 10),
      },
      updated_at: now,
      device_id: deviceId,
    };
  }

  // El catálogo de credenciales se sincroniza siempre (metadatos `cred:<id>`).
  // Los valores de master/secret solo viajan con el opt-in de secretos.
  await addCredentialItems(items, prefs, deviceId, !!selective.secrets, ctx.credsCatalog);

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

/** Subconjunto comparable de una nota (contenido; sin timestamps). */
function noteComparable(doc) {
  return {
    title: doc?.title ?? "",
    connection: doc?.connection ?? "",
    tags: Array.isArray(doc?.tags) ? doc.tags : [],
    body: doc?.body ?? "",
  };
}

/** Subconjunto comparable de una credencial del catálogo (sin timestamps). */
function credComparable(meta) {
  const { updated_at: _u, created_at: _c, ...rest } = meta || {};
  return rest;
}

/**
 * Aplica al estado local los cambios resultantes del merge.
 * Devuelve el desglose de cambios REALES (los items idénticos a lo local no
 * cuentan ni se re-escriben) para que el caller decida qué refrescar en la
 * UI — con un resultado a cero la sync debe ser invisible.
 */
export async function applyMergedState(merged, ctx) {
  const { profiles, prefs } = ctx;
  const allowSecrets = !!ctx.allowSecrets;
  let addedProfiles = 0, deletedProfiles = 0, updatedProfiles = 0, prefsChanged = false;
  let themesChanged = 0, shortcutsChanged = 0, snippetsChanged = 0;
  let secretsChanged = 0;
  let credsChanged = 0;
  let notesChanged = 0;
  let prefsSkippedNewerLocal = false;
  // Dispositivos de origen de los cambios aplicados (para el journal:
  // «2 perfiles actualizados desde el portátil del trabajo»).
  const originDevices = new Set();
  const noteOrigin = (item) => {
    if (item?.device_id && item.device_id !== ctx.deviceId) originDevices.add(item.device_id);
  };

  const localProfileIds = new Set(profiles.map((p) => p.id));
  const localProfilesById = new Map(profiles.map((p) => [p.id, p]));

  // Estado local de notas y credenciales, cargado UNA vez y solo si el merge
  // trae items de ese tipo (permite saltar upserts idénticos sin re-escribir
  // ficheros ni inflar los contadores en cada ciclo).
  let notesById = null;
  const ensureNotes = async () => {
    if (!notesById) {
      const docs = ctx.notesDocs ?? (await readAllNotes());
      notesById = new Map(docs.map((doc) => [doc.profile_id, doc]));
    }
    return notesById;
  };
  let credsById = null;
  const ensureCreds = async () => {
    if (!credsById) {
      const catalog = ctx.credsCatalog ?? (await readCredentialCatalog());
      credsById = new Map(catalog.map((meta) => [meta.id, meta]));
    }
    return credsById;
  };

  // Los perfiles que llegan del remoto se acumulan y se guardan de una sola vez
  // al terminar el barrido de items (ver más abajo): un `save_profile` por perfil
  // reescribía el catálogo entero N veces por ciclo de sincronización.
  const perfilesEntrantes = [];

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
      perfilesEntrantes.push({ profile, item, isNew: !localProfileIds.has(id) });
    } else if (key === "prefs:bundle") {
      // Guardia de carrera: si el usuario tocó las prefs MIENTRAS la sync
      // estaba en vuelo (el `_prefsUpdatedAt` vivo es posterior a la foto con
      // la que se lanzó), aplicar el bundle mezclado revertiría esa edición.
      // Se conserva lo local y el caller programa un push de seguimiento.
      const liveTs = typeof prefs._prefsUpdatedAt === "string" ? prefs._prefsUpdatedAt : "";
      const snapshotTs = typeof ctx.prefsSnapshotTs === "string" ? ctx.prefsSnapshotTs : "";
      if (liveTs && snapshotTs && liveTs > snapshotTs) {
        prefsSkippedNewerLocal = true;
        continue;
      }
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
      if (bundleDataChanged) noteOrigin(item);
    } else if (key.startsWith("theme:")) {
      const id = key.slice(6);
      const theme = { ...(item.data || {}) };
      theme.updatedAt = item.updated_at;
      const list = prefs.customThemes || (prefs.customThemes = []);
      const idx = list.findIndex((t) => t.id === id);
      if (idx >= 0 && sameValue(list[idx], theme)) continue;
      if (idx >= 0) list[idx] = theme; else list.push(theme);
      themesChanged++;
      noteOrigin(item);
    } else if (key.startsWith("shortcut:")) {
      const id = key.slice(9);
      prefs.shortcuts = prefs.shortcuts || {};
      prefs._shortcutsTs = prefs._shortcutsTs || {};
      const valueChanged = !sameValue(prefs.shortcuts[id], item.data);
      const timestampChanged = prefs._shortcutsTs[id] !== item.updated_at;
      if (!valueChanged && !timestampChanged) continue;
      prefs.shortcuts[id] = item.data;
      prefs._shortcutsTs[id] = item.updated_at;
      if (valueChanged) {
        shortcutsChanged++;
        noteOrigin(item);
      }
    } else if (key.startsWith("snippet:")) {
      const id = key.slice(8);
      const snippet = { ...(item.data || {}) };
      snippet.id = snippet.id || id;
      snippet.updated_at = item.updated_at;
      const existing = loadLocalSnippets().find((entry) => entry.id === id);
      if (existing && sameValue(existing, snippet)) continue;
      upsertLocalSnippet(snippet);
      snippetsChanged++;
      noteOrigin(item);
    } else if (key.startsWith("note:")) {
      // Nota Markdown de un perfil: upsert del fichero `.md` (LWW ya resuelto
      // por el merge del SyncState). El backend preserva updated_at/created_at.
      // Solo se importa si el CONTENIDO difiere del local: re-escribir notas
      // idénticas en cada ciclo inflaba `notesChanged` y forzaba re-renders.
      const id = key.slice(5);
      const doc = { ...(item.data || {}) };
      if (!doc.profile_id) doc.profile_id = id;
      doc.updated_at = item.updated_at || doc.updated_at;
      const localNotes = await ensureNotes();
      const existing = localNotes.get(doc.profile_id);
      if (existing && sameValue(noteComparable(existing), noteComparable(doc))) continue;
      try {
        await invoke("note_import", { doc });
        notesChanged++;
        noteOrigin(item);
      } catch (err) {
        console.error("[sync] note_import", id, err);
      }
    } else if (key.startsWith("cred:")) {
      // Metadatos del catálogo de credenciales: upsert por id sin tocar el
      // keyring. El valor real de master/secret llega aparte como `secret:*`.
      // Igual que las notas: sin cambio real, ni import ni contador.
      const id = key.slice(5);
      const meta = { ...(item.data || {}) };
      if (!meta.id) meta.id = id;
      meta.updated_at = item.updated_at;
      const localCreds = await ensureCreds();
      const existing = localCreds.get(meta.id);
      const existingNormalized = existing
        ? { ...existing, value: existing.kind !== "var" ? null : existing.value }
        : null;
      if (existingNormalized && sameValue(credComparable(existingNormalized), credComparable(meta))) {
        continue;
      }
      try {
        await invoke("master_cred_import", { meta });
        credsChanged++;
        noteOrigin(item);
      } catch (err) {
        console.error("[sync] master_cred_import", id, err);
      }
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
          noteOrigin(item);
        } catch (err) {
          console.error("[sync] keyring_set", secretKey, err);
        }
      }
    } else if (key.startsWith("device:")) {
      // Identidad de los equipos del anillo de sync ({nombre, plataforma,
      // last_seen}): solo estado interno para que el journal pueda decir
      // «desde el portátil del trabajo». Nunca cuenta como cambio ni fuerza
      // re-render.
      const id = key.slice(7);
      prefs._syncDevices = prefs._syncDevices || {};
      const entry = { ...(item.data || {}) };
      if (!sameValue(prefs._syncDevices[id], entry)) {
        prefs._syncDevices[id] = entry;
      }
    }
  }

  // Perfiles entrantes: una transacción para todos.
  if (perfilesEntrantes.length) {
    const contabilizar = (entry) => {
      if (entry.isNew) addedProfiles++;
      else updatedProfiles++;
      noteOrigin(entry.item);
    };
    try {
      await invoke("save_profiles", { profiles: perfilesEntrantes.map((p) => p.profile) });
      perfilesEntrantes.forEach(contabilizar);
    } catch (err) {
      // El lote es atómico, así que un perfil ilegible (p. ej. escrito por una
      // versión más nueva) tumbaría la sincronización de TODOS. Si el lote falla,
      // se reintenta perfil a perfil para aislar al culpable y que el resto entre.
      console.error("[sync] save_profiles, se reintenta uno a uno", err);
      for (const entry of perfilesEntrantes) {
        try {
          await invoke("save_profile", { profile: entry.profile });
          contabilizar(entry);
        } catch (e) {
          console.error("[sync] save_profile", entry.profile.id, e);
        }
      }
    }
  }

  // Tombstones
  const perfilesABorrar = [];
  for (const key of Object.keys(merged.tombstones || {})) {
    if (key.startsWith("profile:")) {
      const id = key.slice(8);
      if (localProfileIds.has(id)) perfilesABorrar.push(id);
    } else if (key.startsWith("theme:")) {
      const id = key.slice(6);
      if (prefs.customThemes) {
        const before = prefs.customThemes.length;
        prefs.customThemes = prefs.customThemes.filter((t) => t.id !== id);
        // Los tombstones se re-procesan en CADA ciclo: contar solo cuando el
        // tema aún existía localmente, o cada sync parecería traer cambios.
        if (prefs.customThemes.length !== before) themesChanged++;
      }
    } else if (key.startsWith("shortcut:")) {
      const id = key.slice(9);
      if (prefs.shortcuts && id in prefs.shortcuts) {
        delete prefs.shortcuts[id];
        shortcutsChanged++;
      }
    } else if (key.startsWith("snippet:")) {
      const id = key.slice(8);
      if (loadLocalSnippets().some((snippet) => snippet.id === id)) {
        deleteLocalSnippet(id);
        snippetsChanged++;
      }
    } else if (key.startsWith("note:")) {
      const id = key.slice(5);
      const localNotes = await ensureNotes();
      if (!localNotes.has(id)) continue; // ya no existe: tombstone re-procesado
      try {
        await invoke("note_delete", { profileId: id });
        notesChanged++;
      } catch (err) {
        console.error("[sync] note_delete", id, err);
      }
    }
  }

  // Perfiles borrados en el remoto: también en una sola transacción.
  if (perfilesABorrar.length) {
    try {
      await invoke("delete_profiles", { ids: perfilesABorrar });
      deletedProfiles += perfilesABorrar.length;
    } catch (err) {
      console.error("[sync] delete_profiles", err);
    }
  }

  return {
    addedProfiles, deletedProfiles, updatedProfiles, prefsChanged,
    themesChanged, shortcutsChanged, snippetsChanged,
    secretsChanged, credsChanged, notesChanged, prefsSkippedNewerLocal,
    originDevices: [...originDevices],
  };
}

/**
 * Poda el espejo local de tombstones (`prefs.tombstones`) con la misma
 * retención que aplica el backend al estado. Sin esta mitad, `buildSyncState`
 * re-añadiría los tombstones viejos en cada ciclo y el GC nunca convergería.
 * Devuelve cuántos se eliminaron (el caller persiste prefs si hubo cambios).
 */
export function pruneLocalTombstones(prefs, retentionDays) {
  const days = Math.max(0, parseInt(retentionDays, 10) || 0);
  if (!days || !prefs?.tombstones) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const map of Object.values(prefs.tombstones)) {
    if (!map || typeof map !== "object") continue;
    for (const [id, ts] of Object.entries(map)) {
      const time = new Date(ts).getTime();
      if (Number.isFinite(time) && time < cutoff) {
        delete map[id];
        removed++;
      }
    }
  }
  return removed;
}

/**
 * Diff del estado remoto contra el local para la vista previa (dry-run) de la
 * primera sincronización: qué añadiría, cambiaría y borraría aplicar el merge.
 * Devuelve contadores por tipo de item y una muestra de nombres de perfil.
 */
export function diffRemoteAgainstLocal(remote, current) {
  const kinds = {};
  const bump = (key, field) => {
    const kind = key.split(":", 1)[0];
    kinds[kind] = kinds[kind] || { added: 0, changed: 0, deleted: 0 };
    kinds[kind][field]++;
  };
  const addedProfileNames = [];

  for (const [key, item] of Object.entries(remote.items || {})) {
    if (key.startsWith("device:")) continue; // metadatos, no datos del usuario
    const local = current.items?.[key];
    if (!local) {
      bump(key, "added");
      if (key.startsWith("profile:") && addedProfileNames.length < 8) {
        const name = item?.data?.name;
        if (typeof name === "string" && name) addedProfileNames.push(name);
      }
    } else if (!sameValue(local.data, item.data)) {
      bump(key, "changed");
    }
  }
  for (const key of Object.keys(remote.tombstones || {})) {
    if (current.items?.[key]) bump(key, "deleted");
  }

  const total = Object.values(kinds).reduce(
    (sum, k) => sum + k.added + k.changed + k.deleted,
    0
  );
  return { kinds, total, addedProfileNames };
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

export function upsertLocalSnippet(snippet) {
  const snippets = loadLocalSnippets();
  const idx = snippets.findIndex((item) => item.id === snippet.id);
  if (idx >= 0) snippets[idx] = snippet;
  else snippets.push(snippet);
  saveLocalSnippets(snippets);
}

export function deleteLocalSnippet(id) {
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

  // Estado local leído UNA vez y compartido entre la construcción del estado
  // y la aplicación del merge (evita releer todas las notas/credenciales).
  // La foto de `_prefsUpdatedAt` permite detectar en la aplicación si el
  // usuario tocó las prefs mientras la sync estaba en vuelo.
  const prefsSnapshotTs =
    typeof ctx.prefs?._prefsUpdatedAt === "string" ? ctx.prefs._prefsUpdatedAt : "";
  // Las notas se leen SIEMPRE (aunque el selectivo esté apagado): el merge
  // puede traer items `note:` de otros equipos y la aplicación necesita el
  // estado local para saltarse los idénticos.
  const syncNotes = config.selective?.notes ?? true;
  const notesDocs = await readAllNotes();
  const credsCatalog = await readCredentialCatalog();

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
      notes: syncNotes,
      secrets: !!config.selective?.secrets,
    },
    snippets: loadLocalSnippets(),
    notesDocs,
    credsCatalog,
  });

  const outcome = await invoke("sync_run", {
    current,
    passphrase,
    webdavPassword,
  });

  const summary = await applyMergedState(outcome.state, {
    ...ctx,
    allowSecrets: !!config.selective?.secrets,
    prefsSnapshotTs,
    notesDocs,
    credsCatalog,
  });
  // Metadatos del ciclo (toasts/journal del caller): timestamps futuros
  // acotados, tombstones podados, duplicados fusionados y desvío de reloj.
  summary.meta = {
    clamped: outcome.clamped || 0,
    prunedTombstones: outcome.pruned_tombstones || 0,
    deduped: !!outcome.deduped,
    clockSkewSeconds: outcome.clock_skew_seconds ?? null,
  };
  // Mitad frontend del GC de tombstones (el backend ya podó el estado).
  pruneLocalTombstones(ctx.prefs, config.tombstone_retention_days);
  return summary;
}

/**
 * Vista previa del estado remoto sin aplicar nada (`null` si está vacío).
 * Para el diff de confirmación de la primera sincronización.
 */
export async function peekRemote() {
  const passphrase = await getStoredPassphrase();
  if (!passphrase) throw new Error("no_passphrase");
  const config = await getConfig();
  const webdavPassword =
    config.backend === "webdav" ? await getStoredWebDavPassword() : null;
  return await invoke("sync_peek_remote", { passphrase, webdavPassword });
}

/** ¿Este equipo ya completó alguna sincronización (caché local presente)? */
export async function cacheExists() {
  return await invoke("sync_cache_exists");
}

/** Borra del servidor el blob + histórico y la caché local (privacidad). */
export async function wipeRemote() {
  const webdavPassword = await getStoredWebDavPassword();
  return await invoke("sync_wipe_remote", { webdavPassword });
}

/** Borra solo la caché local del último merge (al desactivar la sync). */
export async function clearLocalCache() {
  return await invoke("sync_clear_local_cache");
}

/**
 * Rota la passphrase: re-cifra el blob remoto (y opcionalmente el histórico)
 * con la nueva. Devuelve cuántos snapshots se re-cifraron. El caller debe
 * guardar la nueva passphrase en el keyring tras el éxito.
 */
export async function rotatePassphrase(oldPassphrase, newPassphrase, reencryptHistory) {
  const webdavPassword = await getStoredWebDavPassword();
  return await invoke("sync_rotate_passphrase", {
    oldPassphrase,
    newPassphrase,
    webdavPassword,
    reencryptHistory: !!reencryptHistory,
  });
}

/* ─────────────────────────── Journal de sincronización ─────────────── */

const JOURNAL_STORAGE_KEY = "rustty-sync-journal";
const JOURNAL_MAX_ENTRIES = 50;

/** Entradas del journal, la más reciente primero. */
export function loadSyncJournal() {
  try {
    const value = JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * Añade una entrada al journal (anillo acotado en localStorage). Un sistema
 * que mueve todos tus perfiles debe poder explicar qué hizo en cada ciclo.
 * @param {object} entry {at, backend, counts, devices, manual}
 */
export function recordSyncJournal(entry) {
  const list = loadSyncJournal();
  list.unshift({ at: new Date().toISOString(), ...entry });
  localStorage.setItem(
    JOURNAL_STORAGE_KEY,
    JSON.stringify(list.slice(0, JOURNAL_MAX_ENTRIES))
  );
}

/* ─────────────────────────── Backup cifrado a fichero ─────────────── */

// wry no implementa window.prompt/confirm (devuelven null/false sin mostrar
// nada), así que estos flujos reciben en `ctx.dialogs` los diálogos
// tematizados de main.js: promptSecret({title,message,label}) → string|null
// y confirm({title,message,submitLabel,danger}) → boolean.
function requireDialogs(ctx) {
  if (!ctx?.dialogs) {
    throw new Error("ctx.dialogs requerido (promptSecret/confirm)");
  }
  return ctx.dialogs;
}

export async function exportToFile(ctx) {
  const dialogs = requireDialogs(ctx);
  const path = await saveDialog({
    title: "Exportar backup cifrado de Rustty",
    defaultPath: `rustty-sync-${new Date().toISOString().slice(0, 10)}.bin`,
    filters: [{ name: "Rustty sync", extensions: ["bin"] }],
  });
  if (!path) return null;

  // Pide passphrase al usuario
  const passphrase = await dialogs.promptSecret({
    title: "Exportar backup cifrado",
    message: "Passphrase para cifrar el fichero (no la pierdas):",
    label: "Passphrase",
  });
  if (!passphrase) return null;

  const state = await buildSyncState({
    profiles: ctx.profiles,
    prefs: ctx.prefs,
    deviceId: ctx.deviceId,
    selective: { profiles: true, prefs: true, themes: true, shortcuts: true, snippets: true, notes: true },
    snippets: loadLocalSnippets(),
    exportedSecrets: ctx.exportedSecrets,
  });

  await invoke("sync_export_file", { path, passphrase, state });
  return path;
}

export async function importFromFile(ctx) {
  const dialogs = requireDialogs(ctx);
  const path = await openDialog({
    title: "Importar backup cifrado de Rustty",
    multiple: false,
    filters: [{ name: "Rustty sync", extensions: ["bin"] }],
  });
  if (!path) return null;

  const passphrase = await dialogs.promptSecret({
    title: "Importar backup cifrado",
    message: "Passphrase con la que se cifró el fichero.",
    label: "Passphrase",
  });
  if (!passphrase) return null;

  const state = await invoke("sync_import_file", { path, passphrase });
  const okImport = await dialogs.confirm({
    title: "Importar backup",
    message: "Se fusionará con el estado actual (last-write-wins por item).",
    submitLabel: "Importar",
  });
  if (!okImport) return null;
  const allowSecrets = stateHasSecrets(state)
    ? await dialogs.confirm({
        title: "Importar backup",
        message: "El backup contiene contraseñas/passphrases cifradas. ¿Guardarlas en el keyring local?",
        submitLabel: "Guardar en el keyring",
      })
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
  const dialogs = requireDialogs(ctx);
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
    ? await dialogs.confirm({
        title: "Restaurar copia",
        message: "La copia contiene contraseñas/passphrases cifradas. ¿Guardarlas en el keyring local?",
        submitLabel: "Guardar en el keyring",
      })
    : false;
  return await applyMergedState(state, { ...ctx, allowSecrets });
}

/* ─────────────────────────── Tracking de tombstones ──────────────── */

export function recordTombstone(prefs, kind, id) {
  prefs.tombstones = prefs.tombstones || {};
  prefs.tombstones[kind] = prefs.tombstones[kind] || {};
  prefs.tombstones[kind][id] = new Date().toISOString();
}
