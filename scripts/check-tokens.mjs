// Guardián del sistema de tokens de color de `src/styles.css`: falla si los
// hallazgos fuera del sistema crecen por encima del baseline.
//
// Qué caza (el detector vive en `tokens-css.mjs`, con tests):
// - Colores: un `#hex` suelto, un `rgb()`/`hsl()` que NO es neutro (una sombra
//   o un velo negro translúcido vale igual en los 233 temas y no avisa; un
//   azul al 28 % es un color congelado y sí) y un color con nombre (`red`,
//   `white`, `orange`…; `transparent`, `currentColor` e `inherit` se permiten).
// - Capas: un `z-index` de capa (≥ 100) va por la escala `var(--z-*)` de
//   `:root`. Con números sueltos, los avisos acabaron por debajo de los modales.
// - Tokens inexistentes: un `var(--x)` sin definición en la hoja (ni entre las
//   variables que pone el código en runtime) cae en silencio a su valor
//   inicial: así la muestra «Rosa» salía gris y el contador del rail a 400.
// - Movimiento: una `transition` con duración literal (`0.15s`, `120ms`) o con
//   `all` va por los tokens `--motion-*` y enumera lo que cambia.
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
import { scanTokens } from "./tokens-css.mjs";

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

const findings = scanTokens(css, { exemptSelector: EXEMPT_SELECTOR, runtimeVars: RUNTIME_VARS, zLayerMin: Z_LAYER_MIN });

const total = findings.length;
console.log(`Hallazgos fuera del sistema de tokens: ${total} (baseline ${BASELINE})`);
for (const f of findings) {
  console.log(`  styles.css:${f.line}  [${f.kind}] ${f.value}  ${f.text}`);
}

if (total > BASELINE) {
  console.error(
    `\n✗ tokens — ${total - BASELINE} hallazgo(s) nuevo(s) fuera del sistema de tokens.\n`
      + "  Colores (hex, rgb/hsl con tinte, nombres): enrútalos por una variable CSS\n"
      + "  (`var(--…)`) o, si describen un tema ajeno al activo, decláralos exentos en\n"
      + "  scripts/check-tokens.mjs. Un gris/negro/blanco translúcido es neutro y no avisa.\n"
      + "  Capas: usa un token `--z-*` (o añade uno a la escala de :root).\n"
      + "  Variables: defínela en la hoja o, si la pone el código, en RUNTIME_VARS.\n"
      + "  Transiciones: duración por `var(--motion-fast|normal|slow)` y sin `all`.",
  );
  if (strict) process.exit(1);
} else if (total < BASELINE) {
  console.log(`\n✓ tokens — ${BASELINE - total} menos que el baseline. Baja BASELINE a ${total}.`);
} else {
  console.log("\n✓ tokens — sin literales de color nuevos.");
}
