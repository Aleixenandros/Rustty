// @ts-check
import { describe, expect, it } from "vitest";
import { passwordPlan } from "./credential-plan.js";

describe("passwordPlan", () => {
  it("KeePass desbloqueada la resuelve el backend: no es una cancelación", () => {
    expect(passwordPlan({ passwordSource: "own", keepassEntryUuid: "uuid-1" }, { keepassUnlocked: true }))
      .toBe("backend");
  });

  it("KeePass bloqueada no deja conectar, aunque llegue una contraseña", () => {
    expect(passwordPlan({ keepassEntryUuid: "uuid-1" }, { keepassUnlocked: false })).toBe("locked");
    expect(passwordPlan({ keepassEntryUuid: "uuid-1" }, { passwordOverride: "x" })).toBe("locked");
  });

  it("la credencial maestra la resuelve el backend, sin pedir nada", () => {
    expect(passwordPlan({ passwordSource: "master" })).toBe("backend");
    expect(passwordPlan({ passwordSource: "master" }, { passwordOverride: "basura" })).toBe("backend");
  });

  it("una identidad adicional con maestra tampoco pregunta", () => {
    // identityView deja keepassEntryUuid en null para las adicionales.
    expect(passwordPlan({ passwordSource: "master", keepassEntryUuid: null })).toBe("backend");
  });

  it("con contraseña propia usa la que llega o la busca/pide", () => {
    expect(passwordPlan({ passwordSource: "own" }, { passwordOverride: "s3cret" })).toBe("override");
    expect(passwordPlan({ passwordSource: "own" })).toBe("ask");
    // Perfiles antiguos sin origen guardado: «propia».
    expect(passwordPlan({})).toBe("ask");
    expect(passwordPlan(null)).toBe("ask");
  });
});
