import { describe, expect, it } from "vitest";
import {
  OSC52_MAX_BYTES,
  TITLE_MAX_CHARS,
  clipboardExcerpt,
  createNotifyLimiter,
  effectiveClipboardPolicy,
  nextProgress,
  normalizeRemoteTitleMode,
  parseOsc52,
  parseOsc777,
  parseOsc9,
  remoteTitleView,
  sanitizeRemoteTitle,
  sanitizeTerminalText,
  tooltipWithRemoteTitle,
} from "./osc.js";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

describe("parseOsc52", () => {
  it("decodifica el texto en UTF-8 con cualquier destino, también vacío", () => {
    expect(parseOsc52(`c;${b64("hola ñ ─")}`)).toEqual({ kind: "write", text: "hola ñ ─", bytes: 11 });
    expect(parseOsc52(`;${b64("x")}`)).toMatchObject({ kind: "write", text: "x" });
    expect(parseOsc52(`ps0;${b64("y")}`)).toMatchObject({ kind: "write", text: "y" });
  });

  it("acepta base64 sin relleno y con saltos de línea", () => {
    expect(parseOsc52("c;YQ")).toMatchObject({ kind: "write", text: "a" });
    expect(parseOsc52("c;aG9s\nYQ==")).toMatchObject({ kind: "write", text: "hola" });
  });

  it("la consulta `?` nunca se trata como escritura", () => {
    expect(parseOsc52("c;?")).toEqual({ kind: "query" });
    expect(parseOsc52(";?")).toEqual({ kind: "query" });
  });

  it("rechaza lo que no es OSC 52 válido sin tocar el portapapeles", () => {
    expect(parseOsc52("sin-separador")).toEqual({ kind: "invalid", reason: "syntax" });
    expect(parseOsc52("zz;YQ==")).toEqual({ kind: "invalid", reason: "syntax" });
    expect(parseOsc52("c;no es base64!")).toEqual({ kind: "invalid", reason: "syntax" });
    expect(parseOsc52("c;Y")).toEqual({ kind: "invalid", reason: "syntax" });
    expect(parseOsc52("c;")).toEqual({ kind: "invalid", reason: "empty" });
  });

  it("comprueba el tope antes de decodificar", () => {
    const exact = "a".repeat(OSC52_MAX_BYTES);
    expect(parseOsc52(`c;${b64(exact)}`)).toMatchObject({ kind: "write", bytes: OSC52_MAX_BYTES });
    expect(parseOsc52(`c;${b64(`${exact}a`)}`)).toEqual({ kind: "invalid", reason: "too_large" });
    expect(parseOsc52(`c;${b64("abcd")}`, { maxBytes: 3 })).toEqual({ kind: "invalid", reason: "too_large" });
  });
});

describe("effectiveClipboardPolicy", () => {
  it("por defecto (o con un valor desconocido) está desactivado", () => {
    expect(effectiveClipboardPolicy(undefined)).toBe("off");
    expect(effectiveClipboardPolicy("whatever")).toBe("off");
  });

  it("una sesión privada como mucho pregunta", () => {
    expect(effectiveClipboardPolicy("allow", { isPrivate: true })).toBe("ask");
    expect(effectiveClipboardPolicy("ask", { isPrivate: true })).toBe("ask");
    expect(effectiveClipboardPolicy("allow")).toBe("allow");
  });

  it("«Permitir en esta sesión» salta la pregunta pero nunca un «Desactivado»", () => {
    expect(effectiveClipboardPolicy("ask", { sessionAllowed: true })).toBe("allow");
    expect(effectiveClipboardPolicy("allow", { isPrivate: true, sessionAllowed: true })).toBe("ask");
    expect(effectiveClipboardPolicy("off", { sessionAllowed: true })).toBe("off");
  });
});

describe("clipboardExcerpt", () => {
  it("cuenta caracteres y líneas y deja a la vista los controles", () => {
    const res = clipboardExcerpt("uno\tdos\nrm -rf \x1b[2J\n");
    expect(res.chars).toBe(20);
    expect(res.lines).toBe(3);
    expect(res.excerpt).toBe("uno→dos\nrm -rf ␛[2J\n");
    expect(res.truncated).toBe(false);
  });

  it("corta por líneas y por caracteres", () => {
    expect(clipboardExcerpt("1\n2\n3\n4\n5", { maxLines: 2 }).excerpt).toBe("1\n2\n…");
    const long = clipboardExcerpt("x".repeat(500), { maxChars: 10 });
    expect(long.excerpt).toBe(`${"x".repeat(10)}\n…`);
    expect(long.truncated).toBe(true);
    expect(long.chars).toBe(500);
  });
});

describe("parseOsc9", () => {
  it("un texto suelto es un aviso (iTerm2)", () => {
    expect(parseOsc9("Backup listo")).toEqual({ kind: "notify", title: "", body: "Backup listo" });
    // Que empiece por un número no lo convierte en ConEmu.
    expect(parseOsc9("3 ficheros copiados")).toMatchObject({ kind: "notify", body: "3 ficheros copiados" });
    expect(parseOsc9("100% hecho")).toMatchObject({ kind: "notify", body: "100% hecho" });
  });

  it("OSC 9;4 es progreso de ConEmu, con sus cinco estados", () => {
    expect(parseOsc9("4;1;42")).toEqual({ kind: "progress", state: "normal", value: 42 });
    expect(parseOsc9("4;1;250")).toEqual({ kind: "progress", state: "normal", value: 100 });
    expect(parseOsc9("4;1")).toEqual({ kind: "progress", state: "normal", value: 0 });
    expect(parseOsc9("4;2;80")).toEqual({ kind: "progress", state: "error", value: 80 });
    expect(parseOsc9("4;2")).toEqual({ kind: "progress", state: "error", value: null });
    expect(parseOsc9("4;3")).toEqual({ kind: "progress", state: "indeterminate", value: null });
    expect(parseOsc9("4;4;10")).toEqual({ kind: "progress", state: "paused", value: 10 });
    expect(parseOsc9("4;0")).toEqual({ kind: "progress", state: "remove", value: null });
  });

  it("los demás subcomandos de ConEmu y el progreso mal formado se ignoran", () => {
    expect(parseOsc9("1;100")).toEqual({ kind: "ignore" });
    expect(parseOsc9("9;C:\\")).toEqual({ kind: "ignore" });
    expect(parseOsc9("4")).toEqual({ kind: "ignore" });
    expect(parseOsc9("4;7;50")).toEqual({ kind: "ignore" });
    expect(parseOsc9("4;x")).toEqual({ kind: "ignore" });
    expect(parseOsc9("")).toEqual({ kind: "ignore" });
    expect(parseOsc9("\x07\x1b")).toEqual({ kind: "ignore" });
  });

  it("el aviso se sanea y se corta", () => {
    expect(parseOsc9("hola\x1b[31m rojo\u202Eabc")).toMatchObject({ body: "hola [31m rojoabc" });
    const long = parseOsc9("a".repeat(500), { maxChars: 20 });
    expect(long).toMatchObject({ kind: "notify" });
    expect(Array.from(/** @type {any} */ (long).body)).toHaveLength(20);
  });
});

describe("nextProgress", () => {
  it("error y pausa sin porcentaje conservan el último", () => {
    const prev = { state: "normal", value: 60 };
    expect(nextProgress(prev, { state: "error", value: null })).toEqual({ state: "error", value: 60 });
    expect(nextProgress(prev, { state: "paused", value: null })).toEqual({ state: "paused", value: 60 });
    expect(nextProgress(null, { state: "error", value: null })).toEqual({ state: "error", value: 100 });
    expect(nextProgress(null, { state: "paused", value: null })).toEqual({ state: "paused", value: 0 });
  });

  it("quitar deja sin barra e indeterminado no lleva porcentaje", () => {
    expect(nextProgress({ state: "normal", value: 5 }, { state: "remove", value: null })).toBeNull();
    expect(nextProgress({ state: "normal", value: 5 }, { state: "indeterminate", value: null }))
      .toEqual({ state: "indeterminate", value: null });
    expect(nextProgress(null, { state: "normal", value: 33 })).toEqual({ state: "normal", value: 33 });
  });
});

describe("parseOsc777", () => {
  it("notify;título;texto, con `;` dentro del texto", () => {
    expect(parseOsc777("notify;Build;terminado; 0 errores"))
      .toEqual({ kind: "notify", title: "Build", body: "terminado; 0 errores" });
  });

  it("solo título se enseña como texto; vacío o de otro subcomando, nada", () => {
    expect(parseOsc777("notify;Listo")).toEqual({ kind: "notify", title: "", body: "Listo" });
    expect(parseOsc777("notify;;")).toEqual({ kind: "ignore" });
    expect(parseOsc777("preexec")).toEqual({ kind: "ignore" });
    expect(parseOsc777("notifyx;a;b")).toEqual({ kind: "ignore" });
  });
});

describe("títulos remotos", () => {
  it("se sanean: sin controles, sin marcas de dirección y cortados", () => {
    expect(sanitizeRemoteTitle("  vim\tmain.rs \u2066x\u2069 ")).toBe("vim main.rs x");
    expect(sanitizeRemoteTitle("\u0085\u009b31m")).toBe("31m");
    const long = sanitizeRemoteTitle("é".repeat(400));
    expect(Array.from(long)).toHaveLength(TITLE_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("no parte un emoji al cortar", () => {
    expect(sanitizeTerminalText("ab😀cd", 4)).toBe("ab😀…");
  });

  it("el modo por defecto es el tooltip", () => {
    expect(normalizeRemoteTitleMode(undefined)).toBe("tooltip");
    expect(normalizeRemoteTitleMode("tab")).toBe("tab");
    expect(normalizeRemoteTitleMode("off")).toBe("off");
  });

  it("el alias manual manda sobre el título remoto en la pestaña", () => {
    expect(remoteTitleView({ remoteTitle: "vim", mode: "tab" })).toEqual({ inTab: "vim", inTooltip: "vim" });
    expect(remoteTitleView({ alias: "web", remoteTitle: "vim", mode: "tab" })).toEqual({ inTab: "", inTooltip: "vim" });
    expect(remoteTitleView({ remoteTitle: "vim", mode: "tooltip" })).toEqual({ inTab: "", inTooltip: "vim" });
    expect(remoteTitleView({ remoteTitle: "vim", mode: "off" })).toEqual({ inTab: "", inTooltip: "" });
    expect(remoteTitleView({ remoteTitle: "", mode: "tab" })).toEqual({ inTab: "", inTooltip: "" });
  });
});

describe("tooltipWithRemoteTitle", () => {
  it("añade, cambia y quita la línea del título sin tocar el resto", () => {
    const base = "web ·2 · root@web:22 · SSH — Sesión privada";
    const one = tooltipWithRemoteTitle(base, "", "vim main.rs");
    expect(one).toBe(`${base}\nvim main.rs`);
    const two = tooltipWithRemoteTitle(one, "vim main.rs", "~/src");
    expect(two).toBe(`${base}\n~/src`);
    expect(tooltipWithRemoteTitle(two, "~/src", "")).toBe(base);
  });

  it("si el tooltip se rehízo entretanto, no recorta nada ajeno", () => {
    // updateTabLabel reescribe el tooltip: la línea vieja ya no está al final.
    expect(tooltipWithRemoteTitle("nuevo", "vim", "vim")).toBe("nuevo\nvim");
    expect(tooltipWithRemoteTitle("", "", "")).toBe("");
  });
});

describe("createNotifyLimiter", () => {
  it("deja pasar `max` avisos por ventana y recupera al vencer", () => {
    let now = 0;
    const limiter = createNotifyLimiter({ max: 2, windowMs: 1000, now: () => now });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    now = 999;
    expect(limiter.allow()).toBe(false);
    now = 1000;
    expect(limiter.allow()).toBe(true);
  });
});

describe("sanitizeTerminalText con textos enormes", () => {
  it("recorta antes de sanear: 10 MB no cuestan casi nada y el resultado es el mismo", () => {
    const huge = "aviso ".repeat(2_000_000);
    const started = Date.now();
    const out = sanitizeTerminalText(huge, 200);
    expect(Date.now() - started).toBeLessThan(200);
    expect(Array.from(out).length).toBeLessThanOrEqual(200);
    expect(out.startsWith("aviso aviso")).toBe(true);
  });
});
