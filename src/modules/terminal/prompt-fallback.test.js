import { describe, it, expect } from "vitest";
import { compilePromptRegex, segmentByPrompt, DEFAULT_PROMPT_PATTERN } from "./prompt-fallback.js";

const BUFFER = [
  "user@host:~$ ls -la",
  "total 12",
  "drwxr-xr-x  2 user user 4096 .",
  "user@host:~$ echo hola",
  "hola",
  "user@host:~$ ",
];

/** Lector de líneas sobre un array, con la firma que espera segmentByPrompt. */
function reader(lines) {
  return (line) => (line >= 0 && line < lines.length ? lines[line] : null);
}

describe("compilePromptRegex", () => {
  it("compila y ancla el patrón al inicio de línea", () => {
    const re = compilePromptRegex("\\w+@\\w+[^$]*\\$\\s");
    expect(re.test("user@host:~$ ls")).toBe(true);
    expect(re.test("  user@host:~$ ls")).toBe(false);
  });

  it("devuelve null con patrón vacío o inválido", () => {
    expect(compilePromptRegex("")).toBeNull();
    expect(compilePromptRegex("   ")).toBeNull();
    expect(compilePromptRegex("([")).toBeNull();
    expect(compilePromptRegex(null)).toBeNull();
  });

  it("el patrón por defecto casa con prompts clásicos y no con salida normal", () => {
    const re = compilePromptRegex(DEFAULT_PROMPT_PATTERN);
    expect(re.test("user@host:~/proyectos$ make")).toBe(true);
    expect(re.test("root@caja:/# id")).toBe(true);
    expect(re.test("❯ git status")).toBe(true);
    expect(re.test("total 12")).toBe(false);
    expect(re.test("drwxr-xr-x  2 user user 4096 .")).toBe(false);
  });
});

describe("segmentByPrompt", () => {
  const re = compilePromptRegex("\\w+@\\w+:[^$]*\\$\\s");

  it("segmenta el buffer en bloques prompt+comando+salida", () => {
    const blocks = segmentByPrompt(reader(BUFFER), 0, BUFFER.length - 1, re);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      promptLine: 0,
      commandLine: 0,
      commandCol: "user@host:~$ ".length,
      outputLine: 1,
      endLine: 2,
      synthetic: true,
    });
    expect(blocks[1]).toMatchObject({ promptLine: 3, endLine: 4 });
    // El último bloque (prompt vacío) queda abierto, como en el tracker real.
    expect(blocks[2].endLine).toBeNull();
  });

  it("usa ids negativos para no chocar con los del tracker", () => {
    const blocks = segmentByPrompt(reader(BUFFER), 0, BUFFER.length - 1, re);
    expect(blocks.every((b) => b.id < 0)).toBe(true);
  });

  it("respeta el tope conservando los bloques más recientes", () => {
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(`u@h:~$ cmd${i}`, `out${i}`);
    const blocks = segmentByPrompt(reader(lines), 0, lines.length - 1, re, 3);
    expect(blocks).toHaveLength(3);
    expect(blocks.at(-1).promptLine).toBe(18);
  });

  it("sin prompts no devuelve nada", () => {
    expect(segmentByPrompt(reader(["a", "b"]), 0, 1, re)).toEqual([]);
  });
});
