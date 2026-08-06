// @ts-check
import { describe, it, expect } from "vitest";
import { createBlockTracker, handleOsc133 } from "./blocks.js";
import { extractBlockText, blockToMarkdown, blockFileName } from "./block-text.js";

/**
 * Lector de buffer sobre un array (índice = línea absoluta).
 * @param {string[]} lines
 */
const reader = (lines) => (n) => (n >= 0 && n < lines.length ? lines[n] : null);

describe("extractBlockText", () => {
  it("recorta el prompt usando la columna del marcador B", () => {
    // `user@host:~$ ls -la` → el prompt ocupa las 13 primeras columnas.
    const lines = ["user@host:~$ ls -la", "total 8", "drwxr-xr-x 2 user user", "user@host:~$ "];
    const s = createBlockTracker();
    handleOsc133(s, "A", 0, 0);
    handleOsc133(s, "B", 0, 13);
    handleOsc133(s, "C", 1, 0);
    handleOsc133(s, "D;0", 3, 0);
    expect(extractBlockText(s.blocks[0], reader(lines))).toEqual({
      command: "ls -la",
      output: "total 8\ndrwxr-xr-x 2 user user",
    });
  });

  it("sin columna conocida degrada a la línea completa, sin inventar recortes", () => {
    const lines = ["$ echo hola", "hola", "$ "];
    const s = createBlockTracker();
    handleOsc133(s, "A", 0);
    handleOsc133(s, "B", 0);
    handleOsc133(s, "C", 1);
    handleOsc133(s, "D;0", 2);
    expect(extractBlockText(s.blocks[0], reader(lines)).command).toBe("$ echo hola");
  });

  it("un bloque abierto llega hasta la última línea del buffer", () => {
    const lines = ["$ tail -f log", "linea 1", "linea 2"];
    const s = createBlockTracker();
    handleOsc133(s, "A", 0, 0);
    handleOsc133(s, "B", 0, 2);
    handleOsc133(s, "C", 1, 0);
    expect(extractBlockText(s.blocks[0], reader(lines), { lastLine: 2 })).toEqual({
      command: "tail -f log",
      output: "linea 1\nlinea 2",
    });
  });

  it("respeta el ajuste de línea de xterm (una fila envuelta no es un salto)", () => {
    const lines = ["$ cat frase", "una frase muy ", "larga", "$ "];
    const s = createBlockTracker();
    handleOsc133(s, "A", 0, 0);
    handleOsc133(s, "B", 0, 2);
    handleOsc133(s, "C", 1, 0);
    handleOsc133(s, "D;0", 3, 0);
    const out = extractBlockText(s.blocks[0], reader(lines), {
      isWrapped: (line) => line === 2,
    });
    expect(out.output).toBe("una frase muy larga");
  });

  it("un bloque sin B no inventa comando", () => {
    const s = createBlockTracker();
    handleOsc133(s, "A", 0, 0);
    handleOsc133(s, "D;0", 1, 0);
    expect(extractBlockText(s.blocks[0], reader(["$ ", ""])).command).toBe("");
  });
});

describe("blockToMarkdown", () => {
  it("serializa comando, contexto y salida", () => {
    const md = blockToMarkdown({
      command: "df -h",
      output: "Filesystem  Size\n/dev/sda1   40G",
      host: "root@srv1",
      cwd: "/var/log",
      exitCode: 0,
      timestamp: "2026-08-06T10:00:00.000Z",
      durationMs: 1234,
    });
    expect(md).toContain("## `df -h`");
    expect(md).toContain("- **Host:** root@srv1");
    expect(md).toContain("- **Directory:** /var/log");
    expect(md).toContain("- **Date:** 2026-08-06T10:00:00.000Z");
    expect(md).toContain("- **Duration:** 1.2s");
    expect(md).toContain("- **Exit code:** 0");
    expect(md).toContain("```console\n$ df -h\nFilesystem  Size\n/dev/sda1   40G\n```");
  });

  it("una salida con ``` no rompe el vallado", () => {
    const md = blockToMarkdown({ command: "cat README.md", output: "```js\ncode\n```" });
    expect(md).toContain("````console");
    expect(md.trimEnd().endsWith("````")).toBe(true);
  });

  it("omite el contexto que no se conoce", () => {
    const md = blockToMarkdown({ command: "ls", output: "" });
    expect(md).not.toContain("**Host:**");
    expect(md).not.toContain("**Exit code:**");
    expect(md).toContain("```console\n$ ls\n```");
  });
});

describe("blockFileName", () => {
  it("construye un nombre seguro y acotado", () => {
    const name = blockFileName("sudo systemctl restart nginx.service", new Date("2026-08-06T10:20:30Z"));
    expect(name).toBe("sudo-systemctl-restart-nginx-service-2026-08-06T10-20-30.md");
  });

  it("un comando sin caracteres útiles cae a un nombre genérico", () => {
    expect(blockFileName("###", new Date("2026-08-06T00:00:00Z"))).toBe("command-2026-08-06T00-00-00.md");
  });
});
