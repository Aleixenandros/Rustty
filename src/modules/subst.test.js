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

  it("secret/master con nombre inválido quedan literales, como en el backend", () => {
    // Espejo de `is_valid_name` (engine.rs): si la preview redactara estos, el
    // marcador viajaría literal al servidor mientras la UI muestra `••••`.
    expect(substitutePreview("${secret:1a}", {})).toBe("${secret:1a}");
    expect(substitutePreview("${secret:a b}", {})).toBe("${secret:a b}");
    expect(substitutePreview("${master:-x}", {})).toBe("${master:-x}");
    // Los válidos con `_`, `-`, `.` intercalados sí se redactan.
    expect(substitutePreview("${secret:_tok-2.prod}", {})).toBe("••••");
  });

  it("doble dólar sin llave es literal (espejo del motor Rust)", () => {
    expect(substitutePreview("precio 5$$ total", {})).toBe("precio 5$$ total");
    expect(substitutePreview("$${host}", { host: "h" })).toBe("${host}");
  });

  it("lee hasta el primer cierre: sin anidamiento (espejo del motor Rust)", () => {
    expect(substitutePreview("${secret:a}b}", {})).toBe("••••b}");
  });

  it("var/ask/env/cmd se dejan literales (resolución en backend)", () => {
    expect(substitutePreview("${var:region}", {})).toBe("${var:region}");
    expect(substitutePreview("${ask:Etiqueta}", {})).toBe("${ask:Etiqueta}");
    expect(substitutePreview("${env:HOME}", {})).toBe("${env:HOME}");
    expect(substitutePreview("${cmd:date}", {})).toBe("${cmd:date}");
  });
});
