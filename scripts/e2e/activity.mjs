// Centro de actividad: recuentos por filtro, filtro transversal de errores,
// entradas «nuevas» y distintivo de errores sin ver en el rail. De paso, dos
// pulidos de la misma tanda: la pista del atajo de búsqueda del inicio sale
// del atajo vigente y las flechas de los submenús son iconos, no un glifo.
//
// El historial se siembra en el almacenamiento y se recarga: así no depende de
// provocar errores de verdad. Al final se devuelve lo que había.
import { sleep } from "./webdriver.mjs";

const shotDir = process.env.E2E_SHOT_DIR || "";
/** Captura opcional (`E2E_SHOT_DIR`): para mirar el resultado, no solo medirlo. */
const snap = async (app, name) => { if (shotDir) await app.screenshot(`${shotDir}/${name}.png`); };

const HISTORY_KEY = "rustty-activity-history-v1";
const SEEN_KEY = "rustty-activity-seen-at-v1";

export async function checkActivityCenter(app, check) {
  const settle = () => sleep(250);
  const reload = async () => {
    await app.exec("setTimeout(() => location.reload(), 50); return true;");
    await sleep(2000);
    await app.waitForApp();
    await sleep(600);
  };
  const original = await app.exec(`
    return { history: localStorage.getItem(arguments[0]), seen: localStorage.getItem(arguments[1]) };
  `, [HISTORY_KEY, SEEN_KEY]);

  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const item = (id, kind, status, minutesAgo) => ({
    id, kind, status, title: `e2e ${id}`, detail: "", actionLabel: "", timestamp: at(minutesAgo),
  });
  // El historial se guarda con un retardo de 250 ms: se deja vaciar antes de
  // sembrar, y se recarga en el mismo paso para que nada lo pise.
  await sleep(600);
  await app.exec(`
    localStorage.setItem(arguments[0], JSON.stringify(arguments[2]));
    localStorage.setItem(arguments[1], arguments[3]);
    location.reload();
    return true;
  `, [HISTORY_KEY, SEEN_KEY, [
    item("act-err-conn", "connection", "error", 1),
    item("act-err-sftp", "sftp", "error", 2),
    item("act-ok-conn", "connection", "success", 3),
    item("act-err-viejo", "sync", "error", 60 * 48),
  ], at(60)]);
  await sleep(2000);
  await app.waitForApp();
  await sleep(600);

  try {
    const badge = await app.exec(`
      const b = document.getElementById("rail-activity-badge");
      const btn = document.querySelector('#rail [data-rail-action="activity"]');
      return { shown: !b.classList.contains("hidden"), text: b.textContent, label: btn.getAttribute("aria-label") || "" };
    `);
    await snap(app, "actividad-rail");
    check("el rail avisa de los errores registrados desde la última vez que se miró la actividad",
      badge.shown && badge.text === "2" && /2/.test(badge.label), JSON.stringify(badge));

    await app.jsClick('[data-rail-action="activity"]');
    await app.waitFor("#activity-center-overlay:not(.hidden)");
    await settle();
    const opened = await app.exec(`
      const count = (f) => document.querySelector('.activity-filter[data-activity-filter="' + f + '"]').dataset.count || "";
      return {
        counts: ["all", "connection", "sftp", "sync", "update", "error"].map(count).join(","),
        fresh: document.querySelectorAll("#activity-center-list .activity-new").length,
        badgeHidden: document.getElementById("rail-activity-badge").classList.contains("hidden"),
      };
    `);
    await snap(app, "actividad-centro");
    check("cada filtro del centro de actividad enseña cuántas entradas tiene (vacío si no hay)",
      opened.counts === "4,2,1,1,,3", opened.counts);
    check("al abrirlo, lo registrado desde la última vez sale marcado como nuevo y el aviso del rail se apaga",
      opened.fresh === 3 && opened.badgeHidden, JSON.stringify(opened));

    await app.jsClick('.activity-filter[data-activity-filter="error"]');
    await settle();
    const errors = await app.exec(`
      const rows = [...document.querySelectorAll("#activity-center-list .activity-item")];
      const chip = document.querySelector('.activity-filter[data-activity-filter="error"]');
      return { n: rows.length, allError: rows.every((r) => r.classList.contains("error")), pressed: chip.getAttribute("aria-pressed") };
    `);
    check("el filtro «Errores» reúne los errores de cualquier tipo",
      errors.n === 3 && errors.allError && errors.pressed === "true", JSON.stringify(errors));

    await app.jsClick('.activity-filter[data-activity-filter="all"]');
    await app.jsClick("#btn-activity-close");
    await app.waitFor("#activity-center-overlay.hidden");
    await settle();
    await app.jsClick('[data-rail-action="activity"]');
    await app.waitFor("#activity-center-overlay:not(.hidden)");
    await settle();
    const again = await app.exec(`
      return {
        fresh: document.querySelectorAll("#activity-center-list .activity-new").length,
        rows: document.querySelectorAll("#activity-center-list .activity-item").length,
      };
    `);
    check("al volver a abrirlo ya no queda nada marcado como nuevo", again.fresh === 0 && again.rows === 4, JSON.stringify(again));
    await app.jsClick("#btn-activity-close");
    await app.waitFor("#activity-center-overlay.hidden");
    await settle();

    // ── Pulidos de la tanda ─────────────────────────────────────
    const hint = await app.exec(`
      const el = document.getElementById("dashboard-search-kbd");
      return { text: el.textContent, hidden: el.classList.contains("hidden") };
    `);
    check("la pista de teclado del buscador del inicio sale del atajo vigente",
      hint.text === "Ctrl+K" && !hint.hidden, JSON.stringify(hint));
    const arrows = await app.exec(`
      const all = [...document.querySelectorAll(".ctx-submenu-arrow")];
      return { n: all.length, icons: all.filter((a) => a.querySelector("svg use")).length, text: all.map((a) => a.textContent.trim()).join("") };
    `);
    check("las flechas de los submenús son iconos, sin glifos de texto",
      arrows.n >= 5 && arrows.icons === arrows.n && arrows.text === "", JSON.stringify(arrows));
    const pressed = await app.exec(`
      return [...document.querySelectorAll("#rail [data-rail-view]")].map((b) => b.getAttribute("aria-pressed")).sort().join(",");
    `);
    check("las dos vistas del rail anuncian cuál está puesta (aria-pressed)", pressed === "false,true", pressed);
  } finally {
    await sleep(600);
    await app.exec(`
      const put = (key, value) => (value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
      put(arguments[0], arguments[2].history);
      put(arguments[1], arguments[2].seen);
      return true;
    `, [HISTORY_KEY, SEEN_KEY, original]);
    await reload();
  }
}
