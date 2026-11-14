// @ts-check
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FILTERS,
  activityExportFormat,
  activityExportJson,
  activityExportText,
  activityFilterCounts,
  activityItemText,
  activityLocalStamp,
  countUnseenErrors,
  filterActivityItems,
  groupActivityByDay,
  isActivityUnseen,
  matchesActivityFilter,
  normalizeActivityItem,
  serializableActivityItem,
} from "./activity.js";

const NOW = Date.parse("2026-08-04T12:00:00Z");
const t = (key) => key;

describe("normalizeActivityItem", () => {
  it("rechaza entradas sin título y acota texto no confiable", () => {
    expect(normalizeActivityItem(null)).toBeNull();
    expect(normalizeActivityItem({ detail: "sin título" })).toBeNull();
    const item = normalizeActivityItem(
      { title: "x".repeat(600), detail: "y".repeat(2500), timestamp: "mal" },
      { createId: () => "id", now: NOW },
    );
    expect(item?.id).toBe("id");
    expect(item?.title).toHaveLength(500);
    expect(item?.detail).toHaveLength(2000);
    expect(item?.timestamp).toBe(new Date(NOW).toISOString());
  });

  it("conserva callbacks en memoria pero no al serializar", () => {
    const action = () => {};
    const item = normalizeActivityItem(
      { id: "a", title: "Abrir", action, timestamp: NOW },
      { now: NOW },
    );
    expect(item?.action).toBe(action);
    expect(serializableActivityItem(/** @type {import("./activity.js").ActivityItem} */ (item)))
      .not.toHaveProperty("action");
  });
});

describe("groupActivityByDay", () => {
  it("agrupa y ordena hoy, ayer, semana y fechas antiguas", () => {
    const make = (id, days) => normalizeActivityItem(
      { id, title: id, timestamp: NOW - days * 86_400_000 },
      { now: NOW },
    );
    const items = [make("hoy", 0), make("ayer", 1), make("semana", 3), make("viejo", 10)]
      .filter(Boolean);
    const groups = groupActivityByDay(
      /** @type {import("./activity.js").ActivityItem[]} */ (items),
      { now: NOW, locale: "en-CA", t },
    );
    expect(groups.slice(0, 3).map((group) => group.label)).toEqual([
      "activity.today",
      "activity.yesterday",
      "activity.this_week",
    ]);
    expect(groups[3].items[0].id).toBe("viejo");
  });
});

describe("filtros del centro de actividad", () => {
  const items = [
    { kind: "connection", status: "success", timestamp: "2026-08-04T10:00:00Z" },
    { kind: "connection", status: "error", timestamp: "2026-08-04T11:00:00Z" },
    { kind: "sftp", status: "error", timestamp: "2026-08-04T11:30:00Z" },
    { kind: "sync", status: "info", timestamp: "2026-08-04T09:00:00Z" },
    { kind: "toast", status: "warning", timestamp: "2026-08-04T08:00:00Z" },
  ];

  it("filtra por tipo, y «error» es transversal a todos los tipos", () => {
    expect(filterActivityItems(items, "all")).toBe(items);
    expect(filterActivityItems(items, "connection")).toHaveLength(2);
    expect(filterActivityItems(items, "sftp")).toHaveLength(1);
    expect(filterActivityItems(items, "update")).toHaveLength(0);
    expect(filterActivityItems(items, "error").map((i) => i.kind)).toEqual(["connection", "sftp"]);
    expect(matchesActivityFilter(items[4], "error")).toBe(false);
  });

  it("cuenta las entradas de cada chip, con todos los filtros presentes", () => {
    const counts = activityFilterCounts(items);
    expect(Object.keys(counts)).toEqual([...ACTIVITY_FILTERS]);
    expect(counts).toEqual({ all: 5, connection: 2, sftp: 1, sync: 1, update: 0, error: 2 });
    expect(activityFilterCounts([]).all).toBe(0);
  });

  it("solo son nuevas las entradas posteriores a la última apertura", () => {
    const seenAt = "2026-08-04T10:30:00Z";
    expect(isActivityUnseen(items[0], seenAt)).toBe(false);
    expect(isActivityUnseen(items[1], seenAt)).toBe(true);
    expect(isActivityUnseen({ timestamp: seenAt }, seenAt)).toBe(false);
    expect(isActivityUnseen({ timestamp: "mal" }, seenAt)).toBe(false);
  });

  it("sin marca guardada no hay nada pendiente: el historial antiguo no cuenta", () => {
    expect(isActivityUnseen(items[1], null)).toBe(false);
    expect(countUnseenErrors(items, null)).toBe(0);
    expect(countUnseenErrors(items, "")).toBe(0);
    expect(countUnseenErrors(items, "no es una fecha")).toBe(0);
  });

  it("el distintivo cuenta solo los errores posteriores a la última apertura", () => {
    expect(countUnseenErrors(items, "2026-08-04T07:00:00Z")).toBe(2);
    expect(countUnseenErrors(items, "2026-08-04T11:15:00Z")).toBe(1);
    expect(countUnseenErrors(items, "2026-08-04T12:00:00Z")).toBe(0);
  });
});

describe("copiar y exportar entradas", () => {
  // Hora local construida con los mismos componentes que se esperan: el test
  // no depende de la zona horaria de la máquina.
  const at = new Date(2026, 10, 14, 9, 5, 7);
  const item = {
    id: "a",
    kind: "connection",
    status: "error",
    title: "web-01",
    detail: "Connection refused\r\n  reintento 2 de 3  ",
    actionLabel: "Reintentar",
    action: () => {},
    timestamp: at.toISOString(),
  };
  const labels = {
    kindLabel: (k) => ({ connection: "Conexión" })[k] || k,
    statusLabel: (s) => ({ error: "Error" })[s] || s,
  };

  it("formatea la fecha local con ceros y sin depender del idioma", () => {
    expect(activityLocalStamp(at)).toBe("2026-11-14 09:05:07");
    expect(activityLocalStamp("no es una fecha")).toBe("");
  });

  it("pone la cabecera en una línea y el detalle sangrado debajo", () => {
    expect(activityItemText(item, labels)).toBe(
      "[2026-11-14 09:05:07] Conexión · Error · web-01\n"
      + "    Connection refused\n"
      + "      reintento 2 de 3",
    );
  });

  it("un título con saltos de línea no parte la cabecera", () => {
    const text = activityItemText({ ...item, title: "uno\ndos", detail: "" }, labels);
    expect(text).toBe("[2026-11-14 09:05:07] Conexión · Error · uno dos");
  });

  it("sin rótulos usa los valores crudos y sin fecha válida omite el corchete", () => {
    expect(activityItemText({ ...item, detail: "", timestamp: "mal" }))
      .toBe("connection · error · web-01");
  });

  it("el volcado de texto acaba en salto de línea y el vacío queda vacío", () => {
    const text = activityExportText([item, { ...item, title: "db-02", detail: "" }], labels);
    expect(text.endsWith("db-02\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(5);
    expect(activityExportText([], labels)).toBe("");
  });

  it("el JSON no lleva callbacks ni identificadores internos", () => {
    const doc = JSON.parse(activityExportJson([item], { exportedAt: "2026-11-14T10:00:00.000Z", filter: "error" }));
    expect(doc).toEqual({
      exportedAt: "2026-11-14T10:00:00.000Z",
      filter: "error",
      count: 1,
      entries: [{
        timestamp: at.toISOString(),
        kind: "connection",
        status: "error",
        title: "web-01",
        detail: "Connection refused\r\n  reintento 2 de 3  ",
      }],
    });
  });

  it("elige el formato por la extensión del fichero", () => {
    expect(activityExportFormat("/tmp/actividad.JSON")).toBe("json");
    expect(activityExportFormat("/tmp/actividad.txt")).toBe("text");
    expect(activityExportFormat("/tmp/actividad.json.txt")).toBe("text");
    expect(activityExportFormat("")).toBe("text");
  });
});
