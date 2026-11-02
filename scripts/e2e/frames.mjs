// Diálogos movibles/redimensionables y tooltips propios, en el WebView real.
//
//   - Preferencias abre con su tamaño de fábrica, sin pico cuadrado en las
//     esquinas (la cabecera hereda el radio del diálogo), se mueve arrastrando
//     la cabecera, se redimensiona desde la esquina, recuerda ambas cosas al
//     reabrir y el doble clic en la cabecera lo devuelve a fábrica.
//   - Estrecho, la barra de secciones se queda en iconos con tooltip.
//   - Un icono con `title` enseña la burbuja propia (`#app-tooltip`) y, mientras
//     el puntero está encima, el atributo `title` se retira (sin doble tooltip
//     nativo) pero `el.title` sigue leyendo y escribiendo su valor; al salir
//     vuelve el atributo.
//
// Los eventos de puntero son sintéticos (`PointerEvent` despachado desde el
// script): WebKitWebDriver no mueve un puntero real sobre el webview.
import { sleep } from "./webdriver.mjs";

export async function checkFrames(app, check, { shot } = {}) {
  const rect = () => app.exec(`
    const r = document.getElementById("modal-prefs").getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  `);
  const pointer = (selector, type, x, y, extra = {}) => app.exec(`
    const el = document.querySelector(arguments[0]);
    el.dispatchEvent(new PointerEvent(arguments[1], { bubbles: true, cancelable: true, composed: true,
      pointerId: 7, pointerType: "mouse", button: 0, buttons: arguments[1] === "pointerup" ? 0 : 1,
      clientX: arguments[2], clientY: arguments[3], ...arguments[4] }));
    return true;
  `, [selector, type, x, y, extra]);
  const drag = async (selector, from, to) => {
    await pointer(selector, "pointerdown", from.x, from.y);
    await pointer(selector, "pointermove", (from.x + to.x) / 2, (from.y + to.y) / 2);
    await pointer(selector, "pointermove", to.x, to.y);
    await pointer(selector, "pointerup", to.x, to.y);
    await sleep(120);
  };

  await app.exec(`
    localStorage.removeItem("rustty-dialog-frame-prefs");
    return true;
  `);
  await app.jsClick("#rail-btn-settings");
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(500);
  const initial = await rect();
  const viewport = await app.exec("return { width: innerWidth, height: innerHeight };");
  check("Preferencias abre más ancha que antes (≥ 900 px o casi toda la ventana)",
    initial.width >= Math.min(900, viewport.width * 0.9), JSON.stringify(initial));
  check("la cabecera de Preferencias hereda el radio del diálogo (sin esquina cuadrada)",
    await app.exec(`
      const box = getComputedStyle(document.getElementById("modal-prefs")).borderTopLeftRadius;
      const head = getComputedStyle(document.querySelector("#modal-prefs > .modal-header")).borderTopLeftRadius;
      return box === head && box !== "0px";
    `));
  if (shot) await shot("prefs-default");

  // Mover arrastrando la cabecera (sobre el título, no sobre el botón ×).
  const title = await app.exec(`
    const r = document.getElementById("modal-prefs-title").getBoundingClientRect();
    return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) };
  `);
  await drag("#modal-prefs > .modal-header", title, { x: title.x - 60, y: title.y + 40 });
  const moved = await rect();
  check("arrastrar la cabecera mueve Preferencias",
    Math.abs(moved.left - (initial.left - 60)) <= 2 && Math.abs(moved.top - (initial.top + 40)) <= 2,
    `${JSON.stringify(initial)} → ${JSON.stringify(moved)}`);

  // Redimensionar desde la esquina inferior derecha: el borde izquierdo quieto.
  const corner = { x: moved.left + moved.width - 2, y: moved.top + moved.height - 2 };
  await drag('#modal-prefs > .dialog-resize-handle[data-dir="se"]', corner, { x: corner.x - 300, y: corner.y - 120 });
  const resized = await rect();
  check("la esquina redimensiona Preferencias dejando quieto el borde opuesto",
    Math.abs(resized.width - (moved.width - 300)) <= 2 && Math.abs(resized.height - (moved.height - 120)) <= 2
      && Math.abs(resized.left - moved.left) <= 2 && Math.abs(resized.top - moved.top) <= 2,
    `${JSON.stringify(moved)} → ${JSON.stringify(resized)}`);

  // Estrecho: la barra de secciones en iconos con tooltip.
  const narrowCorner = { x: resized.left + resized.width - 2, y: resized.top + resized.height - 2 };
  await drag('#modal-prefs > .dialog-resize-handle[data-dir="se"]', narrowCorner, { x: resized.left + 500, y: narrowCorner.y });
  await sleep(200);
  check("estrecha, la barra de secciones se queda en iconos y cada sección lleva tooltip",
    await app.exec(`
      const d = document.getElementById("modal-prefs");
      const item = d.querySelector(".prefs-nav-item");
      return d.classList.contains("is-narrow") && !!item.getAttribute("data-tooltip")
        && d.querySelector(".prefs-nav").getBoundingClientRect().width < 80;
    `));
  if (shot) await shot("prefs-narrow");

  // Cerrar y reabrir: recuerda el marco.
  const beforeClose = await rect();
  await app.jsClick("#btn-prefs-cancel");
  await sleep(300);
  await app.jsClick("#rail-btn-settings");
  await app.waitFor("#modal-prefs-overlay:not(.hidden)");
  await sleep(500);
  const reopened = await rect();
  check("al reabrir, Preferencias conserva posición y tamaño",
    Math.abs(reopened.left - beforeClose.left) <= 2 && Math.abs(reopened.width - beforeClose.width) <= 2,
    `${JSON.stringify(beforeClose)} → ${JSON.stringify(reopened)}`);

  // Doble clic en la cabecera: tamaño y sitio de fábrica.
  await app.exec(`
    const h = document.querySelector("#modal-prefs > .modal-header");
    h.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return true;
  `);
  await sleep(200);
  const reset = await rect();
  check("doble clic en la cabecera devuelve Preferencias a su tamaño y sitio de fábrica",
    Math.abs(reset.width - initial.width) <= 2 && Math.abs(reset.left - initial.left) <= 2
      && (await app.exec('return localStorage.getItem("rustty-dialog-frame-prefs") === null;')),
    `${JSON.stringify(initial)} vs ${JSON.stringify(reset)}`);
  await app.jsClick("#btn-prefs-cancel");
  await sleep(300);
}

export async function checkTooltips(app, check, { shot } = {}) {
  // Un icono del rail con data-tooltip y otro botón con title.
  const hover = (selector) => app.exec(`
    const el = document.querySelector(arguments[0]);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true, pointerType: "mouse",
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return true;
  `, [selector]);
  const leave = (selector) => app.exec(`
    const el = document.querySelector(arguments[0]);
    el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, composed: true, pointerType: "mouse",
      relatedTarget: document.body }));
    return true;
  `, [selector]);
  const bubble = () => app.exec(`
    const b = document.getElementById("app-tooltip");
    if (!b || b.hidden) return null;
    const r = b.getBoundingClientRect();
    return { text: b.textContent, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  `);

  await hover("#rail-btn-settings");
  await sleep(700);
  const railTip = await bubble();
  check("pasar el ratón por un icono del rail enseña su descripción",
    !!railTip && railTip.text.length > 0, JSON.stringify(railTip));
  const railBtn = await app.exec(`
    const r = document.getElementById("rail-btn-settings").getBoundingClientRect();
    return { right: r.right };
  `);
  check("la descripción del rail sale a su derecha, dentro de la ventana",
    !!railTip && railTip.left >= railBtn.right && railTip.right <= (await app.exec("return innerWidth;")));
  if (shot) await shot("tooltip-rail");
  await leave("#rail-btn-settings");
  await sleep(150);
  check("al salir del icono la descripción desaparece", (await bubble()) === null);

  // Un elemento con `title`: se retira mientras dura el hover y vuelve después.
  await app.exec(`
    const b = document.createElement("button");
    b.id = "e2e-tip"; b.type = "button"; b.title = "Descripción e2e";
    b.style.cssText = "position:fixed;left:300px;top:300px;width:30px;height:30px;z-index:5";
    document.body.appendChild(b);
    return true;
  `);
  await hover("#e2e-tip");
  await sleep(700);
  const titled = await app.exec(`
    const b = document.getElementById("e2e-tip");
    const tip = document.getElementById("app-tooltip");
    const during = { attr: b.getAttribute("title"), prop: b.title, text: tip && !tip.hidden ? tip.textContent : null };
    b.title = "Cambiada en caliente";
    return during;
  `);
  check("un title enseña la burbuja propia y no queda como atributo mientras tanto (sin tooltip nativo doble)",
    titled.text === "Descripción e2e" && titled.attr === null && titled.prop === "Descripción e2e", JSON.stringify(titled));
  await sleep(50);
  check("escribir el title en caliente actualiza la burbuja",
    (await bubble())?.text === "Cambiada en caliente");
  await leave("#e2e-tip");
  await sleep(100);
  check("al salir el atributo title vuelve, con el último valor",
    await app.exec('const b = document.getElementById("e2e-tip"); const v = b.getAttribute("title"); b.remove(); return v === "Cambiada en caliente";'));
}
