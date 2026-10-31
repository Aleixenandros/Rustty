// @ts-check
import { describe, expect, it } from "vitest";
import {
  TRANSFER_EXISTS_RETRIES,
  createTransferConflictState,
  namesWithExisting,
  nextAvailableTransferName,
  normalizeSftpConflictPolicy,
  recursiveConflictPolicyForTransfer,
  transferNameKey,
  transferNameSet,
  transferOverwriteFlag,
  transferTarget,
} from "./sftp-conflicts.js";

describe("permiso de sobrescritura de un fichero suelto", () => {
  it("solo viaja cuando se decidió sobrescribir ese nombre", () => {
    expect(transferOverwriteFlag({ action: "transfer", name: "a.txt", overwrite: true })).toBe(true);
  });

  it("un destino nuevo o un nombre renombrado van sin permiso", () => {
    expect(transferOverwriteFlag({ action: "transfer", name: "a.txt" })).toBe(false);
    expect(transferOverwriteFlag({ action: "transfer", name: "a (1).txt", renamed: true })).toBe(false);
    expect(transferOverwriteFlag(null)).toBe(false);
    expect(transferOverwriteFlag({ overwrite: "sí" })).toBe(false);
  });

  it("tras un «ya existe» del backend el nombre cuenta como ocupado", () => {
    const names = namesWithExisting(new Set(["otro.txt"]), "Informe.PDF", { foldCase: true });
    expect(names.has("informe.pdf")).toBe(true);
    expect(names.has("otro.txt")).toBe(true);
    expect(namesWithExisting(null, "a.txt").has("a.txt")).toBe(true);
    expect(namesWithExisting(["x"], "a.txt").size).toBe(2);
  });

  it("los reintentos por «ya existe» están acotados", () => {
    expect(TRANSFER_EXISTS_RETRIES).toBeGreaterThan(0);
    expect(TRANSFER_EXISTS_RETRIES).toBeLessThan(10);
  });
});

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

  it("en un disco sin mayúsculas no propone un nombre que ya existe con otras", () => {
    const fold = { foldCase: true };
    const taken = transferNameSet([{ name: "informe (1).PDF" }], fold);
    expect(nextAvailableTransferName("Informe.pdf", false, (c) => taken.has(transferNameKey(c, fold))))
      .toBe("Informe (2).pdf");
  });
});

describe("transferNameKey", () => {
  it("sin plegar, compara el nombre tal cual", () => {
    expect(transferNameKey("Informe.pdf")).not.toBe(transferNameKey("informe.PDF"));
    expect(transferNameKey("Informe.pdf", { foldCase: false })).toBe("Informe.pdf");
  });

  it("plegado, ignora mayúsculas y la normalización Unicode", () => {
    const fold = { foldCase: true };
    expect(transferNameKey("Informe.pdf", fold)).toBe(transferNameKey("informe.PDF", fold));
    // «Canción» compuesta (NFC) frente a la «o» con tilde combinada (NFD).
    expect(transferNameKey("Canción.mp3", fold)).toBe(transferNameKey("Canción.mp3", fold));
  });

  it("no depende del idioma del sistema (la «I» turca)", () => {
    expect(transferNameKey("INFO.TXT", { foldCase: true })).toBe("info.txt");
  });

  it("el conjunto de un listado usa la misma clave y descarta entradas sin nombre", () => {
    const names = transferNameSet([{ name: "informe.PDF" }, null, { name: "" }], { foldCase: true });
    expect(names.has(transferNameKey("Informe.pdf", { foldCase: true }))).toBe(true);
    expect(names.size).toBe(1);
    expect(transferNameSet(null).size).toBe(0);
  });
});

describe("transferTarget", () => {
  const panel = { cwd: "/srv/app", localCwd: "/home/u/Proyectos/web" };

  it("una descarga conserva la carpeta local de cuando se encoló", () => {
    expect(transferTarget({ direction: "download", targetDir: "/home/u/Descargas" }, panel))
      .toEqual({ side: "local", dir: "/home/u/Descargas", visible: false });
  });

  it("una subida conserva la carpeta remota de cuando se encoló", () => {
    expect(transferTarget({ direction: "upload", targetDir: "/srv/otra" }, panel))
      .toEqual({ side: "remote", dir: "/srv/otra", visible: false });
  });

  it("si el panel sigue en esa carpeta, es la visible", () => {
    expect(transferTarget({ direction: "download", targetDir: "/home/u/Proyectos/web" }, panel).visible)
      .toBe(true);
  });

  it("un trabajo sin carpeta fijada usa la que esté abierta", () => {
    expect(transferTarget({ direction: "upload" }, panel))
      .toEqual({ side: "remote", dir: "/srv/app", visible: true });
    expect(transferTarget(null, panel)).toEqual({ side: "local", dir: "/home/u/Proyectos/web", visible: true });
  });
});
