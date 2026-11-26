// Buscador de Preferencias (`modules/prefs/search-view.js`) y densidad de la
// interfaz en el WebView real.
//
// Buscador: una consulta enseña solo las filas que coinciden, en todas las
// secciones a la vez, con recuento en la barra de secciones; el nombre de una
// sección cuenta como parte de cada fila; Escape vacía la búsqueda sin cerrar
// el diálogo; pulsar una sección con coincidencias se queda en los resultados
// y una sin ellas sale de la búsqueda y la abre; y cerrar y volver a abrir
// Preferencias empieza sin búsqueda.
//
// Densidad: los tokens semánticos (`--row-py`, `--menu-item-py`…) cambian con
// la preferencia y vuelven a su valor al restablecerla.
import { sleep } from "./webdriver.mjs";

const settle = () => sleep(150);

export async function checkPrefsSearch(app, check) {
  const openPrefs = async () => {
    await app.jsClick("#rail-btn-settings");
    await app.waitFor("#modal-prefs-overlay:not(.hidden)");
    await sleep(400);
  };
  const type = (text) => app.exec(`
    const input = document.getElementById("prefs-search");
    input.focus();
    input.value = arguments[0];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `, [text]);
  const state = () => app.exec(`
    const modal = document.getElementById("modal-prefs");
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const panels = [...modal.querySelectorAll(".prefs-panel")].filter(shown).map((p) => p.dataset.prefsPanel);
    const row = (id) => shown(document.getElementById(id)?.closest(".settings-row"));
    const nav = (name) => modal.querySelector('.prefs-nav-item[data-prefs-tab="' + name + '"]');
    return {
      searching: modal.classList.contains("prefs-searching"),
      panels,
      fontFamily: row("pref-font-family"),
      copyOnSelect: row("pref-copy-on-select"),
      terminalCount: nav("terminal")?.querySelector(".prefs-nav-count")?.textContent || "",
      aboutMiss: !!nav("about")?.classList.contains("is-search-miss"),
      empty: shown(document.getElementById("prefs-search-empty")),
      status: document.getElementById("prefs-search-status")?.textContent || "",
      value: document.getElementById("prefs-search").value,
      open: !document.getElementById("modal-prefs-overlay").classList.contains("hidden"),
      activeTab: modal.querySelector(".prefs-nav-item.active")?.dataset.prefsTab || "",
    };
  `);

  await openPrefs();
  try {
    await type("fuente");
    await settle();
    let s = await state();
    check("el buscador de Preferencias filtra las filas de todas las secciones",
      s.searching && s.fontFamily && !s.copyOnSelect && s.panels.includes("terminal") && s.panels.length > 1,
      JSON.stringify(s));
    check("la barra de secciones cuenta las coincidencias y atenúa las que no tienen",
      Number(s.terminalCount) > 0 && s.aboutMiss && /\d/.test(s.status), JSON.stringify(s));

    await type("terminal copiar");
    await settle();
    s = await state();
    // Otras secciones pueden casar también (un atajo de copiar del terminal,
    // en Atajos); en Terminal, todas sus filas llevan «terminal» y solo la de
    // copiar lleva «copiar».
    check("el nombre de la sección cuenta como parte de cada fila (AND)",
      s.copyOnSelect && !s.fontFamily && s.terminalCount === "1" && s.panels.includes("terminal"), JSON.stringify(s));

    await type("zzzz-nada-coincide");
    await settle();
    s = await state();
    check("sin coincidencias, aviso y ninguna sección", s.empty && s.panels.length === 0, JSON.stringify(s));

    await type("fuente");
    await settle();
    await app.jsClick('.prefs-nav-item[data-prefs-tab="terminal"]');
    await settle();
    s = await state();
    check("pulsar una sección con coincidencias se queda en los resultados", s.searching && s.value === "fuente", JSON.stringify(s));
    await app.jsClick('.prefs-nav-item[data-prefs-tab="about"]');
    await settle();
    s = await state();
    check("pulsar una sección sin coincidencias sale de la búsqueda y la abre",
      !s.searching && s.value === "" && s.panels.length === 1 && s.panels[0] === "about", JSON.stringify(s));

    await type("fuente");
    await settle();
    const prevented = await app.exec(`
      const input = document.getElementById("prefs-search");
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    `);
    await settle();
    s = await state();
    check("Escape vacía la búsqueda sin cerrar Preferencias y vuelve a la sección",
      prevented && !s.searching && s.value === "" && s.open && s.panels.length === 1 && s.panels[0] === "about",
      JSON.stringify(s));

    await type("fuente");
    await settle();
    await app.jsClick("#btn-prefs-close");
    await app.waitFor("#modal-prefs-overlay.hidden");
    await openPrefs();
    s = await state();
    check("al volver a abrir Preferencias no queda búsqueda", !s.searching && s.value === "" && s.panels.length === 1,
      JSON.stringify(s));
  } finally {
    await app.exec(`
      const input = document.getElementById("prefs-search");
      if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
      return true;
    `).catch(() => {});
  }

  // Densidad: los tokens semánticos siguen a la preferencia.
  const setDensity = async (value) => {
    await app.jsClick('[data-prefs-tab="appearance"]');
    await app.exec(`
      const sel = document.getElementById("pref-ui-density");
      sel.value = arguments[0];
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `, [value]);
    await app.jsClick("#btn-prefs-save");
    await app.waitFor("#modal-prefs-overlay.hidden");
    await settle();
  };
  const tokens = () => app.exec(`
    const css = getComputedStyle(document.body);
    return ["--row-py", "--menu-item-py", "--list-item-py", "--card-pad"].map((name) => css.getPropertyValue(name).trim());
  `);
  const normal = await tokens();
  try {
    await setDensity("compact");
    const compact = await tokens();
    await openPrefs();
    await setDensity("spacious");
    const spacious = await tokens();
    const px = (list) => list.map((v) => parseFloat(v));
    const [n, c, sp] = [px(normal), px(compact), px(spacious)];
    check("la densidad compacta y la amplia mueven los rellenos de filas, menús, listas y tarjetas",
      n.every((v, i) => c[i] < v && sp[i] > v), JSON.stringify({ normal, compact, spacious }));
  } finally {
    await openPrefs().catch(() => {});
    await setDensity("comfortable").catch(() => {});
  }
}
