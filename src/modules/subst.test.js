import { describe, it, expect } from "vitest";
import { substituteWith, substitutePreview } from "./subst.js";

describe("substituteWith (parser de una pasada)", () => {
  it("resuelve marcadores con la función dada", () => {
    expect(substituteWith("hola ${x}", (b) => (b === "x" ? "mundo" : null))).toBe(
      "hola mundo"
    );
  });

  it("escapa $${...} a literal ${...}", () => {
    expect(substituteWith("$${host}", () => "X")).toBe("${host}");
  });

  it("deja literal el marcador cuyo resolve devuelve null", () => {
    expect(substituteWith("${desconocido}", () => null)).toBe("${desconocido}");
  });

  it("deja literal un marcador sin cierre", () => {
    expect(substituteWith("cola ${sinCierre", () => "X")).toBe("cola ${sinCierre");
  });

  it("no reescanea el resultado (anti-fuga)", () => {
    // El resolve devuelve algo que parece otro marcador: NO debe re-sustituirse.
    expect(substituteWith("${a}", () => "${secret:token}")).toBe("${secret:token}");
  });

  it("devuelve cadena vacía si el template no es string", () => {
    // @ts-expect-error: entrada inválida a propósito
    expect(substituteWith(null, () => "X")).toBe("");
  });
});

describe("substitutePreview (espejo cliente, sin exponer secretos)", () => {
  it("resuelve internos desde el contexto", () => {
    expect(substitutePreview("${host}:${port} (${user})", { host: "h", port: 22, user: "u" })).toBe(
      "h:22 (u)"
    );
  });

  it("interno ausente en el contexto → cadena vacía", () => {
    expect(substitutePreview("[${workspace}]", {})).toBe("[]");
  });

  it("redacta secret y master, nunca el valor", () => {
    expect(substitutePreview("${secret:foo}", {})).toBe("••••");
    expect(substitutePreview("${master:db}", {})).toBe("••••");
  });

  it("secret/master sin cuerpo quedan literales", () => {
    expect(substitutePreview("${secret:}", {})).toBe("${secret:}");
  });

  it("var/ask/env/cmd se dejan literales (resolución en backend)", () => {
    expect(substitutePreview("${var:region}", {})).toBe("${var:region}");
    expect(substitutePreview("${ask:Etiqueta}", {})).toBe("${ask:Etiqueta}");
    expect(substitutePreview("${env:HOME}", {})).toBe("${env:HOME}");
    expect(substitutePreview("${cmd:date}", {})).toBe("${cmd:date}");
  });
});
