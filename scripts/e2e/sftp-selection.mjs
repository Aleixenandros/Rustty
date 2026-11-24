// Panel SFTP, teclado y ratón de verdad (acciones W3C del WebDriver, no
// eventos sintéticos): Ctrl+clic suma filas a la selección, Alt+clic no la
// toca, Mayús+clic selecciona un tramo, Supr abre la confirmación de borrado
// de lo seleccionado, y el clic derecho sobre una transferencia abre su menú,
// que lleva a lo transferido.
//
// Se ejecuta con el panel ya abierto y el lado remoto en la carpeta larga de
// `sftp-scroll.mjs`.
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./webdriver.mjs";

const KEY = { alt: "\uE00A", ctrl: "\uE009", shift: "\uE008", del: "\uE017" };
const shotDir = process.env.E2E_SHOT_DIR || "";

const rowCss = (name, side = "remote") =>
  `.sftp-files[data-side="${side}"] .sftp-row[data-name="${name}"]`;

/** Clic de verdad sobre `css`, con `modifier` pulsado si se da. */
async function realClick(app, css, { modifier = null, button = 0 } = {}) {
  const at = await app.exec(`
    const el = document.querySelector(arguments[0]);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2) };
  `, [css]);
  if (!at) throw new Error(`no está en pantalla: ${css}`);
  const keys = modifier
    ? [{ type: "keyDown", value: modifier }, { type: "pause" }, { type: "pause" }, { type: "pause" }, { type: "keyUp", value: modifier }]
    : [{ type: "pause" }, { type: "pause" }, { type: "pause" }, { type: "pause" }, { type: "pause" }];
  await app.actions({
    actions: [
      { type: "key", id: "teclado", actions: keys },
      {
        type: "pointer",
        id: "raton",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pause" },
          { type: "pointerMove", duration: 0, origin: "viewport", x: at.x, y: at.y },
          { type: "pointerDown", button },
          { type: "pointerUp", button },
          { type: "pause" },
        ],
      },
    ],
  });
}

const selectedNames = (app, side = "remote") => app.exec(`
  return [...document.querySelectorAll('.sftp-files[data-side="${side}"] .sftp-row.selected')].map((r) => r.dataset.name);
`);

export async function checkSftpSelection(app, check, { dir }) {
  // El panel de la prueba es bajo (la ventana es pequeña): se le da sitio para
  // que las filas se vean y el puntero pueda llegar a ellas.
  await app.exec(`
    const panel = document.querySelector(".sftp-panel");
    panel.style.flexBasis = "88%";
    panel.style.maxHeight = "none";
    const div = document.querySelector('.sftp-files[data-side="remote"]');
    div.scrollTop = 0;
    return true;
  `);
  await sleep(400);

  // Selección: clic y Ctrl+clic suman; Alt+clic no toca la selección.
  await realClick(app, rowCss("fichero-0001.txt"));
  await sleep(200);
  await realClick(app, rowCss("fichero-0002.txt"), { modifier: KEY.ctrl });
  await sleep(200);
  await realClick(app, rowCss("fichero-0003.txt"), { modifier: KEY.ctrl });
  await sleep(300);
  const picked = await selectedNames(app);
  check(
    "Ctrl+clic suma filas a la selección del panel SFTP",
    JSON.stringify(picked) === JSON.stringify(["fichero-0001.txt", "fichero-0002.txt", "fichero-0003.txt"]),
    JSON.stringify(picked),
  );
  await realClick(app, rowCss("fichero-0004.txt"), { modifier: KEY.alt });
  await sleep(300);
  const afterAlt = await selectedNames(app);
  check(
    "Alt+clic no cambia la selección",
    JSON.stringify(afterAlt) === JSON.stringify(picked),
    JSON.stringify(afterAlt),
  );

  // Supr con el foco en el listado: la confirmación de borrar lo seleccionado.
  await app.exec('document.querySelector(\'.sftp-files[data-side="remote"]\').focus(); return true;');
  await app.actions({
    actions: [{ type: "key", id: "teclado", actions: [{ type: "keyDown", value: KEY.del }, { type: "keyUp", value: KEY.del }] }],
  });
  await sleep(600);
  const dialog = await app.exec(`
    const overlay = document.getElementById("credential-modal-overlay");
    if (overlay.classList.contains("hidden")) return null;
    return {
      title: document.getElementById("credential-modal-title").textContent.trim(),
      text: overlay.textContent.replace(/\\s+/g, " ").slice(0, 200),
    };
  `);
  if (shotDir) await app.screenshot(`${shotDir}/sftp-supr.png`);
  check(
    "Supr sobre el listado pide confirmar el borrado de lo seleccionado",
    Boolean(dialog) && /3/.test(dialog.text),
    JSON.stringify(dialog),
  );
  if (dialog) {
    await app.jsClick("#btn-credential-cancel");
    await sleep(400);
  }
  const survived = ["fichero-0001.txt", "fichero-0002.txt", "fichero-0003.txt"]
    .every((name) => fs.existsSync(path.join(dir, name)));
  check("cancelar esa confirmación no borra nada", survived);

  // Mayús+clic: el tramo desde la última fila pulsada sin Mayús.
  await realClick(app, rowCss("fichero-0002.txt"));
  await sleep(200);
  await realClick(app, rowCss("fichero-0006.txt"), { modifier: KEY.shift });
  await sleep(300);
  const ranged = await selectedNames(app);
  check(
    "Mayús+clic selecciona el tramo entre dos filas",
    JSON.stringify(ranged) === JSON.stringify(["fichero-0002.txt", "fichero-0003.txt", "fichero-0004.txt", "fichero-0005.txt", "fichero-0006.txt"]),
    JSON.stringify(ranged),
  );

  // Una descarga (doble clic) deja una transferencia en la lista.
  await app.exec(`
    const row = document.querySelector(arguments[0]);
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return true;
  `, [rowCss("fichero-0005.txt")]);
  const started = Date.now();
  let done = false;
  while (Date.now() - started < 15000) {
    done = await app.exec('const el = document.querySelector(".sftp-transfer"); return Boolean(el && el.classList.contains("done"));');
    if (done) break;
    await sleep(250);
  }
  check("el doble clic descarga el fichero y la transferencia termina", done);

  // Clic derecho sobre la transferencia: su menú. Va como evento `contextmenu`
  // y no como acción del WebDriver: WebKitWebDriver suelta el botón derecho
  // como si fuera el izquierdo (`mouseup` y `click` con button 0), y ese clic
  // falso cierra el menú en cuanto se abre. Con un ratón de verdad no pasa.
  await app.exec(`
    const panel = document.querySelector(".sftp-panel");
    panel.style.flexBasis = "";
    panel.style.maxHeight = "";
    const el = document.querySelector(".sftp-transfer .sftp-transfer-label");
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2, clientX: r.left + 20, clientY: r.top + r.height / 2,
    }));
    return true;
  `);
  await sleep(400);
  const menu = await app.exec(`
    const menu = document.getElementById("sftp-transfer-menu");
    if (!menu || menu.classList.contains("hidden")) return null;
    return [...menu.querySelectorAll("[data-xferctx]")].filter((b) => !b.classList.contains("hidden")).map((b) => b.dataset.xferctx);
  `);
  if (shotDir) await app.screenshot(`${shotDir}/sftp-menu-transferencia.png`);
  check(
    "el clic derecho sobre una transferencia terminada abre su menú",
    Array.isArray(menu) && menu.includes("reveal") && menu.includes("remove") && !menu.includes("cancel"),
    JSON.stringify(menu),
  );

  // «Mostrar en la carpeta de destino»: el lado local enseña lo descargado.
  if (menu) {
    await app.jsClick('#sftp-transfer-menu [data-xferctx="reveal"]');
    await sleep(1200);
    const local = await selectedNames(app, "local");
    check(
      "«Mostrar en la carpeta de destino» marca lo descargado en el lado local",
      local.includes("fichero-0005.txt"),
      JSON.stringify(local),
    );
  }
}
