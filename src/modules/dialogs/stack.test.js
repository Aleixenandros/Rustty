import { describe, expect, it } from "vitest";
import {
  MODAL_SAFE_SHORTCUTS, allowShortcutInDialog, backgroundPlan, closeDialog, escapeTarget,
  initialFocusKind, openDialog, pickRestore, topDialog, trapIndex,
} from "./stack.js";

const btnPrefs = { name: "boton Preferencias" };
const btnKnownHosts = { name: "boton known_hosts" };
const btnConfirm = { name: "boton Borrar" };

describe("pila de diálogos", () => {
  it("reabrir un id lo sube a la cima y conserva el opener original", () => {
    let stack = openDialog([], { id: "prefs", opener: btnPrefs });
    stack = openDialog(stack, { id: "keepass", opener: btnKnownHosts });
    stack = openDialog(stack, { id: "prefs", opener: { name: "otro" } });
    expect(stack.map((d) => d.id)).toEqual(["keepass", "prefs"]);
    expect(topDialog(stack)?.opener).toBe(btnPrefs);
    expect(openDialog(stack, { id: "prefs" })).toHaveLength(2);
  });

  it("no modifica la pila de entrada", () => {
    const stack = Object.freeze([Object.freeze({ id: "a", opener: null, modal: true })]);
    expect(() => openDialog(stack, { id: "b" })).not.toThrow();
    expect(() => closeDialog(stack, "a")).not.toThrow();
    expect(stack).toHaveLength(1);
  });

  it("cerrar la cima devuelve el foco a su opener", () => {
    let stack = openDialog([], { id: "prefs", opener: btnPrefs });
    stack = openDialog(stack, { id: "known_hosts", opener: btnKnownHosts });
    const res = closeDialog(stack, "known_hosts");
    expect(res).toMatchObject({ wasTop: true, found: true, restore: btnKnownHosts });
    expect(res.stack.map((d) => d.id)).toEqual(["prefs"]);
    expect(closeDialog(res.stack, "prefs").restore).toBe(btnPrefs);
  });

  it("cerrar el padre con un hijo abierto pasa su opener al hijo", () => {
    let stack = openDialog([], { id: "prefs", opener: btnPrefs });
    stack = openDialog(stack, { id: "known_hosts", opener: btnKnownHosts });
    const res = closeDialog(stack, "prefs");
    expect(res).toMatchObject({ wasTop: false, restore: null });
    expect(res.stack).toEqual([{ id: "known_hosts", opener: btnPrefs, modal: true }]);
    // Y al cerrar después el hijo, el foco vuelve fuera de los dos.
    expect(closeDialog(res.stack, "known_hosts").restore).toBe(btnPrefs);
  });

  it("cadena de restauración con tres niveles", () => {
    let stack = openDialog([], { id: "conn", opener: { name: "fila" } });
    stack = openDialog(stack, { id: "notes", opener: { name: "abrir notas" } });
    stack = openDialog(stack, { id: "confirm", opener: btnConfirm });
    const a = closeDialog(stack, "confirm");
    expect(a.restore).toBe(btnConfirm);
    const b = closeDialog(a.stack, "notes");
    expect(b.restore).toEqual({ name: "abrir notas" });
    expect(closeDialog(b.stack, "conn").restore).toEqual({ name: "fila" });
  });

  it("cerrar un id que no está no cambia nada", () => {
    const stack = openDialog([], { id: "prefs", opener: btnPrefs });
    const res = closeDialog(stack, "nope");
    expect(res).toMatchObject({ found: false, wasTop: false, restore: null });
    expect(res.stack).toEqual(stack);
    expect(topDialog([])).toBeNull();
  });
});

describe("Escape", () => {
  const stack = openDialog(openDialog([], { id: "conn" }), { id: "folder-confirm" });

  it("va solo a la cima", () => {
    expect(escapeTarget(stack, {})).toBe("folder-confirm");
    expect(escapeTarget([], {})).toBeNull();
  });

  it("no cierra nada si un componente interno ya lo consumió", () => {
    expect(escapeTarget(stack, { defaultPrevented: true })).toBeNull();
  });

  it("no cierra nada mientras un IME compone", () => {
    expect(escapeTarget(stack, { isComposing: true })).toBeNull();
  });
});

describe("trampa de Tab", () => {
  it("da la vuelta en los extremos", () => {
    expect(trapIndex(4, 5, false)).toBe(0);
    expect(trapIndex(0, 5, true)).toBe(4);
  });

  it("deja al navegador los movimientos interiores", () => {
    expect(trapIndex(2, 5, false)).toBeNull();
    expect(trapIndex(2, 5, true)).toBeNull();
    expect(trapIndex(0, 5, false)).toBeNull();
  });

  it("devuelve dentro un foco que estaba fuera", () => {
    expect(trapIndex(-1, 5, false)).toBe(0);
    expect(trapIndex(-1, 5, true)).toBe(4);
  });

  it("sin enfocables, el propio diálogo", () => {
    expect(trapIndex(-1, 0, false)).toBe(-1);
    expect(trapIndex(0, 1, false)).toBe(0);
    expect(trapIndex(0, 1, true)).toBe(0);
  });
});

describe("fondo inerte", () => {
  it("sin diálogos no hay nada inerte", () => {
    expect(backgroundPlan([])).toEqual({ background: false, dialogs: [] });
  });

  it("con tres niveles, la app y los dos de debajo", () => {
    let stack = openDialog([], { id: "prefs" });
    stack = openDialog(stack, { id: "known_hosts" });
    stack = openDialog(stack, { id: "confirm" });
    expect(backgroundPlan(stack)).toEqual({ background: true, dialogs: ["prefs", "known_hosts"] });
  });

  it("un panel no modal no bloquea la app", () => {
    const stack = openDialog([], { id: "drawer", modal: false });
    expect(backgroundPlan(stack)).toEqual({ background: false, dialogs: [] });
  });
});

describe("foco inicial", () => {
  it("una confirmación destructiva enfoca Cancelar", () => {
    expect(initialFocusKind({ confirm: true, danger: true })).toBe("cancel");
  });

  it("una confirmación normal mantiene Aceptar", () => {
    expect(initialFocusKind({ confirm: true })).toBe("submit");
  });

  it("con campo, el campo, aunque sea peligrosa", () => {
    expect(initialFocusKind({ confirm: true, danger: true, hasField: true })).toBe("field");
    expect(initialFocusKind({ hasField: true })).toBe("field");
  });

  it("lo explícito manda", () => {
    expect(initialFocusKind({ explicit: true, confirm: true, danger: true })).toBe("explicit");
  });

  it("sin campos, el primer control o el contenedor", () => {
    expect(initialFocusKind({})).toBe("first");
    expect(initialFocusKind({ hasFocusable: false })).toBe("container");
  });
});

describe("restauración del foco", () => {
  it("salta lo desconectado, lo oculto y lo inerte", () => {
    expect(pickRestore([
      { target: "fila borrada", connected: false, visible: true },
      { target: "oculto", connected: true, visible: false },
      { target: "tras el velo", connected: true, visible: true, inert: true },
      { target: "terminal", connected: true, visible: true },
      { target: "lista", connected: true, visible: true },
    ])).toBe("terminal");
  });

  it("sin candidatos válidos, null", () => {
    expect(pickRestore([{ target: null, connected: true, visible: true }])).toBeNull();
    expect(pickRestore([])).toBeNull();
  });
});

describe("atajos con un diálogo abierto", () => {
  it("sin diálogo pasan todos", () => {
    expect(allowShortcutInDialog("close_tab", [])).toBe(true);
  });

  it("con un modal solo pasa la lista blanca", () => {
    const stack = openDialog([], { id: "prefs" });
    expect(allowShortcutInDialog("close_tab", stack)).toBe(false);
    expect(allowShortcutInDialog("paste_password", stack)).toBe(false);
    expect(allowShortcutInDialog("open_preferences", stack)).toBe(false);
    for (const id of MODAL_SAFE_SHORTCUTS) expect(allowShortcutInDialog(id, stack)).toBe(true);
  });

  it("un panel no modal no filtra", () => {
    expect(allowShortcutInDialog("close_tab", openDialog([], { id: "drawer", modal: false }))).toBe(true);
  });
});
