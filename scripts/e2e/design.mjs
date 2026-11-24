// Pulido visual de la 2.30.1, medido en el WebView real (estilos computados y
// geometría, no capturas a ojo):
// - las ayudas de los formularios son texto neutro; el amarillo queda para los
//   avisos (`.form-hint.warn`);
// - la botonera de una conexión aparece al pasar el puntero SIN re-maquetar el
//   nombre (antes se recortaba de golpe ~100 px en cada fila);
// - la línea de la pestaña activa y el filo de la barra de estado toman el
//   color de un entorno PROD / STAGE;
// - la tira de pestañas funde el borde por el que quedan pestañas ocultas;
// - Idioma, la consola local del inicio y la marca del tema elegido son SVG,
//   no caracteres;
// - «Tamaño del texto de la interfaz» llega a la barra lateral, las pestañas y
//   la barra de estado.
//
// Necesita al menos una conexión en la barra lateral (va después de la
// edición en lote, que deja tres).
import { sleep } from "./webdriver.mjs";

export async function checkDesign(app, check, { shot } = {}) {
  // Ayudas neutras y avisos en amarillo.
  const hints = await app.exec(`
    const probe = (cls) => {
      const p = document.createElement("p");
      p.className = cls;
      document.getElementById("modal-connection").appendChild(p);
      const color = getComputedStyle(p).color;
      p.remove();
      return color;
    };
    const color = (name) => {
      const el = document.createElement("span");
      el.style.color = "var(" + name + ")";
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    return { hint: probe("form-hint"), warn: probe("form-hint warn"), danger: probe("form-hint warning"),
             subtext0: color("--subtext0"), yellow: color("--yellow"), red: color("--red") };
  `);
  check(
    "las ayudas de formulario son texto neutro y el amarillo queda para los avisos",
    hints.hint === hints.subtext0 && hints.warn === hints.yellow && hints.danger === hints.red,
    JSON.stringify(hints),
  );

  // Botonera de la fila sin re-maquetar el nombre.
  const at = await app.exec(`
    const item = document.querySelector("#connection-list .conn-item");
    if (!item) return null;
    item.scrollIntoView({ block: "nearest" });
    const r = item.getBoundingClientRect();
    const name = item.querySelector(".conn-item-name").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 3), y: Math.round(r.top + r.height / 2), id: item.dataset.id, nameW: name.width };
  `);
  if (!at) {
    check("hay una conexión en la barra lateral para probar su botonera", false);
  } else {
    await app.actions({
      actions: [{
        type: "pointer", id: "raton", parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, origin: "viewport", x: at.x, y: at.y }, { type: "pause", duration: 300 }],
      }],
    });
    await sleep(300);
    const hover = await app.exec(`
      const item = document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"]');
      const actions = item.querySelector(".conn-item-actions");
      const name = item.querySelector(".conn-item-name").getBoundingClientRect();
      const a = actions.getBoundingClientRect(), r = item.getBoundingClientRect();
      return { hovered: item.matches(":hover"), visible: getComputedStyle(actions).visibility, nameW: name.width,
               inside: a.right <= r.right + 0.5 && a.left >= r.left, mask: getComputedStyle(item.querySelector(".conn-item-info")).webkitMaskImage || "" };
    `, [at.id]);
    if (shot) await shot("diseno-fila-hover");
    check(
      "al pasar el puntero por una conexión su botonera aparece sin recortar el nombre",
      hover.hovered && hover.visible === "visible" && hover.inside && Math.abs(hover.nameW - at.nameW) < 0.5 && /gradient/.test(hover.mask),
      JSON.stringify({ before: at.nameW, ...hover }),
    );
    await app.actions({
      actions: [{
        type: "pointer", id: "raton", parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, origin: "viewport", x: 2, y: 2 }],
      }],
    });
  }

  // PROD / STAGE en la pestaña activa y en la barra de estado. Se miden los
  // estilos con una pestaña y una insignia de prueba: abrir una sesión PROD
  // de verdad pediría un servidor.
  const env = await app.exec(`
    const color = (name) => {
      const el = document.createElement("span");
      el.style.color = "var(" + name + ")";
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    const tabs = document.getElementById("tabs-container");
    const tab = document.createElement("div");
    tab.className = "tab active";
    tab.innerHTML = '<span class="tab-name">e2e</span><span class="env-badge env-prod">PROD</span>';
    tabs.appendChild(tab);
    const prodLine = getComputedStyle(tab, "::after").backgroundColor;
    tab.querySelector(".env-badge").className = "env-badge env-stage";
    const stageLine = getComputedStyle(tab, "::after").backgroundColor;
    tab.querySelector(".env-badge").remove();
    const plainLine = getComputedStyle(tab, "::after").backgroundColor;
    tab.remove();
    const bar = document.getElementById("status-bar");
    const envEl = document.getElementById("status-env");
    const before = envEl.className;
    const plainEdge = getComputedStyle(bar).borderTopColor;
    envEl.className = "env-badge env-prod";
    const prodEdge = getComputedStyle(bar).borderTopColor;
    envEl.className = before;
    return { prodLine, stageLine, plainLine, plainEdge, prodEdge, red: color("--red"), yellow: color("--yellow"), blue: color("--blue") };
  `);
  check(
    "una sesión PROD tiñe de rojo la línea de su pestaña activa (STAGE, de amarillo)",
    env.prodLine === env.red && env.stageLine === env.yellow && env.plainLine === env.blue,
    JSON.stringify(env),
  );
  check(
    "y el filo de la barra de estado cambia con ella",
    env.prodEdge !== env.plainEdge,
    JSON.stringify({ plain: env.plainEdge, prod: env.prodEdge }),
  );

  // Bordes fundidos en la tira de pestañas cuando hay pestañas fuera de vista.
  await app.exec(`
    const bar = document.getElementById("tab-scroll");
    bar.style.maxWidth = "60px";
    bar.scrollLeft = 0;
    return true;
  `);
  await sleep(400);
  const fadeStart = await app.exec(`
    const bar = document.getElementById("tab-scroll");
    return { overflow: bar.scrollWidth > bar.clientWidth + 1, cls: bar.className, mask: getComputedStyle(bar).webkitMaskImage || "" };
  `);
  await app.exec(`const bar = document.getElementById("tab-scroll"); bar.scrollLeft = bar.scrollWidth; return true;`);
  await sleep(300);
  const fadeEnd = await app.exec(`return document.getElementById("tab-scroll").className;`);
  if (shot) await shot("diseno-pestanas-fundido");
  await app.exec(`const bar = document.getElementById("tab-scroll"); bar.style.maxWidth = ""; bar.scrollLeft = 0; return true;`);
  await sleep(400);
  const fadeNone = await app.exec(`return document.getElementById("tab-scroll").className;`);
  check(
    "la tira de pestañas funde el borde por el que quedan pestañas ocultas",
    fadeStart.overflow && /fade-end/.test(fadeStart.cls) && !/fade-start/.test(fadeStart.cls)
      && /gradient/.test(fadeStart.mask)
      && /fade-start/.test(fadeEnd) && !/fade-end/.test(fadeEnd)
      && !/fade-/.test(fadeNone),
    JSON.stringify({ fadeStart, fadeEnd, fadeNone }),
  );

  // Iconos SVG en lugar de caracteres.
  const icons = await app.exec(`
    const lang = document.querySelector('.prefs-nav-item[data-prefs-tab="language"] .prefs-nav-icon');
    const local = document.querySelector("#btn-welcome-local .dashboard-tool-icon");
    const opt = document.querySelector(".theme-option");
    let check = null;
    if (opt) {
      const had = opt.classList.contains("selected");
      opt.classList.add("selected");
      const after = getComputedStyle(opt, "::after"), before = getComputedStyle(opt, "::before");
      check = { content: after.content, mask: before.webkitMaskImage || before.maskImage || "" };
      if (!had) opt.classList.remove("selected");
    }
    return {
      lang: Boolean(lang?.querySelector("svg")) && lang.textContent.trim() === "",
      local: Boolean(local?.querySelector("svg")) && local.textContent.trim() === "",
      check,
    };
  `);
  check(
    "Idioma, la consola local del inicio y la marca del tema elegido son iconos SVG",
    icons.lang && icons.local && (!icons.check || (!/✓/.test(icons.check.content) && /svg/.test(icons.check.mask))),
    JSON.stringify(icons),
  );

  // Tamaño del texto de la interfaz.
  const sizes = await app.exec(`
    const html = document.documentElement;
    const read = () => ({
      name: getComputedStyle(document.querySelector("#connection-list .conn-item-name")).fontSize,
      tab: getComputedStyle(document.getElementById("home-tab")).fontSize,
      status: getComputedStyle(document.getElementById("status-bar")).fontSize,
    });
    const had = [...html.classList].filter((c) => c.startsWith("uitext-"));
    had.forEach((c) => html.classList.remove(c));
    const normal = read();
    html.classList.add("uitext-xlarge");
    const xlarge = read();
    html.classList.remove("uitext-xlarge");
    had.forEach((c) => html.classList.add(c));
    return { normal, xlarge };
  `);
  const px = (v) => parseFloat(v);
  check(
    "«Tamaño del texto de la interfaz» agranda la barra lateral, las pestañas y la barra de estado",
    px(sizes.xlarge.name) > px(sizes.normal.name)
      && px(sizes.xlarge.tab) > px(sizes.normal.tab)
      && px(sizes.xlarge.status) > px(sizes.normal.status),
    JSON.stringify(sizes),
  );
}
