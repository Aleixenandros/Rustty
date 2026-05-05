import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const cargoPath = resolve(root, "src-tauri", "Cargo.toml");
const cargoLockPath = resolve(root, "src-tauri", "Cargo.lock");
const readmePath = resolve(root, "README.md");

const pkg = JSON.parse(await readFile(packagePath, "utf8"));
const versionPattern = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
const versionRe = new RegExp(`^${versionPattern}$`);
if (!versionRe.test(pkg.version)) {
  throw new Error(`Invalid package.json version: ${pkg.version}`);
}

const version = pkg.version;
const tag = `v${version}`;

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
  await writeFile(path, next);
  console.log(`Synced ${displayPath(path)} to ${version}`);
  return true;
}

function displayPath(path) {
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
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

await updateTextFile(readmePath, (readme) =>
  readme.replace(
    /Última versión publicada: \*\*[^*]+\*\*/,
    `Última versión publicada: **${version}**`
  )
);

try {
  const lock = JSON.parse(await readFile(packageLockPath, "utf8"));
  let changed = false;
  if (lock.version !== version) {
    lock.version = version;
    changed = true;
  }
  if (lock.packages?.[""]?.version !== version) {
    lock.packages[""].version = version;
    changed = true;
  }
  if (changed) {
    await writeFile(packageLockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`Synced package-lock.json to ${version}`);
  }
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
}
