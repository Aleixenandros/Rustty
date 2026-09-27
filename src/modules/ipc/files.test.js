import { describe, it, expect } from "vitest";
import {
  createFileApi,
  isFileGrantError,
  localCommandError,
  pickedFile,
  pickedPaths,
  pickRequest,
} from "./files.js";

/**
 * `invoke` falso que registra las llamadas y responde por comando.
 * @param {Record<string, unknown>} responses respuesta (o función de los args) por comando
 */
function fakeInvoke(responses) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses[cmd];
    return typeof r === "function" ? r(args) : r;
  };
  return { invoke, calls };
}

describe("pickRequest", () => {
  it("traduce las opciones del plugin y descarta lo vacío", () => {
    expect(pickRequest("save", {
      title: "Exportar",
      defaultPath: "tema.json",
      filters: [{ name: "JSON", extensions: ["json"] }, { name: "vacío", extensions: [] }],
    })).toEqual({
      options: {
        mode: "save",
        title: "Exportar",
        defaultPath: "tema.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      },
    });
    expect(pickRequest("open")).toEqual({ options: { mode: "open", filters: [] } });
    expect(pickRequest("open", { defaultPath: null, title: "" })).toEqual({
      options: { mode: "open", filters: [] },
    });
  });
});

describe("resultado del diálogo", () => {
  it("un fichero elegido lleva ruta y permiso; cancelar da null", () => {
    expect(pickedFile({ paths: ["/h/a.json"], grant: "t1" })).toEqual({ path: "/h/a.json", grant: "t1" });
    expect(pickedFile(null)).toBeNull();
    // Sin permiso no hay nada que leer ni escribir.
    expect(pickedFile({ paths: ["/h/a.json"], grant: null })).toBeNull();
  });

  it("las rutas sueltas no necesitan permiso", () => {
    expect(pickedPaths({ paths: ["/a", "/b"], grant: null })).toEqual(["/a", "/b"]);
    expect(pickedPaths({ paths: [], grant: null })).toBeNull();
    expect(pickedPaths(null)).toBeNull();
  });
});

describe("createFileApi", () => {
  it("lee y escribe con el permiso, nunca con la ruta", async () => {
    const { invoke, calls } = fakeInvoke({
      fs_pick: (args) => ({ paths: ["/h/x.json"], grant: `g-${args.options.mode}` }),
      read_text_file: "{}",
      write_text_file: undefined,
    });
    const api = createFileApi(invoke);
    const src = await api.pickFileToOpen({ title: "Importar" });
    expect(await api.readTextFile(src, 1024)).toBe("{}");
    const dst = await api.pickFileToSave({ defaultPath: "x.json" });
    await api.writeTextFile(dst, "datos");

    expect(calls.map((c) => c.cmd)).toEqual(["fs_pick", "read_text_file", "fs_pick", "write_text_file"]);
    expect(calls[1].args).toEqual({ grant: "g-open", maxBytes: 1024 });
    expect(calls[3].args).toEqual({ grant: "g-save", contents: "datos" });
    for (const c of calls.slice(1)) expect(c.args).not.toHaveProperty("path");
  });

  it("cancelar el diálogo devuelve null en todos los modos", async () => {
    const { invoke } = fakeInvoke({ fs_pick: null });
    const api = createFileApi(invoke);
    expect(await api.pickFileToOpen()).toBeNull();
    expect(await api.pickFileToSave()).toBeNull();
    expect(await api.pickFiles()).toBeNull();
    expect(await api.pickFilePath()).toBeNull();
    expect(await api.pickDirectory()).toBeNull();
  });

  it("carpetas y rutas de configuración piden el modo correcto", async () => {
    const { invoke, calls } = fakeInvoke({ fs_pick: { paths: ["/datos"], grant: null } });
    const api = createFileApi(invoke);
    expect(await api.pickDirectory()).toBe("/datos");
    expect(await api.pickFilePath()).toBe("/datos");
    expect(await api.pickFiles()).toEqual(["/datos"]);
    expect(calls.map((c) => c.args.options.mode)).toEqual(["directory", "openPath", "openMany"]);
  });
});

describe("errores con marcador", () => {
  it("reconoce los errores de permiso", () => {
    expect(isFileGrantError("fs-grant: el permiso ha caducado")).toBe(true);
    expect(isFileGrantError("No such file or directory")).toBe(false);
    expect(isFileGrantError(null)).toBe(false);
  });

  it("separa código y detalle de los comandos locales", () => {
    expect(localCommandError("local-command:option_value|${host}")).toEqual({ code: "option_value", detail: "${host}" });
    expect(localCommandError("local-command:rejected|")).toEqual({ code: "rejected", detail: "" });
    expect(localCommandError("local-command:empty")).toEqual({ code: "empty", detail: "" });
    expect(localCommandError("comando vacío")).toBeNull();
  });
});
