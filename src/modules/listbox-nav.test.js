// @ts-check
import { describe, expect, it } from "vitest";
import {
  createListboxState, edgeEnabled, listboxKey, pageEnabled, stepEnabled, typeaheadIndex,
  TYPEAHEAD_TIMEOUT_MS,
} from "./listbox-nav.js";

const LABELS = ["Sistema (auto)", "Español", "Inglés (English)", "Francés (Français)", "Portugués (Português)", "Alemán (Deutsch)"];
const open = (index) => ({ open: true, index, search: "", searchAt: 0 });
const press = (state, key, extra = {}) => listboxKey(state, key, { labels: LABELS, ...extra });

describe("listboxKey · lista cerrada", () => {
  it("↓, ↑, Enter y Espacio abren sobre la opción elegida y consumen la tecla", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) {
      const res = press(createListboxState(2), key, { selected: 2 });
      expect(res.action, key).toBe("open");
      expect(res.state.open).toBe(true);
      expect(res.state.index).toBe(2);
      expect(res.prevent).toBe(true);
    }
  });

  it("Alt+↓ abre igual que ↓", () => {
    const res = press(createListboxState(1), "ArrowDown", { altKey: true, selected: 1 });
    expect(res.action).toBe("open");
    expect(res.state.index).toBe(1);
  });

  it("Inicio y Fin abren sobre la primera y la última opción", () => {
    expect(press(createListboxState(3), "Home", { selected: 3 }).state.index).toBe(0);
    expect(press(createListboxState(3), "End", { selected: 3 }).state.index).toBe(LABELS.length - 1);
  });

  it("una letra abre y busca la opción que empieza por ella", () => {
    const res = press(createListboxState(0), "f", { selected: 0, now: 1000 });
    expect(res.action).toBe("open");
    expect(res.state.index).toBe(3);
    expect(res.state.search).toBe("f");
  });

  it("Escape y Tab cerrados no hacen nada: el diálogo de debajo recibe lo suyo", () => {
    for (const key of ["Escape", "Tab", "F5"]) {
      const res = press(createListboxState(1), key);
      expect(res.action, key).toBe("none");
      expect(res.prevent, key).toBe(false);
    }
  });

  it("sin opciones no hace nada", () => {
    const res = listboxKey(createListboxState(0), "ArrowDown", { labels: [] });
    expect(res.action).toBe("none");
  });
});

describe("listboxKey · lista abierta", () => {
  it("↓ y ↑ mueven el resaltado sin dar la vuelta en los extremos", () => {
    expect(press(open(1), "ArrowDown").state.index).toBe(2);
    expect(press(open(2), "ArrowUp").state.index).toBe(1);
    const last = press(open(LABELS.length - 1), "ArrowDown");
    expect(last.state.index).toBe(LABELS.length - 1);
    expect(last.action).toBe("none");
    expect(last.prevent).toBe(true);
    expect(press(open(0), "ArrowUp").state.index).toBe(0);
  });

  it("Inicio y Fin vuelven al principio y al final", () => {
    expect(press(open(3), "Home")).toMatchObject({ action: "move", state: { index: 0 } });
    expect(press(open(3), "End")).toMatchObject({ action: "move", state: { index: LABELS.length - 1 } });
  });

  it("RePág y AvPág saltan una página acotada a los extremos", () => {
    const labels = Array.from({ length: 25 }, (_, i) => `Opción ${i}`);
    expect(listboxKey(open(3), "PageDown", { labels }).state.index).toBe(13);
    expect(listboxKey(open(20), "PageDown", { labels }).state.index).toBe(24);
    expect(listboxKey(open(13), "PageUp", { labels }).state.index).toBe(3);
    expect(listboxKey(open(4), "PageUp", { labels }).state.index).toBe(0);
    expect(listboxKey(open(3), "PageDown", { labels, pageSize: 5 }).state.index).toBe(8);
  });

  it("Enter y Espacio eligen y cierran; Tab elige sin consumir la tecla", () => {
    expect(press(open(4), "Enter")).toMatchObject({ action: "commit", prevent: true, state: { open: false, index: 4 } });
    expect(press(open(4), " ")).toMatchObject({ action: "commit", prevent: true });
    expect(press(open(4), "Tab")).toMatchObject({ action: "commit", prevent: false, state: { open: false, index: 4 } });
  });

  it("Alt+↑ elige la opción resaltada", () => {
    expect(press(open(2), "ArrowUp", { altKey: true })).toMatchObject({ action: "commit", state: { index: 2 } });
  });

  it("Escape cierra sin cambiar la elegida y pide parar el evento", () => {
    const res = press(open(4), "Escape", { selected: 1 });
    expect(res).toMatchObject({ action: "close", prevent: true, state: { open: false, index: 1 } });
  });

  it("una tecla ajena no se consume", () => {
    expect(press(open(1), "F2")).toMatchObject({ action: "none", prevent: false });
    expect(press(open(1), "Shift")).toMatchObject({ action: "none", prevent: false });
  });
});

describe("listboxKey · búsqueda tecleando", () => {
  it("acumula letras dentro del plazo y busca el prefijo completo", () => {
    const state = open(0);
    let res = press(state, "p", { now: 1000 });
    expect(res.state.index).toBe(4);
    res = press(res.state, "o", { now: 1200 });
    expect(res.state.search).toBe("po");
    expect(res.state.index).toBe(4);
    expect(res.action).toBe("none");
  });

  it("pasado el plazo empieza una búsqueda nueva", () => {
    const first = press(open(0), "p", { now: 1000 });
    const later = press(first.state, "i", { now: 1000 + TYPEAHEAD_TIMEOUT_MS + 1 });
    expect(later.state.search).toBe("i");
    expect(later.state.index).toBe(2);
  });

  it("la misma letra repetida recorre las opciones que empiezan por ella", () => {
    const labels = ["Pera", "Plátano", "Manzana", "Piña"];
    let res = listboxKey(open(0), "p", { labels, now: 10 });
    expect(res.state.index).toBe(1);
    res = listboxKey(res.state, "p", { labels, now: 20 });
    expect(res.state.index).toBe(3);
    res = listboxKey(res.state, "p", { labels, now: 30 });
    expect(res.state.index).toBe(0);
  });

  it("ignora mayúsculas y acentos, como el buscador de conexiones", () => {
    expect(typeaheadIndex(["Alemán", "Árbol", "Zeta"], "ar", -1)).toBe(1);
    expect(typeaheadIndex(["Alemán", "Árbol", "Zeta"], "ALE", -1)).toBe(0);
    expect(typeaheadIndex(["Alemán"], "", -1)).toBe(-1);
  });

  it("el espacio continúa una búsqueda en curso en vez de elegir", () => {
    const labels = ["Puerto fijo", "Puerto libre", "Zona"];
    const first = listboxKey(open(2), "p", { labels, now: 100 });
    expect(first.state.index).toBe(0);
    const typedSpace = listboxKey(first.state, " ", { labels, now: 200 });
    expect(typedSpace.action).not.toBe("commit");
    expect(typedSpace.state.search).toBe("p ");
    expect(typedSpace.state.open).toBe(true);
  });
});

describe("opciones desactivadas", () => {
  const disabled = [false, true, true, false, true];
  const labels = ["a", "b", "c", "d", "e"];

  it("las flechas las saltan y los extremos las evitan", () => {
    expect(stepEnabled(0, 1, 5, disabled)).toBe(3);
    expect(stepEnabled(3, -1, 5, disabled)).toBe(0);
    expect(stepEnabled(3, 1, 5, disabled)).toBe(3);
    expect(edgeEnabled(5, disabled)).toBe(0);
    expect(edgeEnabled(5, disabled, true)).toBe(3);
    expect(edgeEnabled(2, [true, true])).toBe(-1);
  });

  it("un salto de página que cae en una desactivada busca la elegible más próxima", () => {
    expect(pageEnabled(0, 1, 2, 5, disabled)).toBe(3);
    expect(pageEnabled(0, 1, 4, 5, disabled)).toBe(3);
    expect(pageEnabled(3, -1, 1, 5, disabled)).toBe(0);
  });

  it("la búsqueda tecleando no cae en ellas", () => {
    expect(typeaheadIndex(labels, "b", -1, disabled)).toBe(-1);
    expect(typeaheadIndex(labels, "d", -1, disabled)).toBe(3);
  });

  it("abrir con la elegida desactivada resalta la primera elegible", () => {
    const res = listboxKey(createListboxState(1), "ArrowDown", { labels, disabled, selected: 1 });
    expect(res.state.index).toBe(0);
  });
});
