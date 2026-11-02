// Barra inferior en la consola local, en el WebView real.
//
//   - Al abrir una consola local aparece la barra con usuario@equipo y el
//     tamaño del terminal, sin latencia, túneles ni ruta (son cosas de SSH).
//   - En Linux, el botón del monitor muestrea ESTE equipo: tras encenderlo
//     llegan CPU y memoria a la barra. Fuera de Linux el botón no aparece.
//   - El icono del monitor dice qué es al pasar el ratón (tooltip propio).
import { sleep } from "./webdriver.mjs";

export async function checkLocalStatusBar(app, check, { shot } = {}) {
  // Desde el inicio (en el smoke puede haber otra pestaña delante).
  await app.jsClick("#home-tab");
  await sleep(300);
  await app.jsClick("#btn-welcome-local");
  await app.waitFor("#status-bar:not(.hidden)", 20000);
  await sleep(800);
  const bar = await app.exec(`
    const vis = (id) => { const el = document.getElementById(id); return !!el && !el.classList.contains("hidden") && el.getClientRects().length > 0; };
    return {
      userHost: document.getElementById("status-user-host")?.textContent || "",
      latency: vis("status-latency") && document.querySelector(".status-latency")?.getClientRects().length > 0,
      tunnels: vis("status-tunnels"),
      route: vis("status-route"),
      metricsToggle: vis("status-metrics-toggle"),
      platform: navigator.platform || "",
    };
  `);
  check("la consola local enseña la barra inferior con usuario y equipo", /\S/.test(bar.userHost) && !bar.userHost.includes(":"), JSON.stringify(bar));
  check("sin latencia, túneles ni ruta en la consola local", !bar.latency && !bar.tunnels && !bar.route, JSON.stringify(bar));
  const linux = /linux/i.test(bar.platform);
  check(linux ? "en Linux está el botón del monitor de recursos" : "fuera de Linux no hay monitor local",
    linux ? bar.metricsToggle : !bar.metricsToggle, JSON.stringify(bar));

  // Tooltip del icono del monitor.
  await app.exec(`
    const el = document.getElementById("status-metrics-toggle");
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", clientX: r.left + 2, clientY: r.top + 2 }));
    return true;
  `);
  await sleep(700);
  const tip = await app.exec('const b = document.getElementById("app-tooltip"); return b && !b.hidden ? b.textContent : null;');
  check("el icono del monitor dice qué es al pasar el ratón", !!tip, String(tip));
  if (shot) await shot("local-status-tooltip");
  await app.exec(`
    document.getElementById("status-metrics-toggle").dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
    return true;
  `);

  if (linux && bar.metricsToggle) {
    await app.jsClick("#status-metrics-toggle");
    let metrics = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      metrics = await app.exec(`
        const wrap = document.getElementById("status-metrics-wrap");
        return { shown: !!wrap && !wrap.classList.contains("hidden"), cpu: document.getElementById("status-cpu")?.textContent || "", ram: document.getElementById("status-ram")?.textContent || "" };
      `);
      if (metrics.shown && /\d/.test(metrics.cpu) && /\d/.test(metrics.ram)) break;
    }
    check("encender el monitor trae CPU y memoria de este equipo a la barra",
      metrics.shown && /\d/.test(metrics.ram), JSON.stringify(metrics));
    if (shot) await shot("local-status-metrics");
    await app.jsClick("#status-metrics-toggle");
    await sleep(300);
  }
}
