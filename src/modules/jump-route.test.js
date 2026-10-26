import { describe, it, expect } from "vitest";
import {
  MAX_JUMPS,
  isJumpCapable,
  supportsJump,
  textBastionOf,
  jumpChain,
  resolveJumpRoute,
  validateJumpIds,
  routeHops,
  describeRoute,
  isUsableJump,
  bastionChoices,
  bastionReferrers,
  jumpCandidates,
  pushRecentJump,
  filterJumpProfiles,
  shouldShowRoutePill,
  normalizeJumpPrefs,
  clampIdleSecs,
  jumpSettingsPayload,
  detachDeletedBastions,
  allowsTextBastion,
  withBastionOverride,
  bastionLinksOf,
  relinkRestoredBastion,
} from "./jump-route.js";

/**
 * Perfil mínimo; `over` pisa lo que haga falta.
 * @param {string} id
 * @param {object} [over]
 */
const P = (id, over = {}) => ({
  id, name: id.toUpperCase(), host: `${id}.lan`, port: 22, username: "ana", connection_type: "ssh", ...over,
});

describe("isJumpCapable / supportsJump", () => {
  it("solo SSH y SFTP hacen de salto", () => {
    expect(isJumpCapable(P("a"))).toBe(true);
    expect(isJumpCapable(P("a", { connection_type: "sftp" }))).toBe(true);
    expect(isJumpCapable(P("a", { connection_type: undefined }))).toBe(true);
    for (const t of ["rdp", "vnc", "telnet", "ftp", "ftps", "webdav"]) {
      expect(isJumpCapable(P("a", { connection_type: t }))).toBe(false);
    }
    expect(isJumpCapable(null)).toBe(false);
  });

  it("SSH, SFTP, RDP, VNC y Telnet pueden ir por un salto; FTP y WebDAV no", () => {
    for (const t of ["ssh", "sftp", "rdp", "vnc", "telnet", "SSH", undefined, null]) expect(supportsJump(t)).toBe(true);
    for (const t of ["ftp", "ftps", "webdav", "local"]) expect(supportsJump(t)).toBe(false);
  });

  it("el bastión de texto solo cuenta si no hay perfil-bastión", () => {
    expect(textBastionOf(P("a", { proxy_jump: " ana@bast:2222 " }))).toBe("ana@bast:2222");
    expect(textBastionOf(P("a", { proxy_jump: "bast", proxy_jump_profile_id: "b" }))).toBe("");
    expect(textBastionOf(P("a"))).toBe("");
    expect(textBastionOf(null)).toBe("");
  });
});

describe("jumpChain", () => {
  it("recorre los perfiles-bastión del más cercano al más lejano", () => {
    const profiles = [P("a"), P("b", { proxy_jump_profile_id: "a" }), P("t", { proxy_jump_profile_id: "b" })];
    expect(jumpChain(profiles[2], profiles)).toEqual({ ids: ["a", "b"], error: null });
    expect(jumpChain(profiles[0], profiles)).toEqual({ ids: [], error: null });
  });

  it("un bastión que ya no existe es «missing» con el perfil que lo nombra", () => {
    const profiles = [P("t", { proxy_jump_profile_id: "fantasma" })];
    const { error } = jumpChain(profiles[0], profiles);
    expect(error).toMatchObject({ kind: "missing", profileId: "t", profileName: "T", jumpId: "fantasma" });
  });

  it("detecta bucles directos e indirectos", () => {
    const self = [P("a", { proxy_jump_profile_id: "a" })];
    expect(jumpChain(self[0], self).error).toMatchObject({ kind: "loop", jumpId: "a" });
    const ring = [P("a", { proxy_jump_profile_id: "b" }), P("b", { proxy_jump_profile_id: "a" })];
    expect(jumpChain(ring[0], ring).error).toMatchObject({ kind: "loop", profileId: "b", jumpId: "a" });
  });

  it("un bastión que no habla SSH es «not_ssh»", () => {
    const profiles = [P("w", { connection_type: "rdp" }), P("t", { proxy_jump_profile_id: "w" })];
    expect(jumpChain(profiles[1], profiles).error).toMatchObject({ kind: "not_ssh", profileId: "t", jumpId: "w", jumpName: "W" });
  });

  it("corta las cadenas de más de MAX_JUMPS", () => {
    const profiles = [];
    for (let i = 0; i <= MAX_JUMPS + 2; i++) {
      profiles.push(P(`p${i}`, i ? { proxy_jump_profile_id: `p${i - 1}` } : {}));
    }
    const { error } = jumpChain(profiles.at(-1), profiles);
    expect(error).toMatchObject({ kind: "too_long", max: MAX_JUMPS });
  });
});

describe("resolveJumpRoute", () => {
  const base = [
    P("act"),                                               // salto activo
    P("dmz", { proxy_jump_profile_id: "act" }),             // pasa por el activo
    P("own"),                                               // bastión propio
    P("t", { proxy_jump_profile_id: "own" }),               // destino con bastión
    P("plain"),                                             // destino sin nada
    P("win", { connection_type: "rdp" }),
    P("ftp", { connection_type: "ftp" }),
    P("solo", { ignore_active_jump: true }),
  ];
  const route = (id, opts = {}) => resolveJumpRoute(base.find((p) => p.id === id), { profiles: base, ...opts });

  it("sin salto activo ni bastión, directo", () => {
    expect(route("plain")).toEqual({ jumps: [], source: "none", clearTextBastion: false, unsupported: false, error: null });
  });

  it("la ruta propia sale de los perfiles-bastión", () => {
    expect(route("t")).toMatchObject({ jumps: ["own"], source: "own", error: null });
  });

  it("el salto activo va delante de la ruta propia", () => {
    expect(route("plain", { activeJumpId: "act" })).toMatchObject({ jumps: ["act"], source: "active" });
    expect(route("t", { activeJumpId: "act" })).toMatchObject({ jumps: ["act", "own"], source: "active" });
  });

  it("el salto activo trae su propia cadena", () => {
    expect(route("plain", { activeJumpId: "dmz" })).toMatchObject({ jumps: ["act", "dmz"], source: "active" });
  });

  it("el propio salto activo y los de su cadena van directos", () => {
    expect(route("act", { activeJumpId: "act" })).toMatchObject({ jumps: [], source: "none" });
    expect(route("act", { activeJumpId: "dmz" })).toMatchObject({ jumps: [], source: "none" });
    // dmz con salto activo dmz: su propia ruta (act) y nada más.
    expect(route("dmz", { activeJumpId: "dmz" })).toMatchObject({ jumps: ["act"], source: "own" });
  });

  it("si la ruta propia ya pasa por el salto activo, no se repite", () => {
    expect(route("dmz", { activeJumpId: "act" })).toMatchObject({ jumps: ["act"], source: "own", error: null });
    const profiles = [...base, P("viaAct", { proxy_jump_profile_id: "dmz" })];
    const r = resolveJumpRoute(profiles.at(-1), { profiles, activeJumpId: "act" });
    expect(r).toMatchObject({ jumps: ["act", "dmz"], source: "own", error: null });
  });

  it("un perfil con «no usar nunca el salto activo» lo ignora (pero no su ruta propia)", () => {
    expect(route("solo", { activeJumpId: "act" })).toMatchObject({ jumps: [], source: "none", unsupported: false });
    const profiles = [...base, P("solo2", { ignore_active_jump: true, proxy_jump_profile_id: "own" })];
    expect(resolveJumpRoute(profiles.at(-1), { profiles, activeJumpId: "act" })).toMatchObject({ jumps: ["own"], source: "own" });
  });

  it("RDP, VNC y Telnet también van por el salto activo", () => {
    expect(route("win", { activeJumpId: "act" })).toMatchObject({ jumps: ["act"], source: "active", unsupported: false });
  });

  it("FTP no puede ir por un salto: se marca y sale sin saltos", () => {
    expect(route("ftp", { activeJumpId: "act" })).toMatchObject({ jumps: [], unsupported: true, source: "active", error: null });
    expect(route("ftp")).toMatchObject({ jumps: [], unsupported: false });
    expect(route("ftp", { override: { viaProfileId: "act" } })).toMatchObject({ unsupported: true, source: "override" });
    const ignoring = P("ftp2", { connection_type: "ftp", ignore_active_jump: true });
    expect(resolveJumpRoute(ignoring, { profiles: base, activeJumpId: "act" }).unsupported).toBe(false);
  });

  it("«Sin saltos» lo quita todo, también el bastión de texto", () => {
    expect(route("t", { activeJumpId: "act", override: { direct: true } }))
      .toEqual({ jumps: [], source: "override", clearTextBastion: true, unsupported: false, error: null });
  });

  it("«Conectar a través de» pone el elegido (con su cadena) delante, sin el activo", () => {
    expect(route("plain", { activeJumpId: "act", override: { viaProfileId: "own" } }))
      .toMatchObject({ jumps: ["own"], source: "override" });
    expect(route("t", { override: { viaProfileId: "dmz" } }))
      .toMatchObject({ jumps: ["act", "dmz", "own"], source: "override" });
    // El elegido es el propio bastión: no se duplica.
    expect(route("t", { override: { viaProfileId: "own" } })).toMatchObject({ jumps: ["own"], source: "override", error: null });
  });

  it("elegir a mano un salto que pasa por el destino es un bucle", () => {
    expect(route("act", { override: { viaProfileId: "dmz" } }).error).toMatchObject({ kind: "loop", profileId: "act" });
    expect(route("own", { override: { viaProfileId: "own" } }).error).toMatchObject({ kind: "loop" });
  });

  it("referencias colgantes llegadas por sync: error «missing», nunca un cuelgue", () => {
    const profiles = [P("t", { proxy_jump_profile_id: "borrado" })];
    expect(resolveJumpRoute(profiles[0], { profiles })).toMatchObject({
      jumps: [], error: { kind: "missing", via: "own", profileId: "t", jumpId: "borrado" },
    });
    expect(route("plain", { activeJumpId: "borrado" }).error).toMatchObject({ kind: "missing", via: "active", profileId: null });
    expect(route("plain", { override: { viaProfileId: "borrado" } }).error).toMatchObject({ kind: "missing", via: "override" });
  });

  it("un salto activo que dejó de ser SSH no se usa en silencio", () => {
    expect(route("plain", { activeJumpId: "win" }).error).toMatchObject({ kind: "not_ssh", via: "active", jumpId: "win" });
    expect(route("plain", { override: { viaProfileId: "win" } }).error).toMatchObject({ kind: "not_ssh", via: "override" });
  });

  it("el error de la cadena del salto activo se atribuye al activo", () => {
    const profiles = [...base, P("rota", { proxy_jump_profile_id: "nada" })];
    const r = resolveJumpRoute(base.find((p) => p.id === "plain"), { profiles, activeJumpId: "rota" });
    expect(r.error).toMatchObject({ kind: "missing", via: "active", profileId: "rota", jumpId: "nada" });
  });

  it("cuenta los saltos de texto en el tope", () => {
    const profiles = [];
    for (let i = 0; i < 4; i++) {
      profiles.push(P(`h${i}`, i ? { proxy_jump_profile_id: `h${i - 1}` } : { proxy_jump: "ana@primero" }));
    }
    const target = P("t", { proxy_jump_profile_id: "h3" });
    // 4 perfiles + 1 de texto = 5: cabe.
    expect(resolveJumpRoute(target, { profiles: [...profiles, target] }).error).toBeNull();
    // Con 4 más por delante (activo con cadena de 3 + texto) se pasa de 8.
    const extra = [P("x0", { proxy_jump: "otro" }), P("x1", { proxy_jump_profile_id: "x0" }), P("x2", { proxy_jump_profile_id: "x1" })];
    const all = [...profiles, ...extra, target];
    const r = resolveJumpRoute(target, { profiles: all, activeJumpId: "x2" });
    expect(r.error).toMatchObject({ kind: "too_long", count: 9, max: MAX_JUMPS, profileId: "t" });
  });

  it("sin destino no hay ruta", () => {
    expect(resolveJumpRoute(null)).toMatchObject({ jumps: [], source: "none", error: null });
  });
});

describe("validateJumpIds", () => {
  const profiles = [P("a"), P("b"), P("w", { connection_type: "rdp" }), P("t")];
  const t = profiles[3];
  it("una ruta sana no da error", () => {
    expect(validateJumpIds(["a", "b"], t, profiles)).toBeNull();
    expect(validateJumpIds([], t, profiles)).toBeNull();
  });
  it("caza saltos borrados, no SSH, repetidos o el propio destino", () => {
    expect(validateJumpIds(["a", "zz"], t, profiles)).toMatchObject({ kind: "missing", via: "route", jumpId: "zz" });
    expect(validateJumpIds(["w"], t, profiles)).toMatchObject({ kind: "not_ssh", jumpId: "w" });
    expect(validateJumpIds(["a", "a"], t, profiles)).toMatchObject({ kind: "loop", jumpId: "a" });
    expect(validateJumpIds(["t"], t, profiles)).toMatchObject({ kind: "loop", jumpId: "t" });
  });
  it("respeta el tope con el bastión de texto del destino", () => {
    const many = Array.from({ length: MAX_JUMPS }, (_, i) => P(`m${i}`));
    const target = P("t", { proxy_jump: "ana@bast" });
    const ids = many.map((p) => p.id);
    expect(validateJumpIds(ids, target, [...many, target])).toMatchObject({ kind: "too_long", count: MAX_JUMPS + 1 });
    expect(validateJumpIds(ids, target, [...many, target], { clearTextBastion: true })).toBeNull();
  });
});

describe("routeHops / describeRoute", () => {
  const profiles = [P("a", { name: "oficina-win", proxy_jump: "ana@puerta" }), P("b", { name: "dmz" })];
  it("nombra cada salto e intercala los bastiones de texto", () => {
    expect(routeHops(["a", "b"], profiles)).toEqual(["ana@puerta", "oficina-win", "dmz"]);
    expect(describeRoute(["a", "b"], profiles)).toBe("ana@puerta → oficina-win → dmz");
  });
  it("añade el bastión de texto del destino salvo que se haya quitado", () => {
    const target = P("t", { proxy_jump: "root@ultimo:2222" });
    expect(describeRoute(["b"], profiles, { target })).toBe("dmz → root@ultimo:2222");
    expect(describeRoute(["b"], profiles, { target, clearTextBastion: true })).toBe("dmz");
    expect(describeRoute([], profiles, { target })).toBe("root@ultimo:2222");
  });
  it("un salto que ya no existe se enseña por su id", () => {
    expect(describeRoute(["fantasma"], profiles)).toBe("fantasma");
    expect(describeRoute([], profiles)).toBe("");
  });
});

describe("candidatos y bastiones elegibles", () => {
  const profiles = [
    P("act", { name: "Activo" }),
    P("rec", { name: "Reciente" }),
    P("bas", { name: "Bastion" }),
    P("t", { name: "Destino", proxy_jump_profile_id: "bas" }),
    P("hijo", { name: "Hijo", proxy_jump_profile_id: "t" }),
    P("win", { name: "Windows", connection_type: "rdp" }),
    P("ftp", { name: "Ftp", connection_type: "ftp" }),
    P("roto", { name: "Roto", proxy_jump_profile_id: "nada" }),
  ];

  it("isUsableJump descarta lo que no existe, no es SSH, está roto o pasa por el destino", () => {
    expect(isUsableJump("act", "t", profiles)).toBe(true);
    expect(isUsableJump("nada", "t", profiles)).toBe(false);
    expect(isUsableJump("win", "t", profiles)).toBe(false);
    expect(isUsableJump("roto", null, profiles)).toBe(false);
    expect(isUsableJump("t", "t", profiles)).toBe(false);
    expect(isUsableJump("hijo", "t", profiles)).toBe(false);
    expect(isUsableJump("hijo", null, profiles)).toBe(true);
  });

  it("jumpCandidates: activo, recientes y bastiones, sin repetir ni bucles", () => {
    const prefs = { activeJumpProfileId: "act", recentJumpProfileIds: ["rec", "act", "nada", "win"] };
    const list = jumpCandidates(profiles, prefs, "plain");
    expect(list.map((c) => c.id)).toEqual(["act", "rec", "bas", "t"]);
    expect(list[0]).toMatchObject({ active: true, recent: true, bastion: false });
    expect(list[2]).toMatchObject({ active: false, recent: false, bastion: true });
    // Para el propio «t»: ni él ni «hijo» (pasa por él).
    expect(jumpCandidates(profiles, prefs, "t").map((c) => c.id)).toEqual(["act", "rec", "bas"]);
    // Para «bas»: «t» pasa por «bas», fuera.
    expect(jumpCandidates(profiles, prefs, "bas").map((c) => c.id)).toEqual(["act", "rec"]);
    expect(jumpCandidates(profiles, {}, null).map((c) => c.id)).toEqual(["bas", "t"]);
  });

  it("bastionChoices: SSH/SFTP salvo el propio y los que pasan por él, por nombre", () => {
    expect(bastionChoices(profiles, "t").map((p) => p.id)).toEqual(["act", "bas", "rec", "roto"]);
    expect(bastionChoices(profiles, null).map((p) => p.id)).toEqual(["act", "bas", "t", "hijo", "rec", "roto"]);
    const ring = [P("a", { proxy_jump_profile_id: "b" }), P("b", { proxy_jump_profile_id: "a" })];
    expect(bastionChoices(ring, "a").map((p) => p.id)).toEqual([]);
  });

  it("bastionReferrers lista quién usa un perfil como bastión", () => {
    expect(bastionReferrers(profiles, "bas").map((p) => p.id)).toEqual(["t"]);
    expect(bastionReferrers(profiles, "act")).toEqual([]);
  });

  it("filterJumpProfiles filtra por palabras sin acentos y respeta los bucles", () => {
    const list = [P("a", { name: "Oficina Málaga", host: "10.0.0.1" }), P("b", { name: "DMZ", group: "Red/Perímetro" }), P("t", { proxy_jump_profile_id: "a" })];
    expect(filterJumpProfiles(list, "malaga").map((p) => p.id)).toEqual(["a"]);
    expect(filterJumpProfiles(list, "perimetro dmz").map((p) => p.id)).toEqual(["b"]);
    expect(filterJumpProfiles(list, "").map((p) => p.id)).toEqual(["b", "a", "t"]);
    expect(filterJumpProfiles(list, "", { excludeId: "a" }).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("pushRecentJump", () => {
  it("pone el último al frente, sin repetir y con tope de 5", () => {
    expect(pushRecentJump(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(pushRecentJump(["a", "b", "c", "d", "e"], "f")).toEqual(["f", "a", "b", "c", "d"]);
    expect(pushRecentJump(null, "a")).toEqual(["a"]);
    expect(pushRecentJump(["a", 3, "", "a", "b"], null)).toEqual(["a", "b"]);
  });
});

describe("preferencias", () => {
  it("normalizeJumpPrefs sanea tipos y valores", () => {
    const prefs = normalizeJumpPrefs({
      activeJumpProfileId: "", activeJumpKeep: "si", recentJumpProfileIds: ["a", "a", 1],
      jumpReuse: undefined, jumpIdleSecs: "99999", jumpUnsupported: "raro", routePill: "nunca",
    });
    expect(prefs).toEqual({
      activeJumpProfileId: null, activeJumpKeep: false, recentJumpProfileIds: ["a"],
      jumpReuse: true, jumpIdleSecs: 3600, jumpUnsupported: "direct", routePill: "auto",
    });
    expect(normalizeJumpPrefs({ jumpReuse: false, jumpUnsupported: "block", routePill: "never", jumpIdleSecs: 1 }))
      .toMatchObject({ jumpReuse: false, jumpUnsupported: "block", routePill: "never", jumpIdleSecs: 5 });
  });

  it("clampIdleSecs cae al valor por defecto si no es un número", () => {
    expect(clampIdleSecs("x")).toBe(60);
    expect(clampIdleSecs(90.4)).toBe(90);
  });

  it("jumpSettingsPayload usa los nombres del contrato", () => {
    expect(jumpSettingsPayload({ jumpReuse: false, jumpIdleSecs: 30, activeJumpProfileId: "a", activeJumpKeep: true }))
      .toEqual({ reuse: false, idle_secs: 30, active_profile_id: "a", keep: true });
    expect(jumpSettingsPayload({})).toEqual({ reuse: true, idle_secs: 60, active_profile_id: null, keep: false });
  });

  it("shouldShowRoutePill según el modo", () => {
    const plain = [P("a")];
    expect(shouldShowRoutePill({ routePill: "always" }, plain)).toBe(true);
    expect(shouldShowRoutePill({ routePill: "never", activeJumpProfileId: "a" }, plain)).toBe(false);
    expect(shouldShowRoutePill({ routePill: "auto" }, plain)).toBe(false);
    expect(shouldShowRoutePill({}, plain)).toBe(false);
    expect(shouldShowRoutePill({ activeJumpProfileId: "a" }, plain)).toBe(true);
    expect(shouldShowRoutePill({ recentJumpProfileIds: ["a"] }, plain)).toBe(true);
    expect(shouldShowRoutePill({}, [P("t", { proxy_jump_profile_id: "a" })])).toBe(true);
  });
});

describe("detachDeletedBastions", () => {
  it("devuelve copias sin bastión de los que apuntaban a perfiles borrados", () => {
    const profiles = [P("b"), P("t", { proxy_jump_profile_id: "b" }), P("u", { proxy_jump_profile_id: "otro" }), P("v", { proxy_jump_profile_id: "b" })];
    const out = detachDeletedBastions(profiles, ["b", "v"], "2026-10-25T00:00:00Z");
    expect(out).toEqual([{ ...profiles[1], proxy_jump_profile_id: null, updated_at: "2026-10-25T00:00:00Z" }]);
    expect(profiles[1].proxy_jump_profile_id).toBe("b");
  });
});

describe("allowsTextBastion", () => {
  it("la dirección manual solo en tipos con credenciales que sirvan para SSH", () => {
    for (const t of ["ssh", "sftp", "rdp", undefined]) expect(allowsTextBastion(t)).toBe(true);
    for (const t of ["vnc", "telnet", "ftp", "webdav"]) expect(allowsTextBastion(t)).toBe(false);
  });
});

describe("withBastionOverride", () => {
  const p = P("t", { proxy_jump_profile_id: "b", proxy_jump: "viejo" });
  it("un bastión de texto puntual sustituye al perfil-bastión", () => {
    expect(withBastionOverride(p, { proxy_jump: " ana@otro " })).toMatchObject({ proxy_jump_profile_id: null, proxy_jump: "ana@otro" });
    expect(withBastionOverride(p, { proxy_jump: "" })).toMatchObject({ proxy_jump_profile_id: null, proxy_jump: null });
    expect(p.proxy_jump_profile_id).toBe("b");
  });
  it("sin override de bastión, el perfil sin tocar", () => {
    expect(withBastionOverride(p, null)).toBe(p);
    expect(withBastionOverride(p, { username: "root" })).toBe(p);
    expect(withBastionOverride(p, { proxy_jump: null })).toBe(p);
  });
  it("la ruta calculada sobre la copia ya no pasa por el bastión guardado", () => {
    const profiles = [P("b"), p];
    expect(resolveJumpRoute(withBastionOverride(p, { proxy_jump: "ana@otro" }), { profiles }).jumps).toEqual([]);
    expect(resolveJumpRoute(p, { profiles }).jumps).toEqual(["b"]);
  });
});

describe("enlaces de bastión al borrar y restaurar", () => {
  const profiles = [
    P("b"),
    P("t", { proxy_jump_profile_id: "b" }),
    P("u", { proxy_jump_profile_id: "b", proxy_jump: "texto" }),
    P("v", { proxy_jump_profile_id: "otro" }),
    P("w", { proxy_jump_profile_id: "b" }),
  ];
  it("bastionLinksOf apunta quién usaba cada perfil borrado (fuera del lote)", () => {
    expect(bastionLinksOf(profiles, ["b", "w"])).toEqual({
      b: [{ id: "t", proxy_jump: null }, { id: "u", proxy_jump: "texto" }],
    });
    expect(bastionLinksOf(profiles, ["v"])).toEqual({});
  });
  it("relinkRestoredBastion vuelve a enlazar solo a los que siguen sin otro bastión", () => {
    const links = bastionLinksOf(profiles, ["b"]).b;
    const detached = detachDeletedBastions(profiles, ["b"], "t1").map((p) => (p.id === "u" ? { ...p, proxy_jump: "cambiado" } : p));
    const now = [...detached, P("x")];
    const out = relinkRestoredBastion(now, "b", links, "t2");
    // «u» cambió de texto entre medias: se queda como está.
    expect(out.map((p) => [p.id, p.proxy_jump_profile_id, p.updated_at])).toEqual([["t", "b", "t2"], ["w", "b", "t2"]]);
    expect(relinkRestoredBastion(now, "b", null)).toEqual([]);
    expect(relinkRestoredBastion(profiles, "b", links)).toEqual([]);
  });
});
