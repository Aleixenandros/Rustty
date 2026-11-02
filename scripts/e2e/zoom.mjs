// Zoom de la interfaz distinto de 100 % (en el WebView real): los menús
// contextuales salen donde se hizo clic y escalados, la lista de un
// desplegable queda pegada a su control y Preferencias cabe en la ventana.
// Antes los menús flotantes, el popover de pestañas y los avisos se quedaban a
// tamaño 1 y los topes en `vh`/`vw` de los diálogos se multiplicaban por el
// zoom.
import { sleep } from "./webdriver.mjs";

export async function zoomFloating(app, check, { shot } = {}) {
  await app.exec(`const p = JSON.parse(localStorage.getItem("rustty-prefs") || "{}"); p.uiZoom = 1.4; localStorage.setItem("rustty-prefs", JSON.stringify(p)); setTimeout(() => location.reload(), 50); return true;`);
  await sleep(2000); await app.waitForApp(); await sleep(1200);
  // Menú contextual del área vacía de la barra lateral.
  const ctx = await app.exec(`
    const list = document.getElementById("connection-list");
    const r = list.getBoundingClientRect();
    const x = Math.round(r.left + 40), y = Math.round(r.top + 200);
    list.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    const m = document.getElementById("context-menu");
    const mr = m.getBoundingClientRect();
    const item = m.querySelector(".ctx-item:not(.hidden)");
    return { x, y, left: Math.round(mr.left), top: Math.round(mr.top), font: item ? getComputedStyle(item).fontSize : null, itemH: item ? Math.round(item.getBoundingClientRect().height) : 0, hidden: m.classList.contains("hidden") };
  `);
  check("con zoom 140 %, el menú contextual sale donde se hizo clic", !ctx.hidden && Math.abs(ctx.left - ctx.x) <= 2 && Math.abs(ctx.top - ctx.y) <= 2, JSON.stringify(ctx));
  check("y sus filas van escaladas (más altas que a zoom 1)", ctx.itemH >= 36, JSON.stringify(ctx));
  if (shot) await shot("zoom-ctx");
  await app.exec(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.body.click(); return true;`);
  await sleep(300);
  // Desplegable dentro de Preferencias.
  await app.jsClick("#rail-btn-settings");
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(600);
  const sel = await app.exec(`
    const d = document.getElementById("pref-tab-wheel-combobox");
    d.scrollIntoView({ block: "center" });
    d.click();
    const l = document.getElementById("pref-tab-wheel-listbox");
    const dr = d.getBoundingClientRect(), lr = l.getBoundingClientRect();
    return { dLeft: Math.round(dr.left), dBottom: Math.round(dr.bottom), dW: Math.round(dr.width), lLeft: Math.round(lr.left), lTop: Math.round(lr.top), lW: Math.round(lr.width), lBottom: Math.round(lr.bottom), hidden: l.classList.contains("hidden") };
  `);
  const below = Math.abs(sel.lTop - (sel.dBottom + 4 * 1.4)) <= 3;
  const above = Math.abs(sel.lBottom - (sel.dBottom - 0)) > 0 && sel.lBottom <= sel.dBottom;
  check("con zoom, la lista del desplegable queda pegada a su control y con su ancho", !sel.hidden && Math.abs(sel.lLeft - sel.dLeft) <= 2 && sel.lW >= sel.dW - 2 && (below || above), JSON.stringify(sel));
  if (shot) await shot("zoom-select");
  await app.exec(`document.getElementById("pref-tab-wheel-combobox").click(); return true;`);
  await app.jsClick("#btn-prefs-cancel");
  await app.exec(`const p = JSON.parse(localStorage.getItem("rustty-prefs") || "{}"); p.uiZoom = 1; localStorage.setItem("rustty-prefs", JSON.stringify(p)); return true;`);
}
export async function zoomDialogs(app, check, { shot } = {}) {
  await app.exec(`const p = JSON.parse(localStorage.getItem("rustty-prefs") || "{}"); p.uiZoom = 1.4; localStorage.setItem("rustty-prefs", JSON.stringify(p)); localStorage.removeItem("rustty-dialog-frame-prefs"); setTimeout(() => location.reload(), 50); return true;`);
  await sleep(2000); await app.waitForApp(); await sleep(1200);
  await app.jsClick("#rail-btn-settings");
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(600);
  const r = await app.exec(`const r = document.getElementById("modal-prefs").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight };`);
  check("con zoom 140 %, Preferencias cabe entera en la ventana", r.top >= 0 && r.bottom <= r.vh && r.left >= 0 && r.right <= r.vw, JSON.stringify(r));
  if (shot) await shot("zoom-prefs");
  await app.jsClick("#btn-prefs-cancel");
  // Volver a zoom 1 de verdad (recargando) para no arrastrarlo al resto.
  await app.exec(`const p = JSON.parse(localStorage.getItem("rustty-prefs") || "{}"); p.uiZoom = 1; localStorage.setItem("rustty-prefs", JSON.stringify(p)); setTimeout(() => location.reload(), 50); return true;`);
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);
}
