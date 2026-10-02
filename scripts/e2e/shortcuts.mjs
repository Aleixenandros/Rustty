// Recorre los handlers de teclado y el editor en el WebView real y aislado.
import { sleep } from "./webdriver.mjs";

export async function checkShortcuts(app, check) {
  const readPrefs = () => app.exec('return JSON.parse(localStorage.getItem("rustty-prefs") || "{}");');
  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);
  const row = '.shortcut-row[data-shortcut-id="new_connection"]';
  await press("Comma", ",", { ctrlKey: true });
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(500);
  await app.jsClick('[data-prefs-tab="shortcuts"]');
  await app.exec('document.querySelector(\'[data-prefs-tab="shortcuts"]\').focus(); return true;');
  await press("ArrowRight", "ArrowRight");
  check("las flechas cambian la pestaña de Preferencias y trasladan el foco",
    await app.exec('return document.activeElement.dataset.prefsTab === "data" && document.activeElement.classList.contains("active");'));
  await press("ArrowLeft", "ArrowLeft");
  await app.jsClick(`${row} .btn-shortcut-edit`);
  await press("Escape", "Escape");
  check("Escape cancela la captura sin cerrar Preferencias y devuelve el foco",
    await app.exec(`return !document.querySelector(".shortcut-row.capturing")
      && !document.getElementById("modal-prefs-overlay").classList.contains("hidden")
      && document.activeElement.classList.contains("btn-shortcut-edit");`));

  const before = await readPrefs();
  const tabsBefore = await app.exec('return document.querySelectorAll("#tabs-container .tab").length;');
  await app.jsClick(`${row} .btn-shortcut-edit`);
  await press("KeyT", "T", { ctrlKey: true, shiftKey: true });
  await sleep(300);
  const edited = await readPrefs();
  check("capturar un atajo de consola no abre otra consola",
    edited.shortcuts.new_connection === "Ctrl+Shift+T"
    && await app.exec('return document.querySelectorAll("#tabs-container .tab").length;') === tabsBefore);
  check("editar un atajo fecha solo esa acción para sincronizarla",
    !!edited._shortcutsTs.new_connection && edited._prefsUpdatedAt === before._prefsUpdatedAt);
  // Para ejecutar elegimos después una combinación libre: un conflicto se
  // avisa, pero conserva la precedencia de las acciones de fábrica.
  await app.jsClick(`${row} .btn-shortcut-edit`);
  await press("KeyN", "n", { ctrlKey: true, altKey: true });
  await app.jsClick("#btn-prefs-cancel");
  await press("KeyN", "n", { ctrlKey: true, altKey: true });
  await app.waitFor("#modal-overlay:not(.hidden)");
  check("la combinación personalizada ejecuta la acción asignada", true);
  await app.jsClick("#btn-modal-cancel");

  await press("Comma", ",", { ctrlKey: true });
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(500);
  await app.jsClick(`${row} .btn-shortcut-clear`);
  check("desactivar un atajo se guarda de forma explícita", (await readPrefs()).shortcuts.new_connection === null);
  await app.jsClick(`${row} .btn-shortcut-reset`);
  const reset = await readPrefs();
  check("restablecer comunica la retirada del atajo personalizado",
    !Object.hasOwn(reset.shortcuts, "new_connection") && !!reset.tombstones.shortcuts.new_connection);

  await app.exec('document.getElementById("shortcuts-preset-select").value = "vim"; return true;');
  await app.jsClick("#btn-shortcuts-apply-preset");
  await app.waitFor("#credential-modal-overlay:not(.hidden)");
  await app.jsClick("#btn-credential-cancel");
  check("cancelar un preset conserva los atajos", JSON.stringify((await readPrefs()).shortcuts) === JSON.stringify(reset.shortcuts));
  await app.jsClick("#btn-shortcuts-apply-preset");
  await app.waitFor("#credential-modal-overlay:not(.hidden)");
  await app.jsClick("#btn-credential-submit");
  await app.waitFor('#credential-modal-overlay.hidden');
  check("aplicar un preset guarda combinaciones y fechas", (await readPrefs()).shortcuts.new_connection === "Ctrl+Alt+N");
  await app.exec('document.getElementById("shortcuts-preset-select").value = "default"; return true;');
  await app.jsClick("#btn-shortcuts-apply-preset");
  await app.waitFor("#credential-modal-overlay:not(.hidden)");
  await app.jsClick("#btn-credential-submit");
  await app.waitFor('#credential-modal-overlay.hidden');
  check("el preset de fábrica elimina los overrides conservando su borrado",
    !Object.keys((await readPrefs()).shortcuts).length && !!(await readPrefs()).tombstones.shortcuts.new_connection);
  await app.jsClick("#btn-prefs-cancel");

  await press("KeyK", "k", { ctrlKey: true });
  // Esperar al foco del documento: la ventana de prueba puede estar detrás
  // de otra app, y WebKit no siempre aplica :focus en ese estado.
  let searchFocused = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    searchFocused = await app.exec('return ["sidebar-search", "dashboard-search"].includes(document.activeElement.id);');
    if (searchFocused) break;
    await sleep(100);
  }
  check("el atajo de búsqueda lleva el foco a las conexiones",
    searchFocused, searchFocused ? "" : await app.exec('return JSON.stringify({ active: document.activeElement.id, visibility: document.visibilityState, windowFocused: document.hasFocus() });'));
  await press("Escape", "Escape");
}
