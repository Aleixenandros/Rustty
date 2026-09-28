// Servidor SSH/SFTP de verdad para el smoke E2E: un `sshd` sin privilegios en un
// puerto libre de 127.0.0.1, con claves propias y solo clave pública. Es la
// versión JavaScript de `src-tauri/src/ssh_fixture.rs` (misma configuración,
// ya probada en CI); el SFTP lo sirve `internal-sftp` sobre el disco real, así
// que las rutas «remotas» son carpetas del directorio de trabajo del test.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SSHD_CANDIDATES = ["/usr/sbin/sshd", "/usr/bin/sshd", "/usr/local/sbin/sshd"];

/** Ruta de `sshd`, o `null` si la máquina no lo tiene. */
export function findSshd() {
  const found = SSHD_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) return null;
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
  } catch (err) {
    // `ssh-keygen -?` sale con código distinto de cero pero existe; solo falla
    // de verdad si no se encuentra el binario.
    if (err.code === "ENOENT") return null;
  }
  return found;
}

/** Un puerto libre de 127.0.0.1 (el sistema lo asigna y se libera al momento). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function keygen(file) {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], { stdio: "ignore" });
}

/** Espera a que el puerto acepte conexiones. */
async function waitForPort(port, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() - started > timeoutMs) throw new Error(`sshd no escucha en ${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Arranca `sshd` en `dir`. Devuelve `{ port, clientKey, knownHostsLine, user, stop }`.
 * @param {string} sshd  Binario de `sshd`.
 * @param {string} dir   Carpeta de trabajo (se crea).
 */
export async function startSshd(sshd, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const hostKey = path.join(dir, "host_ed25519");
  const clientKey = path.join(dir, "client_ed25519");
  keygen(hostKey);
  keygen(clientKey);
  const authorized = path.join(dir, "authorized_keys");
  fs.copyFileSync(`${clientKey}.pub`, authorized);
  fs.chmodSync(authorized, 0o600);
  const port = await freePort();
  const config = path.join(dir, "sshd_config");
  // `StrictModes no` y `UsePAM no`: sin privilegios no hay PAM, y el HOME del
  // runner puede no tener los permisos que sshd exige. Solo clave pública.
  fs.writeFileSync(
    config,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      `PidFile ${path.join(dir, "sshd.pid")}`,
      `AuthorizedKeysFile ${authorized}`,
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "PubkeyAuthentication yes",
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"),
  );
  const child = spawn(sshd, ["-D", "-e", "-f", config], { stdio: "ignore" });
  await waitForPort(port, 10000);
  const hostPub = fs.readFileSync(`${hostKey}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  return {
    port,
    clientKey,
    knownHostsLine: `[127.0.0.1]:${port} ${hostPub}`,
    user: os.userInfo().username,
    stop: () => child.kill("SIGTERM"),
  };
}
