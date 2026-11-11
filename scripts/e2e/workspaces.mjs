// Alcance del buscador de conexiones y orden de los perfiles (workspaces), en
// el WebView real.
//
//   - El selector de alcance de la barra lateral busca en el perfil actual, en
//     todos o en uno concreto; el valor se guarda (también el booleano antiguo
//     `searchAllWorkspaces`, para versiones anteriores) y el selector del inicio
//     lo refleja.
//   - Elegir en ese desplegable (su lista vive en <body>) no cierra el popover
//     de búsqueda ni borra lo escrito.
//   - Cada perfil de la lista trae su menú de opciones (clic derecho o «⋯»):
//     renombrar, mover, comprobar la salud, exportar, eliminar. Bajo la lista
//     ya no hay acciones sueltas que actúen «sobre el perfil activo».
//   - «Mover abajo» y Alt+↑ en la lista de perfiles cambian el orden guardado.
//   - Eliminar un perfil dice cuál es y pide teclear su nombre, también vacío.
import { sleep } from "./webdriver.mjs";

const shotDir = process.env.E2E_SHOT_DIR || "";
/** Captura opcional (`E2E_SHOT_DIR`): para mirar el resultado, no solo medirlo. */
const snap = async (app, name) => { if (shotDir) await app.screenshot(`${shotDir}/${name}.png`); };

const WS_B = { id: "e2e-ws-b", name: "E2E Trabajo" };
const WS_C = { id: "e2e-ws-c", name: "E2E Borrar" };
const IDS = { a: "e2e-scope-a", b: "e2e-scope-b" };

export async function checkWorkspaces(app, check, { shot } = {}) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const settle = () => sleep(250);

  // El perfil activo que haya (el smoke trabaja en el que trae la sincronización)
  // y uno nuevo; al final todo vuelve a como estaba.
  const original = await app.exec('return JSON.parse(localStorage.getItem("rustty-prefs") || "{}");');
  const activeId = original.activeWorkspaceId || "default";
  const all = await invoke("get_profiles");
  const make = (id, name, workspace) => ({
    id, name, host: "198.51.100.70", port: 22, username: "ana",
    connection_type: "ssh", auth_type: "password", workspace_id: workspace, group: null,
    created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z",
  });
  await invoke("save_profiles", {
    profiles: [
      ...all.filter((p) => p.id !== IDS.a && p.id !== IDS.b),
      make(IDS.a, "e2e-alcance-casa", activeId),
      make(IDS.b, "e2e-alcance-trabajo", WS_B.id),
    ],
  });
  await app.exec(`
    const prefs = JSON.parse(localStorage.getItem("rustty-prefs") || "{}");
    const list = (prefs.workspaces || [{ id: "default", name: "Default" }])
      .filter((w) => w.id !== arguments[0].id && w.id !== arguments[1].id);
    prefs.workspaces = [...list, arguments[0], arguments[1]];
    prefs.sidebarViewMode = "current";
    prefs.searchScope = "current";
    prefs.searchAllWorkspaces = false;
    localStorage.setItem("rustty-prefs", JSON.stringify(prefs));
    setTimeout(() => location.reload(), 50);
    return true;
  `, [WS_B, WS_C]);
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);

  const results = () => app.exec(`
    return [...document.querySelectorAll("#connection-list .conn-item")]
      .map((el) => el.dataset.id || el.dataset.treeKey || el.textContent.trim()).filter(Boolean);
  `);
  const storedPrefs = () => app.exec('return JSON.parse(localStorage.getItem("rustty-prefs") || "{}");');
  const setScope = (value) => app.exec(`
    const s = document.getElementById("sidebar-search-scope");
    s.value = arguments[0];
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `, [value]);

  // Abrir la búsqueda de la barra lateral y escribir. Con el inicio a la
  // vista, el botón de buscar enfoca el buscador del inicio: se abre el menú
  // de herramientas, que lleva el mismo campo y su selector de alcance.
  await app.jsClick("#btn-sidebar-tools");
  await app.waitFor("#sidebar-tools-popover:not(.hidden)");
  await app.exec(`
    const input = document.getElementById("sidebar-search");
    input.value = "e2e-alcance";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await sleep(400);
  const inCurrent = await results();
  check("con «Perfil actual» solo salen las conexiones del perfil activo",
    inCurrent.includes(IDS.a) && !inCurrent.includes(IDS.b), JSON.stringify(inCurrent));

  await setScope("all");
  await settle();
  const inAll = await results();
  check("con «Todos los perfiles» salen las de todos",
    inAll.includes(IDS.a) && inAll.includes(IDS.b), JSON.stringify(inAll));

  await setScope(`ws:${WS_B.id}`);
  await settle();
  const inB = await results();
  const saved = await storedPrefs();
  check("con un perfil concreto solo salen las suyas, aunque no sea el activo",
    !inB.includes(IDS.a) && inB.includes(IDS.b), JSON.stringify(inB));
  check("el alcance se guarda (y el booleano antiguo queda coherente)",
    saved.searchScope === `ws:${WS_B.id}` && saved.searchAllWorkspaces === false, JSON.stringify({ s: saved.searchScope, a: saved.searchAllWorkspaces }));
  check("el selector del inicio refleja el mismo alcance",
    await app.exec('return document.getElementById("dashboard-search-scope").value === arguments[0];', [`ws:${WS_B.id}`]));
  if (shot) await shot("search-scope");

  // Elegir con el ratón en la lista del desplegable propio no cierra el popover.
  const listPick = await app.exec(`
    const display = document.getElementById("sidebar-search-scope-combobox");
    if (!display) return { skipped: true };
    display.click();
    const list = document.getElementById("sidebar-search-scope-listbox");
    const option = [...list.querySelectorAll('[role="option"]')][1];
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { skipped: false };
  `);
  await settle();
  if (!listPick.skipped) {
    check("elegir en la lista del alcance no cierra la búsqueda ni la borra",
      await app.exec(`return !document.getElementById("sidebar-tools-popover").classList.contains("hidden")
        && document.getElementById("sidebar-search").value === "e2e-alcance";`));
  }
  await setScope("current");
  await app.exec(`
    const input = document.getElementById("sidebar-search");
    input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await app.jsClick("#btn-sidebar-tools");
  await settle();

  // ── Orden de los perfiles ───────────────────────────────────────
  const order = async () => (await storedPrefs()).workspaces.map((w) => w.id);
  await app.jsClick("#btn-sidebar-tools");
  await app.waitFor("#sidebar-tools-popover:not(.hidden)");
  await settle();
  // Bajo la lista solo queda «Nuevo perfil…»: nada de renombrar/eliminar sueltos.
  const loose = await app.exec(`
    return [...document.querySelectorAll("#workspace-menu [data-ws-action]")]
      .map((b) => b.dataset.wsAction).filter((a) => a !== "select" && a !== "new");
  `);
  check("bajo la lista de perfiles ya no hay acciones sueltas (solo «Nuevo perfil…»)",
    loose.length === 0, JSON.stringify(loose));

  /** Clic derecho sobre un perfil de la lista. */
  const openWsMenu = async (id) => {
    await app.exec(`
      const row = document.querySelector('#workspace-menu .ws-row[data-ws-id="' + arguments[0] + '"]');
      const r = row.getBoundingClientRect();
      row.querySelector(".ws-item").dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8,
      }));
      return true;
    `, [id]);
    await app.waitFor("#context-menu:not(.hidden)");
    await settle();
  };
  const menuEntries = () => app.exec(`
    const shown = (el) => !el.classList.contains("hidden") && el.offsetParent !== null;
    return [...document.querySelectorAll("#context-menu [data-ctx]")].filter(shown)
      .map((b) => b.dataset.ctx + (b.disabled ? ":off" : ""));
  `);
  const popoverOpen = () => app.exec('return !document.getElementById("sidebar-tools-popover").classList.contains("hidden");');

  await openWsMenu(WS_B.id);
  await snap(app, "perfil-menu");
  const entries = await menuEntries();
  check("el clic derecho sobre un perfil abre su menú: renombrar, mover, salud, exportar y eliminar",
    ["rename-ws", "health-ws", "export-ws", "delete-ws"].every((e) => entries.includes(e))
      && entries.some((e) => e.startsWith("move-ws-up")) && entries.some((e) => e.startsWith("move-ws-down"))
      && !entries.includes("connect") && !entries.includes("delete-conn"),
    entries.join(","));
  await app.exec(`
    (document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  `);
  await settle();
  check("Escape cierra el menú del perfil y deja abierta la lista",
    await app.exec('return document.getElementById("context-menu").classList.contains("hidden");') && await popoverOpen());

  await app.jsClick(`#workspace-menu .ws-more[data-ws-id="${WS_B.id}"]`);
  await settle();
  const viaMore = await app.exec(`
    const menu = document.getElementById("context-menu");
    const btn = document.querySelector('#workspace-menu .ws-more[data-ws-id="${WS_B.id}"]');
    return { open: !menu.classList.contains("hidden"), label: btn.getAttribute("aria-label") || "" };
  `);
  check("el botón «⋯» de cada perfil abre el mismo menú y dice de qué perfil es",
    viaMore.open && viaMore.label.includes(WS_B.name), JSON.stringify(viaMore));
  await app.exec('document.body.click(); return true;');
  await settle();

  const before = await order();
  const canDown = before.indexOf(activeId) < before.length - 1;
  await openWsMenu(activeId);
  await app.jsClick(`#context-menu [data-ctx="${canDown ? "move-ws-down" : "move-ws-up"}"]`);
  await settle();
  const afterDown = await order();
  check("«Mover abajo/arriba» del menú del perfil lo mueve una posición",
    afterDown.indexOf(activeId) === before.indexOf(activeId) + (canDown ? 1 : -1), `${before} → ${afterDown}`);
  check("la lista sigue abierta y con el orden nuevo",
    await popoverOpen() && await app.exec(`return [...document.querySelectorAll('#workspace-menu .ws-item[data-ws-action="select"]')]
      .map((b) => b.dataset.wsId).join() === arguments[0];`, [afterDown.join()]));
  const altBack = await app.exec(`
    const item = document.querySelector('#workspace-menu .ws-item[data-ws-id="' + arguments[0] + '"]');
    item.focus();
    const key = arguments[1] ? "ArrowUp" : "ArrowDown";
    const ev = new KeyboardEvent("keydown", { key, code: key, altKey: true, bubbles: true, cancelable: true });
    item.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, focus: document.activeElement?.dataset?.wsId || null };
  `, [activeId, canDown]);
  await settle();
  const afterBack = await order();
  check("Alt+↑/↓ sobre un perfil de la lista lo devuelve a su sitio y el foco lo acompaña",
    afterBack.join() === before.join() && altBack.prevented && altBack.focus === activeId,
    `${afterBack} ${JSON.stringify(altBack)}`);
  if (shot) await shot("workspace-menu");

  // ── Eliminar un perfil: dice cuál y pide teclear su nombre ──────
  const dialog = () => app.exec(`
    const overlay = document.getElementById("credential-modal-overlay");
    return {
      open: !overlay.classList.contains("hidden"),
      message: document.getElementById("credential-modal-message").textContent,
      label: document.getElementById("credential-modal-label").textContent,
      submitOff: document.getElementById("btn-credential-submit").disabled,
    };
  `);
  const typeName = (value) => app.exec(`
    const input = document.getElementById("credential-modal-input");
    input.value = arguments[0];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return document.getElementById("btn-credential-submit").disabled;
  `, [value]);

  // Con conexiones: nombra el perfil y avisa de lo que se lleva. Se cancela.
  await openWsMenu(WS_B.id);
  await app.jsClick('#context-menu [data-ctx="delete-ws"]');
  await app.waitFor("#credential-modal-overlay:not(.hidden)");
  await settle();
  await snap(app, "perfil-eliminar");
  const askB = await dialog();
  check("eliminar un perfil con conexiones dice qué perfil es y pide teclear su nombre",
    askB.message.includes(WS_B.name) && askB.label.includes(WS_B.name) && askB.submitOff, JSON.stringify(askB));
  check("al pedir la confirmación, la lista de perfiles se cierra", !(await popoverOpen()));
  check("con otro nombre, «Eliminar» sigue apagado", await typeName("E2E Otro") === true);
  await app.jsClick("#btn-credential-cancel");
  await settle();
  check("cancelar no elimina el perfil", (await order()).includes(WS_B.id));

  // Vacío: también se nombra y también hay que teclearlo.
  await app.jsClick("#btn-sidebar-tools");
  await app.waitFor("#sidebar-tools-popover:not(.hidden)");
  await settle();
  await openWsMenu(WS_C.id);
  await app.jsClick('#context-menu [data-ctx="delete-ws"]');
  await app.waitFor("#credential-modal-overlay:not(.hidden)");
  await settle();
  const askC = await dialog();
  check("eliminar un perfil vacío también dice cuál es y pide su nombre",
    askC.message.includes(WS_C.name) && askC.submitOff, JSON.stringify(askC));
  const offAfterName = await typeName(WS_C.name);
  await app.jsClick("#btn-credential-submit");
  await settle();
  const afterDelete = await order();
  check("al teclear el nombre se enciende «Eliminar» y el perfil desaparece",
    offAfterName === false && !afterDelete.includes(WS_C.id) && afterDelete.includes(WS_B.id), `${afterDelete}`);
  // Fuera de la papelera, para no dejar rastro en el resto del smoke.
  await app.exec(`
    const key = "rustty.trash.v1";
    const kept = JSON.parse(localStorage.getItem(key) || "[]").filter((e) => !JSON.stringify(e).includes(arguments[0]));
    localStorage.setItem(key, JSON.stringify(kept));
    return true;
  `, [WS_C.id]);
  if (await popoverOpen()) await app.jsClick("#btn-sidebar-tools");
  await settle();

  // Limpieza: fuera las conexiones y el perfil de prueba, y las preferencias
  // tocadas vuelven a su valor (el resto del smoke cuenta con ellas).
  await invoke("delete_profiles", { ids: [IDS.a, IDS.b] });
  await app.exec(`
    const prefs = JSON.parse(localStorage.getItem("rustty-prefs") || "{}");
    const o = arguments[0];
    prefs.workspaces = (prefs.workspaces || []).filter((w) => w.id !== arguments[1] && w.id !== arguments[2]);
    prefs.activeWorkspaceId = o.activeWorkspaceId ?? prefs.activeWorkspaceId;
    prefs.sidebarViewMode = o.sidebarViewMode ?? "current";
    prefs.searchScope = o.searchScope ?? null;
    prefs.searchAllWorkspaces = o.searchAllWorkspaces ?? true;
    localStorage.setItem("rustty-prefs", JSON.stringify(prefs));
    setTimeout(() => location.reload(), 50);
    return true;
  `, [original, WS_B.id, WS_C.id]);
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);
}
