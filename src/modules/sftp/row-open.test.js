// @ts-check
import { describe, expect, it, vi } from "vitest";
import { sftpRowOpenAction } from "./row-open.js";

describe("sftpRowOpenAction", () => {
  it("una carpeta se abre sin sondear", async () => {
    const probe = vi.fn(async () => []);
    expect(await sftpRowOpenAction({ isDir: true, isSymlink: false }, probe)).toBe("navigate");
    expect(probe).not.toHaveBeenCalled();
  });

  it("un fichero normal se transfiere sin sondear", async () => {
    const probe = vi.fn(async () => []);
    expect(await sftpRowOpenAction({ isDir: false, isSymlink: false }, probe)).toBe("transfer");
    expect(probe).not.toHaveBeenCalled();
  });

  it("un enlace cuyo destino se puede listar es una carpeta: se abre", async () => {
    const probe = vi.fn(async () => [{ name: "ls" }]);
    expect(await sftpRowOpenAction({ isDir: false, isSymlink: true }, probe)).toBe("navigate");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("un enlace a fichero (o roto) se transfiere como hasta ahora", async () => {
    const probe = vi.fn(async () => { throw new Error("Not a directory"); });
    expect(await sftpRowOpenAction({ isDir: false, isSymlink: true }, probe)).toBe("transfer");
  });
});
