import { describe, it, expect } from "vitest";
import {
  quotePosixPath,
  quoteWindowsPath,
  quotePath,
  buildDropInsertText,
} from "./shell-quote.js";

describe("quotePosixPath", () => {
  it("deja sin comillas una ruta limpia", () => {
    expect(quotePosixPath("/home/user/file.txt")).toBe("/home/user/file.txt");
    expect(quotePosixPath("/srv/app-2.0/log_file")).toBe("/srv/app-2.0/log_file");
  });

  it("envuelve en comillas simples cuando hay espacios", () => {
    expect(quotePosixPath("/home/user/mi archivo.txt")).toBe(
      "'/home/user/mi archivo.txt'"
    );
  });

  it("escapa la comilla simple como '\\'' ", () => {
    expect(quotePosixPath("/tmp/it's mine")).toBe("'/tmp/it'\\''s mine'");
  });

  it("neutraliza metacaracteres del shell", () => {
    expect(quotePosixPath("/tmp/$(rm -rf)")).toBe("'/tmp/$(rm -rf)'");
    expect(quotePosixPath("/tmp/a;b&c|d")).toBe("'/tmp/a;b&c|d'");
    expect(quotePosixPath("/tmp/back`tick`")).toBe("'/tmp/back`tick`'");
    expect(quotePosixPath("/tmp/glob*?[x]")).toBe("'/tmp/glob*?[x]'");
  });

  it("trata el salto de línea como contenido literal entre comillas", () => {
    expect(quotePosixPath("/tmp/a\nb")).toBe("'/tmp/a\nb'");
  });

  it("la cadena vacía se quotea explícitamente", () => {
    expect(quotePosixPath("")).toBe("''");
  });
});

describe("quoteWindowsPath", () => {
  it("deja sin comillas una ruta limpia con backslashes y unidad", () => {
    expect(quoteWindowsPath("C:\\Users\\ana\\file.txt")).toBe(
      "C:\\Users\\ana\\file.txt"
    );
  });

  it("envuelve en comillas dobles cuando hay espacios", () => {
    expect(quoteWindowsPath("C:\\Program Files\\app\\bin.exe")).toBe(
      '"C:\\Program Files\\app\\bin.exe"'
    );
  });

  it("duplica una comilla doble por robustez", () => {
    expect(quoteWindowsPath('C:\\a "b" c')).toBe('"C:\\a ""b"" c"');
  });
});

describe("quotePath (despacho por plataforma)", () => {
  it("usa POSIX por defecto y Windows cuando se pide", () => {
    expect(quotePath("/tmp/a b", "posix")).toBe("'/tmp/a b'");
    expect(quotePath("C:\\a b", "windows")).toBe('"C:\\a b"');
  });
});

describe("buildDropInsertText", () => {
  it("une varias rutas quoteadas con espacio y añade espacio final", () => {
    expect(
      buildDropInsertText(["/tmp/a", "/tmp/b c"], { platform: "posix" })
    ).toBe("/tmp/a '/tmp/b c' ");
  });

  it("permite desactivar el espacio final", () => {
    expect(
      buildDropInsertText(["/tmp/a"], { platform: "posix", trailingSpace: false })
    ).toBe("/tmp/a");
  });

  it("envuelve en bracketed paste cuando se solicita", () => {
    expect(
      buildDropInsertText(["/tmp/a"], { platform: "posix", bracketed: true })
    ).toBe("\x1b[200~/tmp/a \x1b[201~");
  });

  it("filtra entradas vacías o no-string y devuelve cadena vacía si no queda nada", () => {
    expect(buildDropInsertText([], {})).toBe("");
    // @ts-expect-error entradas no-string deben filtrarse
    expect(buildDropInsertText(["", null, undefined, 5], { platform: "posix" })).toBe("");
  });

  it("rutas Windows con espacios", () => {
    expect(
      buildDropInsertText(["C:\\Program Files\\x", "C:\\tmp\\y"], {
        platform: "windows",
      })
    ).toBe('"C:\\Program Files\\x" C:\\tmp\\y ');
  });
});
