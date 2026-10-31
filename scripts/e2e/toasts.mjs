// Avisos (toasts) y centro de actividad en el WebView real.
//
// Comprueba que «Ir al último aviso» —acción sin combinación de fábrica— lleva
// el foco a la acción del último aviso cuando el usuario le asigna una
// combinación en Preferencias, que Escape y Tab fuera del aviso devuelven el
// foco a donde estaba sin cerrar el diálogo de debajo, que la pila queda por
// encima de la barra de estado con el icono de severidad visible, y que el
// centro de actividad es un diálogo con título, filtros conmutables y Escape
// que devuelve el foco. El aviso de error se provoca interceptando en la
// página la llamada IPC al opener del sistema: sin red ni ventanas nativas.
import { sleep } from "./webdriver.mjs";

/** El controlador de diálogos reacciona en microtareas y con un MutationObserver. */
const settle = () => sleep(200);

export async function checkToasts(app, check) {
  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);
  const activeId = () => app.exec("const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : null;");
  const readPrefs = () => app.exec('return JSON.parse(localStorage.getItem("rustty-prefs") || "{}");');
  const visible = (id) => app.exec("return !document.getElementById(arguments[0]).classList.contains(\"hidden\");", [id]);
  const row = '.shortcut-row[data-shortcut-id="focus_last_toast"]';

  // ── La acción existe, sin combinación, y se asigna por Preferencias ──
  await press("Comma", ",", { ctrlKey: true });
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(500);
  await app.jsClick('[data-prefs-tab="shortcuts"]');
  check("«Ir al último aviso» aparece en Atajos sin combinación de fábrica",
    await app.exec(`const r = document.querySelector('${row}'); return !!r && !!r.querySelector(".shortcut-combo em");`));
  await app.jsClick(`${row} .btn-shortcut-edit`);
  await press("KeyY", "y", { ctrlKey: true, altKey: true });
  await sleep(300);
  check("la combinación elegida para «Ir al último aviso» se guarda",
    (await readPrefs()).shortcuts?.focus_last_toast === "Ctrl+Alt+Y");

  // ── Un aviso de error con acción, provocado sin red ni diálogos nativos ──
  await app.jsClick('[data-prefs-tab="about"]');
  await app.exec(`
    const original = window.fetch;
    window.__e2eToastsFetch = original;
    const url = window.__TAURI_INTERNALS__.convertFileSrc("plugin:opener|open_url", "ipc");
    window.fetch = (target, options) => {
      if (target === url) {
        return Promise.resolve(new Response(JSON.stringify("e2e: opener rechazado"), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "error" },
        }));
      }
      return original(target, options);
    };
    return true;
  `);
  try {
    const openerFocused = await app.exec(`
      const a = document.getElementById("about-link-site");
      a.focus(); a.dataset.e2eOpener = "1";
      return document.activeElement === a;
    `);
    check("hay un control enfocable desde el que provocar el aviso", openerFocused, await activeId());
    await app.jsClick("#about-link-site");
    await app.waitFor(".toast.error .toast-action", 10000);
    await settle();

    check("el aviso de error es la única región viva propia (role=alert) y el resto no lleva role",
      await app.exec(`
        const c = document.getElementById("toast-container");
        const toasts = [...c.querySelectorAll(".toast:not(.toast-overflow)")];
        return c.getAttribute("aria-live") === "polite"
          && toasts.every((el) => (el.classList.contains("error") ? el.getAttribute("role") === "alert" : !el.hasAttribute("role")));
      `));
    check("el icono de severidad se ve sin el modo daltónico y el borde lleva el color del aviso",
      await app.exec(`
        const el = document.querySelector(".toast.error");
        const before = getComputedStyle(el, "::before");
        const mask = before.getPropertyValue("mask-image") || before.getPropertyValue("-webkit-mask-image");
        return !document.body.classList.contains("color-blind-safe")
          && mask && mask !== "none" && parseFloat(before.width) >= 16
          && parseFloat(getComputedStyle(el).borderLeftWidth) >= 3;
      `));
    check("la pila de avisos queda por encima de la barra de estado y dentro de la ventana",
      await app.exec(`
        const r = document.getElementById("toast-container").getBoundingClientRect();
        const statusBar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--status-bar-height")) || 0;
        return statusBar > 0 && window.innerHeight - r.bottom >= statusBar && r.right <= window.innerWidth;
      `));
    check("el indicador de la sincronización de arranque vive dentro de la pila de avisos",
      await app.exec('return document.getElementById("sync-boot-indicator")?.parentElement?.id === "toast-container";'));

    // ── «Ir al último aviso»: foco en la acción, Escape devuelve el foco ──
    const handled = await press("KeyY", "y", { ctrlKey: true, altKey: true });
    await settle();
    check("el atajo asignado lleva el foco a la acción del último aviso, también con Preferencias abierto",
      handled && await app.exec('return document.activeElement?.classList.contains("toast-action") === true;'),
      await activeId());
    await press("Escape", "Escape");
    await settle();
    check("Escape en el aviso devuelve el foco a quien lo tenía y no cierra Preferencias",
      await visible("modal-prefs-overlay")
      && await app.exec('return document.activeElement?.dataset?.e2eOpener === "1";'), await activeId());

    // ── Tab fuera del aviso también devuelve el foco ──
    await press("KeyY", "y", { ctrlKey: true, altKey: true });
    await settle();
    const tabInside = await press("Tab", "Tab");
    check("Tab entre la acción y el botón de cerrar del aviso no sale de él", !tabInside);
    await app.exec('document.querySelector(".toast.error .toast-close").focus(); return true;');
    const tabOut = await press("Tab", "Tab");
    await settle();
    check("Tab desde el último control del aviso devuelve el foco a quien lo tenía",
      tabOut && await app.exec('return document.activeElement?.dataset?.e2eOpener === "1";'), await activeId());

    // ── Cerrar el aviso desde su botón y limpiar ──
    await app.jsClick(".toast.error .toast-close");
    await settle();
    check("el botón de cerrar retira el aviso", !(await app.exec('return !!document.querySelector(".toast.error");')));
  } finally {
    await app.exec(`
      if (window.__e2eToastsFetch) window.fetch = window.__e2eToastsFetch;
      delete window.__e2eToastsFetch;
      document.querySelector("[data-e2e-opener]")?.removeAttribute("data-e2e-opener");
      return true;
    `);
  }
  await app.jsClick('[data-prefs-tab="shortcuts"]');
  await app.jsClick(`${row} .btn-shortcut-reset`);
  check("restablecer deja «Ir al último aviso» sin combinación",
    !Object.hasOwn((await readPrefs()).shortcuts || {}, "focus_last_toast"));
  await app.jsClick("#btn-prefs-cancel");
  await app.waitFor("#modal-prefs-overlay.hidden");
  await settle();

  // ── Centro de actividad: diálogo titulado, filtros conmutables, Escape ──
  const railFocused = await app.exec(`
    const b = document.querySelector('[data-rail-action="activity"]');
    b.focus(); b.dataset.e2eOpener = "1";
    return document.activeElement === b;
  `);
  check("el botón del rail que abre el centro de actividad acepta el foco", railFocused, await activeId());
  await app.jsClick('[data-rail-action="activity"]');
  await app.waitFor("#activity-center-overlay:not(.hidden)");
  await settle();
  check("el centro de actividad es un diálogo con su título como nombre y el foco en el filtro puesto",
    await app.exec(`
      const panel = document.getElementById("activity-center-panel");
      const title = document.getElementById(panel.getAttribute("aria-labelledby") || "");
      return panel.getAttribute("role") === "dialog"
        && !!title && title.textContent.trim().length > 0
        && document.activeElement?.classList.contains("activity-filter")
        && document.activeElement?.getAttribute("aria-pressed") === "true";
    `), await activeId());
  await app.jsClick('.activity-filter[data-activity-filter="connection"]');
  await settle();
  check("los filtros del centro de actividad son conmutadores excluyentes (aria-pressed)",
    await app.exec(`
      const on = [...document.querySelectorAll(".activity-filter")].filter((b) => b.getAttribute("aria-pressed") === "true");
      return on.length === 1 && on[0].dataset.activityFilter === "connection";
    `));
  check("todos los textos del centro de actividad están marcados para traducir",
    await app.exec(`
      const panel = document.getElementById("activity-center-panel");
      const bare = [...panel.querySelectorAll("button, h2, p")]
        .filter((el) => el.textContent.trim() && !el.hasAttribute("data-i18n") && !el.hasAttribute("data-i18n-aria-label") && el.getAttribute("translate") !== "no" && !el.closest("#activity-center-list"));
      return bare.length === 0;
    `));
  await press("Escape", "Escape");
  await app.waitFor("#activity-center-overlay.hidden");
  await settle();
  check("Escape cierra el centro de actividad y el foco vuelve al botón del rail",
    await app.exec('return document.activeElement?.dataset?.e2eOpener === "1";'), await activeId());
  await app.exec(`
    document.querySelector("[data-e2e-opener]")?.removeAttribute("data-e2e-opener");
    const all = document.querySelector('.activity-filter[data-activity-filter="all"]');
    if (all) all.click();
    return true;
  `);
}
