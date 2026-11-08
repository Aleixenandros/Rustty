// Tabla de procesos del monitor de recursos, en el WebView real, sobre la
// consola local (en Linux muestrea este equipo).
//
//   - El filtro, el orden y la pausa viven en la sesión: el buscador no se
//     recrea con cada muestra (conserva foco, texto y cursor) y las filas
//     siguen filtradas tras los refrescos.
//   - Las cabeceras ordenan y dicen el sentido con `aria-sort`.
//   - «Pausar refresco» congela la tabla aunque sigan llegando muestras.
// Terminar un proceso no se prueba aquí: en la consola local no se ofrece.
import { sleep } from "./webdriver.mjs";

/** Filas visibles de la tabla: PID, usuario y comando. */
const ROWS = `
  return [...document.querySelectorAll(".metrics-panel .metrics-proc-table tbody tr")]
    .filter((tr) => tr.querySelector(".metrics-proc-pid"))
    .map((tr) => ({
      pid: Number(tr.querySelector(".metrics-proc-pid").textContent),
      user: tr.querySelector(".metrics-proc-user")?.textContent || "",
      cmd: tr.querySelector(".metrics-proc-cmd")?.textContent || "",
    }));
`;

export async function checkMetricsPanel(app, check, { shot } = {}) {
  const linux = await app.exec("return /linux/i.test(navigator.platform || '');");
  if (!linux) {
    console.log("  --   fuera de Linux no hay monitor local: se salta la tabla de procesos");
    return;
  }
  await app.jsClick("#home-tab");
  await sleep(300);
  await app.jsClick("#btn-welcome-local");
  await app.waitFor("#status-bar:not(.hidden)", 20000);
  await sleep(800);
  await app.jsClick("#status-metrics-expand");
  let rows = [];
  for (let i = 0; i < 30 && rows.length < 2; i++) {
    await sleep(500);
    rows = await app.exec(ROWS);
  }
  check("el panel de recursos enseña la tabla de procesos de este equipo", rows.length >= 2, JSON.stringify(rows.slice(0, 3)));
  if (rows.length < 2) return;
  check("cada proceso trae su usuario", rows.every((r) => r.user.length > 0), JSON.stringify(rows.slice(0, 3)));

  // Filtro: se escribe, llegan dos muestras y el buscador sigue siendo el
  // mismo elemento, con el foco y lo escrito.
  const needle = rows[0].cmd.slice(0, 4).toLowerCase();
  await app.exec(`
    const input = document.querySelector(".metrics-panel .metrics-proc-filter");
    input.__e2e = true;
    input.focus();
    input.value = arguments[0];
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `, [needle]);
  await sleep(7000);
  const filtered = await app.exec(`
    const input = document.querySelector(".metrics-panel .metrics-proc-filter");
    return {
      same: !!input?.__e2e,
      focused: document.activeElement === input,
      value: input?.value,
      caret: input?.selectionStart,
      count: document.querySelector(".metrics-panel .metrics-procs-count")?.textContent || "",
    };
  `);
  rows = await app.exec(ROWS);
  check("el buscador sobrevive a los refrescos con su foco, su texto y su cursor",
    filtered.same && filtered.focused && filtered.value === needle && filtered.caret === 2, JSON.stringify(filtered));
  check("las filas siguen filtradas tras los refrescos",
    rows.length > 0 && rows.every((r) => `${r.cmd} ${r.user} ${r.pid}`.toLowerCase().includes(needle)),
    JSON.stringify({ needle, rows: rows.slice(0, 5), count: filtered.count }));
  // Escape vacía el filtro.
  await app.exec(`
    const input = document.querySelector(".metrics-panel .metrics-proc-filter");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  `);
  await sleep(200);
  const cleared = await app.exec('return document.querySelector(".metrics-panel .metrics-proc-filter").value;');
  check("Escape en el buscador lo vacía", cleared === "", JSON.stringify(cleared));

  // Orden por PID: creciente y, al repetir, decreciente; aria-sort lo dice.
  await app.jsClick('.metrics-panel [data-proc-sort="pid"]');
  await sleep(200);
  let state = await app.exec(`
    const th = (k) => document.querySelector('.metrics-panel th[data-proc-col="' + k + '"]').getAttribute("aria-sort");
    return { pid: th("pid"), cpu: th("cpu") };
  `);
  rows = await app.exec(ROWS);
  const asc = rows.every((r, i) => i === 0 || rows[i - 1].pid <= r.pid);
  check("pulsar PID ordena de menor a mayor y lo anuncia con aria-sort",
    asc && state.pid === "ascending" && state.cpu === "none", JSON.stringify({ state, pids: rows.map((r) => r.pid) }));
  await app.jsClick('.metrics-panel [data-proc-sort="pid"]');
  await sleep(4000);
  rows = await app.exec(ROWS);
  state = await app.exec("return document.querySelector('.metrics-panel th[data-proc-col=\"pid\"]').getAttribute('aria-sort');");
  const desc = rows.every((r, i) => i === 0 || rows[i - 1].pid >= r.pid);
  check("repetir invierte el sentido y aguanta los refrescos", desc && state === "descending", JSON.stringify({ state, pids: rows.map((r) => r.pid) }));

  // Pausa: la tabla no cambia aunque lleguen muestras; reanudar la suelta.
  await app.jsClick('.metrics-panel [data-proc-sort="cpu"]');
  await app.jsClick('.metrics-panel [data-metrics-act="pause"]');
  await sleep(200);
  const frozen = await app.exec(`
    const btn = document.querySelector('.metrics-panel [data-metrics-act="pause"]');
    return {
      pressed: btn.getAttribute("aria-pressed"),
      badge: !document.querySelector(".metrics-panel .metrics-paused-badge").classList.contains("hidden"),
      html: document.querySelector(".metrics-panel .metrics-body").innerHTML,
    };
  `);
  if (shot) await shot("metrics-panel-paused");
  await sleep(7000);
  const later = await app.exec('return document.querySelector(".metrics-panel .metrics-body").innerHTML;');
  check("en pausa el botón queda pulsado, avisa y el panel no cambia con las muestras",
    frozen.pressed === "true" && frozen.badge && later === frozen.html, JSON.stringify({ pressed: frozen.pressed, badge: frozen.badge, same: later === frozen.html }));
  await app.jsClick('.metrics-panel [data-metrics-act="pause"]');
  await sleep(200);
  const resumed = await app.exec(`return document.querySelector('.metrics-panel [data-metrics-act="pause"]').getAttribute("aria-pressed");`);
  check("reanudar suelta la pausa", resumed === "false", String(resumed));

  await app.jsClick('.metrics-panel [data-metrics-act="close"]');
  await sleep(200);
  await app.jsClick("#status-metrics-toggle");
  await sleep(300);
}
