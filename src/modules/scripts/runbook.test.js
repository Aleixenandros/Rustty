import { describe, it, expect } from "vitest";
import { toMarkdown, fromMarkdown } from "./runbook.js";
import { makeStep } from "./model.js";

/**
 * Construye un script con todos los tipos de paso, para ejercitar el round-trip.
 * @param {import("./model.js").TargetSpec} target
 */
function fullScript(target) {
  return {
    id: "ignored",
    name: "Despliegue nocturno",
    description: "Reinicia servicios y verifica el prompt.",
    target,
    steps: [
      makeStep("send", { text: "sudo systemctl restart nginx" }),
      makeStep("waitPrompt"),
      makeStep("waitRegex", { pattern: "\\$\\s*$", timeoutMs: 5000 }),
      makeStep("expectExit", { code: 0 }),
      makeStep("sendPasswordFromKeyring", { profileId: null }),
      makeStep("sendPasswordFromKeyring", { profileId: "p9" }),
      makeStep("sendPasswordFromKeepass", { uuid: "ABC-123" }),
      makeStep("sleep", { ms: 500 }),
      makeStep("disconnect"),
    ],
    createdAt: "t0",
    updatedAt: "t0",
  };
}

describe("runbook round-trip", () => {
  it("conserva nombre, descripción, pasos y objetivo (perfil)", () => {
    const s = fullScript({ kind: "profile", profileId: "p1" });
    const back = fromMarkdown(toMarkdown(s));
    expect(back).not.toBeNull();
    expect(back.name).toBe(s.name);
    expect(back.description).toBe(s.description);
    expect(back.target).toEqual(s.target);
    expect(back.steps).toEqual(s.steps);
  });

  it("conserva un objetivo de carpeta (con ruta y recursividad)", () => {
    const s = fullScript({
      kind: "folder",
      workspaceId: "default",
      folderPath: "PROD/db",
      recursive: true,
    });
    const back = fromMarkdown(toMarkdown(s));
    expect(back.target).toEqual(s.target);
    expect(back.steps).toEqual(s.steps);
  });

  it("conserva un objetivo ad-hoc con varios ids", () => {
    const s = fullScript({ kind: "adhoc", profileIds: ["a", "b", "c"] });
    const back = fromMarkdown(toMarkdown(s));
    expect(back.target).toEqual(s.target);
  });

  it("conserva un objetivo ad-hoc vacío", () => {
    const s = fullScript({ kind: "adhoc", profileIds: [] });
    const back = fromMarkdown(toMarkdown(s));
    expect(back.target).toEqual({ kind: "adhoc", profileIds: [] });
  });

  it("carpeta no recursiva y ruta raíz", () => {
    const s = fullScript({
      kind: "folder",
      workspaceId: "otro",
      folderPath: "",
      recursive: false,
    });
    const back = fromMarkdown(toMarkdown(s));
    expect(back.target).toEqual(s.target);
  });

  it("script sin pasos ni descripción", () => {
    const s = {
      id: "x",
      name: "Vacío",
      description: "",
      target: { kind: "profile", profileId: "p1" },
      steps: [],
      createdAt: "t",
      updatedAt: "t",
    };
    const back = fromMarkdown(toMarkdown(s));
    expect(back.name).toBe("Vacío");
    expect(back.description).toBe("");
    expect(back.steps).toEqual([]);
    expect(back.target).toEqual(s.target);
  });
});

describe("toMarkdown", () => {
  it("produce un runbook legible con encabezados", () => {
    const md = toMarkdown(fullScript({ kind: "profile", profileId: "p1" }));
    expect(md).toContain("# Despliegue nocturno");
    expect(md).toContain("**Objetivo:**");
    expect(md).toContain("## Pasos");
    expect(md).toMatch(/1\. \*\*send\*\* — sudo systemctl restart nginx/);
  });
});

describe("fromMarkdown", () => {
  it("devuelve null ante entradas irreconocibles", () => {
    expect(fromMarkdown(null)).toBeNull();
    expect(fromMarkdown("texto suelto sin estructura")).toBeNull();
    expect(fromMarkdown("# Solo título\n\nsin objetivo")).toBeNull();
  });

  it("ignora líneas de paso irreconocibles", () => {
    const md = [
      "# X",
      "",
      "**Objetivo:** perfil · id p1",
      "",
      "## Pasos",
      "",
      "1. **send** — echo hola",
      "2. **loquesea** — basura",
      "3. **waitPrompt**",
    ].join("\n");
    const s = fromMarkdown(md);
    expect(s.steps).toEqual([
      makeStep("send", { text: "echo hola" }),
      makeStep("waitPrompt"),
    ]);
  });
});
