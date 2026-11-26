// Barra lateral en el WebView real: el chip de la búsqueda activa, el aspa que
// vuelve al workspace actual y las guías de nivel del árbol. Corre después de
// `tree.mjs`, que deja la carpeta `e2e-arbol` con una conexión dentro.
//
// Chip: una búsqueda escrita en el popover completo sigue filtrando al cerrarlo
// (así fue siempre); desde ahora la barra de contexto lo dice con el término y
// el recuento, y su aspa la quita. Guías: con la preferencia encendida (de
// serie) una carpeta abierta pinta su línea; apagada, no.
import { sleep } from "./webdriver.mjs";

const FOLDER = "e2e-arbol";
const settle = () => sleep(250);

export async function checkSidebarFilter(app, check) {
  const chip = () => app.exec(`
    const chip = document.getElementById("sidebar-filter-chip");
    return {
      visible: !!chip && !chip.classList.contains("hidden") && chip.getClientRects().length > 0,
      text: document.getElementById("sidebar-filter-text")?.textContent || "",
      count: document.getElementById("sidebar-filter-count")?.textContent || "",
      rows: document.querySelectorAll("#connection-list .conn-item").length,
    };
  `);
  const popoverOpen = () => app.exec('return !document.getElementById("sidebar-tools-popover").classList.contains("hidden");');

  // Búsqueda desde el popover completo y popover cerrado.
  await app.jsClick("#btn-sidebar-tools");
  await settle();
  await app.exec(`
    const input = document.getElementById("sidebar-search");
    input.value = "e2e-arbol-dentro";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await settle();
  check("con el popover abierto no sale el chip", !(await chip()).visible);
  await app.jsClick("#btn-sidebar-tools");
  await settle();
  let c = await chip();
  check("con el popover cerrado, el chip enseña la búsqueda que sigue filtrando y su recuento",
    !(await popoverOpen()) && c.visible && c.text.includes("e2e-arbol-dentro") && Number(c.count) >= 1 && c.rows >= 1,
    JSON.stringify(c));
  await app.jsClick("#btn-sidebar-filter-edit");
  await settle();
  const editing = await app.exec(`
    return { open: !document.getElementById("sidebar-tools-popover").classList.contains("hidden"),
      value: document.getElementById("sidebar-search").value };
  `);
  check("pulsar el término reabre el popover con la búsqueda", editing.open && editing.value === "e2e-arbol-dentro",
    JSON.stringify(editing));
  await app.jsClick("#btn-sidebar-tools");
  await settle();
  await app.jsClick("#btn-sidebar-filter-clear");
  await settle();
  c = await chip();
  const cleared = await app.exec('return { query: document.getElementById("sidebar-search").value, folder: !!document.querySelector(".folder-item[data-folder-path=\\"e2e-arbol\\"]") };');
  check("el aspa del chip quita el filtro y vuelve el árbol", !c.visible && cleared.query === "" && cleared.folder,
    JSON.stringify({ c, cleared }));

  // Aspa junto a «Todos los perfiles»: vuelve al workspace actual.
  await app.jsClick("#btn-sidebar-tools");
  await settle();
  await app.jsClick('[data-view-mode="all"]');
  await settle();
  await app.jsClick("#btn-sidebar-tools");
  await settle();
  const resetVisible = await app.exec('const b = document.getElementById("btn-sidebar-view-reset"); return !b.classList.contains("hidden") && b.getClientRects().length > 0;');
  await app.jsClick("#btn-sidebar-view-reset");
  await settle();
  const after = await app.exec(`
    return { mode: JSON.parse(localStorage.getItem("rustty-prefs")).sidebarViewMode,
      hidden: document.getElementById("btn-sidebar-view-reset").classList.contains("hidden") };
  `);
  check("fuera del workspace actual hay un aspa que vuelve a él", resetVisible && after.mode === "current" && after.hidden,
    JSON.stringify({ resetVisible, after }));

  // Guías de nivel: carpeta abierta → línea; preferencia apagada → sin línea.
  const folderSel = `.folder-item[data-folder-path="${FOLDER}"]`;
  const expanded = await app.exec('return document.querySelector(arguments[0])?.getAttribute("aria-expanded");', [folderSel]);
  if (expanded !== "true") {
    await app.jsClick(`${folderSel} > .folder-header`);
    await settle();
  }
  const guide = () => app.exec(`
    const children = document.querySelector(arguments[0] + " > .folder-children");
    if (!children) return null;
    const before = getComputedStyle(children, "::before");
    return { content: before.content, width: before.width, left: before.left };
  `, [folderSel]);
  const on = await guide();
  check("una carpeta abierta pinta su guía de nivel", !!on && on.content !== "none" && on.width === "1px", JSON.stringify(on));
  const toggleGuides = async () => {
    await app.jsClick("#btn-sidebar-tools");
    await settle();
    await app.jsClick("#btn-sidebar-tree-guides");
    await settle();
    await app.jsClick("#btn-sidebar-tools");
    await settle();
  };
  await toggleGuides();
  const off = await guide();
  const stored = await app.exec('return JSON.parse(localStorage.getItem("rustty-prefs")).sidebarTreeGuides;');
  check("apagar «Guías de nivel» las quita y se recuerda", stored === false && (!off || off.content === "none"),
    JSON.stringify({ off, stored }));
  await toggleGuides();
}
