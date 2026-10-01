// Regresión del alta de un equipo: backend local cifrado, mismo merge que Drive.
// Todo el estado vive en el directorio aislado del smoke. El keyring se sustituye
// en el renderer para que ni siquiera la passphrase de prueba toque el del usuario.
import path from "node:path";
import { SYNCED_PREF_KEYS } from "../../src/modules/prefs/sync.js";
import { sleep } from "./webdriver.mjs";

export async function checkPrefsSync(app, workDir, check) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const readPrefs = () => app.exec('return JSON.parse(localStorage.getItem("rustty-prefs") || "{}");');
  const openPrefs = async () => {
    await app.jsClick("#rail-btn-settings");
    await app.waitFor("#modal-prefs-overlay:not(.hidden)");
    await sleep(500); // config y catálogo de fuentes asíncronos
  };
  const waitSync = async (previous) => {
    const started = Date.now();
    while (Date.now() - started < 20000) {
      const prefs = await readPrefs();
      if (prefs._lastSyncAt && prefs._lastSyncAt !== previous) return prefs;
      await sleep(150);
    }
    throw new Error("la sincronización no terminó");
  };
  const passphrase = "rustty-e2e-sync-only";
  await app.exec(`
    const original = window.fetch;
    window.__e2eSyncFetch = original;
    const getUrl = window.__TAURI_INTERNALS__.convertFileSrc("keyring_get", "ipc");
    const setUrl = window.__TAURI_INTERNALS__.convertFileSrc("keyring_set", "ipc");
    const runUrl = window.__TAURI_INTERNALS__.convertFileSrc("sync_run", "ipc");
    const passphrase = arguments[0];
    window.fetch = (url, options) => {
      if (url === getUrl || url === setUrl) {
        const payload = JSON.parse(options.body);
        const value = url === getUrl && payload.key === "sync:passphrase" ? passphrase : null;
        return Promise.resolve(new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
        }));
      }
      const probe = window.__e2eSidebarSync;
      if (url === runUrl && probe) {
        probe.calls++;
        if (probe.fail) return Promise.resolve(new Response(JSON.stringify("sync-e2e-error"), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "error" },
        }));
        if (probe.hold) return new Promise((resolve) => {
          probe.release = () => resolve(original(url, options));
        });
      }
      return original(url, options);
    };
    return true;
  `, [passphrase]);
  if (await invoke("keyring_get", { service: "rustty", key: "sync:passphrase" }) !== passphrase) {
    throw new Error("el keyring de prueba no quedó aislado");
  }

  const originalConfig = await invoke("sync_get_config");
  const config = {
    ...originalConfig, enabled: true, backend: "local",
    local: { folder: path.join(workDir, "sync-cloud") },
    auto_interval_seconds: 0, sync_on_exit: false,
  };
  try {
    check("el botón lateral está desactivado sin sincronización configurada",
      await app.exec('return document.getElementById("sidebar-sync-now").disabled;'));
    await app.jsClick("#sidebar-sync-status");
    await app.waitFor("#modal-prefs-overlay:not(.hidden)");
    await sleep(500);
    check("pulsar el estado sigue abriendo Copias de seguridad",
      await app.exec('return document.querySelector(\'.prefs-nav-item[data-prefs-tab="data"]\').classList.contains("active");'));
    await app.jsClick("#btn-prefs-save");
    const initial = await readPrefs();
    check("guardar defaults no los fecha como una edición", !initial._prefsUpdatedAt);
    const remotePrefs = {
      ...Object.fromEntries(SYNCED_PREF_KEYS.filter((k) => k in initial).map((k) => [k, initial[k]])),
      theme: "light", terminalTheme: "dracula", fontSize: 18,
      rightClickPaste: !initial.rightClickPaste,
      workspaces: [{ id: "default", name: "Personal" }, { id: "ws-sync", name: "Producción" }],
      userFoldersByWorkspace: { default: [], "ws-sync": ["Servidores"] },
    };
    const timestamp = "2026-01-01T12:00:00.000Z";
    const current = {
      version: 1, tombstones: {}, items: {
        "prefs:bundle": { data: remotePrefs, updated_at: timestamp, device_id: "linux" },
        "profile:e2e-sync": {
          data: {
            id: "e2e-sync", name: "Servidor de producción", host: "192.0.2.1", port: 22,
            username: "test", auth_type: "password", workspace_id: "ws-sync",
            created_at: timestamp, updated_at: timestamp,
          }, updated_at: timestamp, device_id: "linux",
        },
      },
    };
    await invoke("sync_save_config", { config });
    await invoke("sync_run", { current, passphrase });
    await invoke("sync_clear_local_cache");
    // Abrir la instalación nueva y configurar la nube desde el formulario.
    await openPrefs();
    // Incluso un ajuste explícito más reciente debe ceder a «Recuperar».
    await app.exec('document.getElementById("pref-font-size").value = "30"; return true;');
    await app.jsClick("#btn-prefs-save");
    await app.waitFor("#credential-modal-overlay:not(.hidden)");
    check("un equipo nuevo ofrece recuperar la configuración",
      await app.exec('return document.getElementById("btn-credential-submit").textContent.includes("Recuperar");'));
    if (process.env.E2E_SYNC_SCREENSHOT) await app.screenshot(process.env.E2E_SYNC_SCREENSHOT);
    await app.jsClick("#btn-credential-cancel");
    const cancelledCloud = await invoke("sync_peek_remote", { passphrase });
    check("cancelar la primera sincronización conserva la nube",
      cancelledCloud.items["prefs:bundle"].data.fontSize === 18 && !(await readPrefs())._lastSyncAt);
    await app.waitFor("#sidebar-sync-now:not(:disabled)");
    check("cancelar libera el botón y el estado de sincronización",
      await app.exec('return !document.getElementById("sidebar-sync-dot").classList.contains("busy");'));
    await app.jsClick("#sidebar-sync-now");
    await app.waitFor("#credential-modal-overlay:not(.hidden)");
    check("la sincronización lateral respeta la recuperación inicial y bloquea otro clic",
      await app.exec('return document.getElementById("sidebar-sync-now").disabled && document.getElementById("btn-credential-submit").textContent.includes("Recuperar");'));
    await app.jsClick("#btn-credential-submit");
    let received = await waitSync(initial._lastSyncAt);
    check("el alta descarga nombres, tema y pegado del equipo anterior",
      received.theme === remotePrefs.theme && received.rightClickPaste === remotePrefs.rightClickPaste
      && received.fontSize === remotePrefs.fontSize
      && received.workspaces.some((w) => w.id === "ws-sync" && w.name === "Producción")
      && Date.parse(received._prefsUpdatedAt) === Date.parse(timestamp));
    const profiles = await invoke("get_profiles");
    check("el perfil descargado conserva su workspace", profiles.some((p) => p.id === "e2e-sync" && p.workspace_id === "ws-sync"));

    // Un formulario que ya estaba abierto cuando llegan otros cambios no
    // vuelve a subir sus controles antiguos al pulsar Guardar.
    await openPrefs();
    const newer = "2026-02-01T12:00:00.000Z";
    const updated = { ...remotePrefs, theme: "nord", terminalTheme: "light", fontSize: 20, rightClickPaste: initial.rightClickPaste };
    current.items["prefs:bundle"] = { data: updated, updated_at: newer, device_id: "linux" };
    await invoke("sync_run", { current, passphrase });
    await app.jsClick("#btn-sync-now");
    received = await waitSync(received._lastSyncAt);
    await app.jsClick("#btn-prefs-save");
    received = await waitSync(received._lastSyncAt);
    check("Guardar tras sincronizar conserva los ajustes recibidos con el modal abierto",
      received.theme === updated.theme && received.terminalTheme === updated.terminalTheme
      && received.fontSize === updated.fontSize && received.rightClickPaste === updated.rightClickPaste
      && Date.parse(received._prefsUpdatedAt) === Date.parse(newer));
    const cloud = await invoke("sync_peek_remote", { passphrase });
    check("los defaults no se propagan de vuelta a la nube",
      cloud.items["prefs:bundle"].data.theme === updated.theme
      && cloud.items["prefs:bundle"].data.workspaces[1].name === "Producción");

    await openPrefs();
    const latest = "2026-03-01T12:00:00.000Z";
    current.items["prefs:bundle"] = { data: { ...updated, terminalTheme: "nord", fontSize: 22 }, updated_at: latest, device_id: "linux" };
    await invoke("sync_run", { current, passphrase });
    await app.jsClick("#btn-sync-now");
    received = await waitSync(received._lastSyncAt);

    await app.jsClick("#btn-prefs-cancel");
    await openPrefs();
    const visibleFont = await app.exec('return document.getElementById("pref-font-size").value;');
    check("Cancelar tras sincronizar conserva la tipografía recibida", visibleFont === "22");
    // Guardar una edición real, incluido su preview, sigue propagándola.
    await app.exec(`
      const el = document.getElementById("pref-font-size");
      el.value = "24";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await app.jsClick("#btn-prefs-save");
    received = await readPrefs();
    check("editar la tipografía sí fecha el cambio", received.fontSize === 24 && received._prefsUpdatedAt > latest);
    received = await waitSync(received._lastSyncAt);

    // Navegar es local; renombrar es una edición que tiene que viajar.
    await app.jsClick("#btn-sidebar-tools");
    await app.jsClick('[data-ws-action="select"][data-ws-id="ws-sync"]');
    check("cambiar de workspace no fecha el bundle", (await readPrefs())._prefsUpdatedAt === received._prefsUpdatedAt);
    await app.jsClick("#btn-sidebar-tools");
    await app.jsClick('[data-ws-action="rename"]');
    await app.waitFor("#credential-modal-overlay:not(.hidden)");
    await app.exec('document.getElementById("credential-modal-input").value = "Producción renombrada"; return true;');
    await app.jsClick("#btn-credential-submit");
    const renamed = await readPrefs();
    check("renombrar un workspace fecha la edición", renamed._prefsUpdatedAt > received._prefsUpdatedAt);
    await openPrefs();
    await app.jsClick("#btn-sync-now");
    await waitSync(received._lastSyncAt);
    const renamedCloud = await invoke("sync_peek_remote", { passphrase });
    check("el nombre corregido llega a la nube", renamedCloud.items["prefs:bundle"].data.workspaces.some((w) => w.id === "ws-sync" && w.name === "Producción renombrada"));
    await app.jsClick("#btn-prefs-cancel");

    // Retener la respuesta permite observar el progreso y dos clics rápidos,
    // sin depender de cuánto tarde el cifrado en cada máquina.
    const beforeSidebar = await readPrefs();
    await app.exec(`
      window.__e2eSidebarSync = { calls: 0, hold: true };
      document.getElementById("sync-enabled").checked = false;
      document.getElementById("sync-backend").value = "none";
      const button = document.getElementById("sidebar-sync-now");
      button.click();
      button.click();
      return true;
    `);
    await app.waitFor('#sidebar-sync-now[aria-busy="true"]:disabled');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await app.exec("return !!window.__e2eSidebarSync.release;")) break;
      await sleep(100);
    }
    check("el botón lateral muestra progreso sin abrir Preferencias ni duplicar la petición",
      await app.exec('return window.__e2eSidebarSync.calls === 1 && !!window.__e2eSidebarSync.release && document.getElementById("modal-prefs-overlay").classList.contains("hidden");'));
    await app.exec("window.__e2eSidebarSync.release(); return true;");
    received = await waitSync(beforeSidebar._lastSyncAt);
    await app.waitFor('#sidebar-sync-now[aria-busy="false"]:not(:disabled)');
    const sidebarConfig = await invoke("sync_get_config");
    check("sincronizar desde la barra usa lo guardado y no fecha las preferencias",
      sidebarConfig.enabled && sidebarConfig.backend === "local"
      && received._prefsUpdatedAt === beforeSidebar._prefsUpdatedAt);
    if (process.env.E2E_SIDEBAR_SCREENSHOT) await app.screenshot(process.env.E2E_SIDEBAR_SCREENSHOT);
    check("el botón lateral cabe y es accesible en el modo de solo iconos",
      await app.exec(`
        const wasRail = document.body.classList.contains("sidebar-mode-rail");
        document.body.classList.add("sidebar-mode-rail");
        const button = document.getElementById("sidebar-sync-now");
        button.focus();
        const rect = button.getBoundingClientRect();
        const sidebar = document.getElementById("sidebar").getBoundingClientRect();
        const fits = rect.width >= 24 && rect.left >= sidebar.left && rect.right <= sidebar.right
          && document.activeElement === button && button.getAttribute("aria-label") === "Sincronizar ahora";
        if (!wasRail) document.body.classList.remove("sidebar-mode-rail");
        return fits;
      `));

    await app.exec("window.__e2eSidebarSync = { calls: 0, fail: true }; return true;");
    await app.jsClick("#sidebar-sync-now");
    await app.waitFor("#sidebar-sync-dot.error");
    await app.waitFor("#sidebar-sync-now:not(:disabled)");
    check("un fallo permite reintentar desde la barra lateral",
      await app.exec('return document.getElementById("sidebar-sync-now").getAttribute("aria-busy") === "false";'));
    await app.exec("delete window.__e2eSidebarSync; return true;");
    await app.jsClick("#sidebar-sync-now");
    await waitSync(received._lastSyncAt);
    await app.waitFor("#sidebar-sync-dot.success");
  } finally {
    await app.exec("window.__e2eSidebarSync?.release?.(); delete window.__e2eSidebarSync; return true;");
    await invoke("sync_save_config", { config: originalConfig });
    await openPrefs(); // actualiza también la caché del frontend
    await app.jsClick("#btn-prefs-cancel");
    check("desactivar la sincronización vuelve a desactivar el botón lateral",
      await app.exec('return document.getElementById("sidebar-sync-now").disabled;'));
    await app.exec("window.fetch = window.__e2eSyncFetch; delete window.__e2eSyncFetch; return true;");
  }
}
