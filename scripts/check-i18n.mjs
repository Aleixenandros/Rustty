// Detecta texto visible **hardcodeado** fuera de `t()` en el frontend.
//
// La paridad de claves (`src/i18n.test.js`) garantiza que los 5 catálogos tengan
// las mismas claves, pero no ve una cadena castellana incrustada directamente en
// `main.js` o en HTML generado en runtime: esa frase nunca llega al catálogo y
// por tanto nunca se traduce. Este lint cubre ese hueco.
//
// Uso:
//   node scripts/check-i18n.mjs           # informe completo
//   node scripts/check-i18n.mjs --strict  # falla si hay hallazgos NUEVOS (en CI)
//   node scripts/check-i18n.mjs --update  # reescribe el baseline con lo que hay hoy
//
// **Baseline.** El barrido de las cadenas ya incrustadas es una tarea aparte (y
// larga: cada una necesita clave nueva en los 5 idiomas). Para no dejar el lint
// como un informe que nadie mira, los hallazgos conocidos viven en
// `scripts/i18n-baseline.json` y el modo `--strict` **solo falla con los nuevos**:
// desde hoy no entra ni una cadena castellana más, y el baseline solo puede
// encoger. Se indexa por texto (no por número de línea) para que mover código no
// lo invalide.
//
// Qué mira (contextos donde una cadena literal **se ve**):
//   toast("…")                    avisos
//   confirmThemed({ title: "…" }) diálogos (title/message/submitLabel)
//   promptCredential({ … })       ídem
//   .textContent = "…"            texto inyectado en el DOM
//   title="…" / aria-label="…" / placeholder="…"   atributos en plantillas HTML
//
// Qué NO es un hallazgo (heurística deliberadamente estrecha, para que un aviso
// signifique siempre algo):
//   - Cadenas sin letras (glifos `✕ ↑ ⟳`, números, símbolos, rutas).
//   - Cadenas interpoladas (`${…}`) o que ya vienen de `t(…)`.
//   - Términos canónicos que NO se traducen (protocolos, comandos, nombres
//     propios): ver `CANONICAL`.
//   - Una línea marcada con el comentario `i18n-exempt` (con el motivo al lado).
//
// Cómo exentar algo legítimo: añade `// i18n-exempt: <motivo>` en la línea.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const update = process.argv.includes("--update");
const baselinePath = resolve(root, "scripts", "i18n-baseline.json");

/** Ficheros analizados: los que pintan UI. */
const FILES = ["src/main.js", "src/sync.js"];

/**
 * Términos canónicos que se muestran tal cual en todos los idiomas (protocolos,
 * comandos, nombres de producto, formatos). Una cadena compuesta solo por ellos
 * no es un hallazgo.
 */
const CANONICAL = new Set([
  "ssh", "sftp", "ftp", "ftps", "rdp", "vnc", "telnet", "scp", "socks", "socks5",
  "http", "https", "webdav", "url", "uri", "ip", "ipv4", "ipv6", "dns", "tcp", "udp",
  "id", "uuid", "json", "xml", "yaml", "csv", "md", "markdown", "pem", "ppk", "kdbx",
  "keepass", "keychain", "keyring", "rustty", "tmux", "git", "sudo", "root",
  "mremoteng", "asbru", "putty", "termius", "windows", "macos", "linux",
  "google", "drive", "icloud", "onedrive", "dropbox", "github",
  "ok", "error", "warn", "info", "debug", "log", "logs", "wol", "mac", "cwd", "pty",
  "xterm", "ansi", "utf", "utf-8", "base64", "sha256", "aes", "age", "argon2",
]);

/** Contextos donde una cadena literal es texto visible para el usuario. */
const PATTERNS = [
  { name: "toast", re: /\btoast\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "textContent", re: /\.textContent\s*=\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "title", re: /\btitle:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "message", re: /\bmessage:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "submitLabel", re: /\bsubmitLabel:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "attr title=", re: /\btitle="([^"${}<>]*)"/g, group: 1 },
  { name: "attr aria-label=", re: /\baria-label="([^"${}<>]*)"/g, group: 1 },
  { name: "attr placeholder=", re: /\bplaceholder="([^"${}<>]*)"/g, group: 1 },
];

/** ¿La cadena tiene texto que un humano leería (y por tanto habría que traducir)? */
function isVisibleText(raw) {
  const s = String(raw).trim();
  if (!s) return false;
  // Interpolada o ya traducida: la resuelve otro sitio.
  if (s.includes("${")) return false;
  // Sin letras no hay nada que traducir (glifos, números, símbolos, rutas).
  if (!/\p{L}/u.test(s)) return false;
  // Una sola "palabra" sin espacios y sin acentos suele ser un identificador,
  // una clase CSS o un valor; el texto visible casi siempre tiene más de una
  // palabra o lleva acentos/signos castellanos.
  const words = s.split(/[\s/·|,.:;()[\]{}"'!¡?¿–—-]+/).filter(Boolean);
  const meaningful = words.filter((w) => /\p{L}{2,}/u.test(w));
  if (meaningful.length === 0) return false;
  // Compuesta solo de términos canónicos → no se traduce.
  if (meaningful.every((w) => CANONICAL.has(w.toLowerCase()))) return false;
  // Una sola palabra ASCII en minúsculas: probablemente una clave o un valor.
  if (meaningful.length === 1 && /^[a-z0-9_-]+$/.test(meaningful[0])) return false;
  return true;
}

const findings = [];

for (const rel of FILES) {
  let src;
  try {
    src = await readFile(resolve(root, rel), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") continue;
    throw err;
  }
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    if (line.includes("i18n-exempt")) return;
    for (const { name, re, group } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const text = m[group];
        if (!isVisibleText(text)) continue;
        findings.push({
          file: rel,
          line: i + 1,
          context: name,
          text: text.length > 70 ? `${text.slice(0, 70)}…` : text,
        });
      }
    }
  });
}

/** Identidad estable de un hallazgo: no depende del número de línea. */
function key(f) {
  return `${f.file}|${f.context}|${f.text}`;
}

if (update) {
  const entries = [...new Set(findings.map(key))].sort();
  await writeFile(baselinePath, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Baseline reescrito: ${entries.length} cadena(s) conocidas.`);
  process.exit(0);
}

/** @type {Set<string>} */
let baseline = new Set();
try {
  baseline = new Set(JSON.parse(await readFile(baselinePath, "utf8")));
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
}

const nuevos = findings.filter((f) => !baseline.has(key(f)));
const vistos = new Set(findings.map(key));
const resueltos = [...baseline].filter((k) => !vistos.has(k));

if (nuevos.length) {
  console.error(`Texto visible fuera de t() — ${nuevos.length} hallazgo(s) NUEVOS:\n`);
  for (const f of nuevos) {
    console.error(`  ${relative(".", f.file)}:${f.line}  [${f.context}]  «${f.text}»`);
  }
  console.error(
    "\nEnruta cada cadena por t() con su clave en los 5 idiomas, o marca la línea" +
      "\ncon `// i18n-exempt: <motivo>` si de verdad es texto canónico." +
      "\n(El baseline solo puede encoger: no añadas cadenas nuevas con --update.)"
  );
  if (strict) process.exit(1);
} else {
  console.log(
    `✓ i18n — sin cadenas nuevas fuera de t(). ` +
      `Deuda conocida: ${findings.length} (baseline: ${baseline.size}).`
  );
}

if (resueltos.length) {
  console.log(
    `\n${resueltos.length} cadena(s) del baseline ya no aparecen: ` +
      "ejecuta `npm run check:i18n:update` para podarlo."
  );
  for (const k of resueltos.slice(0, 10)) console.log(`  - ${k}`);
}
