import { describe, it, expect } from "vitest";
import {
  MAX_STEPS,
  STEP_TYPES,
  makeStep,
  emptyScript,
  validateScript,
} from "./model.js";

describe("emptyScript", () => {
  it("crea un script vacío con id, marcas de tiempo y objetivo", () => {
    const target = { kind: "profile", profileId: "p1" };
    const s = emptyScript(target);
    expect(s.id).toBeTruthy();
    expect(s.name).toBe("");
    expect(s.steps).toEqual([]);
    expect(s.target).toEqual(target);
    expect(typeof s.createdAt).toBe("string");
    expect(s.createdAt).toBe(s.updatedAt);
  });

  it("por defecto usa una selección ad-hoc vacía", () => {
    const s = emptyScript();
    expect(s.target).toEqual({ kind: "adhoc", profileIds: [] });
  });
});

describe("makeStep", () => {
  it("rellena valores por defecto de cada tipo", () => {
    expect(makeStep("send")).toEqual({ type: "send", text: "" });
    expect(makeStep("waitPrompt")).toEqual({ type: "waitPrompt" });
    expect(makeStep("waitRegex")).toEqual({ type: "waitRegex", pattern: "", timeoutMs: 30000 });
    expect(makeStep("expectExit")).toEqual({ type: "expectExit", code: 0 });
    expect(makeStep("sendPasswordFromKeyring")).toEqual({ type: "sendPasswordFromKeyring", profileId: null });
    expect(makeStep("sendPasswordFromKeepass")).toEqual({ type: "sendPasswordFromKeepass", uuid: "" });
    expect(makeStep("sleep")).toEqual({ type: "sleep", ms: 0 });
    expect(makeStep("disconnect")).toEqual({ type: "disconnect" });
  });

  it("toma los campos indicados y coacciona números", () => {
    expect(makeStep("waitRegex", { pattern: "\\$\\s", timeoutMs: "5000" })).toEqual({
      type: "waitRegex",
      pattern: "\\$\\s",
      timeoutMs: 5000,
    });
    expect(makeStep("sleep", { ms: "250" })).toEqual({ type: "sleep", ms: 250 });
  });

  it("lanza ante un tipo desconocido", () => {
    // @ts-expect-error tipo inválido a propósito
    expect(() => makeStep("nope")).toThrow();
  });

  it("STEP_TYPES enumera los ocho tipos válidos y está congelado", () => {
    expect(Object.keys(STEP_TYPES).sort()).toEqual(
      [
        "disconnect",
        "expectExit",
        "send",
        "sendPasswordFromKeepass",
        "sendPasswordFromKeyring",
        "sleep",
        "waitPrompt",
        "waitRegex",
      ].sort()
    );
    expect(Object.isFrozen(STEP_TYPES)).toBe(true);
  });
});

describe("validateScript", () => {
  const okTarget = { kind: "profile", profileId: "p1" };

  it("acepta un script válido", () => {
    const s = {
      id: "s1",
      name: "Reinicio nginx",
      target: okTarget,
      steps: [
        makeStep("send", { text: "sudo systemctl restart nginx" }),
        makeStep("waitPrompt"),
        makeStep("waitRegex", { pattern: "\\$\\s*$", timeoutMs: 5000 }),
        makeStep("sleep", { ms: 0 }),
        makeStep("disconnect"),
      ],
      createdAt: "x",
      updatedAt: "x",
    };
    expect(validateScript(s)).toEqual({ ok: true, errors: [] });
  });

  it("rechaza nombre vacío", () => {
    const r = validateScript({ name: "  ", target: okTarget, steps: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "name_required")).toBe(true);
  });

  it("rechaza objetivos mal formados", () => {
    expect(validateScript({ name: "x", target: { kind: "profile" }, steps: [] }).ok).toBe(false);
    expect(validateScript({ name: "x", target: { kind: "adhoc", profileIds: [] }, steps: [] }).ok).toBe(false);
    expect(validateScript({ name: "x", target: { kind: "raro" }, steps: [] }).ok).toBe(false);
  });

  it("acepta carpeta bien formada (incluida la raíz)", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "", recursive: true };
    expect(validateScript({ name: "x", target: t, steps: [] }).ok).toBe(true);
  });

  it("rechaza pasos mal formados", () => {
    const bad = validateScript({
      name: "x",
      target: okTarget,
      steps: [
        { type: "send" }, // falta text
        { type: "waitRegex", pattern: "", timeoutMs: 0 }, // pattern vacío y timeout <= 0
        { type: "waitRegex", pattern: "(", timeoutMs: 100 }, // regex inválida
        { type: "sleep", ms: -1 }, // ms negativo
        { type: "expectExit", code: 1.5 }, // no entero
        { type: "sendPasswordFromKeepass", uuid: "" }, // uuid vacío
        { type: "loquesea" }, // tipo desconocido
      ],
    });
    expect(bad.ok).toBe(false);
    // Un error por cada uno de los siete pasos mal formados.
    expect(bad.errors.filter((e) => e.params && e.params.step != null).length).toBeGreaterThanOrEqual(7);
  });

  it("permite `sendPasswordFromKeyring` con profileId null", () => {
    const r = validateScript({
      name: "x",
      target: okTarget,
      steps: [{ type: "sendPasswordFromKeyring", profileId: null }],
    });
    expect(r.ok).toBe(true);
  });

  it("MAX_STEPS es 50, espejo del backend (types.rs)", () => {
    // Anclado a propósito: si cambia, debe cambiar también en Rust y en la
    // línea roja de memoria/AGENTS.md.
    expect(MAX_STEPS).toBe(50);
  });

  it("rechaza superar MAX_STEPS", () => {
    const steps = Array.from({ length: MAX_STEPS + 1 }, () => makeStep("waitPrompt"));
    const r = validateScript({ name: "x", target: okTarget, steps });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "too_many_steps")).toBe(true);
  });

  it("rechaza entradas no objeto", () => {
    expect(validateScript(null).ok).toBe(false);
    expect(validateScript("x").ok).toBe(false);
  });
});
