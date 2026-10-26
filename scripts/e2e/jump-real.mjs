// Salto activo de verdad: dos `sshd` reales en 127.0.0.1 —el salto y el
// destino—, cada uno con SU clave (el salto no acepta la del destino ni al
// revés, así que cada salto tiene que entrar con sus propias credenciales), y
// todo por la interfaz, como lo haría el usuario:
//
//   1. «Usar como salto activo» en el menú contextual del salto.
//   2. «Conectar» en el destino: la sesión abre, lo tecleado se ejecuta en el
//      destino y la pestaña dice por dónde va. El `sshd` del salto registra un
//      canal `direct-tcpip` hacia el destino: la conexión pasó por él.
//   3. Otra sesión con «Conectar a través de ▸ <salto>»: reutiliza la conexión
//      con el salto (una sola autenticación en su registro, dos canales).
//   4. «Sin saltos (directo)»: conecta sin abrir otro canal en el salto.
//   5. «Probar el salto» de la píldora dice que deja abrir túneles.
//
// Las claves no llevan passphrase y el keyring no está en el bus de la prueba,
// así que la app pregunta la passphrase de cada clave: se contesta vacía.
import fs from "node:fs";
import path from "node:path";
import { startSshd } from "./sshd.mjs";
import { sleep } from "./webdriver.mjs";

const IDS = { jump: "e2e-real-salto", dest: "e2e-real-destino" };

export async function checkJumpReal(app, check, { sshd, workDir, home, children }) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const jumpLog = path.join(workDir, "sshd-salto.log");
  const jump = await startSshd(sshd, path.join(workDir, "sshd-salto"), { logFile: jumpLog });
  children.push({ kill: jump.stop });
  const dest = await startSshd(sshd, path.join(workDir, "sshd-destino"));
  children.push({ kill: dest.stop });
  // Las dos host keys, ya conocidas: ninguna conexión pregunta por ellas.
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.appendFileSync(path.join(home, ".ssh/known_hosts"), `${jump.knownHostsLine}\n${dest.knownHostsLine}\n`);

  const all = await invoke("get_profiles");
  const base = all[0];
  if (!base) throw new Error("falta un perfil de partida para la prueba real del salto");
  const make = (id, name, server) => ({
    ...base,
    id,
    name,
    group: null,
    host: "127.0.0.1",
    port: server.port,
    username: server.user,
    connection_type: "ssh",
    auth_type: "public_key",
    key_path: server.clientKey,
    password_source: "own",
    keepass_entry_uuid: null,
    master_credential_id: null,
    extra_credentials: [],
    ssh_tunnels: [],
    proxy_jump: null,
    proxy_jump_profile_id: null,
    ignore_active_jump: false,
  });
  await invoke("save_profiles", {
    profiles: [make(IDS.jump, "e2e-real-salto", jump), make(IDS.dest, "e2e-real-destino", dest)],
  });
  await app.exec("setTimeout(() => location.reload(), 50); return true;");
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);
  await app.exec(`
    const input = document.getElementById("sidebar-search");
    input.value = "e2e-real";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await app.waitFor(`#connection-list .conn-item[data-id="${IDS.dest}"]`);

  const openCtx = async (id) => {
    await app.exec(`
      document.getElementById("context-menu").classList.add("hidden");
      const item = document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"]');
      const r = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5,
      }));
      return true;
    `, [id]);
    await app.waitFor("#context-menu:not(.hidden)");
  };
  const sessionIds = () => app.exec(
    "return [...document.querySelectorAll('.tab[data-session]')].map((t) => t.dataset.session);",
  );
  /** Contesta vacías las passphrases que pida y espera a que abra una pestaña SSH nueva conectada. */
  const connectAndWait = async (before) => {
    const started = Date.now();
    while (Date.now() - started < 45000) {
      const state = await app.exec(`
        const overlay = document.getElementById("credential-modal-overlay");
        const prompt = !overlay.classList.contains("hidden");
        const before = arguments[0];
        const tab = [...document.querySelectorAll('.tab[data-session]')].find((t) => !before.includes(t.dataset.session));
        const dot = tab && tab.querySelector(".tab-dot");
        return {
          prompt,
          message: prompt ? document.getElementById("credential-modal-message").textContent : "",
          sid: tab ? tab.dataset.session : null,
          dot: dot ? dot.className : "",
        };
      `, [before]);
      if (state.prompt) {
        await app.exec(`
          document.getElementById("credential-modal-remember").checked = false;
          document.getElementById("credential-modal-input").value = "";
          document.getElementById("btn-credential-submit").click();
          return true;
        `);
        await sleep(300);
        continue;
      }
      if (state.sid && /connected/.test(state.dot)) return state.sid;
      if (state.sid && /error/.test(state.dot)) return null;
      await sleep(250);
    }
    return null;
  };
  const runOn = async (sid, file) => {
    await app.exec(
      "window.__TAURI_INTERNALS__.invoke('ssh_send_input', { sessionId: arguments[0], data: Array.from(new TextEncoder().encode(arguments[1])) }); return true;",
      [sid, `touch '${file}'\n`],
    );
    for (let i = 0; i < 40 && !fs.existsSync(file); i++) await sleep(250);
    return fs.existsSync(file);
  };
  const jumpStats = () => {
    const log = fs.existsSync(jumpLog) ? fs.readFileSync(jumpLog, "utf8") : "";
    const accepted = (log.match(/Accepted publickey for /g) || []).length;
    const channels = [...log.matchAll(/direct_tcpip.*?(?:target|to) \S+ port (\d+)/g)]
      .filter((m) => Number(m[1]) === dest.port).length;
    return { accepted, channels };
  };
  const tabRoute = (sid) => app.exec(`
    const badge = document.querySelector('.tab[data-session="' + arguments[0] + '"] .tab-route-badge');
    return badge ? badge.getAttribute("aria-label") : null;
  `, [sid]);

  try {
    // ── 1. Salto activo desde el menú contextual ──
    await openCtx(IDS.jump);
    await app.jsClick('#context-menu [data-ctx="toggle-active-jump"]');
    await sleep(400);
    const prefs = await app.exec('return JSON.parse(localStorage.getItem("rustty-prefs"));');
    check("salto real: «Usar como salto activo» lo pone", prefs.activeJumpProfileId === IDS.jump, String(prefs.activeJumpProfileId));

    // ── 2. Conectar al destino: sale por el salto ──
    let before = await sessionIds();
    await openCtx(IDS.dest);
    await app.jsClick('#context-menu [data-ctx="connect"]');
    const first = await connectAndWait(before);
    check("salto real: el destino conecta a través del salto activo, cada uno con su clave", Boolean(first), String(first));
    if (!first) return;
    check("salto real: lo tecleado se ejecuta en el destino", await runOn(first, path.join(workDir, "salto-1.txt")));
    const route = await tabRoute(first);
    check("salto real: la pestaña dice por dónde va", Boolean(route && route.includes("e2e-real-salto")), String(route));
    let stats = jumpStats();
    check("salto real: el sshd del salto abrió un canal hacia el destino", stats.accepted === 1 && stats.channels === 1, JSON.stringify(stats));

    // ── 3. Otra sesión «a través de» el mismo salto: reutiliza su conexión ──
    before = await sessionIds();
    await openCtx(IDS.dest);
    await app.jsClick(`#ctx-connect-via-submenu [data-ctx="connect-via"][data-via="${IDS.jump}"]`);
    const second = await connectAndWait(before);
    check("salto real: «Conectar a través de» abre otra sesión por el salto", Boolean(second), String(second));
    if (second) check("salto real: la segunda sesión también ejecuta en el destino", await runOn(second, path.join(workDir, "salto-2.txt")));
    stats = jumpStats();
    check("salto real: la segunda sesión reutiliza la conexión con el salto (una autenticación, dos canales)",
      stats.accepted === 1 && stats.channels === 2, JSON.stringify(stats));

    // ── 4. «Sin saltos (directo)»: no pasa por el salto ──
    before = await sessionIds();
    await openCtx(IDS.dest);
    await app.jsClick('#ctx-connect-via-submenu [data-ctx="connect-via"][data-via="direct"]');
    const direct = await connectAndWait(before);
    check("salto real: «Sin saltos» conecta directo", Boolean(direct), String(direct));
    if (direct) {
      check("salto real: la sesión directa ejecuta en el destino", await runOn(direct, path.join(workDir, "salto-3.txt")));
      check("salto real: y su pestaña no lleva ruta", (await tabRoute(direct)) === null);
    }
    stats = jumpStats();
    check("salto real: la conexión directa no abre canal en el salto", stats.channels === 2, JSON.stringify(stats));

    // ── 5. «Probar el salto» desde la píldora ──
    await app.exec('document.querySelectorAll("#toast-container .toast").forEach((el) => el.remove()); return true;');
    await app.jsClick("#sidebar-route-pill");
    await app.waitFor("#route-menu:not(.hidden)");
    await app.jsClick('#route-menu [data-route-action="probe"]');
    let verdict = "";
    for (let i = 0; i < 60 && !verdict; i++) {
      await sleep(250);
      verdict = await app.exec(`
        const t = [...document.querySelectorAll("#toast-container .toast-message")].map((el) => el.textContent)
          .find((x) => x.includes("túneles") || x.includes("No se pudo probar"));
        return t || "";
      `);
    }
    check("salto real: «Probar el salto» dice que deja abrir túneles",
      verdict.includes("deja abrir túneles") && !verdict.includes("no deja"), verdict);
  } finally {
    await app.exec(`
      document.getElementById("route-menu")?.classList.add("hidden");
      document.getElementById("sidebar-route-clear")?.click();
      return true;
    `).catch(() => {});
  }
}
