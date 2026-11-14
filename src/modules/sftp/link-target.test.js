// @ts-check
import { describe, expect, it } from "vitest";
import {
  displayLinkTarget,
  linkInfo,
  LINK_TARGET_DISPLAY_MAX,
  normalizeRemotePath,
  remoteDirname,
  resolveLinkTarget,
} from "./link-target.js";

describe("normalizeRemotePath", () => {
  it("quita barras repetidas, puntos y barra final", () => {
    expect(normalizeRemotePath("/var//log/./nginx/")).toBe("/var/log/nginx");
    expect(normalizeRemotePath("/")).toBe("/");
    expect(normalizeRemotePath("//")).toBe("/");
    expect(normalizeRemotePath("")).toBe("/");
  });

  it("aplica los `..` sin salirse de la raíz", () => {
    expect(normalizeRemotePath("/srv/app/releases/../current")).toBe("/srv/app/current");
    expect(normalizeRemotePath("/a/b/../../c")).toBe("/c");
    expect(normalizeRemotePath("/..")).toBe("/");
    expect(normalizeRemotePath("/../../etc/passwd")).toBe("/etc/passwd");
    expect(normalizeRemotePath("/a/../../../b")).toBe("/b");
  });

  it("no toca nombres que solo se parecen a `.` y `..`", () => {
    expect(normalizeRemotePath("/a/.../b")).toBe("/a/.../b");
    expect(normalizeRemotePath("/a/..b/.c")).toBe("/a/..b/.c");
    expect(normalizeRemotePath("/con espacio/ñandú")).toBe("/con espacio/ñandú");
  });

  it("deja igual las rutas de un servidor Windows", () => {
    expect(normalizeRemotePath("/C:/Users/ana/../Public")).toBe("/C:/Users/Public");
  });
});

describe("remoteDirname", () => {
  it("da la carpeta que contiene la ruta", () => {
    expect(remoteDirname("/etc/nginx/nginx.conf")).toBe("/etc/nginx");
    expect(remoteDirname("/etc")).toBe("/");
    expect(remoteDirname("/")).toBe("/");
    expect(remoteDirname("/var/log/")).toBe("/var");
  });
});

describe("resolveLinkTarget", () => {
  it("un destino absoluto no depende de dónde esté el enlace", () => {
    expect(resolveLinkTarget("/home/ana/config", "/etc/app.conf")).toBe("/etc/app.conf");
    expect(resolveLinkTarget("/home/ana/config", "/etc//app/../app.conf")).toBe("/etc/app.conf");
  });

  it("un destino relativo cuenta desde la carpeta del enlace", () => {
    expect(resolveLinkTarget("/srv/app/current", "releases/v2")).toBe("/srv/app/releases/v2");
    expect(resolveLinkTarget("/srv/app/current", "./releases/v2/")).toBe("/srv/app/releases/v2");
    expect(resolveLinkTarget("/srv/app/current", "../comun/actual")).toBe("/srv/comun/actual");
    expect(resolveLinkTarget("/bin", "usr/bin")).toBe("/usr/bin");
  });

  it("no cuenta desde la carpeta que el panel tenga delante, sino desde la del enlace", () => {
    // El mismo enlace encontrado por una búsqueda recursiva desde `/srv`.
    expect(resolveLinkTarget("/srv/app/shared/logs", "../../logs")).toBe("/srv/logs");
  });

  it("los `..` de más se quedan en la raíz", () => {
    expect(resolveLinkTarget("/a/enlace", "../../../../etc")).toBe("/etc");
    expect(resolveLinkTarget("/enlace", "..")).toBe("/");
  });

  it("aguanta una barra final en la ruta del enlace", () => {
    expect(resolveLinkTarget("/srv/app/current/", "releases/v2")).toBe("/srv/app/releases/v2");
  });

  it("sin destino utilizable no hay ruta", () => {
    expect(resolveLinkTarget("/a/b", "")).toBeNull();
    expect(resolveLinkTarget("/a/b", null)).toBeNull();
    expect(resolveLinkTarget("/a/b", undefined)).toBeNull();
    expect(resolveLinkTarget("/a/b", 42)).toBeNull();
    expect(resolveLinkTarget("/a/b", "x\0y")).toBeNull();
    // Enlace sin ruta absoluta: un destino relativo no tiene desde dónde contar.
    expect(resolveLinkTarget("enlace", "destino")).toBeNull();
    expect(resolveLinkTarget("", "destino")).toBeNull();
  });

  it("el destino es texto: lo que parezca marcado u orden se queda en un nombre", () => {
    expect(resolveLinkTarget("/a/b", "<img src=x onerror=alert(1)>")).toBe("/a/<img src=x onerror=alert(1)>");
    expect(resolveLinkTarget("/a/b", "$(rm -rf ~); `id`")).toBe("/a/$(rm -rf ~); `id`");
  });
});

describe("displayLinkTarget", () => {
  it("deja igual un destino normal", () => {
    expect(displayLinkTarget("../comun/actual")).toBe("../comun/actual");
    expect(displayLinkTarget("/con espacio/ñandú 🦀")).toBe("/con espacio/ñandú 🦀");
  });

  it("no deja pasar saltos de línea ni otros controles", () => {
    expect(displayLinkTarget("/tmp/a\nb\tc\u001b[31m")).toBe("/tmp/a\ufffdb\ufffdc\ufffd[31m");
    expect(displayLinkTarget("a\u0000b\u007fc\u0085d")).toBe("a\ufffdb\ufffdc\ufffdd");
  });

  it("quita las marcas que invierten el orden del texto", () => {
    // Con RLO, «gpj.exe» se leería «exe.jpg».
    expect(displayLinkTarget("/tmp/foto\u202egpj.exe")).toBe("/tmp/fotogpj.exe");
    expect(displayLinkTarget("\u2066a\u2069\u200f\u061cb")).toBe("ab");
  });

  it("corta un destino larguísimo sin partir un carácter", () => {
    const long = "a".repeat(5000);
    const shown = displayLinkTarget(long);
    expect(Array.from(shown)).toHaveLength(LINK_TARGET_DISPLAY_MAX);
    expect(shown.endsWith("…")).toBe(true);
    expect(displayLinkTarget("🦀🦀🦀🦀🦀", 3)).toBe("🦀🦀…");
    expect(displayLinkTarget("abc", 3)).toBe("abc");
  });

  it("no revienta con lo que no es texto", () => {
    expect(displayLinkTarget(null)).toBe("");
    expect(displayLinkTarget(undefined)).toBe("");
    expect(displayLinkTarget(7)).toBe("7");
  });
});

describe("linkInfo", () => {
  it("junta el destino, su ruta y qué hay al final", () => {
    expect(linkInfo("/srv/app/current", { target: "releases/v2", is_dir: true })).toEqual({
      target: "releases/v2",
      path: "/srv/app/releases/v2",
      kind: "dir",
    });
    expect(linkInfo("/home/ana/config", { target: "/etc/app.conf", is_dir: false })).toEqual({
      target: "/etc/app.conf",
      path: "/etc/app.conf",
      kind: "file",
    });
  });

  it("prefiere la ruta real que resolvió el servidor a la cuenta léxica", () => {
    // `current` es un enlace a `releases/v2`: contando `../../shared` desde
    // `/srv/app/current` saldría `/srv/shared`, que no es.
    const raw = { target: "../../shared", is_dir: true, resolved: "/srv/app/shared" };
    expect(linkInfo("/srv/app/current/shared", raw)).toEqual({
      target: "../../shared",
      path: "/srv/app/shared",
      kind: "dir",
    });
    expect(linkInfo("/srv/app/current/shared", { ...raw, resolved: null })?.path).toBe("/srv/shared");
  });

  it("una ruta real que no es absoluta no se usa", () => {
    const raw = { target: "releases/v2", is_dir: true };
    expect(linkInfo("/srv/app/current", { ...raw, resolved: "releases/v2" })?.path).toBe("/srv/app/releases/v2");
    expect(linkInfo("/srv/app/current", { ...raw, resolved: "" })?.path).toBe("/srv/app/releases/v2");
    expect(linkInfo("/srv/app/current", { ...raw, resolved: 7 })?.path).toBe("/srv/app/releases/v2");
    expect(linkInfo("/srv/app/current", { ...raw, resolved: "/x\0y" })?.path).toBe("/srv/app/releases/v2");
    expect(linkInfo("/srv/app/current", { ...raw, resolved: "/srv//app/./v2/" })?.path).toBe("/srv/app/v2");
  });

  it("un enlace roto conserva su destino, de tipo desconocido", () => {
    expect(linkInfo("/a/roto", { target: "../no-existe", is_dir: null })).toEqual({
      target: "../no-existe",
      path: "/no-existe",
      kind: "unknown",
    });
    expect(linkInfo("/a/roto", { target: "x" })?.kind).toBe("unknown");
  });

  it("lo que se enseña va saneado; la ruta por la que se navega, no", () => {
    const info = linkInfo("/a/enlace", { target: "raro\nnombre", is_dir: true });
    expect(info?.target).toBe("raro\ufffdnombre");
    expect(info?.path).toBe("/a/raro\nnombre");
  });

  it("sin respuesta del servidor no hay destino", () => {
    expect(linkInfo("/a/b", null)).toBeNull();
    expect(linkInfo("/a/b", undefined)).toBeNull();
    expect(linkInfo("/a/b", "destino")).toBeNull();
    expect(linkInfo("/a/b", { target: "" })).toBeNull();
    expect(linkInfo("/a/b", { target: 3, is_dir: true })).toBeNull();
  });
});
