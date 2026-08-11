// @ts-check
import { describe, expect, it } from "vitest";
import {
  foldSearchText,
  groupConnectionSearch,
  matchSegments,
  scoreProfile,
  searchTokens,
} from "./connection-search.js";

/**
 * Perfil mínimo de pruebas.
 * @param {any} [overrides]
 */
function profile(overrides = {}) {
  return {
    id: overrides.id || overrides.name || "p1",
    name: "web-01",
    host: "10.0.0.1",
    username: "root",
    connection_type: "ssh",
    group: null,
    workspace_id: "default",
    ...overrides,
  };
}

describe("foldSearchText / searchTokens", () => {
  it("pliega a minúsculas y elimina diacríticos", () => {
    expect(foldSearchText("Producción")).toBe("produccion");
    expect(foldSearchText("Über-Härte")).toBe("uber-harte");
    expect(foldSearchText(null)).toBe("");
  });

  it("trocea la consulta en tokens normalizados descartando espacios", () => {
    expect(searchTokens("  Rancher   PROD ")).toEqual(["rancher", "prod"]);
    expect(searchTokens("")).toEqual([]);
    expect(searchTokens("   ")).toEqual([]);
  });

  it("la barra separa tokens: pegar una ruta busca como con espacios", () => {
    expect(searchTokens("rancher/prod")).toEqual(["rancher", "prod"]);
    expect(searchTokens("/rancher/")).toEqual(["rancher"]);
  });

  it("pliega formas de compatibilidad: la ligadura ﬁ se busca como fi", () => {
    expect(foldSearchText("ﬁle-server")).toBe("file-server");
    expect(scoreProfile(profile({ name: "ﬁle-server" }), searchTokens("file"))).not.toBeNull();
  });
});

describe("scoreProfile", () => {
  it("puntúa nombre exacto por encima de prefijo y de subcadena", () => {
    const tokens = searchTokens("rancher");
    const exact = scoreProfile(profile({ name: "rancher" }), tokens);
    const prefix = scoreProfile(profile({ name: "rancher-master" }), tokens);
    const sub = scoreProfile(profile({ name: "old-rancher" }), tokens);
    expect(exact && prefix && sub).toBeTruthy();
    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(sub.score);
  });

  it("prioriza nombre sobre host, host sobre carpeta y carpeta sobre nota", () => {
    const tokens = searchTokens("rancher");
    const byName = scoreProfile(profile({ name: "rancher" }), tokens);
    const byHost = scoreProfile(profile({ name: "otro", host: "rancher.acme.es" }), tokens);
    const byGroup = scoreProfile(profile({ name: "otro", group: "rancher" }), tokens);
    const byNote = scoreProfile(profile({ name: "otro" }), tokens, { title: "rancher" });
    expect(byName.score).toBeGreaterThan(byHost.score);
    expect(byHost.score).toBeGreaterThan(byGroup.score);
    expect(byGroup.score).toBeGreaterThan(byNote.score);
  });

  it("exige que TODOS los tokens coincidan (AND) aunque sea en campos distintos", () => {
    const p = profile({ name: "api", group: "rancher/prod" });
    expect(scoreProfile(p, searchTokens("rancher api"))).not.toBeNull();
    expect(scoreProfile(p, searchTokens("rancher web"))).toBeNull();
  });

  it("ignora diacríticos en los campos del perfil", () => {
    const p = profile({ name: "Producción BBDD" });
    expect(scoreProfile(p, searchTokens("produccion"))).not.toBeNull();
  });

  it("el protocolo matchea por prefijo o exacto, nunca por subcadena", () => {
    const p = profile({ name: "otro", connection_type: "ftps" });
    const exact = scoreProfile(p, searchTokens("ftps"));
    const prefix = scoreProfile(p, searchTokens("ft"));
    expect(exact?.fields.has("protocol")).toBe(true);
    expect(prefix?.fields.has("protocol")).toBe(true);
    // "tp" es subcadena de "ftps" pero no debe contar como protocolo
    expect(scoreProfile(p, searchTokens("tp"))).toBeNull();
  });

  it("registra los campos que coincidieron", () => {
    const p = profile({ name: "rancher", host: "rancher.acme.es", group: "infra/rancher" });
    const result = scoreProfile(p, searchTokens("rancher"));
    expect([...result.fields].sort()).toEqual(["group", "host", "name"]);
  });

  it("con consulta vacía devuelve score 0 sin campos", () => {
    const result = scoreProfile(profile(), []);
    expect(result).toEqual({ score: 0, fields: new Set() });
  });
});

describe("groupConnectionSearch", () => {
  const catalogo = [
    profile({ id: "a", name: "rancher", host: "10.0.0.5", group: null }),
    profile({ id: "b", name: "nodo-1", group: "rancher" }),
    profile({ id: "c", name: "nodo-2", group: "rancher/prod" }),
    profile({ id: "d", name: "backup", group: "copias" }),
    profile({ id: "e", name: "old-rancher", group: "archivo" }),
  ];

  it("separa coincidencias directas de las que solo llegan por carpeta", () => {
    const result = groupConnectionSearch({ profiles: catalogo, query: "rancher" });
    expect(result.connections.map((m) => m.profile.id)).toEqual(["a", "e"]);
    expect(result.folderOnly.map((m) => m.profile.id).sort()).toEqual(["b", "c"]);
  });

  it("las carpetas coincidentes salen como entrada única con recuento recursivo", () => {
    const result = groupConnectionSearch({ profiles: catalogo, query: "rancher" });
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]).toMatchObject({ path: "rancher", name: "rancher", count: 2 });
  });

  it("no lista subcarpetas cuyo nombre propio no coincide", () => {
    const result = groupConnectionSearch({ profiles: catalogo, query: "rancher" });
    expect(result.folders.some((f) => f.path === "rancher/prod")).toBe(false);
  });

  it("una consulta multi-token encuentra la subcarpeta por ruta + nombre", () => {
    const result = groupConnectionSearch({ profiles: catalogo, query: "rancher prod" });
    expect(result.folders.map((f) => f.path)).toEqual(["rancher/prod"]);
  });

  it("pegar la ruta con barra equivale a la consulta multi-token", () => {
    const result = groupConnectionSearch({ profiles: catalogo, query: "rancher/prod" });
    expect(result.folders.map((f) => f.path)).toEqual(["rancher/prod"]);
  });

  it("un group sucio (barras dobles o inicial) cuenta bajo su ruta normalizada", () => {
    const perfiles = [
      profile({ id: "d1", name: "n1", group: "a//b" }),
      profile({ id: "d2", name: "n2", group: "/a" }),
    ];
    const result = groupConnectionSearch({ profiles: perfiles, query: "b" });
    expect(result.folders).toEqual([
      { path: "a/b", name: "b", workspaceId: "default", count: 1, score: 100 },
    ]);
    const raiz = groupConnectionSearch({ profiles: perfiles, query: "a" });
    expect(raiz.folders.find((f) => f.path === "a")?.count).toBe(2);
  });

  it("incluye carpetas manuales vacías recibidas por parámetro", () => {
    const result = groupConnectionSearch({
      profiles: catalogo,
      folders: [{ path: "rancher/vacia", workspaceId: "default" }],
      query: "vacia",
    });
    expect(result.folders).toEqual([
      { path: "rancher/vacia", name: "vacia", workspaceId: "default", count: 0, score: 100 },
    ]);
  });

  it("separa por workspace carpetas con el mismo nombre", () => {
    const perfiles = [
      profile({ id: "x", name: "n1", group: "rancher", workspace_id: "default" }),
      profile({ id: "y", name: "n2", group: "rancher", workspace_id: "ws2" }),
    ];
    const result = groupConnectionSearch({ profiles: perfiles, query: "rancher" });
    const keys = result.folders.map((f) => `${f.workspaceId}|${f.path}`).sort();
    expect(keys).toEqual(["default|rancher", "ws2|rancher"]);
    expect(result.folders.every((f) => f.count === 1)).toBe(true);
  });

  it("los perfiles que solo coinciden por nota van a su propia sección", () => {
    const notes = new Map([["d", { title: "runbook rancher", tags: [], excerpt: "" }]]);
    const result = groupConnectionSearch({ profiles: catalogo, notes, query: "runbook" });
    expect(result.connections).toHaveLength(0);
    expect(result.notes.map((m) => m.profile.id)).toEqual(["d"]);
  });

  it("una coincidencia directa NO se duplica en notas aunque su nota también coincida", () => {
    const notes = new Map([["a", { title: "rancher", tags: [], excerpt: "" }]]);
    const result = groupConnectionSearch({ profiles: catalogo, notes, query: "rancher" });
    expect(result.connections.some((m) => m.profile.id === "a")).toBe(true);
    expect(result.notes.some((m) => m.profile.id === "a")).toBe(false);
  });

  it("ordena las conexiones por relevancia con desempate alfabético", () => {
    const perfiles = [
      profile({ id: "s2", name: "b-rancher-x" }),
      profile({ id: "s1", name: "a-rancher-x" }),
      profile({ id: "e1", name: "rancher" }),
    ];
    const result = groupConnectionSearch({ profiles: perfiles, query: "rancher" });
    expect(result.connections.map((m) => m.profile.id)).toEqual(["e1", "s1", "s2"]);
  });

  it("con consulta vacía devuelve todo el catálogo ordenado por nombre", () => {
    const result = groupConnectionSearch({ profiles: catalogo, query: "  " });
    expect(result.connections.map((m) => m.profile.id)).toEqual(["d", "b", "c", "e", "a"]);
    expect(result.folders).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});

describe("matchSegments", () => {
  it("marca las coincidencias con índices del texto original", () => {
    expect(matchSegments("old-rancher-01", ["rancher"])).toEqual([
      { text: "old-", hit: false },
      { text: "rancher", hit: true },
      { text: "-01", hit: false },
    ]);
  });

  it("resalta ignorando mayúsculas y diacríticos sin perder el texto original", () => {
    expect(matchSegments("Producción", ["produccion"])).toEqual([
      { text: "Producción", hit: true },
    ]);
    expect(matchSegments("BBDD Producción", ["produc"])).toEqual([
      { text: "BBDD ", hit: false },
      { text: "Produc", hit: true },
      { text: "ción", hit: false },
    ]);
  });

  it("fusiona tokens solapados y repite coincidencias del mismo token", () => {
    expect(matchSegments("abcabc", ["ab", "bc"])).toEqual([{ text: "abcabc", hit: true }]);
  });

  it("no desplaza el resaltado con caracteres astrales (emoji) delante", () => {
    expect(matchSegments("🚀prod-01", ["prod"])).toEqual([
      { text: "🚀", hit: false },
      { text: "prod", hit: true },
      { text: "-01", hit: false },
    ]);
    expect(matchSegments("🚀🔥prod", ["prod"])).toEqual([
      { text: "🚀🔥", hit: false },
      { text: "prod", hit: true },
    ]);
    expect(matchSegments("a🚀b-x", ["🚀b"])).toEqual([
      { text: "a", hit: false },
      { text: "🚀b", hit: true },
      { text: "-x", hit: false },
    ]);
  });

  it("resalta la ligadura completa cuando el token la cruza", () => {
    expect(matchSegments("ﬁle-server", ["file"])).toEqual([
      { text: "ﬁle", hit: true },
      { text: "-server", hit: false },
    ]);
  });

  it("sin tokens devuelve un único segmento sin resaltar", () => {
    expect(matchSegments("texto", [])).toEqual([{ text: "texto", hit: false }]);
    expect(matchSegments("", ["x"])).toEqual([]);
  });
});
