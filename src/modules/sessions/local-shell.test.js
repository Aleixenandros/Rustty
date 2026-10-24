import { describe, expect, it } from "vitest";
import { commandDraftKey, isLocalShellReady, isLocalShellSession } from "./local-shell.js";

// Una consola local tal como la dejan createTerminalTab y openLocalShell.
const localShell = (extra = {}) => ({
  id: "local-abc",
  profileId: "local-abc",
  type: "ssh",
  status: "connected",
  terminal: {},
  _closeOverride() {},
  ...extra,
});
const ssh = (extra = {}) => ({ type: "ssh", profileId: "p1", status: "connected", terminal: {}, ...extra });

describe("isLocalShellSession / isLocalShellReady", () => {
  it("reconoce la consola local aunque su tipo sea ssh", () => {
    expect(isLocalShellSession(localShell())).toBe(true);
    expect(isLocalShellReady(localShell())).toBe(true);
  });

  it("no acepta texto mientras se abre, ni tras cerrarse, ni sin terminal", () => {
    expect(isLocalShellReady(localShell({ status: "connecting" }))).toBe(false);
    expect(isLocalShellReady(localShell({ status: "closed" }))).toBe(false);
    expect(isLocalShellReady(localShell({ terminal: null }))).toBe(false);
  });

  it("una sesión SSH no es una consola local", () => {
    expect(isLocalShellSession(ssh())).toBe(false);
    expect(isLocalShellReady(ssh())).toBe(false);
    expect(isLocalShellSession(null)).toBe(false);
  });
});

describe("commandDraftKey", () => {
  it("todas las consolas locales comparten el borrador «local»", () => {
    expect(commandDraftKey(localShell())).toBe("local");
    expect(commandDraftKey(localShell({ id: "local-xyz", profileId: "local-xyz" }))).toBe("local");
  });

  it("SSH usa su perfil; privadas y sin perfil no guardan borrador", () => {
    expect(commandDraftKey(ssh())).toBe("p1");
    expect(commandDraftKey(ssh({ private: true }))).toBe(null);
    expect(commandDraftKey(localShell({ private: true }))).toBe(null);
    expect(commandDraftKey({ type: "rdp", profileId: "p2" })).toBe(null);
    expect(commandDraftKey(null)).toBe(null);
  });
});
