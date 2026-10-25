import { describe, expect, it } from "vitest";
import { opensReadOnly, readOnlyInputDecision, readOnlyKeyAction } from "./read-only.js";

describe("readOnlyInputDecision", () => {
  it("una sesión sin bloquear lo envía todo", () => {
    for (const origin of ["user", "broadcast", "system"]) {
      expect(readOnlyInputDecision({ readOnly: false, origin })).toBe("send");
    }
  });

  it("en solo lectura la entrada del usuario no sale y se avisa", () => {
    expect(readOnlyInputDecision({ readOnly: true, origin: "user" })).toBe("block");
    // Sin origen explícito se trata como entrada del usuario: lo seguro.
    expect(readOnlyInputDecision({ readOnly: true })).toBe("block");
  });

  it("el broadcast se salta en silencio las panes bloqueadas", () => {
    expect(readOnlyInputDecision({ readOnly: true, origin: "broadcast" })).toBe("skip");
  });

  it("lo que Rustty manda al conectar (OSC 7, carpeta inicial) sigue pasando", () => {
    expect(readOnlyInputDecision({ readOnly: true, origin: "system" })).toBe("send");
  });
});

describe("readOnlyKeyAction", () => {
  it("sin solo lectura la tecla sigue su camino", () => {
    expect(readOnlyKeyAction({ readOnly: false, status: "connected", key: "a" })).toBe("pass");
    expect(readOnlyKeyAction({ readOnly: false, status: "closed", key: "\r" })).toBe("pass");
  });

  it("Intro sobre una sesión cerrada reconecta aunque esté bloqueada", () => {
    expect(readOnlyKeyAction({ readOnly: true, status: "closed", key: "\r" })).toBe("reconnect");
    expect(readOnlyKeyAction({ readOnly: true, status: "error", key: "\n" })).toBe("reconnect");
  });

  it("cualquier otra tecla avisa, también Intro con la sesión viva", () => {
    expect(readOnlyKeyAction({ readOnly: true, status: "connected", key: "\r" })).toBe("notify");
    expect(readOnlyKeyAction({ readOnly: true, status: "connected", key: "\x03" })).toBe("notify");
    expect(readOnlyKeyAction({ readOnly: true, status: "closed", key: "x" })).toBe("notify");
  });
});

describe("opensReadOnly", () => {
  it("el perfil puede pedirlo siempre", () => {
    expect(opensReadOnly({ open_read_only: true }, {})).toBe(true);
    expect(opensReadOnly({ open_read_only: true, environment: "dev" }, { readOnlyProd: false })).toBe(true);
  });

  it("la preferencia global solo afecta a PROD, y apagada no hace nada", () => {
    expect(opensReadOnly({ environment: "prod" }, { readOnlyProd: true })).toBe(true);
    expect(opensReadOnly({ environment: "PROD" }, { readOnlyProd: true })).toBe(true);
    expect(opensReadOnly({ environment: "stage" }, { readOnlyProd: true })).toBe(false);
    expect(opensReadOnly({ environment: null }, { readOnlyProd: true })).toBe(false);
    expect(opensReadOnly({ environment: "prod" }, { readOnlyProd: false })).toBe(false);
    expect(opensReadOnly({ environment: "prod" }, {})).toBe(false);
  });

  it("sin perfil (o perfil antiguo sin el campo) se abre normal", () => {
    expect(opensReadOnly(null, { readOnlyProd: true })).toBe(false);
    expect(opensReadOnly({}, null)).toBe(false);
  });
});
