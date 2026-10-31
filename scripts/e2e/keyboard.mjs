// Accesibilidad de controles por teclado en el WebView real: los desplegables
// propios (combobox de solo selección sobre `modules/listbox-nav.js`), los
// submenús de los menús contextuales (`modules/menu-nav.js`) y la barra de
// pestañas (`modules/tab-navigation.js`).
//
// WebKitWebDriver no hace clic nativo y un KeyboardEvent sintético no ejecuta
// la acción por defecto del navegador: se comprueba lo que el código hace de
// forma explícita (sus propios manejadores), no la navegación nativa.
import { sleep } from "./webdriver.mjs";

const settle = () => sleep(200);

export async function checkKeyboard(app, check) {
  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);
  const visible = (id) => app.exec("const el = document.getElementById(arguments[0]); return !!el && !el.classList.contains(\"hidden\");", [id]);
  const activeId = () => app.exec("const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : null;");
  const readPrefs = () => app.exec('return JSON.parse(localStorage.getItem("rustty-prefs") || "{}");');

  // ── Desplegable de Preferencias → Idioma ────────────────────────
  await press("Comma", ",", { ctrlKey: true });
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(500);
  await app.jsClick('[data-prefs-tab="language"]');
  const combo = await app.exec(`
    const sel = document.getElementById("pref-language");
    const wrap = sel.closest(".custom-select");
    const btn = wrap && wrap.querySelector(".custom-select-display");
    if (!btn) return null;
    btn.focus();
    const label = document.querySelector('label[for="pref-language"]');
    return {
      value: sel.value, focused: document.activeElement === btn, role: btn.getAttribute("role"),
      haspopup: btn.getAttribute("aria-haspopup"), expanded: btn.getAttribute("aria-expanded"),
      controls: btn.getAttribute("aria-controls"), labelledby: btn.getAttribute("aria-labelledby"),
      labelId: label && label.id, listRole: document.getElementById(btn.getAttribute("aria-controls"))?.getAttribute("role"),
    };
  `);
  check("el desplegable de idioma es un combobox etiquetado que controla un listbox",
    !!combo && combo.focused && combo.role === "combobox" && combo.haspopup === "listbox" && combo.expanded === "false"
    && combo.listRole === "listbox" && !!combo.labelId && String(combo.labelledby).split(" ").includes(combo.labelId),
    JSON.stringify(combo));
  const before = combo?.value;
  const openPrevented = await press("ArrowDown", "ArrowDown");
  const opened = await app.exec(`
    const btn = document.activeElement;
    const list = document.getElementById(btn.getAttribute("aria-controls"));
    const active = document.getElementById(btn.getAttribute("aria-activedescendant") || "");
    return { expanded: btn.getAttribute("aria-expanded"), listShown: !list.classList.contains("hidden"),
      activeRole: active && active.getAttribute("role"), activeSelected: active && active.getAttribute("aria-selected"),
      stillFocused: btn.classList.contains("custom-select-display") };
  `);
  check("↓ abre la lista sin mover el foco del botón y resalta la opción elegida",
    openPrevented && opened.expanded === "true" && opened.listShown && opened.activeRole === "option"
    && opened.activeSelected === "true" && opened.stillFocused, JSON.stringify(opened));
  await press("ArrowDown", "ArrowDown");
  await press("Enter", "Enter");
  const after = await app.exec(`
    const sel = document.getElementById("pref-language");
    const btn = sel.closest(".custom-select").querySelector(".custom-select-display");
    return { value: sel.value, text: btn.textContent, expanded: btn.getAttribute("aria-expanded"),
      optText: sel.options[sel.selectedIndex].textContent, focused: document.activeElement === btn };
  `);
  check("↓ y Enter eligen la opción siguiente y cierran la lista",
    after.value !== before && after.value === "en" && after.text === after.optText && after.expanded === "false" && after.focused,
    `${before} → ${JSON.stringify(after)}`);
  await press("ArrowDown", "ArrowDown");
  const escPrevented = await press("Escape", "Escape");
  await settle();
  const escaped = await app.exec(`
    const sel = document.getElementById("pref-language");
    const btn = sel.closest(".custom-select").querySelector(".custom-select-display");
    return { value: sel.value, expanded: btn.getAttribute("aria-expanded"), focused: document.activeElement === btn };
  `);
  check("Escape sobre la lista abierta la cierra sin tocar el valor y NO cierra Preferencias",
    escPrevented && escaped.expanded === "false" && escaped.value === "en" && escaped.focused
    && await visible("modal-prefs-overlay"), JSON.stringify(escaped));
  const typed = await app.exec(`
    const sel = document.getElementById("pref-language");
    const btn = sel.closest(".custom-select").querySelector(".custom-select-display");
    const fire = (key) => btn.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    fire("p");
    const active = document.getElementById(btn.getAttribute("aria-activedescendant") || "");
    const text = active && active.textContent;
    fire("Escape");
    return text;
  `);
  check("tecleando una letra abre y resalta la opción que empieza por ella",
    typeof typed === "string" && typed.toLowerCase().startsWith("p"), String(typed));
  // Dejar el idioma como estaba (es) y salir sin guardar.
  await app.exec('document.getElementById("pref-language").value = "es"; return true;');
  await app.jsClick("#btn-prefs-cancel");
  await app.waitFor("#modal-prefs-overlay.hidden");

  // ── Preferencia «Usar los desplegables del sistema» ─────────────
  await press("Comma", ",", { ctrlKey: true });
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(500);
  await app.jsClick('[data-prefs-tab="appearance"]');
  await app.exec('const cb = document.getElementById("pref-native-selects"); cb.checked = true; return true;');
  await app.jsClick("#btn-prefs-save");
  await app.waitFor("#modal-prefs-overlay.hidden");
  await settle();
  const native = await app.exec(`return {
    pref: JSON.parse(localStorage.getItem("rustty-prefs")).nativeSelects,
    wrapped: document.querySelectorAll(".custom-select").length,
    lists: document.querySelectorAll(".custom-select-list").length,
    selectShown: !document.getElementById("pref-language").closest(".custom-select") };`);
  check("con los desplegables del sistema no queda ningún control propio y el <select> vuelve a estar a la vista",
    native.pref === true && native.wrapped === 0 && native.lists === 0 && native.selectShown, JSON.stringify(native));
  await press("Comma", ",", { ctrlKey: true });
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(500);
  await app.jsClick('[data-prefs-tab="appearance"]');
  await app.exec('document.getElementById("pref-native-selects").checked = false; return true;');
  await app.jsClick("#btn-prefs-save");
  await app.waitFor("#modal-prefs-overlay.hidden");
  await settle();
  const restored = await app.exec(`return {
    pref: JSON.parse(localStorage.getItem("rustty-prefs")).nativeSelects,
    wrapped: document.querySelectorAll(".custom-select").length,
    language: !!document.getElementById("pref-language").closest(".custom-select") };`);
  check("desactivarla vuelve a montar los desplegables propios en vivo",
    restored.pref === false && restored.wrapped > 0 && restored.language, JSON.stringify(restored));
  check("la vuelta deja el idioma como estaba", (await readPrefs()).lang === "es");

  // ── Submenú del menú contextual de una conexión ─────────────────
  const connId = await app.exec(`
    const item = [...document.querySelectorAll("#connection-list .conn-item[data-id]")][0];
    if (!item) return null;
    item.focus();
    const r = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
    return item.dataset.id;
  `);
  check("hay una conexión en la barra lateral desde la que abrir su menú", !!connId, String(connId));
  await app.waitFor("#context-menu:not(.hidden)");
  await settle();
  const menuRoles = await app.exec(`
    const menu = document.getElementById("context-menu");
    const parents = [...menu.querySelectorAll(".ctx-has-submenu")];
    return {
      menuRole: menu.getAttribute("role"),
      firstFocused: menu.contains(document.activeElement) && document.activeElement.getAttribute("role") === "menuitem",
      parents: parents.map((p) => ({ id: p.id, role: p.getAttribute("role"), haspopup: p.getAttribute("aria-haspopup"),
        expanded: p.getAttribute("aria-expanded"), labelled: !!document.getElementById(p.getAttribute("aria-labelledby") || ""),
        visible: !p.classList.contains("hidden") })),
    };
  `);
  check("el menú es un menu, abre con el foco en un menuitem y sus padres anuncian el submenú plegado",
    menuRoles.menuRole === "menu" && menuRoles.firstFocused && menuRoles.parents.length >= 3
    && menuRoles.parents.every((p) => p.role === "menuitem" && p.haspopup === "menu" && p.expanded === "false" && p.labelled),
    JSON.stringify(menuRoles));
  const parentId = menuRoles.parents.find((p) => p.visible && p.id === "ctx-tunnels")?.id
    ?? menuRoles.parents.find((p) => p.visible)?.id;
  check("la conexión ofrece un submenú («Túneles» o el que exista)", !!parentId, String(parentId));
  // Hasta el padre con las flechas, para comprobar que ↓ no se mete en el submenú.
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await press("ArrowDown", "ArrowDown");
    reached = await app.exec("return document.activeElement.id === arguments[0];", [parentId]);
  }
  const onParent = await app.exec(`
    const p = document.getElementById(arguments[0]);
    const sub = p.querySelector('[role="menu"]');
    return { reached: document.activeElement === p, expanded: p.getAttribute("aria-expanded"),
      shown: getComputedStyle(sub).display !== "none", active: p.classList.contains("is-active") };
  `, [parentId]);
  check("↓ recorre solo el primer nivel y llega al padre, que muestra su submenú con el foco (focus-within)",
    reached && onParent.reached && onParent.expanded === "true" && onParent.shown && onParent.active, JSON.stringify(onParent));
  const rightPrevented = await press("ArrowRight", "ArrowRight");
  const inSub = await app.exec(`
    const p = document.getElementById(arguments[0]);
    const sub = p.querySelector('[role="menu"]');
    const a = document.activeElement;
    return { inside: sub.contains(a), role: a.getAttribute("role"), first: a === sub.querySelector('[role="menuitem"]'),
      expanded: p.getAttribute("aria-expanded"), parentActive: p.classList.contains("is-active") };
  `, [parentId]);
  check("→ abre el submenú y enfoca su primer ítem",
    rightPrevented && inSub.inside && inSub.role === "menuitem" && inSub.first && inSub.expanded === "true" && inSub.parentActive,
    JSON.stringify(inSub));
  const escSub = await press("Escape", "Escape");
  await settle();
  const backOnParent = await app.exec(`
    const p = document.getElementById(arguments[0]);
    const sub = p.querySelector('[role="menu"]');
    return { onParent: document.activeElement === p, expanded: p.getAttribute("aria-expanded"),
      shown: getComputedStyle(sub).display !== "none", menuOpen: !document.getElementById("context-menu").classList.contains("hidden"),
      prefsClosed: document.getElementById("modal-prefs-overlay").classList.contains("hidden") };
  `, [parentId]);
  check("Escape en el submenú vuelve al padre y lo pliega sin cerrar el menú",
    escSub && backOnParent.onParent && backOnParent.expanded === "false" && !backOnParent.shown && backOnParent.menuOpen,
    JSON.stringify(backOnParent));
  await press("ArrowRight", "ArrowRight");
  await press("ArrowLeft", "ArrowLeft");
  check("← desde el submenú vuelve también al padre",
    await app.exec("return document.activeElement.id === arguments[0];", [parentId]), await activeId());
  const escTop = await press("Escape", "Escape");
  await settle();
  check("Escape en el primer nivel cierra el menú y devuelve el foco a la conexión que lo abrió",
    escTop && !(await visible("context-menu"))
    && await app.exec("return document.activeElement?.dataset?.id === arguments[0];", [connId]), await activeId());

  // ── Barra de pestañas ───────────────────────────────────────────
  const tabsBefore = await app.exec('return document.querySelectorAll("#tabs-container .tab").length;');
  for (let i = tabsBefore; i < 2; i++) {
    await app.jsClick("#rail-btn-local");
    await app.waitFor(".xterm-helper-textarea");
    await sleep(1500);
  }
  const tabsA11y = await app.exec(`
    const tabs = [...document.querySelectorAll("#tabs-container .tab")];
    tabs[0].focus();
    return {
      count: tabs.length,
      focusedFirst: document.activeElement === tabs[0],
      roles: tabs.every((t) => t.getAttribute("role") === "tab"),
      roving: tabs.filter((t) => t.getAttribute("tabindex") === "0").length,
      described: tabs.every((t) => {
        const d = document.getElementById(t.getAttribute("aria-describedby") || "");
        return !!d && d.classList.contains("sr-only") && d.textContent.trim().length > 0;
      }),
      states: tabs.map((t) => document.getElementById(t.getAttribute("aria-describedby")).textContent),
    };
  `);
  check("las pestañas son tabs con un solo tabindex 0 y cada una describe su estado en palabras",
    tabsA11y.count >= 2 && tabsA11y.focusedFirst && tabsA11y.roles && tabsA11y.described, JSON.stringify(tabsA11y));
  const rightTab = await press("ArrowRight", "ArrowRight");
  const moved = await app.exec(`
    const tabs = [...document.querySelectorAll("#tabs-container .tab")];
    return { second: document.activeElement === tabs[1], secondIndex: tabs[1].getAttribute("tabindex"),
      firstIndex: tabs[0].getAttribute("tabindex"), zeros: tabs.filter((t) => t.getAttribute("tabindex") === "0").length };
  `);
  check("→ mueve el foco a la siguiente pestaña y el tabindex itinerante la sigue",
    rightTab && moved.second && moved.secondIndex === "0" && moved.firstIndex === "-1" && moved.zeros === 1, JSON.stringify(moved));
  await press("Home", "Home");
  check("Inicio vuelve a la primera pestaña",
    await app.exec('const tabs = document.querySelectorAll("#tabs-container .tab"); return document.activeElement === tabs[0] && tabs[0].getAttribute("tabindex") === "0";'));
  await press("End", "End");
  const last = await app.exec(`
    const tabs = [...document.querySelectorAll("#tabs-container .tab")];
    const t = tabs[tabs.length - 1];
    const onLast = document.activeElement === t;
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return { onLast, selected: t.getAttribute("aria-selected"), active: t.classList.contains("active"),
      zeros: tabs.filter((x) => x.getAttribute("tabindex") === "0").length, state: document.getElementById(t.getAttribute("aria-describedby")).textContent };
  `);
  check("Fin va a la última y Enter la activa manteniendo un solo tabindex 0",
    last.onLast && last.selected === "true" && last.active && last.zeros === 1, JSON.stringify(last));
}
