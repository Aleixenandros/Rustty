import { describe, expect, it } from "vitest";
import { isActiveTmuxControlRoot, isTmuxPaneSession, tmuxRootRedirect } from "./sessions.js";

const root = () => ({
  type: "ssh",
  _tmuxControl: true,
  _tmuxWindows: new Map([[0, { tabId: "c-w0" }], [1, { tabId: "c-w1" }]]),
});

describe("isTmuxPaneSession", () => {
  it("solo las panes, no sus ventanas ni la raíz ni una sesión normal", () => {
    expect(isTmuxPaneSession({ type: "ssh" })).toBe(false);
    expect(isTmuxPaneSession({ type: "ssh", _tmuxControl: true })).toBe(false);
    expect(isTmuxPaneSession({ type: "tmux-window", _tmux: { conn: "c", window: 0 } })).toBe(false);
    expect(isTmuxPaneSession({ type: "ssh", _tmux: { conn: "c", pane: 0, window: 0 } })).toBe(true);
    expect(isTmuxPaneSession(null)).toBe(false);
  });
});

describe("isActiveTmuxControlRoot / tmuxRootRedirect", () => {
  it("una raíz con ventanas redirige a la primera", () => {
    expect(isActiveTmuxControlRoot(root())).toBe(true);
    expect(tmuxRootRedirect(root())).toBe("c-w0");
  });

  it("conectando o degradada a shell normal (sin ventanas) no redirige", () => {
    expect(isActiveTmuxControlRoot({ _tmuxControl: true })).toBe(false);
    expect(tmuxRootRedirect({ _tmuxControl: true })).toBe(null);
    expect(tmuxRootRedirect({ _tmuxControl: true, _tmuxWindows: new Map() })).toBe(null);
  });

  it("ni una sesión normal ni una ventana redirigen", () => {
    expect(tmuxRootRedirect({ type: "ssh" })).toBe(null);
    expect(tmuxRootRedirect({ type: "tmux-window", _tmux: { conn: "c", window: 0 } })).toBe(null);
    expect(tmuxRootRedirect(undefined)).toBe(null);
  });
});
