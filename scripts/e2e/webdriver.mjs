// Cliente WebDriver (W3C) mínimo contra `tauri-driver`, sin dependencias.
//
// Por qué no Playwright: en Linux el webview de Tauri es WebKitGTK, y Playwright
// solo sabe manejar sus propios navegadores. La vía oficial de Tauri es
// `tauri-driver`, que hace de puente con el `WebKitWebDriver` del sistema.
//
// Dos límites del WebKitWebDriver de Linux, ya pagados:
//   - El clic nativo (`element/click`) responde «unsupported operation»: los
//     clics se hacen desde la página (`el.click()`), ver `jsClick`.
//   - El terminal (xterm sobre WebGL) no tiene texto en el DOM: la entrada se
//     manda por el mismo comando IPC que usa al teclear, y el resultado se
//     mira en el log del backend o en una captura.

import fs from "node:fs";

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Abre una sesión WebDriver, que lanza la aplicación.
 * @param {object} options
 * @param {string} options.application  Ruta al binario de Rustty.
 * @param {string} [options.driver]     URL de tauri-driver.
 */
export async function openSession({ application, driver = "http://127.0.0.1:4444" }) {
  async function call(method, path, body) {
    const res = await fetch(driver + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (json.value && json.value.error) {
      throw new Error(`${method} ${path}: ${json.value.error}: ${json.value.message}`);
    }
    return json.value;
  }

  const created = await call("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application }, browserName: "wry" } },
  });
  const base = `/session/${created.sessionId}`;

  const session = {
    /** Ejecuta un script en la página; `arguments[n]` recibe `args`. */
    exec: (script, args = []) => call("POST", `${base}/execute/sync`, { script, args }),
    find: async (css) =>
      (await call("POST", `${base}/element`, { using: "css selector", value: css }))[ELEMENT],
    /** Clic desde la página: el nativo no está soportado en WebKitWebDriver. */
    jsClick: (css) =>
      session.exec(
        "const el = document.querySelector(arguments[0]); if (!el) return false; el.click(); return true;",
        [css],
      ),
    screenshot: async (file) =>
      fs.writeFileSync(file, Buffer.from(await call("GET", `${base}/screenshot`), "base64")),
    resize: (width, height) => call("POST", `${base}/window/rect`, { width, height }),
    close: () => call("DELETE", base),
    async waitFor(css, timeoutMs = 30000) {
      const started = Date.now();
      for (;;) {
        try {
          return await session.find(css);
        } catch (err) {
          if (Date.now() - started > timeoutMs) throw err;
          await sleep(250);
        }
      }
    },
    /** Id de la sesión de la última pestaña abierta. */
    lastSessionId: () =>
      session.exec(
        "const tabs = document.querySelectorAll('.tab[data-session]'); return tabs.length ? tabs[tabs.length - 1].dataset.session : null;",
      ),
    /**
     * Llama a un comando IPC desde la página y espera su promesa. Devuelve
     * `{ ok: true, value }` o `{ ok: false, reason }` (el texto del rechazo; no
     * se llama `error` porque `call` tomaría el objeto por un fallo del driver).
     */
    invoke: (cmd, args = {}) =>
      call("POST", `${base}/execute/async`, {
        script:
          "const done = arguments[arguments.length - 1];" +
          "window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(" +
          "(value) => done({ ok: true, value: value === undefined ? null : value })," +
          "(e) => done({ ok: false, reason: String((e && e.message) || e) }));",
        args: [cmd, args],
      }),
    /**
     * Lanza un comando IPC sin esperarlo (uno que abre un diálogo nativo y
     * bloquea); el resultado se recoge después con `result(key)`.
     */
    invokeDetached: (key, cmd, args = {}) =>
      session.exec(
        "const [key, cmd, args] = arguments; window.__e2e = window.__e2e || {}; window.__e2e[key] = null;" +
          "window.__TAURI_INTERNALS__.invoke(cmd, args).then(" +
          "(value) => { window.__e2e[key] = { ok: true, value: value === undefined ? null : value }; }," +
          "(e) => { window.__e2e[key] = { ok: false, reason: String((e && e.message) || e) }; });" +
          "return true;",
        [key, cmd, args],
      ),
    /** Espera el resultado de un `invokeDetached`; `null` si no llega a tiempo. */
    async result(key, timeoutMs = 15000) {
      const started = Date.now();
      for (;;) {
        const value = await session.exec("return (window.__e2e && window.__e2e[arguments[0]]) || null;", [key]);
        if (value || Date.now() - started > timeoutMs) return value;
        await sleep(250);
      }
    },
    /** Escribe en una consola local por el comando IPC que usa el teclado. */
    typeIntoLocalShell: (sessionId, text) =>
      session.exec(
        "window.__TAURI_INTERNALS__.invoke('local_shell_send_input', { sessionId: arguments[0], data: Array.from(new TextEncoder().encode(arguments[1])) }); return true;",
        [sessionId, text],
      ),
  };
  return session;
}
