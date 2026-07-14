#!/usr/bin/env node
/**
 * check-backlog — avisa de tareas del backlog que el código dice que ya están hechas.
 *
 * El backlog (`memoria/tareas.md`) es largo y las features se cierran a trozos: es
 * fácil que algo siga marcado `- [ ]` cuando su preferencia, su comando IPC y su
 * módulo ya existen y tienen llamadores. Este check **solo avisa**: no toca el
 * fichero ni cierra nada. Cerrar una tarea es una decisión con matices (¿está
 * completa o solo empezada?) que no puede tomar una heurística.
 *
 * Cómo funciona: por cada tarea pendiente busca lo que la propia tarea *cita* y
 * comprueba si ya existe en el código:
 *
 *   - **Preferencia** (`prefs.algo`) presente en `DEFAULT_PREFS` de `main.js`.
 *   - **Comando IPC** (`algo_asado`) registrado en el `generate_handler!` de `lib.rs`.
 *   - **Módulo** (`src/modules/x.js`, `x.rs`) que existe en el árbol.
 *
 * Los dos primeros son señales **fuertes**: una tarea que pide «añadir el toggle
 * `prefs.x`» y ya tiene ese toggle es sospechosa de estar hecha. El tercero es
 * **débil** por sí solo (casi toda tarea cita el fichero que va a *modificar*), así
 * que nunca dispara un aviso en solitario.
 *
 * `memoria/` está en `.gitignore` y no viaja al repo: sin él, el check sale con 0 y
 * no dice nada. Por eso no está en CI — es una herramienta de escritorio.
 *
 * Uso:  npm run check:backlog
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BACKLOG = resolve(ROOT, "memoria/tareas.md");

/** Rutas donde se busca un módulo citado por su nombre suelto (`foo.rs`). */
const MODULE_ROOTS = ["", "src/", "src/modules/", "src-tauri/src/", "scripts/", ".github/workflows/"];

/** Lee un fichero del repo, o cadena vacía si no está. */
function read(path) {
  const full = resolve(ROOT, path);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

/** Claves de `DEFAULT_PREFS` (el objeto literal de `main.js`). */
function loadPrefKeys() {
  const src = read("src/main.js");
  const start = src.indexOf("const DEFAULT_PREFS");
  if (start < 0) return new Set();
  // Hasta el cierre del literal en columna 0: `};`
  const end = src.indexOf("\n};", start);
  const body = src.slice(start, end < 0 ? undefined : end);
  return new Set([...body.matchAll(/^\s{2}([A-Za-z_][\w]*)\s*:/gm)].map((m) => m[1]));
}

/** Comandos Tauri registrados en el `generate_handler!` de `lib.rs`. */
function loadCommands() {
  const src = read("src-tauri/src/lib.rs");
  const start = src.indexOf("generate_handler!");
  if (start < 0) return new Set();
  const body = src.slice(start, src.indexOf("])", start));
  return new Set([...body.matchAll(/commands::(\w+)/g)].map((m) => m[1]));
}

/**
 * Trocea el backlog en tareas pendientes: la línea `- [ ]` más sus líneas de
 * continuación indentadas (una línea en blanco o la siguiente viñeta la cierran).
 */
function pendingTasks(md) {
  const lines = md.split("\n");
  const tasks = [];
  let current = null;

  for (const [i, line] of lines.entries()) {
    const open = /^\s*- \[ \] (.*)$/.exec(line);
    if (open) {
      if (current) tasks.push(current);
      current = { line: i + 1, title: titleOf(open[1]), text: open[1] };
      continue;
    }
    if (!current) continue;
    // Continuación: sangrada y no es otra viñeta ni un encabezado.
    if (/^\s+\S/.test(line) && !/^\s*[-*] /.test(line) && !line.trim().startsWith("#")) {
      current.text += ` ${line.trim()}`;
    } else if (!line.trim() || /^\s*[-*] |^#/.test(line)) {
      tasks.push(current);
      current = null;
    }
  }
  if (current) tasks.push(current);
  return tasks;
}

/** Título legible: el primer texto en negrita, o los primeros 60 caracteres. */
function titleOf(text) {
  const bold = /\*\*(.+?)\*\*/.exec(text);
  const raw = bold ? bold[1] : text;
  return raw.replace(/`/g, "").slice(0, 70);
}

/** Señales de «esto ya existe» que la tarea cita en su propio texto. */
function signals(task, prefKeys, commands) {
  const prefs = new Set();
  const cmds = new Set();
  const modules = new Set();

  for (const [, key] of task.text.matchAll(/prefs\.([A-Za-z_]\w*)/g)) {
    if (prefKeys.has(key)) prefs.add(`prefs.${key}`);
  }
  for (const [, name] of task.text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    if (commands.has(name)) cmds.add(`${name}()`);
  }
  for (const [, path] of task.text.matchAll(/`([\w./-]+\.(?:rs|m?js|css|toml|ya?ml))`/g)) {
    const hit = MODULE_ROOTS.map((r) => `${r}${path}`).find((p) => existsSync(resolve(ROOT, p)));
    if (hit) modules.add(hit);
  }

  return { prefs: [...prefs], cmds: [...cmds], modules: [...modules] };
}

// ── Ejecución ────────────────────────────────────────────────────────────────

if (!existsSync(BACKLOG)) {
  console.log("check-backlog — sin backlog local (memoria/ no se publica); nada que comprobar.");
  process.exit(0);
}

const prefKeys = loadPrefKeys();
const commands = loadCommands();
const tasks = pendingTasks(readFileSync(BACKLOG, "utf8"));

const suspects = [];
for (const task of tasks) {
  const found = signals(task, prefKeys, commands);
  const strong = found.prefs.length + found.cmds.length;
  const weak = found.modules.length;
  // Dos señales fuertes, o una fuerte apoyada por un módulo que ya existe.
  if (strong >= 2 || (strong >= 1 && weak >= 1)) suspects.push({ task, found });
}

console.log(
  `check-backlog — ${tasks.length} tareas pendientes; ` +
    `${prefKeys.size} preferencias y ${commands.size} comandos en el código.\n`,
);

if (!suspects.length) {
  console.log("✓ Ninguna tarea pendiente parece implementada ya.");
  process.exit(0);
}

console.log(`⚠ ${suspects.length} tarea(s) citan cosas que YA existen. Revísalas a mano:\n`);
for (const { task, found } of suspects) {
  console.log(`  tareas.md:${task.line}  ${task.title}`);
  const bits = [
    found.prefs.length ? `preferencia: ${found.prefs.join(", ")}` : null,
    found.cmds.length ? `comando: ${found.cmds.join(", ")}` : null,
    found.modules.length ? `módulo: ${found.modules.join(", ")}` : null,
  ].filter(Boolean);
  for (const bit of bits) console.log(`      ya existe → ${bit}`);
  console.log("");
}

// Avisar, nunca bloquear: la tarea puede seguir abierta a propósito (una parte
// hecha y otra no). Quien decide si se cierra es una persona.
console.log("Nota: esto es un aviso. Cerrar una tarea sigue siendo una decisión tuya.");
process.exit(0);
