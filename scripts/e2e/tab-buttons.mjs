// Preferencia «Botones de la pestaña», en el WebView real: se guarda desde
// Preferencias, la hoja oculta los botones (SFTP, túneles, nota) y el menú
// contextual de la pestaña sigue ofreciendo sus paneles.
import { sleep } from "./webdriver.mjs";

/**
 * «Botones de la pestaña»: la preferencia se guarda y la hoja oculta los
 * botones; el menú contextual ofrece igualmente los paneles de la pestaña.
 * La consola local no tiene esos botones: se le pone uno de prueba (el menú
 * lee los botones del DOM, existan o no a la vista) y se quita al acabar.
 */
export async function checkTabButtons(app, check) {
  const setMode = async (mode) => {
    await app.jsClick("#rail-btn-settings");
    await app.waitFor("#modal-prefs-overlay:not(.hidden)");
    await sleep(400);
    await app.jsClick('[data-prefs-tab="terminal"]');
    await app.exec(`
      const sel = document.getElementById("pref-tab-buttons");
      sel.value = arguments[0];
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `, [mode]);
    await app.jsClick("#btn-prefs-save");
    await app.waitFor("#modal-prefs-overlay.hidden");
    await sleep(200);
  };
  await app.jsClick("#home-tab");
  await sleep(300);
  await app.jsClick("#btn-welcome-local");
  await app.waitFor(".tab.active[data-session]", 20000);
  await sleep(500);
  await app.exec(`
    const tab = document.querySelector(".tab.active[data-session]");
    const btn = document.createElement("button");
    btn.className = "tab-sftp e2e-fake";
    tab.querySelector(".tab-close").before(btn);
    return true;
  `);
  const visible = () => app.exec(`
    const btn = document.querySelector(".tab.active .e2e-fake");
    return !!btn && getComputedStyle(btn).display !== "none";
  `);
  try {
    check("de serie los botones de la pestaña se ven", await app.exec("return document.body.dataset.tabButtons;") === "always" && await visible());
    await setMode("never");
    const stored = await app.exec('return JSON.parse(localStorage.getItem("rustty-prefs")).tabButtons;');
    check("«Nunca» se guarda y oculta los botones", stored === "never" && !(await visible()), String(stored));
    await app.exec(`
      const tab = document.querySelector(".tab.active[data-session]");
      const r = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5 }));
      return true;
    `);
    await sleep(300);
    const menu = await app.exec(`
      const m = document.getElementById("tab-context-menu");
      const vis = (sel) => !m.querySelector(sel).classList.contains("hidden");
      return { open: !m.classList.contains("hidden"), sftp: vis(".tabctx-panel-sftp"), tunnels: vis(".tabctx-panel-tunnels"), sep: vis(".tabctx-panels-sep") };
    `);
    check("con los botones ocultos, el menú de la pestaña ofrece su panel",
      menu.open && menu.sftp && !menu.tunnels && menu.sep, JSON.stringify(menu));
    await app.exec('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.body.click(); return true;');
    await sleep(200);
    await setMode("active");
    check("«Solo en la activa» los enseña en la pestaña activa", await visible());

    // «En la activa y al pasar el ratón»: en una pestaña de fondo se esconden,
    // salvo el que está encendido (panel abierto o túneles activos).
    await setMode("hover");
    // Con Inicio delante, la pestaña de la consola queda de fondo.
    await app.jsClick("#home-tab");
    await sleep(400);
    const background = await app.exec(`
      const tabs = [...document.querySelectorAll(".tab[data-session]")];
      const tab = tabs.find((el) => !el.classList.contains("active") && el.querySelector(".e2e-fake"));
      if (!tab) return null;
      const fake = tab.querySelector(".e2e-fake");
      const lit = document.createElement("button");
      lit.className = "tab-tunnels e2e-fake is-on";
      tab.querySelector(".tab-close").before(lit);
      const shown = (el) => getComputedStyle(el).display !== "none";
      return { plain: shown(fake), lit: shown(lit), litColor: getComputedStyle(lit).color };
    `);
    check("«Al pasar el ratón» esconde los botones de las pestañas de fondo salvo el encendido",
      !!background && !background.plain && background.lit, JSON.stringify(background));
    await app.jsClick(".tab[data-session]");
    await sleep(300);
  } finally {
    await app.exec('document.querySelectorAll(".e2e-fake").forEach((el) => el.remove()); return true;');
    await setMode("always").catch(() => {});
  }
}
