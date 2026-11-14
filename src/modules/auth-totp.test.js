import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOTP_PROMPT_PATTERN,
  MAX_PROMPT_LABEL_CHARS,
  MAX_TOTP_PROMPT_PATTERN_LEN,
  TOTP_REPLY,
  createTotpPromptState,
  promptLabel,
  totpEntryChoices,
  totpEntryStatus,
  totpFormIssue,
  totpNoticeKey,
  totpOffer,
  totpProfileFields,
  totpWaitSeconds,
} from "./auth-totp.js";

const codePrompt = (extra = {}) => ({
  promptId: "p1",
  host: "srv.example",
  username: "ana",
  prompts: [{ prompt: "Verification code: ", echo: false }],
  totpKeepass: { autoRejected: false },
  ...extra,
});

describe("espejo del backend", () => {
  const totp = readFileSync(new URL("../../src-tauri/src/auth_totp.rs", import.meta.url), "utf8");
  const prompt = readFileSync(new URL("../../src-tauri/src/auth_prompt.rs", import.meta.url), "utf8");

  it("la regex por defecto y su tope son los de auth_totp.rs", () => {
    expect(totp).toContain(`r"${DEFAULT_TOTP_PROMPT_PATTERN}"`);
    expect(totp).toContain(`pub(crate) const MAX_PATTERN_LEN: usize = ${MAX_TOTP_PROMPT_PATTERN_LEN};`);
  });

  it("los estados son los de TotpReply, uno por variante", () => {
    const body = prompt.match(/pub enum TotpReply \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const variants = [...body.matchAll(/^ {4}([A-Z][A-Za-z]+)\b/gm)].map((m) => m[1]);
    const snake = (name) => name.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());
    expect(variants.map(snake).sort()).toEqual(Object.values(TOTP_REPLY).sort());
  });

  it("todos los avisos tienen su texto en los siete idiomas", () => {
    const notices = ["auto_rejected", "locked", "no_entry", "no_seed", "unsupported", "clock", "failed"];
    for (const lang of ["es", "en", "de", "fr", "pt", "id", "zh-TW"]) {
      const catalog = JSON.parse(readFileSync(new URL(`./i18n/${lang}.json`, import.meta.url), "utf8"));
      for (const notice of notices) {
        const [section, key] = String(totpNoticeKey(notice)).split(".");
        expect(catalog[section]?.[key], `${lang}: ${section}.${key}`).toBeTruthy();
      }
    }
  });
});

describe("la pregunta del servidor es entrada hostil", () => {
  it("se pinta sin controles ni marcas de dirección y sin el espacio final", () => {
    expect(promptLabel("Verification code: ")).toBe("Verification code:");
    expect(promptLabel("Code\u001b[31m rojo\u0007\r\n: ")).toBe("Code [31m rojo :");
    expect(promptLabel("abc‮dcba")).toBe("abcdcba");
    expect(promptLabel(null)).toBe("");
    expect(promptLabel(undefined)).toBe("");
  });

  it("una pregunta desmesurada se corta", () => {
    const label = promptLabel("x".repeat(5_000_000));
    expect(Array.from(label).length).toBe(MAX_PROMPT_LABEL_CHARS);
    expect(label.endsWith("…")).toBe(true);
  });

  it("no interpreta HTML: lo devuelve tal cual para pintarlo como texto", () => {
    const hostile = "<img src=x onerror=alert(1)> code:";
    expect(promptLabel(hostile)).toBe(hostile);
  });
});

describe("qué preguntas ofrecen el código de KeePass", () => {
  it("solo las que el backend marca, y solo de una pregunta", () => {
    expect(totpOffer(codePrompt())).toEqual({ autoRejected: false, locked: false });
    expect(totpOffer(codePrompt({ totpKeepass: { autoRejected: true, locked: true } })))
      .toEqual({ autoRejected: true, locked: true });
    expect(totpOffer(codePrompt({ totpKeepass: null }))).toBeNull();
    expect(totpOffer(codePrompt({ totpKeepass: undefined }))).toBeNull();
    const two = codePrompt({ prompts: [{ prompt: "Code: ", echo: false }, { prompt: "Password: ", echo: false }] });
    expect(totpOffer(two)).toBeNull();
    expect(totpOffer(codePrompt({ prompts: [] }))).toBeNull();
  });

  it("desconfía de un payload con otra forma", () => {
    expect(totpOffer(null)).toBeNull();
    expect(totpOffer(undefined)).toBeNull();
    expect(totpOffer({})).toBeNull();
    expect(totpOffer(codePrompt({ totpKeepass: true }))).toBeNull();
    expect(totpOffer(codePrompt({ totpKeepass: "si" }))).toBeNull();
    expect(totpOffer(codePrompt({ prompts: "Verification code" }))).toBeNull();
    // Los avisos solo cuentan si son exactamente `true`.
    expect(totpOffer(codePrompt({ totpKeepass: { autoRejected: "false", locked: 1 } })))
      .toEqual({ autoRejected: false, locked: false });
  });
});

describe("el diálogo ante la respuesta del backend", () => {
  it("sin oferta no hay botón ni aviso", () => {
    const state = createTotpPromptState(codePrompt({ totpKeepass: null }));
    expect(state.offered).toBe(false);
    expect(state.notice).toBeNull();
  });

  it("entregado o programado: la pregunta está contestada", () => {
    const state = createTotpPromptState(codePrompt());
    expect(state.offered).toBe(true);
    expect(state.notice).toBeNull();
    expect(state.resolve({ status: TOTP_REPLY.sent })).toEqual({ kind: "done" });
    expect(state.resolve({ status: TOTP_REPLY.scheduled, waitSecs: 12 })).toEqual({ kind: "scheduled", seconds: 12 });
    expect(state.resolve({ status: TOTP_REPLY.scheduled, waitSecs: 0.2 })).toEqual({ kind: "scheduled", seconds: 1 });
    // Sin `waitSecs` fiable no se promete un plazo que no se sabe.
    expect(state.resolve({ status: TOTP_REPLY.scheduled })).toEqual({ kind: "scheduled", seconds: 1 });
    expect(state.resolve({ status: TOTP_REPLY.scheduled, waitSecs: "pronto" })).toEqual({ kind: "scheduled", seconds: 1 });
  });

  it("los segundos de espera se enseñan enteros y nunca como cero", () => {
    expect(totpWaitSeconds(17)).toBe(17);
    expect(totpWaitSeconds("17")).toBe(17);
    expect(totpWaitSeconds(16.2)).toBe(17);
    for (const bad of [0, -3, NaN, Infinity, null, undefined, "", "pronto", {}]) {
      expect(totpWaitSeconds(bad)).toBe(1);
    }
  });

  it("un rechazo del automático se avisa y deja el botón: pulsarlo es decisión del usuario", () => {
    const state = createTotpPromptState(codePrompt({ totpKeepass: { autoRejected: true } }));
    expect(state.offered).toBe(true);
    expect(state.notice).toBe("auto_rejected");
    expect(totpNoticeKey(state.notice)).toBe("modal_auth_prompt.totp_auto_rejected");
    // Si además la base está bloqueada, manda el rechazo: es lo que explica
    // por qué no se contestó solo.
    const both = createTotpPromptState(codePrompt({ totpKeepass: { autoRejected: true, locked: true } }));
    expect(both.notice).toBe("auto_rejected");
  });

  it("con la base bloqueada se dice de entrada, y el botón lleva a desbloquearla", () => {
    const state = createTotpPromptState(codePrompt({ totpKeepass: { autoRejected: false, locked: true } }));
    expect(state.offered).toBe(true);
    expect(state.notice).toBe("locked");
    expect(state.resolve({ status: TOTP_REPLY.locked })).toEqual({ kind: "unlock" });
    // Desbloqueada, el mismo botón contesta.
    expect(state.resolve({ status: TOTP_REPLY.sent })).toEqual({ kind: "done" });
  });

  it("con la base bloqueada se ofrece desbloquear; si no se quiere, se avisa y el botón sigue", () => {
    const state = createTotpPromptState(codePrompt());
    expect(state.resolve({ status: TOTP_REPLY.locked })).toEqual({ kind: "unlock" });
    expect(state.offered).toBe(true);
    state.unlockDeclined();
    expect(state.notice).toBe("locked");
    expect(state.offered).toBe(true);
    // Desbloqueada más tarde, el mismo botón funciona.
    expect(state.resolve({ status: TOTP_REPLY.sent })).toEqual({ kind: "done" });
  });

  it("un fallo sin arreglo retira el botón: nada se reintenta solo", () => {
    for (const [status, notice] of [
      [TOTP_REPLY.noEntry, "no_entry"],
      [TOTP_REPLY.noSeed, "no_seed"],
      [TOTP_REPLY.unsupported, "unsupported"],
      [TOTP_REPLY.clock, "clock"],
      [TOTP_REPLY.notOffered, "failed"],
    ]) {
      const state = createTotpPromptState(codePrompt());
      expect(state.resolve({ status })).toEqual({ kind: "manual", notice });
      expect(state.offered).toBe(false);
      expect(state.notice).toBe(notice);
      expect(totpNoticeKey(state.notice)).toMatch(/^modal_auth_prompt\.totp_/);
    }
  });

  it("una respuesta que no se entiende es un fallo, nunca un éxito", () => {
    for (const reply of [null, undefined, {}, { status: "ok" }, { status: "" }, { code: "123456" }, "sent", true]) {
      const state = createTotpPromptState(codePrompt());
      expect(state.resolve(/** @type {any} */ (reply))).toEqual({ kind: "manual", notice: "failed" });
      expect(state.offered).toBe(false);
    }
  });

  it("si la pregunta caducó no queda nada que ofrecer", () => {
    const state = createTotpPromptState(codePrompt());
    expect(state.resolve({ status: TOTP_REPLY.expired })).toEqual({ kind: "expired" });
    expect(state.offered).toBe(false);
  });

  it("los avisos desconocidos no tienen clave", () => {
    expect(totpNoticeKey(null)).toBeNull();
    expect(totpNoticeKey(undefined)).toBeNull();
    expect(totpNoticeKey(/** @type {any} */ ("toString"))).toBeNull();
    expect(totpNoticeKey(/** @type {any} */ ("otro"))).toBeNull();
  });
});

describe("lo que guarda el formulario del perfil", () => {
  it("todo apagado por defecto", () => {
    expect(totpProfileFields({})).toEqual({
      totp_keepass: false,
      totp_keepass_auto: false,
      totp_keepass_entry_uuid: null,
      totp_keepass_prompt_regex: null,
    });
    expect(totpProfileFields(/** @type {any} */ (null)).totp_keepass).toBe(false);
  });

  it("el automático es una segunda casilla y no sobrevive a apagar la primera", () => {
    expect(totpProfileFields({ enabled: true }).totp_keepass_auto).toBe(false);
    expect(totpProfileFields({ enabled: true, auto: true }).totp_keepass_auto).toBe(true);
    const off = totpProfileFields({ enabled: false, auto: true, entryUuid: " abc ", regex: " (?i)token " });
    expect(off.totp_keepass).toBe(false);
    expect(off.totp_keepass_auto).toBe(false);
    // La entrada y la regex se conservan, recortadas.
    expect(off.totp_keepass_entry_uuid).toBe("abc");
    expect(off.totp_keepass_prompt_regex).toBe("(?i)token");
  });

  it("solo `true` activa: un valor cualquiera no enciende nada", () => {
    const fields = totpProfileFields(/** @type {any} */ ({ enabled: "true", auto: 1 }));
    expect(fields.totp_keepass).toBe(false);
    expect(fields.totp_keepass_auto).toBe(false);
  });

  it("en blanco es «sin valor»", () => {
    const fields = totpProfileFields({ enabled: true, entryUuid: "   ", regex: "" });
    expect(fields.totp_keepass_entry_uuid).toBeNull();
    expect(fields.totp_keepass_prompt_regex).toBeNull();
  });
});

describe("qué impide guardar", () => {
  it("apagado no exige nada", () => {
    expect(totpFormIssue({ enabled: false })).toBeNull();
    expect(totpFormIssue({ enabled: false, regex: "(", regexValid: false })).toBeNull();
    expect(totpFormIssue({})).toBeNull();
  });

  it("activado necesita una entrada: la propia o la de la contraseña", () => {
    expect(totpFormIssue({ enabled: true })).toEqual({ field: "entry", code: "need_entry" });
    expect(totpFormIssue({ enabled: true, entryUuid: "  " })).toEqual({ field: "entry", code: "need_entry" });
    expect(totpFormIssue({ enabled: true, entryUuid: "otp-1" })).toBeNull();
    expect(totpFormIssue({ enabled: true, passwordEntryUuid: "pass-1" })).toBeNull();
  });

  it("la regex la juzga el backend; aquí solo el largo", () => {
    const base = { enabled: true, entryUuid: "otp-1" };
    expect(totpFormIssue({ ...base, regex: "(sin cerrar", regexValid: false }))
      .toEqual({ field: "regex", code: "regex_invalid" });
    expect(totpFormIssue({ ...base, regex: "(?i)token", regexValid: true })).toBeNull();
    // Sin veredicto todavía no se da por mala.
    expect(totpFormIssue({ ...base, regex: "(?i)token" })).toBeNull();
    // Vacía = la de por defecto, valga lo que valga el veredicto anterior.
    expect(totpFormIssue({ ...base, regex: "  ", regexValid: false })).toBeNull();
    expect(totpFormIssue({ ...base, regex: "a".repeat(MAX_TOTP_PROMPT_PATTERN_LEN) })).toBeNull();
    expect(totpFormIssue({ ...base, regex: "a".repeat(MAX_TOTP_PROMPT_PATTERN_LEN + 1) }))
      .toEqual({ field: "regex", code: "regex_too_long" });
  });
});

describe("el selector de la entrada con la semilla", () => {
  const entries = [
    { uuid: "a", title: "Servidor A", has_totp: true },
    { uuid: "b", title: "Servidor B", has_totp: false },
    { uuid: "c", title: "Servidor C", has_totp: true },
  ];

  it("ofrece solo las entradas con semilla", () => {
    expect(totpEntryChoices(entries, "").map((c) => c.uuid)).toEqual(["a", "c"]);
    expect(totpEntryChoices(entries, null).every((c) => c.hasTotp)).toBe(true);
  });

  it("conserva la elegida aunque no tenga semilla o no esté (base bloqueada)", () => {
    const withoutSeed = totpEntryChoices(entries, "b");
    expect(withoutSeed[0]).toEqual({ uuid: "b", entry: entries[1], hasTotp: false });
    expect(withoutSeed.map((c) => c.uuid)).toEqual(["b", "a", "c"]);

    const locked = totpEntryChoices([], "zzz");
    expect(locked).toEqual([{ uuid: "zzz", entry: null, hasTotp: false }]);
    expect(totpEntryChoices(null, "zzz")).toHaveLength(1);
    expect(totpEntryChoices(undefined, "")).toEqual([]);
  });

  it("no duplica la elegida si ya está entre las que tienen semilla", () => {
    expect(totpEntryChoices(entries, "c").map((c) => c.uuid)).toEqual(["a", "c"]);
  });

  it("dice en qué estado está la entrada de la que saldría el código", () => {
    const base = { entries, unlocked: true };
    expect(totpEntryStatus({ ...base })).toBe("none");
    expect(totpEntryStatus({ ...base, entryUuid: "a" })).toBe("ok");
    expect(totpEntryStatus({ ...base, entryUuid: "b" })).toBe("no_seed");
    expect(totpEntryStatus({ ...base, entryUuid: "zzz" })).toBe("missing");
    // Sin entrada propia vale la de la contraseña; con las dos, manda la propia.
    expect(totpEntryStatus({ ...base, passwordEntryUuid: "c" })).toBe("ok");
    expect(totpEntryStatus({ ...base, entryUuid: "b", passwordEntryUuid: "c" })).toBe("no_seed");
    // Bloqueada no se puede comprobar nada.
    expect(totpEntryStatus({ entries: [], unlocked: false, entryUuid: "a" })).toBe("locked");
    expect(totpEntryStatus({ entries, entryUuid: "a" })).toBe("locked");
  });
});
