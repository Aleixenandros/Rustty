// Capas flotantes del área del terminal en el WebView real: la barra de
// disposición, el panel de bloques (OSC 133), la búsqueda Ctrl+F, el aviso de
// reconexión y el diagnóstico de la conexión no se pisan en ninguna de sus
// combinaciones. Es una comprobación de la hoja de estilos: las capas se
// muestran quitándoles `hidden` sobre una consola local y se miden sus
// rectángulos; al final se dejan como estaban.
import { sleep } from "./webdriver.mjs";

export async function checkTerminalLayers(app, check) {
  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);

  await press("KeyT", "T", { ctrlKey: true, shiftKey: true });
  await app.waitFor(".xterm-helper-textarea");
  await sleep(1500);
  const sessionId = await app.lastSessionId();
  await app.waitFor(`.terminal-pane[data-session="${sessionId}"] .terminal-search`);

  const result = await app.exec(`
    const pane = document.querySelector('.terminal-pane[data-session="' + arguments[0] + '"]');
    const bar = document.getElementById("view-layout-bar");
    const blocks = document.getElementById("blocks-panel");
    const search = pane.querySelector(".terminal-search");
    const reconnect = pane.querySelector(".terminal-reconnect-overlay");
    const log = pane.querySelector(".connection-log-panel");
    const all = [bar, blocks, search, reconnect, log];
    if (all.some((el) => !el)) return { missing: all.map((el) => !!el) };
    const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const wasHidden = all.map((el) => el.classList.contains("hidden"));
    const states = {
      "disposición + bloques": [bar, blocks],
      "disposición + búsqueda": [bar, search],
      "bloques + búsqueda": [blocks, search],
      "disposición + bloques + búsqueda": [bar, blocks, search],
      "reconexión + diagnóstico": [reconnect, log],
    };
    const out = {};
    const container = document.getElementById("terminals-container").getBoundingClientRect();
    for (const [name, els] of Object.entries(states)) {
      all.forEach((el) => el.classList.add("hidden"));
      els.forEach((el) => el.classList.remove("hidden"));
      const rects = els.map(rect);
      let ok = rects.every((r) => r.w > 0 && r.h > 0 && r.l >= container.left - 1 && r.r <= container.right + 1 && r.t >= container.top - 1 && r.b <= container.bottom + 1);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i], rects[j])) ok = false;
      }
      out[name] = { ok, rects: rects.map((r) => [Math.round(r.l), Math.round(r.t), Math.round(r.r), Math.round(r.b)]) };
    }
    all.forEach((el, i) => el.classList.toggle("hidden", wasHidden[i]));
    out.tokens = all.map((el) => getComputedStyle(el).zIndex);
    return out;
  `, [sessionId]);

  if (result.missing) {
    check("la consola local tiene todas las capas flotantes", false, JSON.stringify(result.missing));
    return;
  }
  for (const [name, state] of Object.entries(result)) {
    if (name === "tokens") continue;
    check(`capas del terminal sin solaparse: ${name}`, state.ok, JSON.stringify(state.rects));
  }
  check("las capas del terminal apilan por la escala de tokens (ningún z-index auto)",
    result.tokens.every((z) => /^\d+$/.test(z)), JSON.stringify(result.tokens));
}
