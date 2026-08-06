// Guardián del sistema de tokens de color: cuenta los literales `#hex` de
// `src/styles.css` que NO son una definición de paleta ni una excepción
// declarada, y falla si crecen por encima del baseline.
//
// El problema que resuelve: un color de chrome escrito a mano se ve bien en el
// tema en el que se escribió y se rompe —o se queda congelado— en los otros
// doce, en el modo de alto contraste y en los 221 temas precargados. Los tokens
// existen justo para eso, y una regla que solo vive en la documentación no la
// cumple nadie.
//
// Uso:
//   node scripts/check-tokens.mjs            # informe
//   node scripts/check-tokens.mjs --strict   # sale con ≠0 si supera el baseline
//
// El baseline SOLO puede bajar (misma disciplina que `check:i18n`): al reducir
// hallazgos, se baja aquí el número y así no vuelven a subir.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = resolve(root, "src", "styles.css");

/**
 * Deuda tolerada. Está a **cero**: el barrido dejó la hoja sin un solo color
 * de chrome fuera del sistema. Solo puede bajar, nunca subir.
 */
const BASELINE = 0;

/**
 * Selectores exentos: su color describe un tema **ajeno al activo**. Las
 * muestras del selector de Apariencia (`.theme-preview.*`) pintan un trozo de
 * cada uno de los trece temas a la vez; sacarlas de `var(--base)` las pintaría
 * todas iguales, que es justo lo contrario de lo que hacen.
 */
const EXEMPT_SELECTOR = /^\.theme-preview\b/;

const strict = process.argv.includes("--strict");
const css = await readFile(cssPath, "utf8");
const lines = css.split("\n");

const findings = [];
let currentSelector = "";

for (const [index, rawLine] of lines.entries()) {
  const line = rawLine.trim();
  if (line.startsWith("/*") || line.startsWith("*")) continue;

  // Selector en curso: la última línea que abre un bloque.
  if (line.includes("{")) currentSelector = line.slice(0, line.indexOf("{")).trim();

  const matches = rawLine.match(/#[0-9a-fA-F]{3,8}\b/g);
  if (!matches) continue;

  // Definición de token de paleta (`--algo: #hex;`): es la fuente del sistema.
  if (/^--[a-z0-9-]+:\s*#/.test(line)) continue;
  if (EXEMPT_SELECTOR.test(currentSelector)) continue;

  for (const hex of matches) {
    findings.push({ line: index + 1, hex, text: line.slice(0, 100) });
  }
}

const total = findings.length;
console.log(`Colores hex fuera del sistema de tokens: ${total} (baseline ${BASELINE})`);
for (const f of findings) {
  console.log(`  styles.css:${f.line}  ${f.hex}  ${f.text}`);
}

if (total > BASELINE) {
  console.error(
    `\n✗ tokens — ${total - BASELINE} literal(es) de color nuevo(s) fuera del sistema de tokens.\n`
      + "  Enrútalos por una variable CSS (`var(--…)`) o, si describen un tema\n"
      + "  ajeno al activo, decláralos exentos en scripts/check-tokens.mjs.",
  );
  if (strict) process.exit(1);
} else if (total < BASELINE) {
  console.log(`\n✓ tokens — ${BASELINE - total} menos que el baseline. Baja BASELINE a ${total}.`);
} else {
  console.log("\n✓ tokens — sin literales de color nuevos.");
}
