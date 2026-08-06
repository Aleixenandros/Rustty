// @ts-check
import { describe, it, expect } from "vitest";
import {
  DIAGNOSTICS_VERSION,
  redactSecrets,
  hostAlias,
  redactHost,
  redactPath,
  sanitizePrefsForDiagnostics,
  buildDiagnosticsReport,
  diagnosticsToMarkdown,
} from "./diagnostics.js";

describe("redactSecrets", () => {
  it("tacha pares clave=valor de contraseñas y tokens", () => {
    expect(redactSecrets("PASSWORD=hunter2 y token: abc123")).toBe("PASSWORD=•••• y token: ••••");
    expect(redactSecrets('api_key="zzz"')).toBe("api_key=••••");
    expect(redactSecrets("passphrase = secreta")).toBe("passphrase = ••••");
  });

  it("tacha cabeceras Authorization y claves SSH", () => {
    expect(redactSecrets("Authorization: Bearer eyJhbGciOi.AAAA"))
      .toBe("Authorization: Bearer ••••");
    expect(redactSecrets("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefg user@host"))
      .toBe("ssh-ed25519 •••• user@host");
  });

  it("tacha credenciales incrustadas en una URL", () => {
    expect(redactSecrets("https://ana:clave@dav.example.com/rustty"))
      .toBe("https://••••:••••@dav.example.com/rustty");
  });

  it("una clave privada PEM no sobrevive al informe", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactSecrets(pem)).not.toContain("b3BlbnNza");
  });

  it("deja intacto el texto sin secretos", () => {
    expect(redactSecrets("conexión rechazada en el puerto 22")).toBe("conexión rechazada en el puerto 22");
  });
});

describe("redactHost", () => {
  it("sin consentimiento usa un alias estable y no reversible", () => {
    const a = redactHost("prod-db.example.com", false);
    expect(a).toMatch(/^host-[a-z0-9]+$/);
    expect(a).toBe(hostAlias("prod-db.example.com"));
    expect(a).not.toContain("example");
  });

  it("hosts distintos no colisionan y con consentimiento van tal cual", () => {
    expect(hostAlias("a.example.com")).not.toBe(hostAlias("b.example.com"));
    expect(redactHost("prod-db.example.com", true)).toBe("prod-db.example.com");
  });
});

describe("redactPath", () => {
  it("sin consentimiento deja solo la forma de la ruta", () => {
    expect(redactPath("/home/ana/Documentos/claves/id_rsa.pub")).toBe("<path:5/*.pub>");
    expect(redactPath("C:\\Users\\Ana\\perfil.json")).toBe("<path:4\\*.json>");
  });

  it("con consentimiento acorta el home a ~", () => {
    expect(redactPath("/home/ana/notas.md", { includePaths: true, home: "/home/ana" })).toBe("~/notas.md");
    expect(redactPath("/etc/hosts", { includePaths: true, home: "/home/ana" })).toBe("/etc/hosts");
  });
});

describe("sanitizePrefsForDiagnostics", () => {
  it("conserva escalares, resume estructuras y excluye lo del usuario", () => {
    const out = sanitizePrefsForDiagnostics({
      fontSize: 14,
      overlayScrollbars: true,
      theme: "dark",
      commandDrafts: { local: "rm -rf /" },
      recentKeepassEntries: ["uuid-1"],
      customThemes: [{ id: "x" }],
      workspaces: [{ name: "Cliente ACME" }],
      sessionLogDir: "/home/ana/logs",
      recentHosts: ["a", "b"],
    });
    expect(out).toEqual({
      fontSize: 14,
      overlayScrollbars: true,
      theme: "dark",
      sessionLogDir: "<path:3/*>",
      recentHosts: "<array:2>",
    });
  });

  it("una preferencia con pinta de secreto se tacha aunque no esté en la lista", () => {
    const out = sanitizePrefsForDiagnostics({ syncUrl: "https://ana:clave@dav.example.com" });
    expect(out.syncUrl).toBe("https://••••:••••@dav.example.com");
  });
});

describe("buildDiagnosticsReport", () => {
  const input = {
    appVersion: "1.68.0",
    platform: "linux",
    osVersion: "6.17",
    arch: "x86_64",
    locale: "es",
    prefs: { fontSize: 13, commandDrafts: { local: "secreto" } },
    counts: { profiles: 12 },
    sessions: [{ type: "ssh", status: "connected", host: "prod.example.com", error: "token=abc" }],
    activity: [
      { timestamp: "2026-08-06T09:00:00Z", kind: "ssh", status: "error", title: "password=hunter2", detail: "" },
    ],
    logs: ["conectando", "Authorization: Bearer eyJhbGciOi.AAAA"],
    home: "/home/ana",
  };

  it("redacta por defecto y lo declara en el propio informe", () => {
    const report = buildDiagnosticsReport(input, { now: new Date("2026-08-06T10:00:00Z") });
    expect(report.version).toBe(DIAGNOSTICS_VERSION);
    expect(report.generatedAt).toBe("2026-08-06T10:00:00.000Z");
    expect(report.redaction).toEqual({
      hosts: "aliased",
      paths: "shape-only",
      secrets: "always-redacted",
      terminalOutput: "never-included",
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain("prod.example.com");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("eyJhbGciOi");
    expect(json).not.toContain("secreto");
  });

  it("con consentimiento aparecen los hosts, pero nunca los secretos", () => {
    const report = buildDiagnosticsReport(input, { includeHosts: true });
    const json = JSON.stringify(report);
    expect(json).toContain("prod.example.com");
    expect(json).not.toContain("token=abc");
  });

  it("acota actividad y logs a los más recientes", () => {
    const report = buildDiagnosticsReport(
      {
        appVersion: "1.68.0",
        activity: Array.from({ length: 10 }, (_, i) => ({ title: `ev${i}` })),
        logs: Array.from({ length: 10 }, (_, i) => `log${i}`),
      },
      { maxActivity: 2, maxLogs: 3 },
    );
    expect(/** @type {any[]} */ (report.activity).map((a) => a.title)).toEqual(["ev8", "ev9"]);
    expect(report.logs).toEqual(["log7", "log8", "log9"]);
  });
});

describe("diagnosticsToMarkdown", () => {
  it("resume el informe en un bloque pegable", () => {
    const md = diagnosticsToMarkdown(buildDiagnosticsReport({
      appVersion: "1.68.0",
      platform: "linux",
      arch: "x86_64",
      locale: "es",
      counts: { profiles: 3 },
      sessions: [{ type: "ssh", status: "connected", host: "h.example.com" }],
      activity: [{ timestamp: "2026-08-06T09:00:00Z", status: "error", title: "fallo" }],
    }));
    expect(md).toContain("## Rustty — diagnostics");
    expect(md).toContain("- **App version:** 1.68.0");
    expect(md).toContain("- **Items:** profiles=3");
    expect(md).toContain("### Sessions");
    expect(md).toContain("### Recent activity");
    expect(md).not.toContain("h.example.com");
  });
});
