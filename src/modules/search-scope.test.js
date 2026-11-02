import { describe, expect, it } from "vitest";
import {
  normalizeSearchScope, resolveSearchScope, scopeIncludesWorkspace, searchScopeOptions, workspaceScope,
} from "./search-scope.js";

describe("normalizeSearchScope", () => {
  it("conserva los valores válidos", () => {
    expect(normalizeSearchScope("current")).toBe("current");
    expect(normalizeSearchScope("all")).toBe("all");
    expect(normalizeSearchScope("ws:abc")).toBe("ws:abc");
  });

  it("sin valor propio, hereda el booleano antiguo", () => {
    expect(normalizeSearchScope(undefined, false)).toBe("current");
    expect(normalizeSearchScope(undefined, true)).toBe("all");
    expect(normalizeSearchScope(undefined)).toBe("all");
  });

  it("descarta lo que no es un alcance", () => {
    expect(normalizeSearchScope("ws:", false)).toBe("current");
    expect(normalizeSearchScope(42)).toBe("all");
    expect(normalizeSearchScope("todo")).toBe("all");
  });
});

describe("resolveSearchScope", () => {
  const ctx = { activeId: "default", workspaceIds: ["default", "trabajo"] };

  it("«actual» es el workspace activo y «todos» no filtra", () => {
    expect(resolveSearchScope("current", ctx)).toEqual({ kind: "workspace", id: "default" });
    expect(resolveSearchScope("all", ctx)).toEqual({ kind: "all" });
  });

  it("un workspace concreto, si existe", () => {
    expect(resolveSearchScope(workspaceScope("trabajo"), ctx)).toEqual({ kind: "workspace", id: "trabajo" });
  });

  it("un workspace que ya no existe cae al activo", () => {
    expect(resolveSearchScope("ws:borrado", ctx)).toEqual({ kind: "workspace", id: "default" });
  });
});

describe("scopeIncludesWorkspace", () => {
  it("filtra por workspace salvo en «todos»", () => {
    expect(scopeIncludesWorkspace({ kind: "all" }, "x")).toBe(true);
    expect(scopeIncludesWorkspace({ kind: "workspace", id: "a" }, "a")).toBe(true);
    expect(scopeIncludesWorkspace({ kind: "workspace", id: "a" }, "b")).toBe(false);
  });
});

describe("searchScopeOptions", () => {
  const labels = { current: "Perfil actual", all: "Todos los perfiles" };

  it("ofrece actual, todos y cada workspace por su nombre", () => {
    const options = searchScopeOptions([{ id: "default", label: "Casa" }, { id: "t", label: "Trabajo" }], labels);
    expect(options.map((o) => o.value)).toEqual(["current", "all", "ws:default", "ws:t"]);
    expect(options[3]).toEqual({ value: "ws:t", label: "Trabajo", group: "workspaces" });
  });

  it("con un solo workspace no repite el actual por su nombre", () => {
    expect(searchScopeOptions([{ id: "default", label: "Casa" }], labels).map((o) => o.value)).toEqual(["current", "all"]);
  });
});
