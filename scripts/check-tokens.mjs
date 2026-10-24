// Guardián del sistema de tokens de color: cuenta los literales `#hex` de
// `src/styles.css` que NO son una definición de paleta ni una excepción
// declarada, y falla si crecen por encima del baseline.
//
// Dos reglas más, también con baseline 0:
// - Capas: un `z-index` de capa (≥ 100) va por la escala `var(--z-*)` de
//   `:root`. Con números sueltos, los avisos acabaron por debajo de los modales.
// - Tokens inexistentes: un `var(--x)` sin definición en la hoja (ni entre las
//   variables que pone el código en runtime) cae en silencio a su valor
//   inicial: así la muestra «Rosa» salía gris y el contador del rail a 400.
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

/**
 * Variables que no se definen en la hoja porque las pone el código en
 * runtime (`style.setProperty`, atributos `style` de las plantillas).
 */
const RUNTIME_VARS = new Set([
  "--connection-modal-height", "--connection-modal-width", // tamaño recordado del modal de conexión
  "--folder-tint", "--pin-tint", "--workspace-tint",       // colores de carpeta/workspace por elemento
  "--term-bg-blur", "--term-bg-image", "--term-bg-opacity", // imagen de fondo del terminal
  "--terminal-font", "--ui-zoom",
  "--modal-header-h",                                       // altura medida de la cabecera del modal de conexión
]);

/** `z-index` a partir del cual es una capa de la app (los menores apilan dentro de un componente). */
const Z_LAYER_MIN = 100;

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

// Capas fuera de la escala `--z-*`.
for (const [index, rawLine] of lines.entries()) {
  if (rawLine.trim().startsWith("/*") || rawLine.trim().startsWith("*")) continue;
  for (const m of rawLine.matchAll(/(?:^|[\s;{])z-index:\s*(-?\d+)/g)) {
    if (Math.abs(Number(m[1])) < Z_LAYER_MIN) continue;
    findings.push({ line: index + 1, hex: `z-index ${m[1]}`, text: "usa la escala var(--z-*) de :root" });
  }
}

// `var(--x)` sin definición.
const defined = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
for (const [index, rawLine] of lines.entries()) {
  if (rawLine.trim().startsWith("/*") || rawLine.trim().startsWith("*")) continue;
  for (const m of rawLine.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
    if (defined.has(m[1]) || RUNTIME_VARS.has(m[1])) continue;
    findings.push({ line: index + 1, hex: m[1], text: "variable sin definir" });
  }
}

const total = findings.length;
console.log(`Hallazgos fuera del sistema de tokens: ${total} (baseline ${BASELINE})`);
for (const f of findings) {
  console.log(`  styles.css:${f.line}  ${f.hex}  ${f.text}`);
}

if (total > BASELINE) {
  console.error(
    `\n✗ tokens — ${total - BASELINE} hallazgo(s) nuevo(s) fuera del sistema de tokens.\n`
      + "  Colores: enrútalos por una variable CSS (`var(--…)`) o, si describen un\n"
      + "  tema ajeno al activo, decláralos exentos en scripts/check-tokens.mjs.\n"
      + "  Capas: usa un token `--z-*` (o añade uno a la escala de :root).\n"
      + "  Variables: defínela en la hoja o, si la pone el código, en RUNTIME_VARS.",
  );
  if (strict) process.exit(1);
} else if (total < BASELINE) {
  console.log(`\n✓ tokens — ${BASELINE - total} menos que el baseline. Baja BASELINE a ${total}.`);
} else {
  console.log("\n✓ tokens — sin literales de color nuevos.");
}
