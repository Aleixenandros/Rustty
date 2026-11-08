import { describe, expect, it } from "vitest";
import { connectableHost, localTunnelAddress, localTunnelUrl } from "./address.js";

describe("connectableHost", () => {
  it("un comodín se sustituye por el loopback de su familia", () => {
    expect(connectableHost("0.0.0.0")).toBe("127.0.0.1");
    expect(connectableHost("")).toBe("127.0.0.1");
    expect(connectableHost(null)).toBe("127.0.0.1");
    expect(connectableHost(undefined)).toBe("127.0.0.1");
    expect(connectableHost("::")).toBe("[::1]");
    expect(connectableHost("[::]")).toBe("[::1]");
  });

  it("un host concreto se conserva; una IPv6 va entre corchetes", () => {
    expect(connectableHost("127.0.0.1")).toBe("127.0.0.1");
    expect(connectableHost(" localhost ")).toBe("localhost");
    expect(connectableHost("192.168.1.20")).toBe("192.168.1.20");
    expect(connectableHost("::1")).toBe("[::1]");
    expect(connectableHost("[fe80::1]")).toBe("[fe80::1]");
  });
});

describe("localTunnelAddress / localTunnelUrl", () => {
  it("un -L da su dirección y su URL http", () => {
    const tun = { tunnelType: "local", bindHost: "127.0.0.1", localPort: 8080 };
    expect(localTunnelAddress(tun)).toBe("127.0.0.1:8080");
    expect(localTunnelUrl(tun)).toBe("http://127.0.0.1:8080/");
  });

  it("con el bind real, también comodín o IPv6", () => {
    expect(localTunnelAddress({ tunnelType: "local", bindHost: "0.0.0.0", localPort: 3000 })).toBe("127.0.0.1:3000");
    expect(localTunnelUrl({ tunnelType: "local", bindHost: "::1", localPort: "5432" })).toBe("http://[::1]:5432/");
  });

  it("SOCKS, remoto o puerto inválido no tienen dirección local", () => {
    expect(localTunnelAddress({ tunnelType: "dynamic", bindHost: "127.0.0.1", localPort: 1080 })).toBeNull();
    expect(localTunnelAddress({ tunnelType: "remote", bindHost: "127.0.0.1", localPort: 80 })).toBeNull();
    expect(localTunnelAddress({ tunnelType: "local", bindHost: "127.0.0.1", localPort: 0 })).toBeNull();
    expect(localTunnelAddress({ tunnelType: "local", bindHost: "127.0.0.1", localPort: 70000 })).toBeNull();
    expect(localTunnelUrl(null)).toBeNull();
  });
});
