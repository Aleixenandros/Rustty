// @ts-check
import { describe, expect, it } from "vitest";
import { localParentPath, splitLocalPathPrefix } from "./local-path.js";
import { pathSegments } from "./path-history.js";

describe("localParentPath", () => {
  it("el padre de una carpeta de la raíz de una unidad es la raíz, con separador", () => {
    expect(localParentPath("C:\\Users")).toBe("C:\\");
    expect(localParentPath("C:\\notas.txt")).toBe("C:\\");
    expect(localParentPath("D:/Fotos")).toBe("D:/");
  });

  it("sube un nivel dentro de una unidad", () => {
    expect(localParentPath("C:\\Users\\ana")).toBe("C:\\Users");
    expect(localParentPath("C:/Users/ana")).toBe("C:/Users");
  });

  it("la raíz de una unidad es su propio padre", () => {
    expect(localParentPath("C:\\")).toBe("C:\\");
    expect(localParentPath("E:/")).toBe("E:/");
  });

  it("una unidad sin separador escrita a mano lleva a su raíz", () => {
    expect(localParentPath("C:")).toBe("C:\\");
  });

  it("no cambia las rutas POSIX", () => {
    expect(localParentPath("/home")).toBe("/");
    expect(localParentPath("/home/ana")).toBe("/home");
    expect(localParentPath("/")).toBe("/");
    expect(localParentPath("")).toBe(null);
  });

  it("las migas del padre de C:\\Users son solo la unidad", () => {
    expect(pathSegments(/** @type {string} */ (localParentPath("C:\\Users"))))
      .toEqual([{ label: "C:", path: "C:\\" }]);
  });
});

describe("splitLocalPathPrefix", () => {
  it("completa dentro de la raíz de la unidad", () => {
    expect(splitLocalPathPrefix("C:\\Us")).toEqual({ parent: "C:\\", prefix: "Us", sep: "\\" });
    expect(splitLocalPathPrefix("C:\\").parent).toBe("C:\\");
    expect(splitLocalPathPrefix("D:/Fo")).toEqual({ parent: "D:/", prefix: "Fo", sep: "/" });
  });

  it("dentro de una carpeta, el padre es la carpeta", () => {
    expect(splitLocalPathPrefix("C:\\Users\\an")).toEqual({ parent: "C:\\Users", prefix: "an", sep: "\\" });
  });

  it("no cambia las rutas POSIX", () => {
    expect(splitLocalPathPrefix("/ho")).toEqual({ parent: "/", prefix: "ho", sep: "/" });
    expect(splitLocalPathPrefix("/home/an")).toEqual({ parent: "/home", prefix: "an", sep: "/" });
    expect(splitLocalPathPrefix("abc")).toEqual({ parent: "abc", prefix: "", sep: "/" });
  });
});
