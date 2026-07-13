import { describe, it, expect } from "vitest";
import { toMarkdown, fromMarkdown, parseRunbook } from "./runbook.js";
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
  it("produce un runbook legible con tokens canónicos neutros", () => {
    const md = toMarkdown(fullScript({ kind: "profile", profileId: "p1" }));
    expect(md).toContain("# Despliegue nocturno");
    expect(md).toContain("**Target:** profile id=p1");
    expect(md).toContain("## Steps");
    expect(md).toMatch(/1\. \*\*send\*\* — sudo systemctl restart nginx/);
    // Los tokens estructurales ya no dependen del castellano.
    expect(md).not.toContain("**Objetivo:**");
    expect(md).not.toContain("## Pasos");
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
      "**Target:** profile id=p1",
      "",
      "## Steps",
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

describe("runbooks legados (tokens en castellano)", () => {
  it("lee el formato v1 completo", () => {
    const md = [
      "# Antiguo",
      "",
      "Descripción previa.",
      "",
      "**Objetivo:** carpeta · workspace default · recursivo sí · ruta PROD/db",
      "",
      "## Pasos",
      "",
      "1. **send** — uptime",
      "2. **waitRegex** — timeout 5000 ms · patrón: \\$\\s*$",
      "3. **expectExit** — código 0",
      "4. **sendPasswordFromKeyring** — contraseña de keyring",
      "5. **sendPasswordFromKeyring** — contraseña de keyring · perfil p9",
      "6. **sendPasswordFromKeepass** — contraseña de KeePass · uuid ABC-123",
      "7. **sleep** — pausa 500 ms",
      "8. **disconnect**",
    ].join("\n");
    const { script, ignored } = parseRunbook(md);
    expect(ignored).toEqual([]);
    expect(script.name).toBe("Antiguo");
    expect(script.description).toBe("Descripción previa.");
    expect(script.target).toEqual({
      kind: "folder",
      workspaceId: "default",
      folderPath: "PROD/db",
      recursive: true,
    });
    expect(script.steps).toEqual([
      makeStep("send", { text: "uptime" }),
      makeStep("waitRegex", { timeoutMs: 5000, pattern: "\\$\\s*$" }),
      makeStep("expectExit", { code: 0 }),
      makeStep("sendPasswordFromKeyring", { profileId: null }),
      makeStep("sendPasswordFromKeyring", { profileId: "p9" }),
      makeStep("sendPasswordFromKeepass", { uuid: "ABC-123" }),
      makeStep("sleep", { ms: 500 }),
      makeStep("disconnect"),
    ]);
  });

  it("lee los objetivos legados de perfil y selección", () => {
    const head = (objetivo) => ["# X", "", `**Objetivo:** ${objetivo}`, "", "## Pasos", ""].join("\n");
    expect(fromMarkdown(head("perfil · id p1")).target).toEqual({
      kind: "profile",
      profileId: "p1",
    });
    expect(fromMarkdown(head("selección · ids a, b")).target).toEqual({
      kind: "adhoc",
      profileIds: ["a", "b"],
    });
    expect(fromMarkdown(head("selección · ids")).target).toEqual({
      kind: "adhoc",
      profileIds: [],
    });
  });

  it("un runbook exportado como v1 se reexporta como v2 sin perder nada", () => {
    const v1 = [
      "# Migrado",
      "",
      "**Objetivo:** perfil · id p1",
      "",
      "## Pasos",
      "",
      "1. **send** — echo hola",
      "2. **sleep** — pausa 250 ms",
    ].join("\n");
    const back = fromMarkdown(toMarkdown(fromMarkdown(v1)));
    expect(back.target).toEqual({ kind: "profile", profileId: "p1" });
    expect(back.steps).toEqual([
      makeStep("send", { text: "echo hola" }),
      makeStep("sleep", { ms: 250 }),
    ]);
  });
});

describe("parseRunbook (diagnóstico)", () => {
  it("no reporta nada cuando el runbook está completo", () => {
    const md = toMarkdown(fullScript({ kind: "profile", profileId: "p1" }));
    const { script, ignored } = parseRunbook(md);
    expect(ignored).toEqual([]);
    expect(script.steps).toHaveLength(9);
  });

  it("reporta los pasos no reconocidos con su número de línea", () => {
    const md = [
      "# X", // 1
      "", // 2
      "**Target:** profile id=p1", // 3
      "", // 4
      "## Steps", // 5
      "", // 6
      "1. **send** — echo hola", // 7
      "2. **loquesea** — basura", // 8
      "3. **sleep** — 500 ms", // 9 (payload legado mal escrito: sin `pausa`)
      "4. **waitPrompt**", // 10
    ].join("\n");
    const { script, ignored } = parseRunbook(md);
    expect(script.steps).toEqual([
      makeStep("send", { text: "echo hola" }),
      makeStep("waitPrompt"),
    ]);
    expect(ignored).toEqual([
      { line: 8, text: "**loquesea** — basura" },
      { line: 9, text: "**sleep** — 500 ms" },
    ]);
  });

  it("reporta un paso al que se le cayó el número de lista", () => {
    const md = [
      "# X",
      "",
      "**Target:** profile id=p1",
      "",
      "## Steps",
      "",
      "1. **send** — echo uno",
      "**send** — echo dos",
      "- **waitPrompt**",
    ].join("\n");
    const { script, ignored } = parseRunbook(md);
    expect(script.steps).toEqual([makeStep("send", { text: "echo uno" })]);
    expect(ignored).toEqual([
      { line: 8, text: "**send** — echo dos" },
      { line: 9, text: "- **waitPrompt**" },
    ]);
  });

  it("la prosa entre pasos no se reporta como ignorada", () => {
    const md = [
      "# X",
      "",
      "**Target:** profile id=p1",
      "",
      "## Steps",
      "",
      "1. **send** — echo hola",
      "",
      "Nota: este runbook se ejecuta de noche.",
      "",
      "2. **waitPrompt**",
    ].join("\n");
    const { script, ignored } = parseRunbook(md);
    expect(ignored).toEqual([]);
    expect(script.steps).toHaveLength(2);
  });

  it("un objetivo irreconocible no devuelve script", () => {
    const md = ["# X", "", "**Target:** vete a saber", "", "## Steps", ""].join("\n");
    expect(parseRunbook(md).script).toBeNull();
  });
});
