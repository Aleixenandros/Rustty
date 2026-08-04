// @ts-check
import { describe, expect, it } from "vitest";
import {
  createTransferConflictState,
  nextAvailableTransferName,
  normalizeSftpConflictPolicy,
  recursiveConflictPolicyForTransfer,
} from "./sftp-conflicts.js";

describe("políticas de conflicto SFTP", () => {
  it("sanea preferencias desconocidas", () => {
    expect(normalizeSftpConflictPolicy("rename")).toBe("rename");
    expect(normalizeSftpConflictPolicy(new String("rename"))).toBe("rename");
    expect(normalizeSftpConflictPolicy("desconocida")).toBe("ask");
    expect(normalizeSftpConflictPolicy(null)).toBe("ask");
  });

  it("la política recursiva nunca vuelve a preguntar", () => {
    expect(recursiveConflictPolicyForTransfer(null, "ask")).toBe("overwrite");
    expect(recursiveConflictPolicyForTransfer(null, "skip")).toBe("skip");
    expect(recursiveConflictPolicyForTransfer({ renamed: true }, "skip")).toBe("overwrite");
  });

  it("cada lote reserva nombres por lado de forma independiente", () => {
    const state = createTransferConflictState();
    state.reservedNames.local.add("informe (1).txt");
    expect(state.reservedNames.local.has("informe (1).txt")).toBe(true);
    expect(state.reservedNames.remote.has("informe (1).txt")).toBe(false);
  });
});

describe("nextAvailableTransferName", () => {
  it("conserva la extensión y salta nombres ocupados", () => {
    const occupied = new Set(["informe (1).txt", "informe (2).txt"]);
    expect(nextAvailableTransferName("informe.txt", false, (name) => occupied.has(name)))
      .toBe("informe (3).txt");
  });

  it("no confunde el punto de un directorio con una extensión", () => {
    expect(nextAvailableTransferName("release.v1", true, () => false)).toBe("release.v1 (1)");
  });
});
