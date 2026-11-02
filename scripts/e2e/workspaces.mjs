// Alcance del buscador de conexiones y orden de los perfiles (workspaces), en
// el WebView real.
//
//   - El selector de alcance de la barra lateral busca en el perfil actual, en
//     todos o en uno concreto; el valor se guarda (también el booleano antiguo
//     `searchAllWorkspaces`, para versiones anteriores) y el selector del inicio
//     lo refleja.
//   - Elegir en ese desplegable (su lista vive en <body>) no cierra el popover
//     de búsqueda ni borra lo escrito.
//   - «Bajar perfil» y Alt+↑ en la lista de perfiles cambian el orden guardado.
import { sleep } from "./webdriver.mjs";

const WS_B = { id: "e2e-ws-b", name: "E2E Trabajo" };
const IDS = { a: "e2e-scope-a", b: "e2e-scope-b" };

export async function checkWorkspaces(app, check, { shot } = {}) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const settle = () => sleep(250);

  // Dos perfiles con una conexión cada uno y nombres que comparten la búsqueda.
  const all = await invoke("get_profiles");
  const make = (id, name, workspace) => ({
    id, name, host: "198.51.100.70", port: 22, username: "ana",
    connection_type: "ssh", auth_type: "password", workspace_id: workspace, group: null,
    created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z",
  });
  await invoke("save_profiles", {
    profiles: [
      ...all.filter((p) => p.id !== IDS.a && p.id !== IDS.b),
      make(IDS.a, "e2e-alcance-casa", "default"),
      make(IDS.b, "e2e-alcance-trabajo", WS_B.id),
    ],
  });
  await app.exec(`
    const prefs = JSON.parse(localStorage.getItem("rustty-prefs") || "{}");
    const list = (prefs.workspaces || [{ id: "default", name: "Default" }]).filter((w) => w.id !== arguments[0].id);
    prefs.workspaces = [...list, arguments[0]];
    prefs.activeWorkspaceId = "default";
    prefs.sidebarViewMode = "current";
    prefs.searchScope = "current";
    prefs.searchAllWorkspaces = false;
    localStorage.setItem("rustty-prefs", JSON.stringify(prefs));
    setTimeout(() => location.reload(), 50);
    return true;
  `, [WS_B]);
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
  const before = await order();
  await app.jsClick('#workspace-menu .ws-item[data-ws-action="move-down"]');
  await settle();
  const afterDown = await order();
  check("«Bajar perfil» mueve el perfil activo una posición",
    afterDown.indexOf("default") === before.indexOf("default") + 1, `${before} → ${afterDown}`);
  check("la lista del menú sigue el orden nuevo",
    await app.exec(`return [...document.querySelectorAll('#workspace-menu .ws-item[data-ws-action="select"]')]
      .map((b) => b.dataset.wsId).join() === arguments[0];`, [afterDown.join()]));
  const altUp = await app.exec(`
    const item = document.querySelector('#workspace-menu .ws-item[data-ws-id="default"]');
    item.focus();
    const ev = new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", altKey: true, bubbles: true, cancelable: true });
    item.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, focus: document.activeElement?.dataset?.wsId || null };
  `);
  await settle();
  const afterUp = await order();
  check("Alt+↑ sobre un perfil de la lista lo sube y el foco lo acompaña",
    afterUp.join() === before.join() && altUp.prevented && altUp.focus === "default",
    `${afterUp} ${JSON.stringify(altUp)}`);
  if (shot) await shot("workspace-menu");
  await app.jsClick("#btn-sidebar-tools");
  await settle();
}
