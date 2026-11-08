import { describe, expect, it } from "vitest";
import { parseSelf, parseWhoisUserId, Tailscale } from "../src/net/tailscale.ts";

const status = {
  Self: {
    UserID: 42,
    HostName: "Mac mini",
    DNSName: "mac-mini.tail1234ab.ts.net.",
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    Online: true,
  },
  BackendState: "Running",
};

describe("parseSelf", () => {
  it("IPv4 のアドレス・MagicDNS の名前・ユーザーを取り出す", () => {
    expect(parseSelf(status)).toEqual({
      ipv4: "100.101.102.103",
      dnsName: "mac-mini.tail1234ab.ts.net",
      hostName: "Mac mini",
      userId: 42,
    });
  });

  it("Tailscale が止まっていれば null", () => {
    expect(parseSelf({ ...status, BackendState: "Stopped" })).toBeNull();
    expect(parseSelf({})).toBeNull();
  });
});

describe("parseWhoisUserId", () => {
  it("相手のユーザー ID を取り出す", () => {
    expect(parseWhoisUserId({ UserProfile: { ID: 42, LoginName: "me@github" } })).toBe(42);
    expect(parseWhoisUserId({})).toBeNull();
  });
});

describe("Tailscale.isSameUser", () => {
  it("同じアカウントの端末だけ通す。同じ IP は覚えておく", async () => {
    const calls: string[][] = [];
    const ts = new Tailscale(async (args) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify(status);
      if (args[2] === "100.1.1.1") return JSON.stringify({ UserProfile: { ID: 42 } });
      return JSON.stringify({ UserProfile: { ID: 7 } });
    });
    expect(await ts.isSameUser("100.1.1.1")).toBe(true);
    expect(await ts.isSameUser("100.1.1.1")).toBe(true);
    expect(await ts.isSameUser("100.2.2.2")).toBe(false);
    expect(calls.filter((c) => c[0] === "whois" && c[2] === "100.1.1.1").length).toBe(1);
  });

  it("Mac の中からの接続（127.0.0.1）は通す", async () => {
    const ts = new Tailscale(async () => {
      throw new Error("should not be called");
    });
    expect(await ts.isSameUser("127.0.0.1")).toBe(true);
    expect(await ts.isSameUser("::ffff:127.0.0.1")).toBe(true);
  });

  it("調べられなければ通さない", async () => {
    const ts = new Tailscale(async () => {
      throw new Error("tailscale not running");
    });
    expect(await ts.isSameUser("100.1.1.1")).toBe(false);
  });
});
