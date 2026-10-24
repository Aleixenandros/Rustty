// Recorre el controlador de diálogos (`src/modules/dialogs/`) en el WebView
// real: Escape solo cierra el diálogo de arriba, el foco entra al abrir y
// vuelve a quien lo abrió al cerrar, el fondo queda inerte, Tab da la vuelta
// dentro y los atajos globales no actúan detrás de un modal.
//
// WebKitWebDriver no mueve el foco con un KeyboardEvent sintético (su acción
// por defecto no existe): se comprueba lo que el controlador hace de forma
// explícita — la vuelta del Tab en los extremos, Escape, el foco inicial y la
// restauración —, no la navegación nativa entre controles intermedios.
import { sleep } from "./webdriver.mjs";

/** El controlador reacciona en microtareas y con un MutationObserver. */
const settle = () => sleep(200);

export async function checkDialogs(app, check) {
  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);
  const activeId = () => app.exec("const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : null;");
  const visible = (id) => app.exec("return !document.getElementById(arguments[0]).classList.contains(\"hidden\");", [id]);

  // ── Nueva conexión: foco dentro y fondo inerte ──────────────────
  // Disparador comprobable: el buscador de conexiones si de verdad acepta el
  // foco (con la ventana de prueba detrás de otra, o con la búsqueda oculta en
  // la vista actual, `focus()` no hace nada y el disparador real sería el
  // terminal); si no, el primer botón visible del rail.
  const opener = await app.exec(`
    const candidates = [document.getElementById("sidebar-search"), ...document.querySelectorAll("#rail button")];
    for (const el of candidates) {
      if (!el || !el.getClientRects().length || el.closest(".hidden")) continue;
      el.focus();
      if (document.activeElement === el) { el.dataset.e2eOpener = "1"; return el.id || el.className; }
    }
    return null;
  `);
  check("hay un control enfocable desde el que abrir Nueva conexión", !!opener, String(opener));
  await press("KeyN", "N", { ctrlKey: true, shiftKey: true });
  await app.waitFor("#modal-overlay:not(.hidden)");
  await settle();
  check("abrir Nueva conexión lleva el foco dentro del diálogo",
    await app.exec('return document.getElementById("modal-connection").contains(document.activeElement);'),
    await activeId());
  check("con un modal abierto el fondo queda inerte y los tiradores de la ventana no",
    await app.exec(`return document.getElementById("main-area").inert === true
      && document.getElementById("sidebar").inert === true
      && document.getElementById("window-resize-handles").inert !== true;`));

  // ── Escape en un popover interno no cierra el diálogo ───────────
  await app.exec('document.getElementById("f-host").value = "e2e-escape.example"; return true;');
  await app.jsClick("#f-folder-trigger");
  await app.waitFor("#f-folder-popover:not(.hidden)");
  await press("Escape", "Escape");
  await settle();
  check("Escape en el selector de carpeta no cierra Nueva conexión ni borra lo escrito",
    await app.exec(`return document.getElementById("f-folder-popover").classList.contains("hidden")
      && !document.getElementById("modal-overlay").classList.contains("hidden")
      && document.getElementById("f-host").value === "e2e-escape.example";`));

  // ── Trampa de Tab en los extremos ───────────────────────────────
  const trap = await app.exec(`
    const box = document.getElementById("modal-connection");
    const sel = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const list = [...box.querySelectorAll(sel)]
      .filter((el) => el.tabIndex >= 0 && el.getClientRects().length && !el.closest(".hidden"));
    const fire = (shift) => {
      const ev = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    list[list.length - 1].focus();
    const forward = fire(false) && document.activeElement === list[0];
    list[0].focus();
    const backward = fire(true) && document.activeElement === list[list.length - 1];
    return { forward, backward, count: list.length };
  `);
  check("Tab en el último control vuelve al primero y Shift+Tab en el primero al último",
    trap.forward && trap.backward, JSON.stringify(trap));

  // ── Atajos globales detrás del modal ────────────────────────────
  const tabsBefore = await app.exec('return document.querySelectorAll("#tabs-container .tab").length;');
  const ctrlW = await press("KeyW", "w", { ctrlKey: true });
  const ctrlComma = await press("Comma", ",", { ctrlKey: true });
  await settle();
  check("Ctrl+W y Ctrl+, no actúan detrás de un modal",
    !ctrlW && !ctrlComma && !(await visible("modal-prefs-overlay"))
    && await app.exec('return document.querySelectorAll("#tabs-container .tab").length;') === tabsBefore);
  const zoomIn = await press("Equal", "=", { ctrlKey: true, altKey: true });
  await press("Digit0", "0", { ctrlKey: true, altKey: true });
  check("el zoom de la interfaz sigue funcionando con un modal abierto", zoomIn);

  // ── Escape cierra y el foco vuelve ──────────────────────────────
  await press("Escape", "Escape");
  await app.waitFor("#modal-overlay.hidden");
  await settle();
  check("Escape cierra Nueva conexión y el foco vuelve a quien la abrió",
    await app.exec('return document.activeElement?.dataset?.e2eOpener === "1";'), `${opener} → ${await activeId()}`);
  await app.exec('document.querySelector("[data-e2e-opener]")?.removeAttribute("data-e2e-opener"); return true;');
  check("al cerrar el último diálogo el fondo deja de estar inerte",
    await app.exec('return document.getElementById("main-area").inert === false;'));

  // ── Diálogo hijo: Preferencias → known_hosts ────────────────────
  await press("Comma", ",", { ctrlKey: true });
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await settle();
  check("Preferencias recibe el foco en su pestaña activa",
    await app.exec('return document.activeElement?.classList.contains("prefs-nav-item") === true;'),
    await activeId());
  await app.jsClick('[data-prefs-tab="security"]');
  await app.exec('document.getElementById("btn-manage-known-hosts").focus(); return true;');
  await app.jsClick("#btn-manage-known-hosts");
  await app.waitFor("#known-hosts-overlay:not(.hidden)");
  await settle();
  check("con known_hosts abierto, Preferencias queda inerte por debajo",
    await app.exec(`return document.getElementById("modal-prefs-overlay").inert === true
      && document.getElementById("known-hosts-modal").contains(document.activeElement);`), await activeId());
  await press("Escape", "Escape");
  await app.waitFor("#known-hosts-overlay.hidden");
  await settle();
  check("Escape en known_hosts no cierra Preferencias y el foco vuelve a su botón",
    await visible("modal-prefs-overlay")
    && await app.exec('return document.activeElement?.id === "btn-manage-known-hosts";'), await activeId());

  // ── Confirmación destructiva ────────────────────────────────────
  await app.jsClick('[data-prefs-tab="shortcuts"]');
  await app.exec('document.getElementById("shortcuts-preset-select").value = "vim"; document.getElementById("btn-shortcuts-apply-preset").focus(); return true;');
  await app.jsClick("#btn-shortcuts-apply-preset");
  await app.waitFor("#credential-modal-overlay:not(.hidden)");
  await settle();
  check("una confirmación destructiva es alertdialog, lee su mensaje y empieza en Cancelar",
    await app.exec(`const box = document.getElementById("credential-modal");
      return box.getAttribute("role") === "alertdialog"
        && box.getAttribute("aria-describedby") === "credential-modal-message"
        && document.activeElement?.id === "btn-credential-cancel";`), await activeId());
  await press("Escape", "Escape");
  await app.waitFor("#credential-modal-overlay.hidden");
  await settle();
  check("Escape en la confirmación cancela sin cerrar Preferencias y devuelve el foco",
    await visible("modal-prefs-overlay")
    && await app.exec('return document.activeElement?.id === "btn-shortcuts-apply-preset";'), await activeId());
  await press("Escape", "Escape");
  await app.waitFor("#modal-prefs-overlay.hidden");
  await settle();
  check("Escape cierra Preferencias al final de la cadena", !(await visible("modal-prefs-overlay")));
}
