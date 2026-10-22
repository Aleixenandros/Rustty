// Mensajes de la pestaña de sincronización cuando el keyring del SO rechaza las
// escrituras (lo que hacía oo7 0.7.0~beta en Fedora 45) y cuando la cuenta de
// Drive estaba conectada pero su token ha desaparecido. Todo se simula en el
// renderer: ni el keyring ni ninguna cuenta real se tocan.
import fs from "node:fs";
import { sleep } from "./webdriver.mjs";

const texts = JSON.parse(
  fs.readFileSync(new URL("../../src/modules/i18n/es.json", import.meta.url), "utf8"),
).prefs_sync;

export async function checkSyncFeedback(app, check) {
  const detail = "Platform secure storage failure: DBus error: Failed to create a new item Password too short: 2.";
  const keyringFailure = `keyring-unavailable: ${detail}`;
  const toastShown = (text) => app.exec(
    'return [...document.querySelectorAll(".toast-message")].some((el) => el.textContent.includes(arguments[0]));',
    [text],
  );
  const statusIs = (key) => app.exec(
    'return document.getElementById("sync-oauth-text").textContent === arguments[0];',
    [texts[key]],
  );
  const eventually = async (probe, timeoutMs = 10000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await probe()) return true;
      await sleep(150);
    }
    return false;
  };
  const selectBackend = (backend) => app.exec(`
    const select = document.getElementById("sync-backend");
    select.value = arguments[0];
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `, [backend]);

  await app.exec(`
    const original = window.fetch;
    window.__e2eSyncFeedbackFetch = original;
    const keyringFailure = arguments[0];
    const url = (command) => window.__TAURI_INTERNALS__.convertFileSrc(command, "ipc");
    const reply = (value, ok) => Promise.resolve(new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Tauri-Response": ok ? "ok" : "error" },
    }));
    const probe = window.__e2eSyncFeedback = { account: "token_missing", disconnectCalls: 0 };
    window.fetch = (target, options) => {
      if (target === url("keyring_set")) return reply(keyringFailure, false);
      if (target === url("sync_oauth_status")) return reply(probe.account, true);
      if (target === url("sync_oauth_disconnect")) {
        probe.disconnectCalls++;
        probe.account = "disconnected";
        return reply(false, true);
      }
      return original(target, options);
    };
    return true;
  `, [keyringFailure]);
  let previousBackend = null;
  try {
    await app.jsClick("#rail-btn-settings");
    await app.waitFor("#modal-prefs-overlay:not(.hidden)");
    await app.jsClick('.prefs-nav-item[data-prefs-tab="data"]');
    await sleep(500); // la pestaña carga su configuración de forma asíncrona
    previousBackend = await app.exec('return document.getElementById("sync-backend").value;');

    // «Probar conexión» guarda antes el formulario, passphrase incluida.
    await app.exec('document.getElementById("sync-passphrase").value = "passphrase-e2e-rechazada"; return true;');
    await app.jsClick("#btn-sync-test");
    check("un keyring que rechaza la passphrase se nombra a sí mismo, con el detalle",
      await eventually(() => toastShown(texts.keyring_unavailable.replace("{detail}", detail))));
    check("ese fallo no se presenta como un fallo del backend",
      !(await toastShown("Backend:")));
    await app.exec('document.getElementById("sync-passphrase").value = ""; return true;');

    await selectBackend("google_drive");
    check("una cuenta conectada cuyo token ha desaparecido lo dice, en rojo",
      await eventually(() => statusIs("oauth_token_missing"))
      && await app.exec('return document.getElementById("sync-oauth-dot").classList.contains("error");'));

    await app.jsClick("#btn-sync-oauth-disconnect");
    check("desconectar sin nada que desconectar lo avisa en vez de callar",
      await eventually(() => toastShown(texts.oauth_disconnect_nothing)));
    check("tras desconectar el estado vuelve a «No conectado»",
      await statusIs("oauth_disconnected")
      && await app.exec("return window.__e2eSyncFeedback.disconnectCalls === 1;"));
  } finally {
    if (previousBackend !== null) await selectBackend(previousBackend);
    await app.jsClick("#btn-prefs-cancel");
    await app.exec(`
      if (window.__e2eSyncFeedbackFetch) window.fetch = window.__e2eSyncFeedbackFetch;
      delete window.__e2eSyncFeedbackFetch;
      delete window.__e2eSyncFeedback;
      return true;
    `);
  }
}
