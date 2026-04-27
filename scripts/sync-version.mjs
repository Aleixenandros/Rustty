import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const cargoPath = resolve(root, "src-tauri", "Cargo.toml");

const pkg = JSON.parse(await readFile(packagePath, "utf8"));
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error(`Invalid package.json version: ${pkg.version}`);
}

const cargo = await readFile(cargoPath, "utf8");
const nextCargo = cargo.replace(
  /^version\s*=\s*"[^"]+"/m,
  `version = "${pkg.version}"`
);

if (nextCargo !== cargo) {
  await writeFile(cargoPath, nextCargo);
  console.log(`Synced Cargo.toml version to ${pkg.version}`);
}
