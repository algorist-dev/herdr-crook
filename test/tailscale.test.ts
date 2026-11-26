import { describe, expect, it } from "vitest";
import { parseSelf, parseWhoisUserId, Tailscale, UNKNOWN_LIMIT } from "../src/net/tailscale.ts";

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

describe("Tailscale.probe", () => {
  it("動いていれば running と自分の情報", async () => {
    const ts = new Tailscale(async () => JSON.stringify(status));
    expect(await ts.probe()).toEqual({ state: "running", self: parseSelf(status) });
  });

  it("止まっていると分かれば stopped", async () => {
    const ts = new Tailscale(async () => JSON.stringify({ ...status, BackendState: "Stopped" }));
    expect(await ts.probe()).toEqual({ state: "stopped" });
  });

  it("聞けなかった（時間切れ・起動できない・読めない）ときは unknown", async () => {
    const timeout = new Tailscale(async () => {
      throw new Error("timed out");
    });
    expect(await timeout.probe()).toEqual({ state: "unknown" });
    const garbled = new Tailscale(async () => "not json");
    expect(await garbled.probe()).toEqual({ state: "unknown" });
  });

  it("聞けなかったときの self() は、前に分かった自分を返す（混んだ Mac で Tailscale の接続を切らない）", async () => {
    let busy = false;
    const ts = new Tailscale(async (args) => {
      if (busy) throw new Error("timed out");
      if (args[0] === "status") return JSON.stringify(status);
      return JSON.stringify({ UserProfile: { ID: 42 } });
    });
    expect((await ts.self())?.ipv4).toBe("100.101.102.103");
    busy = true;
    expect((await ts.self())?.ipv4).toBe("100.101.102.103");
  });

  it("止まっていると分かったら、前の自分は忘れる", async () => {
    let state = "Running";
    const ts = new Tailscale(async () => JSON.stringify({ ...status, BackendState: state }));
    expect(await ts.self()).not.toBeNull();
    state = "Stopped";
    expect(await ts.self()).toBeNull();
  });
});

describe("Tailscale.probe（続けて聞けないとき）", () => {
  it("続けて UNKNOWN_LIMIT 回聞けなければ stopped とみなし、前の自分も忘れる", async () => {
    let up = true;
    const ts = new Tailscale(async () => {
      if (!up) throw new Error("failed to connect to local tailscaled");
      return JSON.stringify(status);
    });
    expect((await ts.probe()).state).toBe("running");
    up = false;
    for (let i = 1; i < UNKNOWN_LIMIT; i++) expect((await ts.probe()).state).toBe("unknown");
    expect(await ts.probe()).toEqual({ state: "stopped" });
    expect(await ts.self()).toBeNull();
  });

  it("あいだに一度でも聞ければ数え直す", async () => {
    const answers = ["x", "x", "x", JSON.stringify(status), "x", "x", "x"];
    const ts = new Tailscale(async () => {
      const a = answers.shift()!;
      if (a === "x") throw new Error("timed out");
      return a;
    });
    const states = [];
    for (let i = 0; i < 7; i++) states.push((await ts.probe()).state);
    expect(states).toEqual(["unknown", "unknown", "unknown", "running", "unknown", "unknown", "unknown"]);
  });

  it("JSON でも中身が変（null・数）なら投げずに unknown", async () => {
    expect((await new Tailscale(async () => "null").probe()).state).toBe("unknown");
    expect((await new Tailscale(async () => "3").probe()).state).toBe("unknown");
  });
});
