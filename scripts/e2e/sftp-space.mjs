// Panel SFTP, desde la interfaz: al abrir el panel de archivos de un servidor que lo admite
// (el `sshd` de prueba es OpenSSH), la cabecera del lado remoto enseña el
// espacio libre del disco. Los comandos que hay debajo se prueban aparte, por
// IPC, en la sección del panel SFTP de `smoke.mjs`.
import { sleep } from "./webdriver.mjs";

const shotDir = process.env.E2E_SHOT_DIR || "";

export async function checkSftpSpace(app, check, profile) {
  const profileId = profile.id;
  const tabs = () => app.exec(
    "return [...document.querySelectorAll('.tab[data-session]')].map((t) => t.dataset.session);",
  );
  const search = (value) => app.exec(`
    const input = document.getElementById("sidebar-search");
    input.value = arguments[0];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `, [value]);
  // El perfil entró por la CLI con la app ya abierta: se recarga para que la
  // barra lateral lo tenga, y se pasa a su perfil de trabajo, que puede no ser
  // el que dejaron puesto las secciones anteriores.
  await app.exec("setTimeout(() => location.reload(), 50); return true;");
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);
  const selectWorkspace = (id) => app.exec(`
    const item = document.querySelector('#workspace-menu .ws-item[data-ws-id="' + arguments[0] + '"]');
    if (item) item.click();
    return Boolean(item);
  `, [id]);
  const previous = await app.exec(
    'const a = document.querySelector("#workspace-menu .ws-item.active"); return a ? a.dataset.wsId : null;',
  );
  await selectWorkspace(profile.workspace_id);
  await sleep(400);
  const before = await tabs();
  await search("e2e-sftp");
  try {
    await app.waitFor(`#connection-list .conn-item[data-id="${profileId}"]`);
    await app.jsClick(`#connection-list .conn-item[data-id="${profileId}"] [data-action="connect"]`);
    let state = null;
    let panelAsked = false;
    const started = Date.now();
    while (Date.now() - started < 45000) {
      // La conexión abre un terminal; el panel de archivos se pide con el
      // botón de su pestaña en cuanto está conectada.
      if (!panelAsked) {
        panelAsked = await app.exec(`
          const before = arguments[0];
          const tab = [...document.querySelectorAll('.tab[data-session]')].find((t) => !before.includes(t.dataset.session));
          const dot = tab && tab.querySelector(".tab-dot");
          const btn = tab && tab.querySelector(".tab-sftp");
          if (!btn || !dot || !/connected/.test(dot.className)) return false;
          btn.click();
          return true;
        `, [before]);
      }
      state = await app.exec(`
        const box = document.querySelector(".sftp-side-remote [data-sftp-space]");
        if (!box) return null;
        const fill = box.querySelector(".sftp-space-fill");
        return {
          hidden: box.classList.contains("hidden"),
          text: box.querySelector(".sftp-space-text").textContent.trim(),
          width: fill ? fill.style.width : "",
          rows: document.querySelectorAll('.sftp-files[data-side="remote"] .sftp-row').length,
        };
      `);
      if (state && !state.hidden && state.text) break;
      // La clave de prueba no lleva passphrase, pero el diálogo la pregunta:
      // se contesta vacía y sin guardarla en el llavero.
      await app.exec(`
        const overlay = document.getElementById("credential-modal-overlay");
        if (overlay.classList.contains("hidden")) return false;
        document.getElementById("credential-modal-remember").checked = false;
        document.getElementById("credential-modal-input").value = "";
        document.getElementById("btn-credential-submit").click();
        return true;
      `);
      await sleep(400);
    }
    if (shotDir) await app.screenshot(`${shotDir}/sftp-espacio.png`);
    check(
      "el panel SFTP enseña el espacio libre del disco del servidor, con su barra de ocupación",
      Boolean(state) && !state.hidden && /\d/.test(state.text) && /^\d+(\.\d+)?%$/.test(state.width),
      JSON.stringify(state),
    );
  } finally {
    for (const sid of (await tabs()).filter((id) => !before.includes(id))) {
      await app.jsClick(`.tab[data-session="${sid}"] .tab-close`);
      await sleep(400);
      // Cerrar una sesión viva puede pedir confirmación: se acepta.
      const asks = await app.exec(
        'return !document.getElementById("credential-modal-overlay").classList.contains("hidden");',
      );
      if (asks) {
        await app.jsClick("#btn-credential-submit");
        await sleep(300);
      }
    }
    await search("");
    if (previous && previous !== profile.workspace_id) await selectWorkspace(previous);
  }
}
