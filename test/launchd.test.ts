import { describe, expect, it } from "vitest";
import { bootstrapWithRetry, buildPlist, decideEnsure, LABEL, plistRunsCli } from "../src/app/launchd.ts";

describe("buildPlist", () => {
  const plist = buildPlist({
    node: "/opt/homebrew/bin/node",
    cli: "/Users/me/crook/plugin/src/cli.ts",
    home: "/Users/me/.config/crook",
    env: { HERDR_BIN: "/opt/homebrew/bin/herdr", HERDR_SOCKET_PATH: "/Users/me/.config/herdr/herdr.sock" },
  });

  it("ログインしたら動き、落ちても立ち上げ直す", () => {
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("node で cli.ts serve を動かす", () => {
    expect(plist).toMatch(/<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/me\/crook\/plugin\/src\/cli.ts<\/string>\s*<string>serve<\/string>/);
  });

  it("Herdr と Tailscale が見つかるよう PATH と環境を渡す", () => {
    expect(plist).toContain("<key>HERDR_BIN</key>");
    expect(plist).toContain("/opt/homebrew/bin:/usr/local/bin");
    expect(plist).toContain("<string>/Users/me/.config/herdr/herdr.sock</string>");
  });

  it("XML に使えない文字はエスケープする", () => {
    const p = buildPlist({ node: "/a&b", cli: "/c<d", home: "/h", env: {} });
    expect(p).toContain("/a&amp;b");
    expect(p).toContain("/c&lt;d");
  });
});

describe("launchd が動かす場所（herdr plugin update は新しい場所へ入れる）", () => {
  const options = { node: "/n", home: "/h", env: {} };
  it("同じ cli.ts なら true、更新で場所が変わったら false", () => {
    const plist = buildPlist({ ...options, cli: "/p/29225-0/checkout/src/cli.ts" });
    expect(plistRunsCli(plist, "/p/29225-0/checkout/src/cli.ts")).toBe(true);
    expect(plistRunsCli(plist, "/p/30016-0/checkout/src/cli.ts")).toBe(false);
  });

  it("& などを含む場所でも読み違えない", () => {
    const cli = "/a&b/src/cli.ts";
    expect(plistRunsCli(buildPlist({ ...options, cli }), cli)).toBe(true);
  });
});

describe("launchd に入れ直す（bootout は止め終わる前に返る）", () => {
  it("止め終わるまで bootstrap が失敗しても、やり直して入る", async () => {
    let calls = 0;
    const waits: number[] = [];
    await bootstrapWithRetry(
      async () => {
        if (++calls < 3) throw new Error("Bootstrap failed: 5: Input/output error");
      },
      async (ms) => void waits.push(ms),
    );
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("ずっと失敗するなら、あきらめて失敗を伝える", async () => {
    let calls = 0;
    await expect(
      bootstrapWithRetry(
        async () => {
          calls++;
          throw new Error("no");
        },
        async () => {},
      ),
    ).rejects.toThrow("no");
    expect(calls).toBeGreaterThan(5);
  });
});

describe("Herdr の起動フックで何をするか", () => {
  const usual = { defaultSession: true, customHome: false, plistExists: true, plistCurrent: true, relayUp: true };

  it("中継が今の場所で動いていれば何もしない", () => {
    expect(decideEnsure(usual)).toBe("none");
  });

  it("更新で場所が変わったら、動いていても入れ直す", () => {
    expect(decideEnsure({ ...usual, plistCurrent: false })).toBe("relocate");
  });

  it("試しのセッションや別の設定フォルダからは、場所が違っても入れ直さない", () => {
    expect(decideEnsure({ ...usual, plistCurrent: false, defaultSession: false })).toBe("none");
    expect(decideEnsure({ ...usual, plistCurrent: false, customHome: true })).toBe("none");
  });

  it("はじめて入れるのは、いつものセッションのときだけ", () => {
    const none = { ...usual, plistExists: false, plistCurrent: false, relayUp: false };
    expect(decideEnsure(none)).toBe("firstInstall");
    expect(decideEnsure({ ...none, defaultSession: false })).toBe("none");
  });

  it("いつものセッションで止まっていたら、launchd に立ち上げ直させる", () => {
    expect(decideEnsure({ ...usual, relayUp: false })).toBe("restart");
  });

  it("試しのセッションでは、中継が動いていなくても launchd に触らない", () => {
    expect(decideEnsure({ ...usual, relayUp: false, defaultSession: false })).toBe("none");
  });
});
