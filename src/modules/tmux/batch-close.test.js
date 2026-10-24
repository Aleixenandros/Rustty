import { describe, expect, it } from "vitest";
import { normalizeTmuxBatchClose } from "./batch-close.js";

// Una pestaña SSH normal (A), una conexión tmux R con dos ventanas y sus panes.
const ROLES = {
  A: { role: "plain" },
  R: { role: "root" },
  "R-w0": { role: "window", conn: "R" },
  "R-p0": { role: "pane", conn: "R" },
  "R-w1": { role: "window", conn: "R" },
  "R-p1": { role: "pane", conn: "R" },
};
const ALL = Object.keys(ROLES);
const roleOf = (sid) => ROLES[sid] || { role: "plain" };
const run = (candidates) => normalizeTmuxBatchClose({ candidates, all: ALL, roleOf });

describe("normalizeTmuxBatchClose", () => {
  it("«Cerrar todas»: la conexión tmux se cierra por su raíz, sin ventanas ni panes", () => {
    expect(run(ALL)).toEqual({ ids: ["A", "R"], confirmEach: [] });
  });

  it("«Cerrar las demás» desde una ventana conserva su conexión", () => {
    const res = run(ALL.filter((sid) => sid !== "R-w0"));
    expect(res.ids).toEqual(["A"]);
    expect(res.ids).not.toContain("R");
    // La otra ventana de la misma conexión pide su propia confirmación (kill-window).
    expect(res.confirmEach).toEqual(["R-w1"]);
  });

  it("«Cerrar a la derecha» desde una ventana no cierra la raíz", () => {
    const res = run(["R-w1"]);
    expect(res.ids).toEqual([]);
    expect(res.confirmEach).toEqual(["R-w1"]);
  });

  it("«Cerrar a la derecha» con todas las ventanas dentro desconecta por la raíz, sin kill-window", () => {
    // Orden del DOM con una ventana arrastrada antes de la raíz: [A, R-w1, R, R-w0].
    expect(run(["R-w1", "R", "R-w0"])).toEqual({ ids: ["R"], confirmEach: [] });
  });

  it("una ventana anclada (fuera del lote) conserva la conexión en «Cerrar todas»", () => {
    const res = run(ALL.filter((sid) => sid !== "R-w1"));
    expect(res.ids).toEqual(["A"]);
    expect(res.confirmEach).toEqual(["R-w0"]);
  });

  it("sin tmux, el lote no cambia", () => {
    const res = normalizeTmuxBatchClose({
      candidates: ["A", "B"],
      all: ["A", "B", "C"],
      roleOf: () => ({ role: "plain" }),
    });
    expect(res).toEqual({ ids: ["A", "B"], confirmEach: [] });
  });
});
