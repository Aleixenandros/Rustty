// Salto activo y bastiones por la interfaz, sin servidores reales
// (`modules/jump-route.js` + la sección «SALTO ACTIVO» de main.js).
//
// Comprueba lo que se ve y lo que se manda, no la conexión: el formulario
// guarda el bastión elegido entre las conexiones guardadas
// (`proxy_jump_profile_id`), «Usar como salto activo» del menú contextual
// enciende la píldora de la barra lateral y su ✕ la apaga, «Conectar a través
// de» ofrece lo esperado según el tipo, borrar un bastión lo avisa, y la paleta
// trae las acciones del salto (con el selector «Elegir conexión…» manejado por
// teclado). Las conexiones no se abren: los saltos de verdad los prueba la
// integración del backend.
//
// Lo guardado se comprueba reabriendo el formulario (el perfil en memoria) y,
// si el backend ya conoce el campo, en lo que devuelve `get_profiles`: un
// backend anterior lo descartaría al guardar. Las capturas van a
// `E2E_ARTIFACT_DIR`, en un tema oscuro y uno claro.
import path from "node:path";
import { sleep } from "./webdriver.mjs";

const IDS = {
  jump: "e2e-jump-office",
  dest: "e2e-jump-dest",
  rdp: "e2e-jump-rdp",
  ftp: "e2e-jump-ftp",
  vnc: "e2e-jump-vnc",
};

export async function checkJump(app, check, artifactsDir) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const all = await invoke("get_profiles");
  const base = all.find((p) => p.id === "e2e-sync") || all[0];
  if (!base) throw new Error("falta un perfil de partida para probar los saltos");
  const make = (id, over) => ({
    ...base,
    id,
    group: null,
    port: 22,
    username: "ana",
    connection_type: "ssh",
    auth_type: "password",
    password_source: "own",
    keepass_entry_uuid: null,
    master_credential_id: null,
    extra_credentials: [],
    ssh_tunnels: [],
    proxy_jump: null,
    ...over,
  });
  await invoke("save_profiles", {
    profiles: [
      make(IDS.jump, { name: "e2e-salto-oficina", host: "198.51.100.10" }),
      make(IDS.dest, { name: "e2e-destino", host: "198.51.100.20" }),
      make(IDS.rdp, { name: "e2e-escritorio", host: "198.51.100.30", connection_type: "rdp", port: 3389 }),
      make(IDS.ftp, { name: "e2e-ficheros", host: "198.51.100.40", connection_type: "ftp", port: 21 }),
      make(IDS.vnc, { name: "e2e-pantalla", host: "198.51.100.50", connection_type: "vnc", port: 5900 }),
    ],
  });
  const originalTheme = await app.exec('return JSON.parse(localStorage.getItem("rustty-prefs")).theme;');
  await app.exec("setTimeout(() => location.reload(), 50); return true;");
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);

  const readPrefs = () => app.exec('return JSON.parse(localStorage.getItem("rustty-prefs"));');
  const showOnly = (query) => app.exec(`
    const input = document.getElementById("sidebar-search");
    input.value = arguments[0];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `, [query]);
  const openCtx = async (id) => {
    await app.exec(`
      document.getElementById("context-menu").classList.add("hidden");
      const item = document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"]');
      if (!item) return false;
      const r = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5,
      }));
      return true;
    `, [id]);
    await app.waitFor("#context-menu:not(.hidden)");
  };
  const ctxState = () => app.exec(`
    const vis = (sel) => { const el = document.querySelector(sel); return !!el && !el.classList.contains("hidden"); };
    const sub = document.getElementById("ctx-connect-via-submenu");
    return {
      via: vis("#ctx-connect-via"),
      toggle: vis("#ctx-toggle-active-jump"),
      toggleLabel: document.getElementById("ctx-active-jump-label").textContent,
      items: [...sub.querySelectorAll("[data-ctx]")].map((b) => ({ ctx: b.dataset.ctx, via: b.dataset.via || "", text: b.textContent })),
    };
  `);
  const pillState = () => app.exec(`
    const wrap = document.getElementById("sidebar-route");
    return {
      visible: !wrap.classList.contains("hidden"),
      active: wrap.classList.contains("is-active"),
      label: document.getElementById("sidebar-route-label").textContent,
      clear: !document.getElementById("sidebar-route-clear").classList.contains("hidden"),
      title: document.getElementById("sidebar-route-pill").title,
    };
  `);
  const clearToasts = () => app.exec(
    'document.querySelectorAll("#toast-container .toast").forEach((el) => el.remove()); return true;',
  );
  const toastTexts = () => app.exec(
    'return [...document.querySelectorAll("#toast-container .toast-message")].map((el) => el.textContent);',
  );
  const toastSeen = (text) => app.exec(
    'return [...document.querySelectorAll("#toast-container .toast-message")].some((el) => el.textContent.includes(arguments[0]));',
    [text],
  );
  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);
  const capture = async (name) => {
    if (!artifactsDir) return;
    // La captura es del último fotograma pintado: se deja pintar el cambio.
    await sleep(400);
    await app.screenshot(path.join(artifactsDir, name)).catch(() => {});
  };
  const setTheme = async (theme) => {
    await app.jsClick("#rail-btn-settings");
    await app.waitFor("#modal-prefs-overlay:not(.hidden)");
    await sleep(400);
    await app.jsClick('[data-prefs-tab="appearance"]');
    await app.jsClick(`input[name="pref-theme"][value="${theme}"]`);
    await app.jsClick("#btn-prefs-save");
    await app.waitFor("#modal-prefs-overlay.hidden");
    await clearToasts();
  };

  try {
    await setTheme("dark");
    await showOnly("e2e-");
    await app.waitFor(`#connection-list .conn-item[data-id="${IDS.dest}"]`);

    // ── Píldora apagada de partida (modo «auto», sin saltos usados) ──
    let pill = await pillState();
    check("sin saltos, la píldora de ruta no estorba", !pill.visible, JSON.stringify(pill));

    // ── Formulario: el bastión se elige entre las conexiones guardadas ──
    await openCtx(IDS.dest);
    await app.jsClick('#context-menu [data-ctx="edit-conn"]');
    await app.waitFor("#modal-overlay:not(.hidden)");
    await app.jsClick('.modal-tab[data-modal-tab="advanced"]');
    await sleep(300);
    const form = await app.exec(`
      const sel = document.getElementById("f-proxy-jump-mode");
      return {
        options: [...sel.options].map((o) => o.value),
        manualHidden: document.getElementById("field-proxy-jump-manual").classList.contains("hidden"),
        ignore: !!document.getElementById("f-ignore-active-jump"),
      };
    `);
    check("el selector de bastión ofrece las conexiones SSH guardadas, sin la propia ni las que no son SSH",
      form.options.includes(`profile:${IDS.jump}`) && !form.options.includes(`profile:${IDS.dest}`)
      && !form.options.includes(`profile:${IDS.rdp}`) && !form.options.includes(`profile:${IDS.ftp}`)
      && form.options[0] === "" && form.options[1] === "manual",
      JSON.stringify(form.options));
    check("sin bastión no se enseña la dirección manual y está la casilla del salto activo",
      form.manualHidden && form.ignore, JSON.stringify(form));
    await app.exec(`
      const sel = document.getElementById("f-proxy-jump-mode");
      sel.value = "manual";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `);
    check("«Dirección manual…» enseña el campo de texto",
      await app.exec('return !document.getElementById("field-proxy-jump-manual").classList.contains("hidden");'));
    await app.exec(`
      const sel = document.getElementById("f-proxy-jump-mode");
      sel.value = arguments[0];
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `, [`profile:${IDS.jump}`]);
    await capture("salto-formulario.png");
    await app.jsClick("#btn-modal-save-only");
    await app.waitFor("#modal-overlay.hidden");
    await sleep(500);
    // El `invoke` de Tauri es de solo lectura en la página: lo guardado se mira
    // reabriendo el formulario y, si el backend ya conoce el campo, en disco.
    await openCtx(IDS.dest);
    await app.jsClick('#context-menu [data-ctx="edit-conn"]');
    await app.waitFor("#modal-overlay:not(.hidden)");
    await app.jsClick('.modal-tab[data-modal-tab="advanced"]');
    await sleep(300);
    const reopened = await app.exec(`
      return {
        mode: document.getElementById("f-proxy-jump-mode").value,
        manualHidden: document.getElementById("field-proxy-jump-manual").classList.contains("hidden"),
        missing: !document.getElementById("f-proxy-jump-missing").classList.contains("hidden"),
      };
    `);
    check("el bastión elegido se guarda en el perfil (proxy_jump_profile_id) y se vuelve a ver al editar",
      reopened.mode === `profile:${IDS.jump}` && reopened.manualHidden && !reopened.missing, JSON.stringify(reopened));
    await app.jsClick("#btn-modal-cancel");
    await app.waitFor("#modal-overlay.hidden");
    const roundTrip = (await invoke("get_profiles")).find((p) => p.id === IDS.dest);
    if (roundTrip && "proxy_jump_profile_id" in roundTrip) {
      check("el backend guarda proxy_jump_profile_id sin dirección de texto",
        roundTrip.proxy_jump_profile_id === IDS.jump && !roundTrip.proxy_jump,
        JSON.stringify({ id: roundTrip.proxy_jump_profile_id, text: roundTrip.proxy_jump }));
    } else {
      console.log("  --   este backend aún no guarda proxy_jump_profile_id: se omite la vuelta por profiles.json");
    }
    pill = await pillState();
    check("con un perfil que usa bastión, la píldora aparece en «Directo»",
      pill.visible && !pill.active && pill.label === "Directo" && !pill.clear, JSON.stringify(pill));
    await capture("salto-pildora-directo.png");

    // ── «Usar como salto activo» desde el menú contextual ──
    await openCtx(IDS.rdp);
    let ctx = await ctxState();
    check("una conexión RDP puede ir «a través de» pero no hacer de salto", ctx.via && !ctx.toggle, JSON.stringify(ctx));
    await openCtx(IDS.ftp);
    ctx = await ctxState();
    check("una conexión FTP no ofrece saltos", !ctx.via && !ctx.toggle, JSON.stringify(ctx));
    await openCtx(IDS.jump);
    ctx = await ctxState();
    check("una conexión SSH ofrece «Usar como salto activo»",
      ctx.toggle && ctx.toggleLabel === "Usar como salto activo", JSON.stringify(ctx));
    check("su «Conectar a través de» no se ofrece a sí misma",
      ctx.via && !ctx.items.some((i) => i.via === IDS.jump), JSON.stringify(ctx.items));
    await clearToasts();
    await app.jsClick('#context-menu [data-ctx="toggle-active-jump"]');
    await sleep(400);
    let toasts = await toastTexts();
    check("poner el salto activo enseña solo su aviso (las preferencias se guardan sin otro)",
      toasts.length === 1 && toasts[0].includes("saldrán por e2e-salto-oficina"), JSON.stringify(toasts));
    pill = await pillState();
    let prefs = await readPrefs();
    check("la píldora se enciende con el salto activo",
      pill.visible && pill.active && pill.label === "Por: e2e-salto-oficina" && pill.clear, JSON.stringify(pill));
    check("el salto activo queda en las preferencias locales (y en los recientes)",
      prefs.activeJumpProfileId === IDS.jump && prefs.recentJumpProfileIds?.[0] === IDS.jump, JSON.stringify({
        active: prefs.activeJumpProfileId, recent: prefs.recentJumpProfileIds,
      }));
    check("avisa de que las conexiones nuevas saldrán por él", await toastSeen("Las conexiones nuevas saldrán por e2e-salto-oficina"));

    // ── «Conectar a través de ▸» del destino ──
    await openCtx(IDS.dest);
    ctx = await ctxState();
    check("«Conectar a través de» ofrece sin saltos, el salto activo marcado y elegir conexión",
      ctx.items[0]?.via === "direct"
      && ctx.items.some((i) => i.via === IDS.jump && i.text.includes("e2e-salto-oficina · activo"))
      && ctx.items.at(-1)?.ctx === "connect-via-pick"
      && !ctx.items.some((i) => i.via === IDS.dest || i.via === IDS.rdp || i.via === IDS.ftp),
      JSON.stringify(ctx.items));
    // Solo para la foto: un menú más alto que la ventana recorta sus submenús.
    await app.exec('document.getElementById("context-menu").classList.remove("menu-overflow"); document.getElementById("ctx-connect-via-submenu").style.display = "block"; return true;');
    await capture("salto-submenu-oscuro.png");
    await app.exec('document.getElementById("ctx-connect-via-submenu").style.display = ""; document.getElementById("context-menu").classList.add("hidden"); return true;');

    // ── Borrar el bastión: la confirmación lo dice; se cancela ──
    await openCtx(IDS.jump);
    await app.jsClick('#context-menu [data-ctx="delete-conn"]');
    await app.waitFor("#credential-modal-overlay:not(.hidden)");
    const deleteMessage = await app.exec('return document.getElementById("credential-modal-message").textContent;');
    check("borrar un bastión avisa de quién se queda sin él y de que es el salto activo",
      deleteMessage.includes("Es el bastión de 1 conexión") && deleteMessage.includes("Es el salto activo"), deleteMessage);
    await app.jsClick("#btn-credential-cancel");
    await app.waitFor("#credential-modal-overlay.hidden");

    // ── Menú de la píldora ──
    await app.jsClick("#sidebar-route-pill");
    await app.waitFor("#route-menu:not(.hidden)");
    const menu = await app.exec(`
      return [...document.querySelectorAll("#route-menu [data-route-action]")].map((b) => ({
        action: b.dataset.routeAction, id: b.dataset.jumpId || "", checked: b.getAttribute("aria-checked"),
      }));
    `);
    check("el menú de la píldora ofrece directo, el salto elegido, elegir, probar y preferencias",
      menu[0]?.action === "direct" && menu[0]?.checked === "false"
      && menu.some((m) => m.action === "set" && m.id === IDS.jump && m.checked === "true")
      && ["pick", "probe", "prefs"].every((a) => menu.some((m) => m.action === a)),
      JSON.stringify(menu));
    await capture("salto-menu-pildora.png");
    await press("Escape", "Escape");
    await sleep(200);
    if (!(await app.exec('return document.getElementById("route-menu").classList.contains("hidden");'))) {
      await app.exec('document.getElementById("route-menu").classList.add("hidden"); return true;');
    }

    // ── La ✕ lo quita ──
    await clearToasts();
    await app.jsClick("#sidebar-route-clear");
    await sleep(400);
    toasts = await toastTexts();
    check("quitarlo enseña solo su aviso", toasts.length === 1 && toasts[0].includes("saldrán directas"), JSON.stringify(toasts));
    pill = await pillState();
    prefs = await readPrefs();
    check("la ✕ apaga la píldora y quita el salto activo",
      !pill.active && pill.label === "Directo" && !pill.clear && prefs.activeJumpProfileId === null, JSON.stringify(pill));
    check("y avisa de que las conexiones nuevas saldrán directas", await toastSeen("Las conexiones nuevas saldrán directas"));

    // ── Paleta: elegir el salto activo con el selector, por teclado ──
    const openPalette = async (query) => {
      await press("KeyP", "P", { ctrlKey: true, shiftKey: true });
      await app.waitFor("#command-palette-overlay:not(.hidden)");
      await app.exec(`
        const input = document.getElementById("command-palette-input");
        input.value = arguments[0];
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      `, [query]);
      await sleep(200);
      return app.exec('return [...document.querySelectorAll("#command-palette-list .palette-item-title")].map((el) => el.textContent);');
    };
    let titles = await openPalette("salto");
    check("la paleta ofrece «Salto activo: elegir conexión…»", titles.includes("Salto activo: elegir conexión…"), JSON.stringify(titles));
    await app.exec(`
      const item = [...document.querySelectorAll("#command-palette-list [data-palette-idx]")]
        .find((el) => el.textContent.includes("Salto activo: elegir conexión…"));
      item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      return true;
    `);
    await app.waitFor("#jump-picker-overlay:not(.hidden)");
    await app.exec(`
      const input = document.getElementById("jump-picker-filter");
      input.focus();
      input.value = "oficina";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await sleep(200);
    const picker = await app.exec(`
      return {
        title: document.getElementById("jump-picker-title").textContent,
        items: [...document.querySelectorAll("#jump-picker-list [data-jump-idx] .jump-picker-name")].map((el) => el.textContent),
        focused: document.activeElement && document.activeElement.id,
      };
    `);
    check("el selector filtra las conexiones SSH por lo escrito",
      picker.title === "Elegir el salto activo" && picker.items.length === 1 && picker.items[0] === "e2e-salto-oficina",
      JSON.stringify(picker));
    await capture("salto-selector.png");
    // El foco de WebKitWebDriver no siempre sigue a `focus()`: la tecla va al filtro.
    await clearToasts();
    await app.exec(`
      document.getElementById("jump-picker-filter").dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", bubbles: true, cancelable: true,
      }));
      return true;
    `);
    await sleep(400);
    prefs = await readPrefs();
    toasts = await toastTexts();
    check("elegirlo en el selector tampoco suma avisos de preferencias",
      !toasts.some((m) => m.includes("Preferencias guardadas")) && toasts.some((m) => m.includes("saldrán por")), JSON.stringify(toasts));
    check("Intro en el selector pone el salto activo",
      prefs.activeJumpProfileId === IDS.jump
      && await app.exec('return document.getElementById("jump-picker-overlay").classList.contains("hidden");'),
      String(prefs.activeJumpProfileId));
    titles = await openPalette("salto");
    check("con salto activo, la paleta ofrece desactivarlo y probarlo",
      titles.includes("Salto activo: desactivar") && titles.includes("Probar el salto activo"), JSON.stringify(titles));
    await press("Escape", "Escape");
    await sleep(300);
    if (!(await app.exec('return document.getElementById("command-palette-overlay").classList.contains("hidden");'))) {
      await app.exec('document.getElementById("command-palette-overlay").classList.add("hidden"); return true;');
    }

    // ── Píldora encendida en un tema claro ──
    await setTheme("light");
    await showOnly("e2e-");
    await sleep(300);
    await capture("salto-pildora-activo-claro.png");
    await openCtx(IDS.dest);
    await app.exec('document.getElementById("context-menu").classList.remove("menu-overflow"); document.getElementById("ctx-connect-via-submenu").style.display = "block"; return true;');
    await capture("salto-submenu-claro.png");
    await app.exec('document.getElementById("ctx-connect-via-submenu").style.display = ""; document.getElementById("context-menu").classList.add("hidden"); return true;');
    await setTheme("dark");
    await showOnly("e2e-");
    await sleep(300);
    await capture("salto-pildora-activo-oscuro.png");

    // ── VNC: bastión guardado sí, dirección manual no (no tiene credenciales SSH) ──
    const bastionOptionsOf = async (id) => {
      await openCtx(id);
      await app.jsClick('#context-menu [data-ctx="edit-conn"]');
      await app.waitFor("#modal-overlay:not(.hidden)");
      await sleep(300);
      const options = await app.exec('return [...document.getElementById("f-proxy-jump-mode").options].map((o) => o.value);');
      await app.jsClick("#btn-modal-cancel");
      await app.waitFor("#modal-overlay.hidden");
      return options;
    };
    const vncOptions = await bastionOptionsOf(IDS.vnc);
    check("una conexión VNC no ofrece dirección manual de bastión, sí las conexiones guardadas",
      !vncOptions.includes("manual") && vncOptions.includes(`profile:${IDS.jump}`), JSON.stringify(vncOptions));
    const rdpOptions = await bastionOptionsOf(IDS.rdp);
    check("una conexión RDP sí la ofrece", rdpOptions.includes("manual"), JSON.stringify(rdpOptions));

    // ── Borrar el bastión y deshacerlo: vuelve a enlazarse y a ser el salto activo ──
    await openCtx(IDS.jump);
    await app.jsClick('#context-menu [data-ctx="delete-conn"]');
    await app.waitFor("#credential-modal-overlay:not(.hidden)");
    await clearToasts();
    await app.jsClick("#btn-credential-submit");
    await app.waitFor("#credential-modal-overlay.hidden");
    await sleep(600);
    const afterDelete = (await invoke("get_profiles")).find((p) => p.id === IDS.dest);
    prefs = await readPrefs();
    check("al borrar el bastión, quien lo usaba se queda sin él y el salto activo se quita",
      afterDelete && !afterDelete.proxy_jump_profile_id && prefs.activeJumpProfileId === null,
      JSON.stringify({ ref: afterDelete?.proxy_jump_profile_id, active: prefs.activeJumpProfileId }));
    const undone = await app.exec(`
      const toast = [...document.querySelectorAll("#toast-container .toast")]
        .find((el) => el.querySelector(".toast-action") && /eliminad/i.test(el.textContent));
      if (!toast) return false;
      toast.querySelector(".toast-action").click();
      return true;
    `);
    await sleep(1000);
    const afterUndo = (await invoke("get_profiles")).find((p) => p.id === IDS.dest);
    prefs = await readPrefs();
    check("«Deshacer» devuelve el bastión, vuelve a enlazar a quien lo usaba y lo repone como salto activo",
      undone && afterUndo?.proxy_jump_profile_id === IDS.jump && prefs.activeJumpProfileId === IDS.jump,
      JSON.stringify({ undone, ref: afterUndo?.proxy_jump_profile_id, active: prefs.activeJumpProfileId }));
  } finally {
    // Sin restos para lo que venga detrás: ni salto activo ni perfiles de prueba.
    await app.exec(`
      document.getElementById("context-menu").classList.add("hidden");
      document.getElementById("route-menu").classList.add("hidden");
      const input = document.getElementById("sidebar-search");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `).catch(() => {});
    if (await app.exec('return !!document.querySelector("#sidebar-route.is-active");').catch(() => false)) {
      await app.jsClick("#sidebar-route-clear").catch(() => {});
    }
    await app.invoke("delete_profiles", { ids: Object.values(IDS) });
    if (originalTheme && originalTheme !== "dark") await setTheme(originalTheme).catch(() => {});
  }
}
