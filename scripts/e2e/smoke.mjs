#!/usr/bin/env node
// Smoke test de extremo a extremo: arranca Rustty de verdad, con un directorio
// de datos AISLADO, y comprueba lo que ningún test unitario puede ver.
//
//   1. La interfaz monta y enseña el dashboard.
//   2. Una consola local abre, ejecuta un comando y devuelve UTF-8 entero.
//   3. Al recargar el webview con esa consola viva, el backend la BARRE
//      (`sweep_orphan_sessions`): no quedan shells sin dueño.
//   4. Una consola que termina deja el aviso de cierre DESPUÉS de su salida.
//   5. Mínimo privilegio del IPC: sin permiso del diálogo no se lee ni se
//      escribe nada; los `Include` de ~/.ssh/config no salen de ~/.ssh ni
//      devuelven una clave privada; un comando local autorizado recibe un valor
//      malicioso sin interpretarlo, y uno sin autorizar abre el diálogo NATIVO
//      (se cierra con `wmctrl`, que equivale a no autorizar); el selector de
//      ficheros lo abre el backend y el renderer ya no alcanza el plugin.
//      Elegir un fichero de verdad en el diálogo GTK no se puede automatizar.
//
// Requisitos (solo Linux): `tauri-driver` en el PATH (o en $TAURI_DRIVER),
// `WebKitWebDriver` (paquete webkit2gtk-driver / webkitgtk), el binario debug
// compilado (`cargo build` en src-tauri/) y un display (o `xvfb-run`).
//
//   npm run e2e:smoke
//
// No corre en CI a propósito: depende del WebKitWebDriver del sistema.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, sleep } from "./webdriver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const application = path.join(root, "src-tauri/target/debug/rustty");
const driverBin = process.env.TAURI_DRIVER || "tauri-driver";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rustty-e2e-"));
const children = [];
const failures = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok " : " FALLO"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function start(cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
  children.push(child);
  return child;
}

/** Espera a que responda ALGUNA de las URLs (la misma máquina por IPv6 o IPv4). */
async function waitForHttp(urls, timeoutMs) {
  const started = Date.now();
  for (;;) {
    for (const url of urls) {
      try {
        await fetch(url);
        return;
      } catch {
        /* aún no escucha ahí */
      }
    }
    if (Date.now() - started > timeoutMs) throw new Error(`sin respuesta de ${urls.join(" ni ")}`);
    await sleep(300);
  }
}

function readLog() {
  const file = path.join(workDir, "com.rustty.app/logs/rustty.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** ¿Hay una ventana (X11) cuyo título contenga `title`? Espera hasta el plazo. */
async function waitForWindow(title, timeoutMs) {
  const started = Date.now();
  for (;;) {
    let list = "";
    try {
      list = execFileSync("wmctrl", ["-l"], { encoding: "utf8" });
    } catch {
      /* sin gestor de ventanas o sin wmctrl */
    }
    if (list.includes(title)) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(250);
  }
}

/** Captura la ventana con ese título (ImageMagick `import`), si se pidió. */
function captureWindow(title, file) {
  if (!file) return;
  try {
    const line = execFileSync("wmctrl", ["-l"], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.includes(title));
    if (line) execFileSync("import", ["-window", line.split(/\s+/)[0], file]);
  } catch {
    /* la captura es opcional */
  }
}

/** Cierra (como el botón de la barra de título) la ventana con ese título. */
function closeWindow(title) {
  try {
    execFileSync("wmctrl", ["-c", title]);
  } catch {
    /* ya no estaba */
  }
}

/**
 * Autoriza de antemano una plantilla de comando local, como si el usuario la
 * hubiera aceptado en el diálogo: mismo fichero y misma huella que
 * `local_command_policy.rs` (SHA-256 del texto sin bordes).
 */
function seedTrustedCommand(template) {
  const hash = crypto.createHash("sha256").update(template.trim()).digest("hex");
  const file = path.join(workDir, "com.rustty.app/trusted_local_commands.json");
  const doc = { version: 2, kind: "trusted_local_commands", items: [{ hash, approved: 0 }] };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

/** HOME falso con un ~/.ssh de prueba: un Include legítimo y una clave. */
function prepareHome() {
  const home = path.join(workDir, "home");
  fs.mkdirSync(path.join(home, ".ssh/config.d"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh/config.d/work"), "Host work\n  HostName 10.0.0.9\n");
  fs.writeFileSync(
    path.join(home, ".ssh/id_e2e"),
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
  );
  fs.writeFileSync(path.join(home, "notas.txt"), "secreto\n");
  return home;
}

/** Sección 5: los límites del IPC de ficheros y de los comandos locales. */
async function checkIpcLeastPrivilege(app, home) {
  const invented = await app.invoke("read_text_file", { grant: "inventado", maxBytes: 1024 });
  check("un permiso inventado no lee nada", !invented.ok && invented.reason.startsWith("fs-grant:"), invented.reason);
  const byPath = await app.invoke("read_text_file", { path: "/etc/hostname" });
  check("ya no se puede leer por ruta", !byPath.ok, byPath.reason);
  const target = path.join(workDir, "escrito-por-ruta.txt");
  const writeByPath = await app.invoke("write_text_file", { path: target, contents: "x" });
  check("ya no se puede escribir por ruta", !writeByPath.ok && !fs.existsSync(target), writeByPath.reason);

  const inc = await app.invoke("read_ssh_config_include", { path: path.join(home, ".ssh/config.d/work") });
  check("un Include bajo ~/.ssh se lee", inc.ok && String(inc.value).includes("Host work"), inc.reason);
  const key = await app.invoke("read_ssh_config_include", { path: path.join(home, ".ssh/id_e2e") });
  check("una clave privada bajo ~/.ssh no se devuelve", !key.ok && key.reason.startsWith("fs-grant:"), key.reason);
  const outside = await app.invoke("read_ssh_config_include", { path: path.join(home, "notas.txt") });
  check("un Include fuera de ~/.ssh se rechaza", !outside.ok && outside.reason.startsWith("fs-grant:"), outside.reason);

  const out = path.join(workDir, "comando.txt");
  const canary = path.join(workDir, "inyectado");
  const template = `printf '[%s]' \${ask:valor} > '${out}'`;
  seedTrustedCommand(template);
  const payload = `a; touch '${canary}'`;
  const ran = await app.invoke("run_local_command", {
    request: { template, name: "e2e", asks: { valor: payload }, lang: "es", timeoutSecs: 10 },
  });
  const written = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  check(
    "un comando autorizado recibe un valor malicioso sin ejecutarlo",
    ran.ok && written === `[${payload}]` && !fs.existsSync(canary),
    ran.ok ? JSON.stringify(written) : ran.reason,
  );

  const promptTitle = "Autorizar comando local";
  await app.invokeDetached("untrusted", "run_local_command", {
    request: {
      template: `touch '${canary}' && ping -c 1 \${host} | tee "\${ask:Fichero}"`,
      name: "sin autorizar",
      context: { host: "10.0.0.9" },
      asks: { Fichero: "salida.txt" },
      lang: "es",
      timeoutSecs: 10,
    },
  });
  const prompted = await waitForWindow(promptTitle, 15000);
  check("un comando sin autorizar abre el diálogo nativo", prompted);
  if (prompted) {
    await sleep(500);
    captureWindow(promptTitle, process.env.E2E_DIALOG_SCREENSHOT);
    closeWindow(promptTitle);
  }
  const rejected = await app.result("untrusted");
  check(
    "cerrar el diálogo de autorización no ejecuta nada",
    Boolean(rejected) && !rejected.ok && rejected.reason.startsWith("local-command:rejected") && !fs.existsSync(canary),
    JSON.stringify(rejected),
  );

  const pickTitle = "E2E elegir fichero";
  await app.invokeDetached("pick", "fs_pick", { options: { mode: "open", title: pickTitle, filters: [] } });
  const picker = await waitForWindow(pickTitle, 15000);
  check("el selector de ficheros lo abre el backend", picker);
  if (picker) closeWindow(pickTitle);
  const picked = await app.result("pick");
  check("cancelar el selector no da ningún permiso", Boolean(picked) && picked.ok && picked.value === null, JSON.stringify(picked));

  const directTitle = "E2E plugin directo";
  await app.invokeDetached("direct", "plugin:dialog|open", { options: { title: directTitle } });
  const directWindow = await waitForWindow(directTitle, 3000);
  if (directWindow) closeWindow(directTitle);
  const direct = await app.result("direct", 5000);
  check(
    "el renderer ya no alcanza el plugin de diálogos",
    !directWindow && Boolean(direct) && !direct.ok,
    direct ? direct.reason : "sin respuesta",
  );
}

async function main() {
  if (!fs.existsSync(application)) {
    throw new Error(`falta ${application}: compila antes con «cargo build» en src-tauri/`);
  }
  // El binario debug carga la interfaz del servidor de desarrollo.
  start("npx", ["vite", "--strictPort"]);
  // Vite escucha en `localhost`, que aquí es solo ::1; el `fetch` de Node
  // resuelve `localhost` a 127.0.0.1 y se queda esperando a nadie.
  await waitForHttp(["http://[::1]:1420", "http://127.0.0.1:1420"], 60000);
  // XDG_DATA_HOME aísla perfiles, preferencias, sync y log del usuario real;
  // GDK_BACKEND=x11 hace visible la ventana (y sus diálogos) a wmctrl y a las
  // herramientas de captura. HOME apunta a un ~/.ssh de prueba; XAUTHORITY se
  // fija para que el cambio de HOME no deje a la app sin acceso al display.
  const home = prepareHome();
  start(driverBin, ["--port", "4444"], {
    XDG_DATA_HOME: workDir,
    GDK_BACKEND: "x11",
    HOME: home,
    XAUTHORITY: process.env.XAUTHORITY || path.join(os.homedir(), ".Xauthority"),
  });
  await waitForHttp(["http://127.0.0.1:4444/status"], 20000);

  const app = await openSession({ application });
  try {
    await app.waitFor("#btn-welcome-local", 60000);
    await sleep(2500);
    check("la interfaz monta y enseña el dashboard", true);

    await app.jsClick("#btn-welcome-local");
    await app.waitFor(".xterm-helper-textarea");
    await sleep(2000);
    const first = await app.lastSessionId();
    check("abre una consola local", typeof first === "string" && first.startsWith("local-"), String(first));

    // Recarga con la consola viva: es un frontend nuevo y la consola, huérfana.
    await app.exec("setTimeout(() => location.reload(), 50); return true;");
    await sleep(5000);
    await app.waitFor("#btn-welcome-local", 60000);
    await sleep(2000);
    check(
      "el backend barre la consola del frontend anterior",
      /barrido al arrancar la interfaz: 0 SSH, 0 SFTP y 1 consolas/.test(readLog()),
    );

    // Consola nueva: UTF-8 partido en bytes por `printf`, y cierre ordenado.
    const marker = path.join(workDir, "salida.txt");
    await app.jsClick("#btn-welcome-local");
    await app.waitFor(".xterm-helper-textarea");
    await sleep(2500);
    const second = await app.lastSessionId();
    await app.typeIntoLocalShell(second, `printf 'a\\xc3\\xb1o \\xe2\\x94\\x80 ok\\n' > '${marker}'; exit\n`);
    await sleep(3000);
    const written = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    check("la consola ejecuta lo tecleado", written === "año ─ ok\n", JSON.stringify(written));
    const closed = await app.exec(
      "const tab = document.querySelector('.tab[data-session=\"' + arguments[0] + '\"] .tab-dot'); return tab ? tab.className : '';",
      [second],
    );
    check("al terminar el shell la pestaña pasa a cerrada", /error/.test(String(closed)), String(closed));

    await checkIpcLeastPrivilege(app, home);
    if (process.env.E2E_SCREENSHOT) await app.screenshot(process.env.E2E_SCREENSHOT);
  } finally {
    await app.close().catch(() => {});
  }
}

let exitCode = 0;
try {
  await main();
  if (failures.length) exitCode = 1;
} catch (err) {
  console.error(`\nE2E abortado: ${err.message}`);
  exitCode = 2;
} finally {
  for (const child of children) child.kill("SIGTERM");
  // Los procesos recién terminados pueden seguir escribiendo un instante
  // (cachés de GTK en el HOME de prueba): se reintenta en vez de fallar.
  await sleep(500);
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(exitCode === 0 ? "\nSmoke E2E: todo en orden." : `\nSmoke E2E: ${failures.length} comprobaciones fallidas.`);
process.exit(exitCode);
