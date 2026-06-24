// Verificación rápida de contraste WCAG AA de los temas base de la UI.
//
// Lee los tokens de color de `src/styles.css` (`:root` y cada `html.theme-*`)
// y `public/themes/bundled-themes.json`, y comprueba que los textos sobre el
// fondo alcanzan el ratio mínimo AA: 4.5:1 para texto normal y 3:1 para texto
// grande / elementos de interfaz.
//
// Uso:
//   node scripts/check-contrast.mjs          # informe completo
//   node scripts/check-contrast.mjs --strict # además, sale con código ≠0 si algo falla
//
// Sin dependencias externas: el cálculo de luminancia y ratio sigue la fórmula
// de la WCAG 2.x (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = resolve(root, "src", "styles.css");
const bundledThemesPath = resolve(root, "public", "themes", "bundled-themes.json");

/** Pares texto→fondo a comprobar y su umbral AA. */
const CHECKS = [
  { fg: "--text", bg: "--base", min: 4.5, label: "Texto principal" },
  { fg: "--subtext1", bg: "--base", min: 4.5, label: "Texto secundario" },
  { fg: "--subtext0", bg: "--base", min: 4.5, label: "Texto atenuado" },
  { fg: "--overlay1", bg: "--base", min: 3.0, label: "Apagado (UI)" },
  { fg: "--overlay0", bg: "--base", min: 3.0, label: "Apagado/bordes (UI)" },
];

const BUNDLED_UI_CHECKS = CHECKS.map((check) => ({
  ...check,
  fg: check.fg.slice(2),
  bg: check.bg.slice(2),
}));

const TERMINAL_CHECKS = [
  { fg: "foreground", bg: "background", min: 4.5, label: "Texto terminal" },
  { fg: "cursor", bg: "background", min: 4.5, label: "Cursor terminal" },
  { fg: "cursorAccent", bg: "cursor", min: 4.5, label: "Texto bajo cursor" },
];

/** Convierte `#rgb` o `#rrggbb` a `[r, g, b]` en 0–255, o `null` si no es hex. */
function parseHex(value) {
  if (typeof value !== "string") return null;
  let hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** Luminancia relativa WCAG de un color [r,g,b] (0–255). */
function relativeLuminance([r, g, b]) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** Ratio de contraste WCAG entre dos colores hex. */
function contrastRatio(fgHex, bgHex) {
  const fg = parseHex(fgHex);
  const bg = parseHex(bgHex);
  if (!fg || !bg) return null;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Extrae los pares `--token: valor;` del cuerpo del bloque CSS de la paleta de
 * un selector. Un mismo selector puede aparecer en varios sitios (p. ej. un
 * selector múltiple que solo ajusta sombras), así que se salta los bloques que
 * no definen `requiredToken` y devuelve el de la paleta completa, o `null`.
 */
function extractTokens(css, selector, requiredToken = "--base") {
  let from = 0;
  for (;;) {
    const start = css.indexOf(`${selector} {`, from);
    if (start === -1) return null;
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    if (open === -1 || close === -1) return null;
    const body = css.slice(open + 1, close);
    const tokens = {};
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      tokens[m[1]] = m[2].trim();
    }
    if (!requiredToken || requiredToken in tokens) return tokens;
    from = close + 1;
  }
}

function fmtRatio(n) {
  return n.toFixed(2).padStart(5, " ");
}

async function main() {
  const strict = process.argv.includes("--strict");
  const css = await readFile(cssPath, "utf8");
  const bundledPack = JSON.parse(await readFile(bundledThemesPath, "utf8"));

  // El tema por defecto (oscuro) vive en `:root`; el resto en `html.theme-*`.
  // Solo se evalúan los que definen una paleta de chrome propia (`--base`):
  // algunos nombres aparecen únicamente en selectores de sombras o como tema de
  // terminal y no tienen tokens de UI.
  const base = extractTokens(css, ":root");
  const names = [...new Set(
    [...css.matchAll(/html\.theme-([a-z0-9-]+)\s*[,{]/gi)].map((m) => m[1])
  )].sort();
  const themes = [["default (:root)", base]];
  const skipped = [];
  for (const name of names) {
    const tokens = extractTokens(css, `html.theme-${name}`);
    if (tokens) themes.push([name, tokens]);
    else skipped.push(name);
  }

  let failures = 0;
  let checked = 0;

  for (const [name, tokens] of themes) {
    const lines = [];
    let themeFails = 0;
    for (const check of CHECKS) {
      // Los temas redefinen los tokens; si falta alguno, cae al del base.
      const fg = tokens[check.fg] ?? base?.[check.fg];
      const bg = tokens[check.bg] ?? base?.[check.bg];
      const ratio = contrastRatio(fg, bg);
      checked++;
      if (ratio == null) {
        lines.push(`    ?  ${check.label} (${check.fg}/${check.bg}): valor no hex`);
        continue;
      }
      const ok = ratio >= check.min;
      if (!ok) { themeFails++; failures++; }
      const mark = ok ? "✓" : "✗";
      lines.push(
        `    ${mark}  ${fmtRatio(ratio)}:1  (min ${check.min})  ${check.label} ` +
        `[${check.fg} ${fg} / ${check.bg} ${bg}]`
      );
    }
    const head = themeFails === 0 ? "OK " : `${themeFails} fallo(s)`;
    console.log(`\n${themeFails === 0 ? "✓" : "✗"} ${name} — ${head}`);
    for (const l of lines) console.log(l);
  }

  console.log(
    `\nResumen: ${themes.length} temas, ${checked} comprobaciones, ${failures} por debajo de AA.`
  );
  if (skipped.length) {
    console.log(`Omitidos (sin paleta de chrome propia): ${skipped.join(", ")}.`);
  }

  const bundledFailures = [];
  let bundledChecked = 0;

  for (const theme of bundledPack.themes || []) {
    for (const check of BUNDLED_UI_CHECKS) {
      const fg = theme.ui?.[check.fg];
      const bg = theme.ui?.[check.bg];
      const ratio = contrastRatio(fg, bg);
      bundledChecked++;
      if (ratio == null || ratio < check.min) {
        bundledFailures.push({
          id: theme.id,
          label: `${check.label} (${check.fg}/${check.bg})`,
          ratio,
          min: check.min,
        });
      }
    }

    for (const check of TERMINAL_CHECKS) {
      const fg = theme.terminal?.[check.fg];
      const bg = theme.terminal?.[check.bg];
      const ratio = contrastRatio(fg, bg);
      bundledChecked++;
      if (ratio == null || ratio < check.min) {
        bundledFailures.push({
          id: theme.id,
          label: `${check.label} (${check.fg}/${check.bg})`,
          ratio,
          min: check.min,
        });
      }
    }
  }

  failures += bundledFailures.length;
  console.log(
    `\n${bundledFailures.length === 0 ? "✓" : "✗"} bundled themes — ` +
    `${bundledPack.themes?.length || 0} temas, ${bundledChecked} comprobaciones, ` +
    `${bundledFailures.length} por debajo de AA.`
  );
  for (const failure of bundledFailures.slice(0, 30)) {
    const ratio = failure.ratio == null ? "valor no hex" : `${fmtRatio(failure.ratio)}:1`;
    console.log(`    ✗  ${failure.id}: ${ratio}  (min ${failure.min})  ${failure.label}`);
  }
  if (bundledFailures.length > 30) {
    console.log(`    ... ${bundledFailures.length - 30} fallo(s) más.`);
  }

  if (failures > 0 && strict) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
