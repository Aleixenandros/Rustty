// @ts-check
import { describe, expect, it } from "vitest";
import {
  groupActivityByDay,
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
