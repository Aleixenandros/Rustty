import { describe, expect, it } from "vitest";
import {
  BUILTIN_QUICK_SELECT_RULES, QUICK_SELECT_ALPHABET, QUICK_SELECT_MAX_PATTERNS, QUICK_SELECT_MAX_PATTERN_LENGTH,
  assignQuickSelectLabels, compileQuickSelectPatterns, findQuickSelectMatches, isIpv6, quickSelectLabels,
  quickSelectPatternError, readViewportLines, resolveQuickSelectKey, quickSelectHintPlacement, hasNestedQuantifier
} from "./quick-select.js";

/**
 * Carácter ancho (dos celdas), como los ideogramas en xterm.
 * @param {string} ch
 */
const isWide = (ch) => /[\u3000-\u9fff\uff00-\uffef]/.test(ch);

/**
 * Buffer con la forma del de xterm. Cada fila es un texto; las de `wrapped`
 * continúan la anterior. Un ideograma ocupa dos celdas (la segunda con ancho
 * 0) y `""` es una celda vacía, como las que deja xterm al final.
 * @param {(string|string[])[]} rows Texto o lista de celdas.
 * @param {{ viewportY?: number, wrapped?: number[], cols?: number }} [opts]
 */
function fakeBuffer(rows, { viewportY = 0, wrapped = [], cols = 80 } = {}) {
  const lines = rows.map((row, y) => {
    const cells = [];
    for (const ch of Array.isArray(row) ? row : [...row]) {
      cells.push({ chars: ch, width: isWide(ch) ? 2 : 1 });
      if (isWide(ch)) cells.push({ chars: "", width: 0 });
    }
    while (cells.length < cols) cells.push({ chars: "", width: 1 });
    return {
      isWrapped: wrapped.includes(y),
      length: cells.length,
      getCell: (x) => cells[x] && { getChars: () => cells[x].chars, getWidth: () => cells[x].width },
    };
  });
  return { viewportY, length: lines.length, getLine: (y) => lines[y] };
}

/**
 * Textos encontrados en una sola línea (por defecto, con los patrones de serie).
 * @param {string} text
 * @param {readonly any[]} [rules]
 */
function found(text, rules = BUILTIN_QUICK_SELECT_RULES) {
  const lines = readViewportLines(fakeBuffer([text], { cols: Math.max(80, text.length) }), 1);
  return findQuickSelectMatches(lines, { rules, rows: 1 }).matches.map((m) => m.text);
}

describe("lectura de la pantalla", () => {
  it("une las filas envueltas y sitúa cada tramo en su fila", () => {
    const buffer = fakeBuffer(["ver https://ejemplo", ".es/a/b fin"], { wrapped: [1], cols: 19 });
    const lines = readViewportLines(buffer, 2);
    expect(lines.map((l) => l.text)).toEqual(["ver https://ejemplo.es/a/b fin"]);
    const [url] = findQuickSelectMatches(lines, { rules: BUILTIN_QUICK_SELECT_RULES, rows: 2 }).matches;
    expect(url).toMatchObject({ text: "https://ejemplo.es/a/b", kind: "url", row: 0, col: 4 });
    expect(url.segments).toEqual([{ row: 0, col: 4, width: 15 }, { row: 1, col: 0, width: 7 }]);
  });

  it("convierte índices de texto a columnas con caracteres anchos", () => {
    const [ip] = findQuickSelectMatches(readViewportLines(fakeBuffer(["漢字 10.0.0.1"]), 1),
      { rules: BUILTIN_QUICK_SELECT_RULES, rows: 1 }).matches;
    expect(ip).toMatchObject({ text: "10.0.0.1", col: 5 });
    expect(ip.segments).toEqual([{ row: 0, col: 5, width: 8 }]);
  });

  it("la celda vacía que deja un carácter ancho al saltar de fila no parte la línea", () => {
    // 6 columnas: «/srv/» + celda vacía; el ideograma no cabía y bajó.
    const buffer = fakeBuffer([["/", "s", "r", "v", "/", ""], "漢/log"], { wrapped: [1], cols: 6 });
    const [line] = readViewportLines(buffer, 2);
    expect(line.text).toBe("/srv/漢/log");
    const [path] = findQuickSelectMatches([line], { rules: BUILTIN_QUICK_SELECT_RULES, rows: 2 }).matches;
    expect(path.text).toBe("/srv/漢/log");
    expect(path.segments).toEqual([{ row: 0, col: 0, width: 5 }, { row: 1, col: 0, width: 6 }]);
  });

  it("solo etiqueta lo que empieza en pantalla, sin trocear lo que viene de arriba", () => {
    const buffer = fakeBuffer(
      ["primera", "ver https://ejemplo", ".es/aaa/bbb", "ip 10.1.2.3", "fuera 10.9.9.9"],
      { viewportY: 2, wrapped: [2], cols: 19 },
    );
    const { matches } = findQuickSelectMatches(readViewportLines(buffer, 2), { rules: BUILTIN_QUICK_SELECT_RULES, rows: 2 });
    // La URL empieza encima de la pantalla: ni ella ni «.es/aaa/bbb» como ruta.
    expect(matches.map((m) => [m.text, m.row])).toEqual([["10.1.2.3", 1]]);
  });
});

describe("patrones de serie", () => {
  it("IPv4 con puerto, sin la máscara ni versiones", () => {
    expect(found("inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0")).toEqual(["192.168.1.10", "192.168.1.255"]);
    // Un puerto imposible no se pega a la IP (queda como número suelto).
    expect(found("db 10.0.0.5:5432 y 10.0.0.6:99999")).toEqual(["10.0.0.5:5432", "10.0.0.6", "99999"]);
    expect(found("v1.2.3.4 y 1.2.3.4.5 y 300.1.1.1")).toEqual([]);
  });

  it("IPv6 con corchetes y puerto, con zona, sin horas, MACs ni C++", () => {
    expect(found("LISTEN [::]:22 [2001:db8::1]:8443 fe80::1%eth0 ::1")).toEqual(
      ["[::]:22", "[2001:db8::1]:8443", "fe80::1%eth0", "::1"]);
    expect(found("inet6 fe80::5054:ff:fe12:3456/64 scope link")).toEqual(["fe80::5054:ff:fe12:3456"]);
    expect(found("ether 52:54:00:12:34:56 a las 12:34:56, std::vector")).toEqual([]);
    expect(isIpv6("::ffff:192.168.1.1")).toBe(true);
    expect(isIpv6("1:2:3:4:5:6:7")).toBe(false);
    expect(isIpv6("1::2::3")).toBe(false);
  });

  it("URL con la puntuación de la frase fuera y los paréntesis con pareja dentro", () => {
    expect(found("ver (https://es.wikipedia.org/wiki/A_(b)) y https://x.io/p.")).toEqual(
      ["https://es.wikipedia.org/wiki/A_(b)", "https://x.io/p"]);
    // La URL se queda su dominio, su IP y su puerto.
    expect(found("curl https://10.0.0.1:8443/api")).toEqual(["https://10.0.0.1:8443/api"]);
  });

  it("rutas Unix, relativas y de Windows", () => {
    expect(found("edita /etc/nginx/nginx.conf, ~/.ssh/config y src/main.js:42")).toEqual(
      ["/etc/nginx/nginx.conf", "~/.ssh/config", "src/main.js"]);
    expect(found("deploy@web01:/srv/app ./run.sh ../lib")).toEqual(["/srv/app", "./run.sh", "../lib"]);
    expect(found(String.raw`copia C:\Users\ana\informe.txt a \\nas\copias`)).toEqual(
      [String.raw`C:\Users\ana\informe.txt`, String.raw`\\nas\copias`]);
    // Sin letras no es una ruta.
    expect(found("1/2 de 25/10/2026")).toEqual(["2026"]);
  });

  it("UUID, hashes, contenedores y pods", () => {
    expect(found("UUID=123e4567-e89b-12d3-a456-426614174000 ext4")).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(found("commit 3f9a2c1d7b8e9f0a1b2c3d4e5f60718293a4b5c6 (HEAD -> main)")).toEqual(
      ["3f9a2c1d7b8e9f0a1b2c3d4e5f60718293a4b5c6"]);
    expect(found("a1b2c3d arregla las cabeceras defaced")).toEqual(["a1b2c3d"]);
    const id = "4f1c2b3a".repeat(8);
    expect(found(`sha256:${id}`)).toEqual([id]);
    expect(found("web-7c5ddbdf54-x2k9p 1/1 Running 0 5d")).toEqual(["web-7c5ddbdf54-x2k9p"]);
  });

  it("dominios y correos", () => {
    expect(found("resolviendo mirror.example.org... hecho")).toEqual(["mirror.example.org"]);
    expect(found("escribe a ana.garcia+ops@example.co.uk ya")).toEqual(["ana.garcia+ops@example.co.uk"]);
    expect(found("e.g. 3.14 y v1.2.3")).toEqual([]);
  });

  it("números largos, no los trozos de un decimal", () => {
    expect(found("PID 48213 usa 1.5% y 12345.678 bytes el 2026-10-25")).toEqual(["48213", "2026"]);
  });
});

describe("patrones propios", () => {
  it("ignoran los vacíos, inválidos y demasiado largos, con tope de cantidad", () => {
    expect(quickSelectPatternError("")).toBe("empty");
    expect(quickSelectPatternError("  ")).toBe("empty");
    expect(quickSelectPatternError(42)).toBe("empty");
    expect(quickSelectPatternError("(")).toBe("invalid");
    expect(quickSelectPatternError("a".repeat(QUICK_SELECT_MAX_PATTERN_LENGTH + 1))).toBe("too_long");
    expect(quickSelectPatternError("ticket-\\d+")).toBeNull();
    expect(compileQuickSelectPatterns(["(", "", { pattern: "ok" }, "a".repeat(300), null])).toHaveLength(1);
    expect(compileQuickSelectPatterns("no es una lista")).toEqual([]);
    const many = Array.from({ length: QUICK_SELECT_MAX_PATTERNS + 5 }, (_, i) => `p${i}`);
    expect(compileQuickSelectPatterns(many)).toHaveLength(QUICK_SELECT_MAX_PATTERNS);
  });

  it("ganan a los de serie y, con un grupo, seleccionan solo el grupo", () => {
    const rules = [...compileQuickSelectPatterns([{ pattern: "ticket-(\\d+)" }]), ...BUILTIN_QUICK_SELECT_RULES];
    const lines = readViewportLines(fakeBuffer(["ver ticket-4521 en 10.0.0.1"]), 1);
    const { matches } = findQuickSelectMatches(lines, { rules, rows: 1 });
    expect(matches.map((m) => [m.text, m.kind, m.col])).toEqual([["4521", "custom", 11], ["10.0.0.1", "ipv4", 19]]);
  });

  it("un patrón que casa con la cadena vacía no se queda en bucle", () => {
    const rules = compileQuickSelectPatterns(["x*"]);
    expect(found("a xx b", rules)).toEqual(["xx"]);
  });

  it("el presupuesto de tiempo corta el escaneo y lo dice", () => {
    let clock = 0;
    const lines = readViewportLines(fakeBuffer(["10.0.0.1", "10.0.0.2", "10.0.0.3"]), 3);
    const result = findQuickSelectMatches(lines, {
      rules: BUILTIN_QUICK_SELECT_RULES, rows: 3, budgetMs: 10, now: () => (clock += 1),
    });
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBeLessThan(3);
  });

  it("una línea larga y patológica no dispara el tiempo", () => {
    const text = `${"a".repeat(1000)}${"/a".repeat(500)} ${"f".repeat(500)}`;
    const buffer = fakeBuffer([text], { cols: text.length });
    const t0 = performance.now();
    findQuickSelectMatches(readViewportLines(buffer, 1), { rules: BUILTIN_QUICK_SELECT_RULES, rows: 1, budgetMs: 1e9 });
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("etiquetas", () => {
  it("de una letra mientras caben, sin prefijos ambiguos después, con tope alfabeto²", () => {
    const n = QUICK_SELECT_ALPHABET.length;
    expect(new Set(QUICK_SELECT_ALPHABET).size).toBe(n);
    expect(quickSelectLabels(3)).toEqual(["a", "s", "d"]);
    for (const count of [0, 1, n, n + 1, 60, 300, n * n - 1, n * n, n * n + 50]) {
      const labels = quickSelectLabels(count);
      expect(labels).toHaveLength(Math.min(count, n * n));
      expect(new Set(labels).size).toBe(labels.length);
      const singles = labels.filter((l) => l.length === 1);
      for (const s of singles) expect(labels.some((l) => l.length === 2 && l.startsWith(s))).toBe(false);
      expect(labels.every((l) => l.length <= 2)).toBe(true);
    }
    // Con una etiqueta de más, solo una letra pasa a ser prefijo.
    expect(quickSelectLabels(n + 1).filter((l) => l.length === 1)).toHaveLength(n - 1);
  });

  it("el mismo texto lleva la misma etiqueta y lo de abajo recibe las cortas", () => {
    const at = (text, row, col) => ({ text, kind: "ipv4", row, col, segments: [] });
    const { targets, truncated } = assignQuickSelectLabels([at("10.0.0.1", 0, 0), at("10.0.0.2", 3, 0), at("10.0.0.1", 5, 4)]);
    expect(truncated).toBe(false);
    expect(targets.map((t) => [t.label, t.text, t.occurrences.length])).toEqual([["a", "10.0.0.1", 2], ["s", "10.0.0.2", 1]]);
  });
});

describe("teclado", () => {
  const labels = ["a", "s", "na", "ns"];
  const idle = { typed: "", paste: false };

  it("Escape cancela; una letra copia; con Mayúsculas también pega", () => {
    expect(resolveQuickSelectKey(labels, idle, { key: "Escape" })).toEqual({ type: "cancel" });
    expect(resolveQuickSelectKey(labels, idle, { key: "a", shiftKey: false })).toEqual({ type: "select", label: "a", paste: false });
    expect(resolveQuickSelectKey(labels, idle, { key: "A", shiftKey: true })).toEqual({ type: "select", label: "a", paste: true });
  });

  it("con Bloq Mayús la letra llega en mayúscula pero no pega", () => {
    expect(resolveQuickSelectKey(labels, idle, { key: "A", shiftKey: false })).toEqual({ type: "select", label: "a", paste: false });
  });

  it("dos letras: la primera queda pendiente y Retroceso la borra", () => {
    const pending = resolveQuickSelectKey(labels, idle, { key: "N", shiftKey: true });
    expect(pending).toEqual({ type: "pending", typed: "n", paste: true });
    expect(resolveQuickSelectKey(labels, { typed: "n", paste: true }, { key: "s", shiftKey: false }))
      .toEqual({ type: "select", label: "ns", paste: true });
    expect(resolveQuickSelectKey(labels, { typed: "n", paste: false }, { key: "Backspace" }))
      .toEqual({ type: "pending", typed: "", paste: false });
  });

  it("ignora lo que no forma etiqueta y las combinaciones con modificadores", () => {
    expect(resolveQuickSelectKey(labels, idle, { key: "z" })).toEqual({ type: "ignore" });
    expect(resolveQuickSelectKey(labels, { typed: "n", paste: false }, { key: "q" })).toEqual({ type: "ignore" });
    expect(resolveQuickSelectKey(labels, idle, { key: "1" })).toEqual({ type: "ignore" });
    expect(resolveQuickSelectKey(labels, idle, { key: "Enter" })).toEqual({ type: "ignore" });
    expect(resolveQuickSelectKey(labels, idle, { key: "a", ctrlKey: true })).toEqual({ type: "ignore" });
    expect(resolveQuickSelectKey(labels, idle, { key: "Backspace" })).toEqual({ type: "ignore" });
  });
});

describe("quickSelectHintPlacement", () => {
  const box = (left, top, w = 10, h = 10) => ({ left, top, right: left + w, bottom: top + h });
  const bottom = box(100, 90, 60, 8);
  const top = box(100, 2, 60, 8);
  it("abajo si no tapa ninguna etiqueta", () => {
    expect(quickSelectHintPlacement([box(0, 0), box(20, 50)], bottom, top)).toBe("bottom");
  });
  it("arriba si abajo tapa una etiqueta", () => {
    expect(quickSelectHintPlacement([box(120, 92)], bottom, top)).toBe("top");
  });
  it("oculto si tapa en los dos sitios", () => {
    expect(quickSelectHintPlacement([box(120, 92), box(130, 3)], bottom, top)).toBe("hidden");
  });
});

describe("patrones propios con repeticiones anidadas", () => {
  it("detecta las formas de retroceso exponencial", () => {
    for (const p of ["(a+)+", "(\\w+\\s?)+;", "((ab)*)+", "(x{2,})*", "(?:[a-z]+\\.)+"]) {
      expect(hasNestedQuantifier(p), p).toBe(true);
    }
  });
  it("deja pasar las repeticiones simples o acotadas", () => {
    for (const p of ["\\b[a-f0-9]{7,40}\\b", "(ab)+", "(a+)?", "(a{2})+", "[(+)]+", "ID-(\\d+)", "\\(a+\\)+"]) {
      expect(hasNestedQuantifier(p), p).toBe(false);
    }
  });
  it("un patrón así se rechaza al validar y no cuelga el escaneo", () => {
    expect(quickSelectPatternError("(\\w+\\s?)+;")).toBe("nested_quantifier");
  });
});
