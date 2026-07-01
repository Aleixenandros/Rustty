import { describe, it, expect } from "vitest";
import { rankCommandSuggestions } from "./command-suggest.js";

describe("rankCommandSuggestions", () => {
  it("con consulta vacía devuelve los más recientes primero", () => {
    const hist = ["ls", "cd /var", "systemctl status nginx"];
    expect(rankCommandSuggestions(hist, "")).toEqual([
      "systemctl status nginx",
      "cd /var",
      "ls",
    ]);
  });

  it("prioriza coincidencias por prefijo sobre subcadena", () => {
    const hist = ["git status", "systemctl status nginx", "git stash"];
    // query "git st" → prefijos "git stash" (más reciente) y "git status"
    expect(rankCommandSuggestions(hist, "git st")).toEqual([
      "git stash",
      "git status",
    ]);
  });

  it("incluye subcadenas después de los prefijos", () => {
    const hist = ["docker ps", "ps aux", "systemctl status nginx"];
    // query "ps": prefijo "ps aux"; subcadena "docker ps"
    expect(rankCommandSuggestions(hist, "ps")).toEqual(["ps aux", "docker ps"]);
  });

  it("es case-insensitive", () => {
    const hist = ["LS -la", "Cat file"];
    expect(rankCommandSuggestions(hist, "ls")).toEqual(["LS -la"]);
  });

  it("deduplica conservando la ocurrencia más reciente", () => {
    const hist = ["ls", "cd /tmp", "ls", "cd /var"];
    expect(rankCommandSuggestions(hist, "")).toEqual(["cd /var", "ls", "cd /tmp"]);
  });

  it("descarta el comando idéntico a lo tecleado", () => {
    const hist = ["git status", "git stash"];
    expect(rankCommandSuggestions(hist, "git status")).toEqual([]);
  });

  it("recorta espacios de los comandos y de la consulta", () => {
    const hist = ["  npm run build  ", "npm test"];
    expect(rankCommandSuggestions(hist, "  npm r ")).toEqual(["npm run build"]);
  });

  it("respeta el límite", () => {
    const hist = ["a1", "a2", "a3", "a4", "a5"];
    expect(rankCommandSuggestions(hist, "a", { limit: 2 })).toEqual(["a5", "a4"]);
  });

  it("tolera entradas no-string y listas vacías", () => {
    // @ts-expect-error probamos robustez ante datos sucios
    expect(rankCommandSuggestions([null, 42, "ls", undefined], "l")).toEqual(["ls"]);
    expect(rankCommandSuggestions([], "x")).toEqual([]);
    // @ts-expect-error historial no-array
    expect(rankCommandSuggestions(null, "x")).toEqual([]);
  });
});
