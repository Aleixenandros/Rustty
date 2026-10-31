import { describe, it, expect } from "vitest";
import {
  BULK_FIELD_KEYS,
  applyBulkEdit,
  applyUndo,
  buildUndo,
  fieldAdmits,
  markedFields,
  normalizeFolder,
  replaceHost,
  summarizeBulkEdit,
  validateBulkPatch,
} from "./bulk-edit.js";

const NOW = "2026-10-30T10:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

/**
 * Perfil SSH de prueba con todos los campos que toca el lote.
 * @param {string} id
 * @param {object} [over]
 */
function profile(id, over = {}) {
  return {
    id,
    name: id,
    host: `${id}.old.corp`,
    port: 22,
    username: "ana",
    connection_type: "ssh",
    auth_type: "password",
    key_path: null,
    password_source: "own",
    master_credential_id: null,
    keepass_entry_uuid: null,
    keepass_property: null,
    group: null,
    workspace_id: "default",
    environment: null,
    keep_alive_secs: null,
    auto_reconnect: null,
    allow_legacy_algorithms: false,
    legacy_algorithms: null,
    session_log: false,
    open_read_only: false,
    proxy_jump: null,
    proxy_jump_profile_id: null,
    updated_at: OLD,
    ...over,
  };
}

const mixed = () => [
  profile("ssh1"),
  profile("ssh2", { auth_type: "public_key", key_path: "~/.ssh/id_ed25519" }),
  profile("rdp1", { connection_type: "rdp", port: 3389 }),
  profile("vnc1", { connection_type: "vnc", port: 5900 }),
  profile("tel1", { connection_type: "telnet", port: 23 }),
  profile("ftp1", { connection_type: "ftp", port: 21 }),
];

describe("markedFields", () => {
  it("solo conoce los campos del catálogo y los devuelve en orden de aplicación", () => {
    expect(markedFields({ host_replace: { from: "a", to: "b" }, username: "x", nada: 1 })).toEqual(["username", "host_replace"]);
    expect(markedFields(null)).toEqual([]);
    expect(BULK_FIELD_KEYS.indexOf("auth")).toBeLessThan(BULK_FIELD_KEYS.indexOf("master_credential"));
  });
});

describe("applyBulkEdit: lo que no se marca no se toca", () => {
  it("cambia solo el campo marcado y conserva el resto del perfil", () => {
    const before = mixed();
    const { profiles, changed } = applyBulkEdit(before, { username: "root" }, { now: NOW });
    expect(changed).toBe(6);
    for (const p of profiles) {
      const orig = before.find((x) => x.id === p.id);
      expect(p.username).toBe("root");
      expect(p.updated_at).toBe(NOW);
      const { username: _u, updated_at: _t, ...restNew } = p;
      const { username: _ou, updated_at: _ot, ...restOld } = orig;
      expect(restNew).toEqual(restOld);
    }
  });

  it("no muta los perfiles de entrada", () => {
    const before = mixed();
    const frozen = JSON.stringify(before);
    applyBulkEdit(before, { username: "root", port: 2222, group: "x" }, { now: NOW });
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("un perfil que ya tiene el valor no cambia ni se fecha", () => {
    const before = [profile("a", { username: "root" }), profile("b")];
    const res = applyBulkEdit(before, { username: "root" }, { now: NOW });
    expect(res.changed).toBe(1);
    expect(res.profiles.map((p) => p.id)).toEqual(["b"]);
    expect(res.summary.perField.username).toEqual({ applied: 1, skipped: 0, unchanged: 1 });
  });

  it("un parche vacío no cambia nada", () => {
    const res = applyBulkEdit(mixed(), {}, { now: NOW });
    expect(res.changed).toBe(0);
    expect(res.profiles).toEqual([]);
    expect(res.summary.fields).toBe(0);
  });

  it("sin opciones pone una fecha ISO", () => {
    const res = applyBulkEdit([profile("a")], { port: 2222 });
    expect(res.profiles[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.profiles[0].updated_at).not.toBe(OLD);
  });
});

describe("compatibilidad por tipo", () => {
  it("usuario, puerto, entorno y carpeta se aplican a todos los tipos", () => {
    const res = applyBulkEdit(mixed(), { username: "u", port: 2222, environment: "prod", group: "Lote" }, { now: NOW });
    expect(res.changed).toBe(6);
    expect(res.summary.skippedProfiles).toBe(0);
    for (const key of ["username", "port", "environment", "group"]) expect(res.skipped[key]).toBe(0);
    expect(res.profiles.every((p) => p.port === 2222 && p.environment === "prod" && p.group === "Lote")).toBe(true);
  });

  it("los campos solo SSH se saltan en RDP, VNC, Telnet y FTP y se cuentan", () => {
    const res = applyBulkEdit(mixed(), {
      auth: { auth_type: "agent" },
      keep_alive_secs: 30,
      auto_reconnect: 3,
      legacy: true,
      session_log: true,
      open_read_only: true,
    }, { now: NOW });
    expect(res.changed).toBe(2);
    expect(res.profiles.map((p) => p.id).sort()).toEqual(["ssh1", "ssh2"]);
    for (const key of ["auth", "keep_alive_secs", "auto_reconnect", "legacy", "session_log", "open_read_only"]) {
      expect(res.skipped[key]).toBe(4);
    }
    expect(res.summary.skippedProfiles).toBe(4);
    const ssh1 = res.profiles.find((p) => p.id === "ssh1");
    expect(ssh1).toMatchObject({
      auth_type: "agent", key_path: null, keep_alive_secs: 30, auto_reconnect: 3,
      allow_legacy_algorithms: true, legacy_algorithms: null, session_log: true, open_read_only: true,
    });
  });

  it("fieldAdmits espeja las reglas para pintar los contadores antes de elegir valor", () => {
    expect(fieldAdmits("auth", profile("a", { connection_type: "ftp" }))).toBe(false);
    expect(fieldAdmits("auth", profile("a"))).toBe(true);
    expect(fieldAdmits("bastion", profile("a", { connection_type: "ftp" }))).toBe(false);
    expect(fieldAdmits("bastion", profile("a", { connection_type: "vnc" }))).toBe(true);
    expect(fieldAdmits("master_credential", profile("a", { auth_type: "public_key" }))).toBe(false);
    expect(fieldAdmits("master_credential", profile("a", { connection_type: "rdp" }))).toBe(true);
    expect(fieldAdmits("username", profile("a", { connection_type: "ftps" }))).toBe(true);
    expect(fieldAdmits("inventado", profile("a"))).toBe(false);
  });
});

describe("autenticación y credencial maestra", () => {
  it("clave pública con ruta vacía conserva la clave de cada perfil; con ruta, la impone", () => {
    const keep = applyBulkEdit(mixed(), { auth: { auth_type: "public_key", key_path: "" } }, { now: NOW });
    expect(keep.profiles.find((p) => p.id === "ssh1").key_path).toBeNull();
    expect(keep.profiles.find((p) => p.id === "ssh2")).toBeUndefined(); // ya era public_key con su clave
    expect(keep.summary.perField.auth.unchanged).toBe(1);
    const set = applyBulkEdit(mixed(), { auth: { auth_type: "public_key", key_path: "~/.ssh/lote" } }, { now: NOW });
    expect(set.profiles.find((p) => p.id === "ssh2").key_path).toBe("~/.ssh/lote");
  });

  it("pasar a agente limpia clave, origen de contraseña y credencial maestra", () => {
    const before = [profile("a", { password_source: "master", master_credential_id: "cred-1", key_path: "x" })];
    const res = applyBulkEdit(before, { auth: { auth_type: "agent" } }, { now: NOW });
    expect(res.profiles[0]).toMatchObject({ auth_type: "agent", key_path: null, password_source: "own", master_credential_id: null });
  });

  it("la credencial maestra entra en quien usa contraseña: SSH con contraseña, RDP, VNC, Telnet y FTP", () => {
    const res = applyBulkEdit(mixed(), { master_credential: "cred-1" }, { now: NOW });
    expect(res.changed).toBe(5);
    expect(res.skipped.master_credential).toBe(1); // ssh2 va por clave
    for (const p of res.profiles) {
      expect(p.password_source).toBe("master");
      expect(p.master_credential_id).toBe("cred-1");
      expect(p.keepass_entry_uuid).toBeNull();
    }
  });

  it("en el mismo parche, poner contraseña primero deja entrar a la credencial maestra", () => {
    const before = [profile("k", { auth_type: "public_key", key_path: "~/.ssh/id" })];
    const res = applyBulkEdit(before, { auth: { auth_type: "password" }, master_credential: "cred-1" }, { now: NOW });
    expect(res.skipped.master_credential).toBe(0);
    expect(res.profiles[0]).toMatchObject({ auth_type: "password", key_path: null, password_source: "master", master_credential_id: "cred-1" });
  });

  it("credencial maestra nula vuelve a la contraseña propia, sin tocar la contraseña (no hay campo de secreto)", () => {
    const before = [profile("m", { password_source: "master", master_credential_id: "cred-1" })];
    const res = applyBulkEdit(before, { master_credential: null }, { now: NOW });
    expect(res.profiles[0]).toMatchObject({ password_source: "own", master_credential_id: null });
    expect(Object.keys(res.profiles[0])).not.toContain("password");
  });
});

describe("bastión", () => {
  const withJump = () => [...mixed(), profile("jump", { host: "bastion.corp" })];

  it("un perfil-bastión entra en SSH, RDP, VNC y Telnet; FTP se salta", () => {
    const res = applyBulkEdit(mixed(), { bastion: { profile_id: "jump" } }, { now: NOW, catalog: withJump() });
    expect(res.profiles.map((p) => p.id).sort()).toEqual(["rdp1", "ssh1", "ssh2", "tel1", "vnc1"]);
    expect(res.skipped.bastion).toBe(1);
    expect(res.profiles.every((p) => p.proxy_jump_profile_id === "jump" && p.proxy_jump === null)).toBe(true);
  });

  it("nunca se asigna a sí mismo ni formando un bucle", () => {
    // jump ya pasa por ssh1: ponerle a ssh1 el bastión jump cerraría el bucle.
    const catalog = [...mixed(), profile("jump", { proxy_jump_profile_id: "ssh1" })];
    const selected = catalog.filter((p) => ["ssh1", "ssh2", "jump"].includes(p.id));
    const res = applyBulkEdit(selected, { bastion: { profile_id: "jump" } }, { now: NOW, catalog });
    expect(res.profiles.map((p) => p.id)).toEqual(["ssh2"]);
    expect(res.skipped.bastion).toBe(2);
  });

  it("la dirección manual solo entra en los tipos con bastión de texto", () => {
    const res = applyBulkEdit(mixed(), { bastion: { text: " ana@bastion:22 " } }, { now: NOW });
    expect(res.profiles.map((p) => p.id).sort()).toEqual(["rdp1", "ssh1", "ssh2"]);
    expect(res.skipped.bastion).toBe(3); // vnc, telnet, ftp
    expect(res.profiles[0]).toMatchObject({ proxy_jump: "ana@bastion:22", proxy_jump_profile_id: null });
  });

  it("nulo quita el bastión, de perfil o de texto", () => {
    const before = [
      profile("a", { proxy_jump_profile_id: "jump" }),
      profile("b", { proxy_jump: "x@y" }),
      profile("c"),
      profile("f", { connection_type: "ftp", proxy_jump: "x@y" }),
    ];
    const res = applyBulkEdit(before, { bastion: null }, { now: NOW });
    expect(res.profiles.map((p) => p.id)).toEqual(["a", "b"]);
    expect(res.profiles.every((p) => p.proxy_jump === null && p.proxy_jump_profile_id === null)).toBe(true);
    expect(res.summary.perField.bastion).toEqual({ applied: 2, skipped: 1, unchanged: 1 });
  });
});

describe("otros campos", () => {
  it("entorno nulo o vacío quita el distintivo", () => {
    const before = [profile("a", { environment: "prod" }), profile("b")];
    const res = applyBulkEdit(before, { environment: "" }, { now: NOW });
    expect(res.profiles.map((p) => p.id)).toEqual(["a"]);
    expect(res.profiles[0].environment).toBeNull();
  });

  it("activar los algoritmos legacy conserva el subconjunto de cada perfil; desactivarlos lo limpia", () => {
    const before = [
      profile("a", { allow_legacy_algorithms: false, legacy_algorithms: ["ssh-rsa"] }),
      profile("b", { allow_legacy_algorithms: true, legacy_algorithms: ["aes-cbc"] }),
    ];
    const on = applyBulkEdit(before, { legacy: true }, { now: NOW });
    expect(on.profiles.map((p) => p.id)).toEqual(["a"]);
    expect(on.profiles[0].legacy_algorithms).toEqual(["ssh-rsa"]);
    const off = applyBulkEdit(before, { legacy: false }, { now: NOW });
    expect(off.profiles.map((p) => p.id)).toEqual(["a", "b"]);
    expect(off.profiles.every((p) => p.allow_legacy_algorithms === false && p.legacy_algorithms === null)).toBe(true);
  });

  it("keepalive y reconexión admiten null (desactivar)", () => {
    const before = [profile("a", { keep_alive_secs: 30, auto_reconnect: 5 })];
    const res = applyBulkEdit(before, { keep_alive_secs: null, auto_reconnect: null }, { now: NOW });
    expect(res.profiles[0]).toMatchObject({ keep_alive_secs: null, auto_reconnect: null });
  });

  it("la carpeta se normaliza y vacía significa raíz", () => {
    expect(normalizeFolder(" Prod / Web ")).toBe("Prod/Web");
    expect(normalizeFolder("/a//b/")).toBe("a/b");
    expect(normalizeFolder("")).toBeNull();
    expect(normalizeFolder("  ")).toBeNull();
    expect(normalizeFolder(null)).toBeNull();
    const before = [profile("a", { group: "Vieja" }), profile("b")];
    const res = applyBulkEdit(before, { group: "" }, { now: NOW });
    expect(res.profiles.map((p) => p.id)).toEqual(["a"]);
    expect(res.profiles[0].group).toBeNull();
  });
});

describe("reemplazo en el host", () => {
  it("replaceHost es literal: ni regex ni mayúsculas", () => {
    expect(replaceHost("web.old.corp", ".old.corp", ".new.corp")).toBe("web.new.corp");
    expect(replaceHost("webxoldxcorp", ".old.corp", ".new.corp")).toBe("webxoldxcorp");
    expect(replaceHost("a.b.a.b", "a.b", "x")).toBe("x.x");
    expect(replaceHost("Web.OLD.corp", ".old.corp", ".new.corp")).toBe("Web.OLD.corp");
    expect(replaceHost("h(1)+[2]", "(1)+[2]", "")).toBe("h");
    expect(replaceHost("host", "", "x")).toBe("host");
    expect(replaceHost(null, "a", "b")).toBe("");
    expect(replaceHost("host.old", ".old", null)).toBe("host");
  });

  it("cambia solo los hosts que contienen la subcadena y deja una vista previa", () => {
    const before = [...mixed(), profile("otro", { host: "10.0.0.5" })];
    const res = applyBulkEdit(before, { host_replace: { from: ".old.corp", to: ".new.corp" } }, { now: NOW });
    expect(res.changed).toBe(6);
    expect(res.summary.perField.host_replace).toEqual({ applied: 6, skipped: 0, unchanged: 1 });
    expect(res.summary.hostPreview).toHaveLength(6);
    expect(res.summary.hostPreview[0]).toEqual({ id: "ssh1", name: "ssh1", before: "ssh1.old.corp", after: "ssh1.new.corp" });
    expect(res.profiles.find((p) => p.id === "ftp1").host).toBe("ftp1.new.corp");
  });
});

describe("resumen", () => {
  it("summarizeBulkEdit cuenta campos, cambios y saltos sin fechar ni mutar", () => {
    const before = mixed();
    const frozen = JSON.stringify(before);
    const s = summarizeBulkEdit(before, { username: "u", keep_alive_secs: 30, host_replace: { from: "zzz", to: "q" } });
    expect(JSON.stringify(before)).toBe(frozen);
    expect(s.fields).toBe(3);
    expect(s.total).toBe(6);
    expect(s.changed).toBe(6);
    expect(s.skippedProfiles).toBe(4);
    expect(s.skipped).toEqual({ username: 0, keep_alive_secs: 4, host_replace: 0 });
    expect(s.perField.host_replace.unchanged).toBe(6);
    expect(s.hostPreview).toEqual([]);
  });

  it("el resumen de la vista previa coincide con el de aplicar", () => {
    const patch = { port: 2222, auth: { auth_type: "agent" }, bastion: null };
    expect(summarizeBulkEdit(mixed(), patch)).toEqual(applyBulkEdit(mixed(), patch, { now: NOW }).summary);
  });
});

describe("validateBulkPatch", () => {
  it("acepta un parche bien formado", () => {
    expect(validateBulkPatch({
      username: "", port: 22, auth: { auth_type: "public_key", key_path: "" }, master_credential: null,
      bastion: { profile_id: "x" }, keep_alive_secs: null, auto_reconnect: 20, environment: null,
      legacy: false, session_log: true, open_read_only: false, group: null, host_replace: { from: "a", to: "" },
    })).toEqual([]);
    expect(validateBulkPatch({ bastion: { text: "a@b" }, environment: "dev", keep_alive_secs: 3600 })).toEqual([]);
    expect(validateBulkPatch(null)).toEqual([]);
  });

  it("señala cada campo inválido", () => {
    expect(validateBulkPatch({ port: 0 })).toEqual(["port"]);
    expect(validateBulkPatch({ port: 70000 })).toEqual(["port"]);
    expect(validateBulkPatch({ port: "22" })).toEqual(["port"]);
    expect(validateBulkPatch({ auth: { auth_type: "otp" } })).toEqual(["auth"]);
    expect(validateBulkPatch({ master_credential: "" })).toEqual(["master_credential"]);
    expect(validateBulkPatch({ bastion: { text: "  " } })).toEqual(["bastion"]);
    expect(validateBulkPatch({ bastion: { profile_id: "" } })).toEqual(["bastion"]);
    expect(validateBulkPatch({ bastion: "x" })).toEqual(["bastion"]);
    expect(validateBulkPatch({ keep_alive_secs: 0 })).toEqual(["keep_alive_secs"]);
    expect(validateBulkPatch({ keep_alive_secs: 3601 })).toEqual(["keep_alive_secs"]);
    expect(validateBulkPatch({ auto_reconnect: 21 })).toEqual(["auto_reconnect"]);
    expect(validateBulkPatch({ environment: "qa" })).toEqual(["environment"]);
    expect(validateBulkPatch({ legacy: "yes" })).toEqual(["legacy"]);
    expect(validateBulkPatch({ group: 3 })).toEqual(["group"]);
    expect(validateBulkPatch({ host_replace: { from: "", to: "x" } })).toEqual(["host_replace"]);
    expect(validateBulkPatch({ username: 1, port: -1 })).toEqual(["username", "port"]);
  });
});

describe("deshacer", () => {
  it("la foto anterior solo guarda los perfiles que cambiaron y es una copia", () => {
    const before = [profile("a", { username: "root" }), profile("b", { legacy_algorithms: ["ssh-rsa"] })];
    const res = applyBulkEdit(before, { username: "root" }, { now: NOW });
    const undo = buildUndo(before, res);
    expect(undo.ids).toEqual(["b"]);
    expect(undo.snapshot[0]).toEqual(before[1]);
    before[1].legacy_algorithms.push("aes-cbc");
    expect(undo.snapshot[0].legacy_algorithms).toEqual(["ssh-rsa"]);
  });

  it("applyUndo restaura exactamente la foto anterior con fecha nueva", () => {
    const before = mixed();
    const res = applyBulkEdit(before, { username: "root", port: 2222, environment: "prod", bastion: { text: "j@h" } }, { now: NOW });
    const undo = buildUndo(before, res);
    const UNDO_AT = "2026-10-30T10:05:00.000Z";
    const restored = applyUndo(undo, { now: UNDO_AT });
    expect(restored).toHaveLength(res.changed);
    for (const p of restored) {
      const orig = before.find((x) => x.id === p.id);
      expect(p.updated_at).toBe(UNDO_AT);
      const { updated_at: _a, ...restRestored } = p;
      const { updated_at: _b, ...restOrig } = orig;
      expect(restRestored).toEqual(restOrig);
    }
  });

  it("applyUndo no resucita perfiles borrados entre medias", () => {
    const before = [profile("a"), profile("b")];
    const res = applyBulkEdit(before, { port: 2222 }, { now: NOW });
    const undo = buildUndo(before, res);
    const restored = applyUndo(undo, { now: NOW, existingIds: ["b"] });
    expect(restored.map((p) => p.id)).toEqual(["b"]);
    expect(applyUndo(null, { now: NOW })).toEqual([]);
  });
});
