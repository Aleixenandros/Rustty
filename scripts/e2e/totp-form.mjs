// Formulario de conexión: el segundo factor con el TOTP de KeePass es una
// opción del perfil que viene apagada, y sus ajustes (de qué entrada sale la
// semilla, enviar sin preguntar, la pregunta que se reconoce) solo aparecen al
// activarla. El intercambio con el servidor se prueba en Rust (`kbd_fixture`).
import { sleep } from "./webdriver.mjs";

const shotDir = process.env.E2E_SHOT_DIR || "";

export async function checkTotpForm(app, check) {
  await app.jsClick("#rail-btn-new");
  await app.waitFor("#modal-overlay:not(.hidden)");
  await sleep(300);
  await app.jsClick('#modal-connection .modal-tab[data-modal-tab="advanced"]');
  await sleep(300);
  try {
    const read = () => app.exec(`
      const on = document.getElementById("f-totp-keepass");
      const box = document.getElementById("totp-keepass-options");
      const auto = document.getElementById("f-totp-keepass-auto");
      const warning = document.getElementById("totp-keepass-warning");
      return {
        present: Boolean(on && box && auto && warning),
        on: Boolean(on && on.checked),
        auto: Boolean(auto && auto.checked),
        optionsHidden: Boolean(box && box.hidden),
        warning: warning ? warning.textContent.trim().length : 0,
        warningIcon: Boolean(warning && warning.querySelector("svg")),
      };
    `);
    const initial = await read();
    check(
      "el TOTP de KeePass viene apagado en un perfil nuevo, con sus ajustes ocultos y el aviso de los dos factores a la vista",
      initial.present && !initial.on && !initial.auto && initial.optionsHidden && initial.warning > 20 && initial.warningIcon,
      JSON.stringify(initial),
    );
    await app.exec(`
      const on = document.getElementById("f-totp-keepass");
      on.scrollIntoView({ block: "center" });
      on.click();
      return true;
    `);
    await sleep(300);
    const enabled = await read();
    if (shotDir) await app.screenshot(`${shotDir}/totp-formulario.png`);
    check(
      "al activarlo aparecen sus ajustes, y «enviar sin preguntar» sigue apagado hasta que se elija",
      enabled.on && !enabled.optionsHidden && !enabled.auto,
      JSON.stringify(enabled),
    );
  } finally {
    await app.jsClick("#btn-modal-close");
    await sleep(300);
    // Un formulario tocado puede preguntar si se descartan los cambios.
    const asks = await app.exec(
      'return !document.getElementById("credential-modal-overlay").classList.contains("hidden");',
    );
    if (asks) {
      await app.jsClick("#btn-credential-submit");
      await sleep(300);
    }
  }
}
