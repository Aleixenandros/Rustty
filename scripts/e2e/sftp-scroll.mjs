// Panel SFTP, listado largo: por encima de 200 entradas el listado se pinta por
// tramos (solo las filas del viewport). Aquí se baja por una carpeta de 400
// ficheros como lo haría alguien con la rueda y se comprueba que el scroll
// avanza sin volver atrás, que la fila que queda arriba es la que corresponde
// a esa altura y que se llega a la última. También mira las migas de la ruta:
// la raíz no puede salir pegada al separador («//home/…»).
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./webdriver.mjs";

const shotDir = process.env.E2E_SHOT_DIR || "";

/** Crea la carpeta de prueba con `count` ficheros y devuelve su ruta. */
export function prepareLongListing(workDir, count = 400) {
  const dir = path.join(workDir, "listado-largo");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    fs.writeFileSync(path.join(dir, `fichero-${String(i).padStart(4, "0")}.txt`), `${i}\n`);
  }
  return dir;
}

/** Con el panel de archivos ya abierto: navega a `dir` y baja por el listado. */
export async function checkSftpScroll(app, check, dir, count = 400) {
  // Se navega escribiendo la ruta, como el usuario con Ctrl+L.
  await app.exec(`
    const input = document.querySelector('.sftp-path[data-side="remote"]');
    input.classList.remove("hidden");
    input.focus();
    input.value = arguments[0];
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  `, [dir]);
  const started = Date.now();
  let total = 0;
  while (Date.now() - started < 15000) {
    total = await app.exec(`
      const row = document.querySelector('.sftp-files[data-side="remote"] .sftp-row');
      return row ? Number(row.getAttribute("aria-setsize")) : 0;
    `);
    if (total === count) break;
    await sleep(250);
  }
  check("el panel SFTP lista la carpeta de 400 ficheros", total === count, `aria-setsize=${total}`);
  if (total !== count) return;

  const crumbs = await app.exec(`
    const nav = document.querySelector('.sftp-breadcrumb[data-side="remote"]');
    return nav ? nav.textContent.replace(/\\s+/g, "") : "";
  `);
  check(
    "las migas de la ruta no repiten la barra de la raíz",
    crumbs.startsWith("/") && !crumbs.startsWith("//") && crumbs.endsWith("listado-largo"),
    crumbs,
  );

  // Bajada a pasos de 90 px, dejando un fotograma entre paso y paso (el
  // repintado del tramo va en `requestAnimationFrame`). En cada paso se mira
  // dónde quedó el scroll y qué fila hay de verdad en lo alto del viewport.
  const samples = [];
  for (let step = 0; step < 160; step++) {
    const sample = await app.execAsync(`
      const done = arguments[arguments.length - 1];
      const div = document.querySelector('.sftp-files[data-side="remote"]');
      div.scrollTop = div.scrollTop + 90;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const box = div.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
        const row = hit && hit.closest(".sftp-row");
        done({
          top: div.scrollTop,
          max: div.scrollHeight - div.clientHeight,
          pos: row ? Number(row.getAttribute("aria-posinset")) : 0,
        });
      }));
    `).catch(() => null);
    if (!sample) break;
    samples.push(sample);
    if (sample.top >= sample.max - 1) break;
  }
  const backwards = samples.filter((s, i) => i > 0 && s.top < samples[i - 1].top - 1);
  const rowsBack = samples.filter((s, i) => i > 0 && s.pos && samples[i - 1].pos && s.pos < samples[i - 1].pos);
  const last = samples[samples.length - 1] || { top: 0, max: 1, pos: 0 };
  if (shotDir) await app.screenshot(`${shotDir}/sftp-listado-largo.png`);
  check(
    "bajando por el listado largo el scroll no vuelve atrás",
    samples.length > 5 && backwards.length === 0,
    `${samples.length} pasos, retrocesos: ${JSON.stringify(backwards.slice(0, 3))}`,
  );
  check(
    "la fila que queda arriba avanza con el scroll",
    rowsBack.length === 0,
    JSON.stringify(rowsBack.slice(0, 3)),
  );
  const lastRow = await app.exec(`
    const div = document.querySelector('.sftp-files[data-side="remote"]');
    const rows = div.querySelectorAll(".sftp-row");
    const row = rows[rows.length - 1];
    if (!row) return null;
    const a = row.getBoundingClientRect();
    const b = div.getBoundingClientRect();
    return { pos: Number(row.getAttribute("aria-posinset")), visible: a.top < b.bottom && a.bottom > b.top };
  `);
  check(
    "al final del scroll se ve la última fila del listado",
    last.top >= last.max - 1 && lastRow?.pos === count && lastRow?.visible,
    JSON.stringify({ last, lastRow }),
  );
}
