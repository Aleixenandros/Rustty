// Panel real con datos de prueba: cabecera, distribución y borrado confirmado.
import path from "node:path";
import { sleep } from "./webdriver.mjs";

export async function checkTunnels(app, check, artifactsDir) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const profile = (await invoke("get_profiles")).find((p) => p.id === "e2e-sync");
  if (!profile) throw new Error("falta el perfil aislado para probar túneles");
  const originalTheme = await app.exec('return JSON.parse(localStorage.getItem("rustty-prefs")).theme;');
  const setTheme = async (theme) => {
    await app.jsClick("#rail-btn-settings");
    await app.waitFor("#modal-prefs-overlay:not(.hidden)");
    await sleep(500);
    await app.jsClick('[data-prefs-tab="appearance"]');
    await app.jsClick(`input[name="pref-theme"][value="${theme}"]`);
    await app.jsClick("#btn-prefs-save");
    await app.waitFor("#modal-prefs-overlay.hidden");
  };
  await invoke("save_profile", { profile: {
    ...profile,
    ssh_tunnels: [
      { id: "e2e-local", name: "Base de datos de producción", tunnel_type: "local", bind_host: "127.0.0.1", local_port: 15432, remote_host: "db.internal.example", remote_port: 5432 },
      { id: "e2e-remote", name: "Servicio de desarrollo", tunnel_type: "remote", bind_host: "127.0.0.1", local_port: 8080, remote_host: "127.0.0.1", remote_port: 3000 },
      { id: "e2e-socks", name: "Proxy de administración", tunnel_type: "dynamic", bind_host: "127.0.0.1", local_port: 1080 },
    ],
  } });
  try {
    await app.exec("setTimeout(() => location.reload(), 50); return true;");
    await sleep(2000);
    await app.waitFor("#btn-welcome-local", 60000);
    for (const [theme, width, height] of [["light", 1280, 800], ["dark", 1280, 800], ["light", 800, 700]]) {
      await app.resize(width, height);
      await setTheme(theme);
      await app.jsClick("#rail-btn-tunnels");
      await app.waitFor('#global-tunnels-overlay:not(.hidden) [data-tunnel-id="e2e-local"]');
      await sleep(250);
      const layout = await app.exec(`
        const modal = document.getElementById("global-tunnels-modal");
        const body = modal.querySelector(".global-tunnels-body");
        const minimize = document.getElementById("btn-global-tunnels-minimize").getBoundingClientRect();
        const close = document.getElementById("btn-global-tunnels-close").getBoundingClientRect();
        const rows = [...document.querySelectorAll("#global-saved-tunnels .global-tunnel-row")];
        return {
          width: innerWidth,
          gap: close.left - minimize.right,
          aligned: Math.abs(close.top - minimize.top) < 1,
          noOverflow: body.scrollWidth <= body.clientWidth + 1,
          actionsVisible: rows.every(row => [...row.querySelectorAll("button")].every(button => {
            const a = button.getBoundingClientRect(), b = row.getBoundingClientRect();
            return a.width > 0 && a.left >= b.left && a.right <= b.right;
          })),
        };
      `);
      check(`túneles ${theme} a ${width}px: controles juntos y contenido sin desbordar`,
        layout.width <= width && layout.gap >= 0 && layout.gap <= 8 && layout.aligned && layout.noOverflow && layout.actionsVisible,
        JSON.stringify(layout));
      if (artifactsDir) await app.screenshot(path.join(artifactsDir, `tunnels-${theme}-${width}.png`));
      await app.jsClick("#btn-global-tunnels-minimize");
      await app.waitFor("#global-tunnels-overlay.hidden");
    }
    await app.jsClick("#rail-btn-tunnels");
    await app.waitFor('#global-saved-tunnels [data-tunnel-id="e2e-local"]');
    check("minimizar y reabrir conserva los túneles guardados", true);
    await app.jsClick('#global-saved-tunnels [data-tunnel-id="e2e-local"] [data-global-tunnel-action="delete-saved"]');
    await app.waitFor("#credential-modal-overlay:not(.hidden)");
    await app.jsClick("#btn-credential-cancel");
    check("cancelar el borrado conserva el túnel",
      (await invoke("get_profiles")).find((p) => p.id === profile.id).ssh_tunnels.length === 3);
    await app.jsClick('#global-saved-tunnels [data-tunnel-id="e2e-local"] [data-global-tunnel-action="delete-saved"]');
    await app.waitFor("#credential-modal-overlay:not(.hidden)");
    await app.jsClick("#btn-credential-submit");
    await app.waitFor('#global-saved-tunnels:not(:has([data-tunnel-id="e2e-local"]))');
    check("borrar elimina solo el túnel confirmado",
      (await invoke("get_profiles")).find((p) => p.id === profile.id).ssh_tunnels.length === 2);
    await app.jsClick("#btn-global-tunnels-close");
    await app.waitFor("#global-tunnels-overlay.hidden");
    check("cerrar oculta el panel sin túneles activos", true);
  } finally {
    await app.jsClick("#btn-global-tunnels-minimize");
    await invoke("save_profile", { profile });
    await app.resize(1280, 800);
    await setTheme(originalTheme);
  }
}
