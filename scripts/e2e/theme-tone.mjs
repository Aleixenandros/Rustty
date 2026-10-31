// Tono del tema como dato: `html[data-tone]`, `color-scheme` y las sombras
// siguen al tema aplicado —de la hoja o del bundle— y el tono queda guardado
// para que boot.js lo ponga antes del primer pintado al recargar.
import path from "node:path";
import { sleep } from "./webdriver.mjs";

export async function checkThemeTone(app, check, artifactsDir) {
  const originalTheme = await app.exec('return JSON.parse(localStorage.getItem("rustty-prefs")).theme;');
  const setTheme = async (theme) => {
    await app.jsClick("#rail-btn-settings");
    await app.waitFor("#modal-prefs-overlay:not(.hidden)");
    await sleep(400);
    await app.jsClick('[data-prefs-tab="appearance"]');
    const found = await app.jsClick(`input[name="pref-theme"][value="${theme}"]`);
    if (!found) throw new Error(`no existe el tema ${theme} en Preferencias`);
    await app.jsClick("#btn-prefs-save");
    await app.waitFor("#modal-prefs-overlay.hidden");
    await sleep(200);
  };
  const read = () => app.exec(`
    const html = document.documentElement;
    const cs = getComputedStyle(html);
    return {
      tone: html.dataset.tone || null,
      hc: html.hasAttribute("data-tone-hc"),
      scheme: cs.colorScheme,
      shadow: cs.getPropertyValue("--shadow-1").trim(),
      ring: cs.getPropertyValue("--focus-ring-width").trim(),
      saved: JSON.parse(localStorage.getItem("rustty-theme-tone") || "null"),
    };
  `);
  const pressed = await app.exec(`
    const rules = [];
    for (const sheet of document.styleSheets) {
      try { for (const r of sheet.cssRules) if (r.selectorText && r.selectorText.includes(":active")) rules.push(r.selectorText); } catch (e) {}
    }
    return rules.join("\\n");
  `);
  check("estado pulsado común declarado en la hoja",
    [".btn-primary:active", ".rail-btn:active", ".ctx-item:active", ".dashboard-tool:active", ".tab:active"].every((s) => pressed.includes(s)));
  try {
    const cases = [
      ["dark", "dark", false],
      ["light", "light", false],
      ["github-light-high-contrast", "light", true],
      ["dracula", "dark", false],
    ];
    const shadows = {};
    for (const [theme, tone, hc] of cases) {
      await setTheme(theme);
      const state = await read();
      shadows[tone] = state.shadow;
      check(`tema ${theme}: tono ${tone} y esquema de color ${tone}`,
        state.tone === tone && state.scheme === tone, JSON.stringify(state));
      check(`tema ${theme}: tono guardado para el arranque`,
        state.saved && state.saved.theme === theme && state.saved.tone === tone, JSON.stringify(state.saved));
      check(`tema ${theme}: anillo de foco ${hc ? "grueso" : "normal"}`,
        state.hc === hc && state.ring === (hc ? "3px" : "2px"), JSON.stringify(state));
      if (artifactsDir) await app.screenshot(path.join(artifactsDir, `theme-tone-${theme}.png`));
    }
    check("las sombras del tono claro no son las negras del oscuro",
      shadows.light && shadows.dark && shadows.light !== shadows.dark, JSON.stringify(shadows));
    // Al recargar, boot.js pone el tono guardado antes de que main.js mida nada.
    await setTheme("light");
    await app.exec("setTimeout(() => location.reload(), 50); return true;");
    await sleep(2000);
    await app.waitForApp();
    const booted = await read();
    check("tras recargar el tono claro está puesto desde el arranque", booted.tone === "light" && booted.scheme === "light", JSON.stringify(booted));
  } finally {
    await setTheme(originalTheme).catch(() => {});
  }
}
