// @ts-check
import { describe, expect, it } from "vitest";
import { rovingKey, treeKey, typeAhead, visibleNodes } from "./tree-nav.js";

/** Árbol de ejemplo: dos carpetas (una con subcarpeta) y una conexión suelta. */
const MODEL = [
  {
    key: "folder:ws|Producción", openKey: "Producción", label: "Producción", kind: "folder",
    children: [
      { key: "p1", label: "web-01", kind: "connection" },
      {
        key: "folder:ws|Producción/BBDD", openKey: "Producción/BBDD", label: "BBDD", kind: "folder",
        children: [{ key: "p2", label: "postgres", kind: "connection" }],
      },
    ],
  },
  { key: "folder:ws|Pruebas", openKey: "Pruebas", label: "Pruebas", kind: "folder", children: [] },
  { key: "p3", label: "Ágora", kind: "connection" },
];

describe("visibleNodes", () => {
  it("con todo plegado solo lista la raíz, con nivel 1 y sin padre", () => {
    const nodes = visibleNodes(MODEL, new Set());
    expect(nodes.map((n) => n.key)).toEqual(["folder:ws|Producción", "folder:ws|Pruebas", "p3"]);
    expect(nodes.every((n) => n.level === 1 && n.parentKey === null)).toBe(true);
    expect(nodes.map((n) => n.expandable)).toEqual([true, true, false]);
    expect(nodes.map((n) => n.expanded)).toEqual([false, false, false]);
  });

  it("abre por openKey (la ruta de la carpeta) y anida niveles y padres", () => {
    const nodes = visibleNodes(MODEL, new Set(["Producción", "Producción/BBDD"]));
    expect(nodes.map((n) => [n.key, n.level, n.parentKey])).toEqual([
      ["folder:ws|Producción", 1, null],
      ["p1", 2, "folder:ws|Producción"],
      ["folder:ws|Producción/BBDD", 2, "folder:ws|Producción"],
      ["p2", 3, "folder:ws|Producción/BBDD"],
      ["folder:ws|Pruebas", 1, null],
      ["p3", 1, null],
    ]);
    expect(nodes[0].expanded).toBe(true);
    expect(nodes[0].kind).toBe("folder");
  });

  it("una subcarpeta abierta dentro de una cerrada no se ve", () => {
    const nodes = visibleNodes(MODEL, new Set(["Producción/BBDD"]));
    expect(nodes.map((n) => n.key)).toEqual(["folder:ws|Producción", "folder:ws|Pruebas", "p3"]);
  });

  it("sin openKey usa la propia clave y una carpeta vacía sigue siendo desplegable", () => {
    const nodes = visibleNodes([{ key: "__ws__/a", label: "A", children: [] }], new Set(["__ws__/a"]));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].expandable).toBe(true);
    expect(nodes[0].expanded).toBe(true);
  });
});

describe("treeKey", () => {
  const open = new Set(["Producción"]);
  const nodes = visibleNodes(MODEL, open); // Producción, p1, BBDD, Pruebas, p3

  it("ignora las teclas que no son del árbol", () => {
    expect(treeKey(nodes, "p1", "Tab")).toBeNull();
    expect(treeKey(nodes, "p1", "a")).toBeNull();
    expect(treeKey(nodes, "p1", "Escape")).toBeNull();
  });

  it("↓ y ↑ recorren sin dar la vuelta; Inicio y Fin saltan a los extremos", () => {
    expect(treeKey(nodes, "p1", "ArrowDown")?.focus).toBe("folder:ws|Producción/BBDD");
    expect(treeKey(nodes, "p3", "ArrowDown")?.focus).toBe("p3");
    expect(treeKey(nodes, "p1", "ArrowUp")?.focus).toBe("folder:ws|Producción");
    expect(treeKey(nodes, "folder:ws|Producción", "ArrowUp")?.focus).toBe("folder:ws|Producción");
    expect(treeKey(nodes, "p1", "Home")?.focus).toBe("folder:ws|Producción");
    expect(treeKey(nodes, "p1", "End")?.focus).toBe("p3");
  });

  it("sin nodo actual, cualquier flecha lleva al primero", () => {
    expect(treeKey(nodes, null, "ArrowDown")?.focus).toBe("folder:ws|Producción");
    expect(treeKey(nodes, null, "ArrowUp")?.focus).toBe("folder:ws|Producción");
    expect(treeKey(nodes, "fantasma", "ArrowRight")?.focus).toBe("folder:ws|Producción");
    expect(treeKey(nodes, null, "ArrowLeft")?.focus).toBe("folder:ws|Producción");
  });

  it("→ despliega una carpeta cerrada, baja al primer hijo de una abierta y no hace nada en una hoja", () => {
    expect(treeKey(nodes, "folder:ws|Pruebas", "ArrowRight")?.toggle).toBe("folder:ws|Pruebas");
    const onOpen = treeKey(nodes, "folder:ws|Producción", "ArrowRight");
    expect(onOpen?.toggle).toBeNull();
    expect(onOpen?.focus).toBe("p1");
    const onLeaf = treeKey(nodes, "p1", "ArrowRight");
    expect(onLeaf).toEqual({ focus: null, toggle: null, expand: [], activate: null });
  });

  it("→ en una carpeta abierta pero vacía no mueve el foco", () => {
    const withEmpty = visibleNodes(MODEL, new Set(["Pruebas"]));
    const result = treeKey(withEmpty, "folder:ws|Pruebas", "ArrowRight");
    expect(result?.focus).toBeNull();
    expect(result?.toggle).toBeNull();
  });

  it("← pliega una carpeta abierta, sube al padre desde un hijo y no hace nada en la raíz", () => {
    expect(treeKey(nodes, "folder:ws|Producción", "ArrowLeft")?.toggle).toBe("folder:ws|Producción");
    expect(treeKey(nodes, "p1", "ArrowLeft")?.focus).toBe("folder:ws|Producción");
    expect(treeKey(nodes, "folder:ws|Producción/BBDD", "ArrowLeft")?.focus).toBe("folder:ws|Producción");
    expect(treeKey(nodes, "p3", "ArrowLeft")).toEqual({ focus: null, toggle: null, expand: [], activate: null });
  });

  it("Enter y Espacio activan el nodo actual", () => {
    expect(treeKey(nodes, "p1", "Enter")?.activate).toBe("p1");
    expect(treeKey(nodes, "folder:ws|Pruebas", " ")?.activate).toBe("folder:ws|Pruebas");
    expect(treeKey(nodes, null, "Enter")?.activate).toBeNull();
  });

  it("* despliega los hermanos cerrados del nivel actual, sin tocar los abiertos ni otros niveles", () => {
    expect(treeKey(nodes, "p3", "*")?.expand).toEqual(["folder:ws|Pruebas"]);
    // Dentro de Producción, el único hermano desplegable es BBDD (cerrada).
    expect(treeKey(nodes, "p1", "*")?.expand).toEqual(["folder:ws|Producción/BBDD"]);
  });

  it("con el árbol vacío devuelve un resultado neutro", () => {
    expect(treeKey([], null, "ArrowDown")).toEqual({ focus: null, toggle: null, expand: [], activate: null });
  });
});

describe("typeAhead", () => {
  const nodes = visibleNodes(MODEL, new Set(["Producción", "Producción/BBDD"]));
  // Producción, web-01, BBDD, postgres, Pruebas, Ágora

  it("salta al siguiente nodo que empieza por lo tecleado, sin acentos ni mayúsculas", () => {
    expect(typeAhead(nodes, "folder:ws|Producción", "pr")).toBe("folder:ws|Pruebas");
    expect(typeAhead(nodes, "p3", "ago")).toBe("p3");
    expect(typeAhead(nodes, null, "agora")).toBe("p3");
    expect(typeAhead(nodes, "p1", "BB")).toBe("folder:ws|Producción/BBDD");
  });

  it("da la vuelta al final de la lista", () => {
    expect(typeAhead(nodes, "p3", "web")).toBe("p1");
    expect(typeAhead(nodes, "folder:ws|Pruebas", "produ")).toBe("folder:ws|Producción");
  });

  it("repetir una letra recorre los nodos que empiezan por ella", () => {
    expect(typeAhead(nodes, "folder:ws|Producción", "p")).toBe("p2");
    expect(typeAhead(nodes, "folder:ws|Producción", "pp")).toBe("p2");
    expect(typeAhead(nodes, "p2", "pp")).toBe("folder:ws|Pruebas");
  });

  it("sin coincidencia, texto vacío o sin nodos devuelve null", () => {
    expect(typeAhead(nodes, "p1", "zzz")).toBeNull();
    expect(typeAhead(nodes, "p1", "")).toBeNull();
    expect(typeAhead([], null, "p")).toBeNull();
  });
});

describe("rovingKey", () => {
  const nodes = visibleNodes(MODEL, new Set());

  it("prefiere la última fila enfocada si sigue visible", () => {
    expect(rovingKey(nodes, "p3", "folder:ws|Pruebas")).toBe("p3");
  });

  it("si la última ya no se ve (carpeta plegada), cae en la conexión activa", () => {
    expect(rovingKey(nodes, "p1", "p3")).toBe("p3");
  });

  it("sin ninguna de las dos, la primera fila; y null con el árbol vacío", () => {
    expect(rovingKey(nodes, null, null)).toBe("folder:ws|Producción");
    expect(rovingKey(nodes, "p1", "p2")).toBe("folder:ws|Producción");
    expect(rovingKey([], "p1", "p2")).toBeNull();
  });
});
