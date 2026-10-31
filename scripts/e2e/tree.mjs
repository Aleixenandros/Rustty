// Árbol de conexiones con el teclado (`modules/tree-nav.js` + la sección
// «Árbol de conexiones: teclado» de main.js) en el WebView real.
//
// Comprueba el patrón de árbol: una sola parada de Tab (la fila enfocada lleva
// el único tabindex 0), → despliega una carpeta y ↓ baja a su conexión, ←
// vuelve a la carpeta, un repintado de la lista (marcar favorito) deja el foco
// en la misma fila, y Shift+F10 abre el menú contextual sobre la fila y Escape
// devuelve el foco. Como en `dialogs.mjs`, los eventos de teclado son
// sintéticos: se prueba lo que hace el manejador del árbol, no la acción
// nativa del navegador.
import { sleep } from "./webdriver.mjs";

const IDS = { inFolder: "e2e-tree-in", root: "e2e-tree-root" };
const FOLDER = "e2e-arbol";

/** El árbol reacciona en el mismo tick; el repintado y el menú, en microtareas. */
const settle = () => sleep(200);

export async function checkTree(app, check) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const all = await invoke("get_profiles");
  const base = all.find((p) => p.id === "e2e-sync") || all[0];
  if (!base) throw new Error("falta un perfil de partida para probar el árbol");
  const make = (id, over) => ({
    ...base,
    id,
    port: 22,
    username: "ana",
    connection_type: "ssh",
    auth_type: "password",
    password_source: "own",
    keepass_entry_uuid: null,
    master_credential_id: null,
    extra_credentials: [],
    ssh_tunnels: [],
    proxy_jump: null,
    ...over,
  });
  await invoke("save_profiles", {
    profiles: [
      ...all.filter((p) => p.id !== IDS.inFolder && p.id !== IDS.root),
      make(IDS.inFolder, { name: "e2e-arbol-dentro", host: "198.51.100.60", group: FOLDER }),
      make(IDS.root, { name: "e2e-arbol-raiz", host: "198.51.100.61", group: null }),
    ],
  });
  await app.exec("setTimeout(() => location.reload(), 50); return true;");
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);

  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);
  const activeKey = () => app.exec(`
    const a = document.activeElement;
    return a ? (a.dataset.treeKey || a.id || a.className || a.tagName) : null;
  `);

  // Vista del workspace actual, sin búsqueda, con la carpeta de prueba plegada.
  await app.exec(`
    document.querySelector('[data-view-mode="current"]')?.click();
    const input = document.getElementById("sidebar-search");
    if (input && input.value) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
    return true;
  `);
  await settle();
  const folderSel = `#connection-list .folder-item[data-folder-path="${FOLDER}"]`;
  await app.waitFor(folderSel);
  const prepared = await app.exec(`
    const folder = document.querySelector(arguments[0]);
    if (folder.getAttribute("aria-expanded") === "true") folder.querySelector(":scope > .folder-header").click();
    folder.focus();
    const rows = [...document.querySelectorAll("#connection-list [data-tree-key]")];
    return {
      focused: document.activeElement === folder,
      level: folder.getAttribute("aria-level"),
      label: document.getElementById(folder.getAttribute("aria-labelledby") || "")?.textContent,
      tabStops: rows.filter((r) => r.getAttribute("tabindex") === "0").length,
      actionStops: [...document.querySelectorAll('#connection-list .conn-item [data-action]')]
        .filter((b) => b.getAttribute("tabindex") === "0").length,
      expanded: folder.getAttribute("aria-expanded"),
    };
  `, [folderSel]);
  check("la carpeta se enfoca y lleva el único tabindex 0 del árbol, con su nombre como etiqueta",
    prepared.focused && prepared.tabStops === 1 && prepared.actionStops === 0
      && prepared.level === "1" && prepared.label === FOLDER && prepared.expanded === "false",
    JSON.stringify(prepared));

  // → despliega; ↓ baja a la conexión de dentro.
  const right = await press("ArrowRight", "ArrowRight");
  await settle();
  const afterRight = await app.exec(`
    const folder = document.querySelector(arguments[0]);
    return { expanded: folder.getAttribute("aria-expanded"),
      childrenShown: !folder.querySelector(":scope > .folder-children").classList.contains("hidden"),
      focus: document.activeElement === folder };
  `, [folderSel]);
  check("→ despliega la carpeta enfocada sin mover el foco",
    right && afterRight.expanded === "true" && afterRight.childrenShown && afterRight.focus, JSON.stringify(afterRight));
  await press("ArrowDown", "ArrowDown");
  await settle();
  const onConn = await app.exec(`
    const a = document.activeElement;
    const row = document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"]');
    return { isRow: a === row, tabindex: row?.getAttribute("tabindex"), level: row?.getAttribute("aria-level"),
      selected: row?.classList.contains("selected"),
      actionStops: row ? [...row.querySelectorAll("[data-action]")].filter((b) => b.getAttribute("tabindex") === "0").length : -1,
      stops: [...document.querySelectorAll("#connection-list [data-tree-key]")].filter((r) => r.getAttribute("tabindex") === "0").length };
  `, [IDS.inFolder]);
  check("↓ llega a la conexión de la carpeta, que pasa a ser la parada de Tab (con sus acciones) y queda seleccionada",
    onConn.isRow && onConn.tabindex === "0" && onConn.level === "2" && onConn.selected
      && onConn.actionStops === 3 && onConn.stops === 1, JSON.stringify(onConn));

  // Repintado: marcar favorito desde el botón de la fila reconstruye la lista.
  await app.exec(`document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"] [data-action="toggle-favorite"]').click(); return true;`, [IDS.inFolder]);
  await settle();
  const afterRepaint = await app.exec(`
    const row = document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"]');
    return { isRow: document.activeElement === row, fav: !!row?.querySelector(".conn-fav.on"),
      tabindex: row?.getAttribute("tabindex") };
  `, [IDS.inFolder]);
  check("tras repintar la lista (favorito) el foco sigue en la misma fila",
    afterRepaint.isRow && afterRepaint.fav && afterRepaint.tabindex === "0", JSON.stringify(afterRepaint));
  await app.exec(`document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"] [data-action="toggle-favorite"]').click(); return true;`, [IDS.inFolder]);
  await settle();

  // Shift+F10: menú contextual sobre la fila; Escape lo cierra y devuelve el foco.
  await app.exec('document.getElementById("context-menu").classList.add("hidden"); return true;');
  const shiftF10 = await press("F10", "F10", { shiftKey: true });
  await app.waitFor("#context-menu:not(.hidden)");
  await settle();
  const menu = await app.exec(`
    const row = document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"]');
    const r = row.getBoundingClientRect();
    const m = document.getElementById("context-menu").getBoundingClientRect();
    const vis = (sel) => { const el = document.querySelector(sel); return !!el && !el.classList.contains("hidden"); };
    // El menú se abre en un punto de la fila; si no cabe hacia abajo, el
    // posicionador lo recoloca, pero ese punto sigue quedando dentro del menú.
    const x = r.left + Math.min(28, r.width / 2);
    const y = r.top + r.height / 2;
    return { nearRow: m.left - 2 <= x && x <= m.right + 2 && m.top - 2 <= y && y <= m.bottom + 2,
      row: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      menu: [Math.round(m.left), Math.round(m.top), Math.round(m.width), Math.round(m.height)],
      connItems: vis('#context-menu [data-ctx="edit-conn"]') && vis('#context-menu [data-ctx="toggle-favorite"]'),
      folderItems: vis('#context-menu [data-ctx="rename-folder"]'),
      focusInMenu: document.getElementById("context-menu").contains(document.activeElement) };
  `, [IDS.inFolder]);
  check("Shift+F10 abre el menú contextual de la conexión sobre su fila y lleva el foco dentro",
    shiftF10 && menu.nearRow && menu.connItems && !menu.folderItems && menu.focusInMenu, JSON.stringify(menu));
  await press("Escape", "Escape");
  await app.waitFor("#context-menu.hidden");
  await settle();
  check("Escape cierra el menú y el foco vuelve a la fila",
    (await activeKey()) === IDS.inFolder, String(await activeKey()));

  // ← sube a la carpeta; Enter la pliega.
  await press("ArrowLeft", "ArrowLeft");
  await settle();
  check("← desde la conexión sube a su carpeta", (await activeKey()) === `folder:default|${FOLDER}`
    || (await app.exec('return document.activeElement?.dataset?.folderPath;')) === FOLDER, String(await activeKey()));
  await press("Enter", "Enter");
  await settle();
  const collapsed = await app.exec(`
    const folder = document.querySelector(arguments[0]);
    return { expanded: folder.getAttribute("aria-expanded"), focus: document.activeElement === folder };
  `, [folderSel]);
  check("Enter en la carpeta la pliega sin perder el foco", collapsed.expanded === "false" && collapsed.focus, JSON.stringify(collapsed));

  // Búsqueda tecleando: la primera letra del perfil de la raíz salta a él.
  await press("KeyE", "e");
  await press("Digit2", "2");
  await press("KeyE", "e");
  await press("Minus", "-");
  await press("KeyA", "a");
  await press("KeyR", "r");
  await press("KeyB", "b");
  await press("KeyO", "o");
  await press("KeyL", "l");
  await press("Minus", "-");
  await press("KeyR", "r");
  await settle();
  check("teclear el nombre salta a la conexión que empieza por él",
    (await activeKey()) === IDS.root, String(await activeKey()));
}
