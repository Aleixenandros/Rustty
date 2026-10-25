// Protocolos modernos del terminal y modo solo lectura, en una consola local
// real (`modules/terminal/osc.js` y `modules/terminal/read-only.js`).
//
// La salida la produce el propio shell con `printf`: el título (OSC 0) y el
// progreso (OSC 9;4) llegan por el mismo camino que los de un servidor. El
// `sleep` final retrasa el prompt siguiente, que en muchas distribuciones
// vuelve a fijar el título (PROMPT_COMMAND de /etc/bashrc) y taparía el de
// la prueba antes de mirarlo.
//
// La solo lectura se prueba por la interfaz: el menú de la pestaña la activa,
// el editor de comandos intenta insertar una orden que crearía un fichero y no
// debe salir nada hacia `local_shell_send_input`; el «Desbloquear» del aviso
// la quita y la misma orden ya se ejecuta. El portapapeles (OSC 52) no se
// prueba aquí: tocaría el portapapeles real del escritorio.
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./webdriver.mjs";

export async function checkTerminalProtocols(app, check, workDir) {
  await app.jsClick("#btn-welcome-local");
  await app.waitFor(".xterm-helper-textarea");
  await sleep(2500);
  const sid = await app.lastSessionId();
  check("abre una consola local para los protocolos", typeof sid === "string" && sid.startsWith("local-"), String(sid));

  const tabState = () => app.exec(`
    const tab = document.querySelector('.tab[data-session="' + arguments[0] + '"]');
    const bar = tab && tab.querySelector(".tab-progress");
    const fill = bar && bar.querySelector(".tab-progress-fill");
    const textarea = document.querySelector('.terminal-pane[data-session="' + arguments[0] + '"] .xterm-helper-textarea');
    return {
      title: tab ? tab.title : "",
      progress: bar ? bar.dataset.state : null,
      width: fill ? fill.style.width : null,
      valueNow: bar ? bar.getAttribute("aria-valuenow") : null,
      lock: !!(tab && tab.querySelector(".tab-readonly-badge")),
      stdinOff: !!(textarea && textarea.readOnly),
    };
  `, [sid]);

  // ── OSC 0 y OSC 9;4 ─────────────────────────────────────────────
  await app.typeIntoLocalShell(sid, "printf '\\033]0;e2e-titulo-remoto\\007\\033]9;4;1;42\\007'; sleep 4\n");
  await sleep(1500);
  let state = await tabState();
  check("el título que fija el shell (OSC 0) sale en el tooltip de la pestaña",
    state.title.includes("e2e-titulo-remoto"), JSON.stringify(state));
  check("el progreso OSC 9;4 pinta la barra de la pestaña al 42 %",
    state.progress === "normal" && state.width === "42%" && state.valueNow === "42", JSON.stringify(state));
  await sleep(3500);
  await app.typeIntoLocalShell(sid, "printf '\\033]9;4;3\\007'; sleep 2\n");
  await sleep(1200);
  state = await tabState();
  check("OSC 9;4;3 deja la barra en indeterminado", state.progress === "indeterminate", JSON.stringify(state));
  await sleep(1500);
  await app.typeIntoLocalShell(sid, "printf '\\033]9;4;0\\007'\n");
  await sleep(1200);
  state = await tabState();
  check("OSC 9;4;0 retira la barra", state.progress === null, JSON.stringify(state));

  // ── Solo lectura desde el menú de la pestaña ────────────────────
  await app.exec(`
    const tab = document.querySelector('.tab[data-session="' + arguments[0] + '"]');
    const r = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5,
    }));
    return true;
  `, [sid]);
  await app.waitFor("#tab-context-menu:not(.hidden)");
  check("el menú de la pestaña ofrece «Solo lectura»",
    await app.exec('return !document.querySelector(\'#tab-context-menu [data-tabctx="toggle-read-only"]\').classList.contains("hidden");'));
  await app.jsClick('#tab-context-menu [data-tabctx="toggle-read-only"]');
  await sleep(300);
  state = await tabState();
  check("en solo lectura la pestaña lleva el candado y xterm no acepta entrada",
    state.lock && state.stdinOff, JSON.stringify(state));

  // ── El editor de comandos no envía nada ─────────────────────────
  const marker = path.join(workDir, "solo-lectura.txt");
  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);
  await press("KeyE", "E", { ctrlKey: true, shiftKey: true });
  await app.waitFor("#cmd-editor-overlay:not(.hidden)");
  await app.exec(`
    document.getElementById("cmd-editor-textarea").value = arguments[0];
    document.getElementById("cmd-editor-insert").click();
    return true;
  `, [`touch '${marker}'\n`]);
  await sleep(1500);
  const blocked = await app.exec(`
    const toast = [...document.querySelectorAll("#toast-container .toast")]
      .find((el) => /solo lectura/i.test(el.textContent) && el.querySelector(".toast-action"));
    return {
      editorOpen: !document.getElementById("cmd-editor-overlay").classList.contains("hidden"),
      draft: document.getElementById("cmd-editor-textarea").value,
      toast: toast ? toast.querySelector(".toast-message").textContent : null,
    };
  `);
  check("en solo lectura el editor no envía la orden a la consola", !fs.existsSync(marker));
  check("el editor sigue abierto con lo escrito y un aviso ofrece desbloquear",
    blocked.editorOpen && blocked.draft.includes("touch") && !!blocked.toast, JSON.stringify(blocked));

  // ── «Desbloquear» del aviso: la misma orden ya sale ─────────────
  await app.exec(`
    const toast = [...document.querySelectorAll("#toast-container .toast")]
      .find((el) => /solo lectura/i.test(el.textContent) && el.querySelector(".toast-action"));
    toast?.querySelector(".toast-action").click();
    return true;
  `);
  await sleep(300);
  state = await tabState();
  check("«Desbloquear» quita el candado y devuelve la entrada a xterm", !state.lock && !state.stdinOff, JSON.stringify(state));
  await app.jsClick("#cmd-editor-insert");
  await sleep(2000);
  check("desbloqueada, la orden del editor se ejecuta", fs.existsSync(marker));
  await app.typeIntoLocalShell(sid, "exit\n");
  await sleep(1500);
}
