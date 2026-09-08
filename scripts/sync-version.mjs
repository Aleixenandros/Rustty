/**
 * Propaga la versión de `package.json` (fuente única) al resto de ficheros que
 * la declaran, incluida la documentación pública que promete soporte.
 *
 * Uso:
 *   node scripts/sync-version.mjs            escribe los ficheros desincronizados
 *   node scripts/sync-version.mjs --check    no escribe; sale con 1 si hay deriva
 *
 * El modo `--check` es el que corre en CI: `SECURITY.md` llegó a citar la línea
 * 1.35.x con el paquete ya en 1.52.0 —una promesa de soporte falsa— porque nada
 * vigilaba esa deriva. Todo documento público que cite la versión se actualiza
 * desde aquí, no a mano.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const cargoPath = resolve(root, "src-tauri", "Cargo.toml");
const cargoLockPath = resolve(root, "src-tauri", "Cargo.lock");
const securityPath = resolve(root, "SECURITY.md");

const checkOnly = process.argv.includes("--check");

const pkg = JSON.parse(await readFile(packagePath, "utf8"));
const versionPattern = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
const versionRe = new RegExp(`^${versionPattern}$`);
if (!versionRe.test(pkg.version)) {
  throw new Error(`Invalid package.json version: ${pkg.version}`);
}

const version = pkg.version;
/** Línea de soporte que se declara en SECURITY.md: `1.53.0` → `1.53`. */
const minorLine = version.split(".").slice(0, 2).join(".");

/** Ficheros que quedarían desincronizados (solo se rellena con `--check`). */
const stale = [];

function displayPath(path) {
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

async function updateTextFile(path, transform) {
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }

  const next = transform(current);
  if (next === current) return false;
  if (checkOnly) {
    stale.push(displayPath(path));
    return true;
  }
  await writeFile(path, next);
  console.log(`Synced ${displayPath(path)} to ${version}`);
  return true;
}

await updateTextFile(cargoPath, (cargo) =>
  cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`)
);

await updateTextFile(cargoLockPath, (lock) =>
  lock.replace(
    /(\[\[package\]\]\nname = "rustty"\nversion = ")[^"]+(")/,
    `$1${version}$2`
  )
);

// SECURITY.md declara qué línea recibe parches de seguridad: la matriz de
// soporte y la versión citada se derivan de `package.json`.
await updateTextFile(securityPath, (md) =>
  md
    .replace(/la línea \*\*\d+\.\d+\.x\*\*/g, `la línea **${minorLine}.x**`)
    .replace(/declaran `\d+\.\d+\.\d+[^`]*`/g, `declaran \`${version}\``)
    .replace(/^\| \d+\.\d+\.x(\s*)\|/gm, `| ${minorLine}.x$1|`)
    .replace(/^\| < \d+\.\d+(\s*)\|/gm, `| < ${minorLine}$1|`)
    .replace(/última \d+\.\d+\.x/g, `última ${minorLine}.x`)
);

async function updatePackageLock() {
  let lock;
  try {
    lock = JSON.parse(await readFile(packageLockPath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  let changed = false;
  if (lock.version !== version) {
    lock.version = version;
    changed = true;
  }
  if (lock.packages?.[""]?.version !== version) {
    lock.packages[""].version = version;
    changed = true;
  }
  if (!changed) return;
  if (checkOnly) {
    stale.push(displayPath(packageLockPath));
    return;
  }
  await writeFile(packageLockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Synced package-lock.json to ${version}`);
}

await updatePackageLock();

/**
 * Los plugins de Tauri vienen en pareja: un paquete npm (`@tauri-apps/plugin-x`)
 * y un crate de Rust (`tauri-plugin-x`). La CLI de Tauri **exige** que compartan
 * major y minor, y aborta el build si no. Ese aborto llega en el job `build`,
 * ya pasado el gate `verify`: en v2.7.0 costó un ciclo entero de release por
 * subir los paquetes npm sin subir sus crates. Aquí se caza antes, en el mismo
 * `--check` que ya corren la CI y el gate.
 *
 * Solo se compara major.minor, que es lo que exige la CLI; el parche puede
 * divergir sin problema.
 */
async function checkTauriPluginPairs() {
  const cargo = await readFile(cargoPath, "utf8");
  const minor = (v) => String(v).replace(/^[^\d]*/, "").split(".").slice(0, 2).join(".");
  const mismatched = [];

  for (const [npmName, npmVersion] of Object.entries(pkg.dependencies || {})) {
    const plugin = npmName.startsWith("@tauri-apps/plugin-")
      ? npmName.slice("@tauri-apps/plugin-".length)
      : null;
    if (!plugin) continue;
    const crate = `tauri-plugin-${plugin}`;
    // La versión del crate puede ir suelta (`= "2.11.0"`) o dentro de una tabla
    // (`= { version = "2.11.0", features = [...] }`).
    const declared = cargo.match(
      new RegExp(`^${crate}\\s*=\\s*(?:"([^"]+)"|\\{[^}]*?version\\s*=\\s*"([^"]+)")`, "m")
    );
    if (!declared) continue;
    const crateVersion = declared[1] ?? declared[2];
    // Un requisito laxo (`"2"`) cubre cualquier minor: no puede desajustarse.
    if (!crateVersion.includes(".")) continue;
    if (minor(crateVersion) !== minor(npmVersion)) {
      mismatched.push(`  - ${crate} (${crateVersion}) ≠ ${npmName} (${npmVersion})`);
    }
  }

  if (mismatched.length) {
    console.error(
      "Plugins de Tauri descuadrados entre npm y Rust (la CLI de Tauri exige el\n" +
        "mismo major.minor y aborta el build):\n" +
        mismatched.join("\n") +
        "\n\nSube el crate en src-tauri/Cargo.toml a la altura de su paquete npm."
    );
    process.exit(1);
  }
}

await checkTauriPluginPairs();

if (checkOnly && stale.length) {
  console.error(
    `La versión ${version} de package.json no está propagada a:\n` +
      stale.map((f) => `  - ${f}`).join("\n") +
      "\n\nEjecuta `npm run sync-version` y vuelve a commitear."
  );
  process.exit(1);
}
