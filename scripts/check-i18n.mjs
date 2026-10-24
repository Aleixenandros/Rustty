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
//   .placeholder = "…"            ídem en un campo (así se colaba «(configurada)»)
//   title="…" / aria-label="…" / placeholder="…"   atributos en plantillas HTML
//
// Las plantillas (`…${x}…`) se leen aparte, con un analizador que sigue las
// interpolaciones anidadas: lo que cuenta es su **tramo literal**. Así se ve
// toast(`No se pudo mover: ${err}`) —«No se pudo mover:» es castellano fijo—,
// mientras que toast(`${t("x.y")}: ${err}`) o toast(`${err}`) no dejan texto
// propio y no son hallazgos.
//
// En `toast(…)`, `.textContent =` y `.placeholder =` se lee además la
// expresión entera: las ramas de un ternario o el lado derecho de un `||`
// (`toast(ok ? "Hecho" : "Falló")`), sin contar las claves de `t("…")`.
//
// Ficheros: `main.js`, `sync.js`, los módulos de `src/modules/` (sin tests) e
// `index.html`. En el HTML cuenta el texto entre etiquetas sin `data-i18n` (en
// el elemento o un ancestro) y los atributos `title`/`data-tooltip`/
// `aria-label`/`placeholder` sin su `data-i18n-*`: ver `i18n-html.mjs`.
//
// Qué NO es un hallazgo (heurística deliberadamente estrecha, para que un aviso
// signifique siempre algo):
//   - Cadenas sin letras (glifos `✕ ↑ ⟳`, números, símbolos, rutas).
//   - Lo que llega interpolado (`${…}`) o ya viene de `t(…)`.
//   - Términos canónicos que NO se traducen (protocolos, comandos, nombres
//     propios): ver `CANONICAL`.
//   - Una línea marcada con el comentario `i18n-exempt` (con el motivo al lado);
//     en una plantilla de varias líneas, la línea donde empieza.
//
// Cómo exentar algo legítimo: añade `// i18n-exempt: <motivo>` en la línea
// (en HTML, `<!-- i18n-exempt: <motivo> -->`). Un texto del HTML que no se
// traduce por naturaleza (nombre propio, licencia, glifo) lleva mejor
// `translate="no"` en su elemento: es el atributo estándar y lo respetan
// también los traductores del navegador.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { expressionLiterals, templateLiteralText } from "./i18n-template.mjs";
import { untranslatedHtmlTexts } from "./i18n-html.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const update = process.argv.includes("--update");
const baselinePath = resolve(root, "scripts", "i18n-baseline.json");

/**
 * Módulos puros de `src/modules/` (sin sus tests): hoy casi ninguno pinta
 * texto, pero el día que uno lo haga debe pasar por el mismo filtro.
 */
const MODULE_FILES = (await readdir(resolve(root, "src/modules"), { recursive: true }))
  .map((f) => `src/modules/${f.split("\\").join("/")}`)
  .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
  .sort();

/**
 * Ficheros analizados: los que pintan UI. `index.html` (el chasis, traducido
 * con `data-i18n*`) tiene su propio analizador: `i18n-html.mjs`.
 */
const FILES = ["index.html", "src/main.js", "src/sync.js", ...MODULE_FILES];

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
  // «error» no está a propósito: fr/pt/de lo traducen (Erreur, Erro, Fehler),
  // y con él dentro se colaba `Error: ${err}`.
  "ok", "warn", "info", "debug", "log", "logs", "wol", "mac", "cwd", "pty",
  "xterm", "ansi", "utf", "utf-8", "base64", "sha256", "aes", "age", "argon2",
  // Unidades: «64 KiB» o «12 ms» se escriben igual en los cinco idiomas.
  "px", "ms", "kib", "mib", "gib", "kb", "mb", "gb",
]);

/**
 * Contextos donde una cadena literal es texto visible para el usuario.
 * Las comillas simples y dobles se miran aquí, línea a línea; las plantillas
 * (comilla invertida), en `TEMPLATE_CONTEXTS`.
 */
const PATTERNS = [
  { name: "toast", re: /\btoast\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "textContent", re: /\.textContent\s*=\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "placeholder", re: /\.placeholder\s*=\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "title", re: /\btitle:\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "message", re: /\bmessage:\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  { name: "submitLabel", re: /\bsubmitLabel:\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g, group: 2 },
  // El `(?<![-\w])` descarta los atributos `data-i18n-title=` / `data-i18n-…`,
  // cuyo valor es **una clave** del catálogo y no texto visible: con `\b` se
  // colaban como si fueran cadenas sin traducir.
  { name: "attr title=", re: /(?<![-\w])title="([^"${}<>]*)"/g, group: 1 },
  { name: "attr aria-label=", re: /(?<![-\w])aria-label="([^"${}<>]*)"/g, group: 1 },
  { name: "attr placeholder=", re: /(?<![-\w])placeholder="([^"${}<>]*)"/g, group: 1 },
];

/** Los mismos contextos cuando el valor es una plantilla: la regex solo localiza la comilla de apertura. */
const TEMPLATE_CONTEXTS = [
  { name: "toast", re: /\btoast\(\s*`/g },
  { name: "textContent", re: /\.textContent\s*=\s*`/g },
  { name: "placeholder", re: /\.placeholder\s*=\s*`/g },
  { name: "title", re: /\btitle:\s*`/g },
  { name: "message", re: /\bmessage:\s*`/g },
  { name: "submitLabel", re: /\bsubmitLabel:\s*`/g },
];

/**
 * Contextos cuyo valor se lee como expresión entera y no solo por la comilla
 * pegada al contexto: así se ven las ramas de un ternario o de un `||`
 * (`toast(ok ? "Hecho" : "Falló")`, `x.textContent = n || "Ninguno"`). Las
 * claves de `t("…")` y los lados de una comparación no cuentan; ver
 * `expressionLiterals`.
 */
const EXPRESSION_CONTEXTS = [
  { name: "toast", re: /\btoast\(/g },
  { name: "textContent", re: /\.textContent\s*=(?!=)/g },
  { name: "placeholder", re: /\.placeholder\s*=(?!=)/g },
];

/** ¿La cadena tiene texto que un humano leería (y por tanto habría que traducir)? */
function isVisibleText(raw) {
  const s = String(raw).trim();
  if (!s) return false;
  // Interpolada o ya traducida: la resuelve otro sitio.
  if (s.includes("${")) return false;
  // Sin letras no hay nada que traducir (glifos, números, símbolos, rutas).
  if (!/\p{L}/u.test(s)) return false;
  // Rutas, URL y dominios (`~/.ssh/id_rsa`, `/var/www`, `rustty.es`): se
  // muestran tal cual en todos los idiomas.
  if (/^(?:~\/|\.{0,2}\/|[a-z][\w+.-]*:\/\/)\S/i.test(s)) return false;
  if (/^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?$/i.test(s)) return false;
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

/** Recorta un texto largo para el informe (y para la clave del baseline). */
function clip(text) {
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

for (const rel of FILES) {
  let src;
  try {
    src = await readFile(resolve(root, rel), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") continue;
    throw err;
  }
  const lines = src.split("\n");

  // El chasis HTML: texto entre etiquetas y atributos visibles sin su
  // `data-i18n*`. Se exenta igual, con `<!-- i18n-exempt: <motivo> -->` en la línea.
  if (rel.endsWith(".html")) {
    for (const f of untranslatedHtmlTexts(src)) {
      if (lines[f.line - 1].includes("i18n-exempt")) continue;
      if (!isVisibleText(f.text)) continue;
      findings.push({ file: rel, line: f.line, context: `html ${f.context}`, text: clip(f.text) });
    }
    continue;
  }

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

  // Plantillas: sobre el fichero entero, porque pueden ocupar varias líneas.
  for (const { name, re } of TEMPLATE_CONTEXTS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      const line = src.slice(0, m.index).split("\n").length;
      if (lines[line - 1].includes("i18n-exempt")) continue;
      const text = templateLiteralText(src, open);
      if (!isVisibleText(text)) continue;
      findings.push({
        file: rel,
        line,
        context: `${name} (plantilla)`,
        text: text.length > 70 ? `${text.slice(0, 70)}…` : text,
      });
    }
  }

  // Expresiones: el resto de literales del valor (ramas de un ternario, el
  // lado derecho de un `||`). El literal que abre el valor ya lo han mirado
  // las dos pasadas anteriores si está en la misma línea (o es una plantilla).
  for (const { name, re } of EXPRESSION_CONTEXTS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const start = m.index + m[0].length;
      const openLine = src.slice(0, m.index).split("\n").length;
      if (lines[openLine - 1].includes("i18n-exempt")) continue;
      const leading = start + (src.slice(start).length - src.slice(start).trimStart().length);
      for (const lit of expressionLiterals(src, start)) {
        const line = src.slice(0, lit.pos).split("\n").length;
        if (lit.pos === leading && (lit.template || line === openLine)) continue;
        if (lines[line - 1].includes("i18n-exempt")) continue;
        if (!isVisibleText(lit.text)) continue;
        findings.push({ file: rel, line, context: `${name} (expresión)`, text: clip(lit.text) });
      }
    }
  }
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
