// @ts-check
import { describe, it, expect } from "vitest";
import {
  formatBytesPerSec,
  formatKib,
  usagePct,
  summaryDisk,
  sparklinePath,
  pushHistory,
  computeMetricAlerts,
  PROC_SORT_KEYS,
  defaultProcView,
  filterProcs,
  sortProcs,
  procTableRows,
  nextProcSort,
  procSortAria,
} from "./metrics-view.js";

describe("formatBytesPerSec", () => {
  it("formatea la tasa con sufijo /s", () => {
    expect(formatBytesPerSec(0)).toBe("0 B/s");
    expect(formatBytesPerSec(1536)).toBe("1.5 KB/s");
    expect(formatBytesPerSec(1024 * 1024)).toBe("1.0 MB/s");
  });

  it("devuelve «—» sin tasa (primera muestra) o valor inválido", () => {
    expect(formatBytesPerSec(null)).toBe("—");
    expect(formatBytesPerSec(undefined)).toBe("—");
    expect(formatBytesPerSec(-1)).toBe("—");
    expect(formatBytesPerSec(NaN)).toBe("—");
  });
});

describe("formatKib", () => {
  it("interpreta la entrada como kiB", () => {
    expect(formatKib(1024)).toBe("1.0 MB"); // 1024 kiB = 1 MiB
    expect(formatKib(0)).toBe("0 B");
  });
});

describe("usagePct", () => {
  it("da el porcentaje acotado con un decimal", () => {
    expect(usagePct(50, 100)).toBe(50);
    expect(usagePct(1, 3)).toBe(33.3);
    expect(usagePct(200, 100)).toBe(100);
  });

  it("0 si el total no es válido", () => {
    expect(usagePct(5, 0)).toBe(0);
    expect(usagePct(5, -1)).toBe(0);
    expect(usagePct(5, NaN)).toBe(0);
  });
});

describe("summaryDisk", () => {
  const disk = (mount, usedKb, sizeKb) => ({ mount, usedKb, sizeKb });

  it("prefiere el montado en /", () => {
    const disks = [disk("/boot", 90, 100), disk("/", 10, 100)];
    expect(summaryDisk(disks)?.mount).toBe("/");
  });

  it("sin /, elige el más lleno", () => {
    const disks = [disk("/a", 10, 100), disk("/b", 80, 100), disk("/c", 50, 100)];
    expect(summaryDisk(disks)?.mount).toBe("/b");
  });

  it("null si no hay discos", () => {
    expect(summaryDisk([])).toBeNull();
    expect(summaryDisk(undefined)).toBeNull();
  });
});

describe("sparklinePath", () => {
  it("«» con menos de dos puntos", () => {
    expect(sparklinePath([], 100, 20)).toBe("");
    expect(sparklinePath([5], 100, 20)).toBe("");
  });

  it("normaliza al máximo y encaja en el alto (Y hacia abajo)", () => {
    // [0, max] en ancho 100, alto 20 → sube de abajo (y=20) a arriba (y=0).
    const d = sparklinePath([0, 10], 100, 20);
    expect(d).toBe("M0.00,20.00 L100.00,0.00");
  });

  it("todo ceros → línea plana abajo", () => {
    expect(sparklinePath([0, 0, 0], 100, 20)).toBe("M0.00,20.00 L50.00,20.00 L100.00,20.00");
  });
});

describe("pushHistory", () => {
  it("añade sin mutar la entrada", () => {
    const a = [1, 2];
    const b = pushHistory(a, 3, 10);
    expect(b).toEqual([1, 2, 3]);
    expect(a).toEqual([1, 2]); // intacto
  });

  it("descarta los más viejos al superar el tope", () => {
    expect(pushHistory([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushHistory([], 1, 3)).toEqual([1]);
  });
});

describe("computeMetricAlerts", () => {
  const th = { cpu: 90, mem: 90, disk: 90 };

  it("dispara al cruzar el umbral hacia arriba", () => {
    const r = computeMetricAlerts({}, { cpu: 95, mem: 50, disk: 89.9 }, th);
    expect(r.fired).toEqual(["cpu"]);
    expect(r.active.cpu).toBe(true);
    expect(r.active.mem).toBe(false);
  });

  it("no repite el aviso mientras sigue por encima", () => {
    const first = computeMetricAlerts({}, { cpu: 95 }, { cpu: 90 });
    const second = computeMetricAlerts(first.active, { cpu: 97 }, { cpu: 90 });
    expect(second.fired).toEqual([]);
    expect(second.active.cpu).toBe(true);
  });

  it("histéresis: no se rearma hasta caer bajo umbral - margen", () => {
    const alerting = { cpu: true };
    // 87 con umbral 90 y margen 5: sigue en alerta (no rearma, no dispara).
    const mid = computeMetricAlerts(alerting, { cpu: 87 }, { cpu: 90 });
    expect(mid.active.cpu).toBe(true);
    expect(mid.fired).toEqual([]);
    // 84 < 85: rearmado; el siguiente cruce vuelve a disparar.
    const low = computeMetricAlerts(mid.active, { cpu: 84 }, { cpu: 90 });
    expect(low.active.cpu).toBe(false);
    const again = computeMetricAlerts(low.active, { cpu: 92 }, { cpu: 90 });
    expect(again.fired).toEqual(["cpu"]);
  });

  it("umbral 0 = desactivado; valor null (primera muestra) nunca dispara", () => {
    const r = computeMetricAlerts({}, { cpu: 99, mem: null }, { cpu: 0, mem: 90 });
    expect(r.fired).toEqual([]);
    expect(r.active).toEqual({ cpu: false, mem: false });
  });

  it("varias métricas pueden disparar en la misma muestra", () => {
    const r = computeMetricAlerts({}, { cpu: 95, mem: 91, disk: 99 }, th);
    expect(r.fired).toEqual(["cpu", "mem", "disk"]);
  });
});

const PROCS = [
  { pid: 1234, cpuPct: 12.5, memPct: 3.2, user: "postgres", command: "postgres" },
  { pid: 42, cpuPct: 8, memPct: 11.1, user: "aleix", command: "rust analyzer" },
  { pid: 7, cpuPct: 8, memPct: 0.1, user: "root", command: "nginx" },
  { pid: 900, cpuPct: 0, memPct: 0.5, user: "root", command: "Nginx-worker" },
];
const pids = (rows) => rows.map((p) => p.pid);

describe("filterProcs", () => {
  it("sin consulta devuelve todos (en una copia)", () => {
    const out = filterProcs(PROCS, "  ");
    expect(pids(out)).toEqual([1234, 42, 7, 900]);
    expect(out).not.toBe(PROCS);
  });

  it("casa por comando sin distinguir mayúsculas", () => {
    expect(pids(filterProcs(PROCS, "NGINX"))).toEqual([7, 900]);
  });

  it("casa por PID y por usuario", () => {
    expect(pids(filterProcs(PROCS, "1234"))).toEqual([1234]);
    expect(pids(filterProcs(PROCS, "aleix"))).toEqual([42]);
  });

  it("varias palabras se exigen todas, cada una en cualquier campo", () => {
    expect(pids(filterProcs(PROCS, "root worker"))).toEqual([900]);
    expect(pids(filterProcs(PROCS, "root postgres"))).toEqual([]);
  });

  it("tolera filas sin usuario y entradas que no son lista", () => {
    expect(pids(filterProcs([{ pid: 5, cpuPct: 0, memPct: 0, command: "sh" }], "sh"))).toEqual([5]);
    expect(filterProcs(/** @type {any} */ (null), "x")).toEqual([]);
  });
});

describe("sortProcs", () => {
  it("por %CPU descendente, empates por PID creciente", () => {
    expect(pids(sortProcs(PROCS, "cpu", "desc"))).toEqual([1234, 7, 42, 900]);
  });

  it("por %MEM ascendente", () => {
    expect(pids(sortProcs(PROCS, "mem", "asc"))).toEqual([7, 900, 1234, 42]);
  });

  it("por PID", () => {
    expect(pids(sortProcs(PROCS, "pid", "asc"))).toEqual([7, 42, 900, 1234]);
    expect(pids(sortProcs(PROCS, "pid", "desc"))).toEqual([1234, 900, 42, 7]);
  });

  it("por comando sin distinguir mayúsculas", () => {
    expect(sortProcs(PROCS, "command", "asc").map((p) => p.command))
      .toEqual(["nginx", "Nginx-worker", "postgres", "rust analyzer"]);
  });

  it("no muta la entrada y una clave desconocida ordena por %CPU", () => {
    const copy = PROCS.slice();
    sortProcs(PROCS, "pid", "asc");
    expect(PROCS).toEqual(copy);
    expect(pids(sortProcs(PROCS, "nope", "desc"))).toEqual([1234, 7, 42, 900]);
  });
});

describe("procTableRows / nextProcSort / procSortAria", () => {
  it("la vista por defecto es el orden del servidor (%CPU desc) sin filtro", () => {
    expect(defaultProcView()).toEqual({ filter: "", sortKey: "cpu", sortDir: "desc" });
    expect(pids(procTableRows(PROCS, null))).toEqual([1234, 7, 42, 900]);
  });

  it("filtra y luego ordena", () => {
    expect(pids(procTableRows(PROCS, { filter: "root", sortKey: "pid", sortDir: "desc" }))).toEqual([900, 7]);
  });

  it("la misma columna invierte; otra empieza en su sentido natural", () => {
    const view = defaultProcView();
    expect(nextProcSort(view, "cpu")).toEqual({ sortKey: "cpu", sortDir: "asc" });
    expect(nextProcSort(view, "mem")).toEqual({ sortKey: "mem", sortDir: "desc" });
    expect(nextProcSort(view, "pid")).toEqual({ sortKey: "pid", sortDir: "asc" });
    expect(nextProcSort(view, "command")).toEqual({ sortKey: "command", sortDir: "asc" });
    expect(nextProcSort({ ...view, sortKey: "pid", sortDir: "asc" }, "pid")).toEqual({ sortKey: "pid", sortDir: "desc" });
    expect(nextProcSort(view, "bogus")).toEqual({ sortKey: "cpu", sortDir: "desc" });
  });

  it("aria-sort solo en la columna activa", () => {
    const view = { filter: "", sortKey: /** @type {const} */ ("mem"), sortDir: /** @type {const} */ ("asc") };
    expect(procSortAria(view, "mem")).toBe("ascending");
    expect(procSortAria({ ...view, sortDir: "desc" }, "mem")).toBe("descending");
    expect(procSortAria(view, "cpu")).toBe("none");
    expect(procSortAria(null, "cpu")).toBe("none");
  });

  it("todas las columnas ordenables tienen sentido natural", () => {
    for (const key of PROC_SORT_KEYS) {
      expect(nextProcSort({ filter: "", sortKey: "cpu", sortDir: "desc" }, key).sortKey).toBe(key);
    }
  });
});
