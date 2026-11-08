import { describe, expect, it } from "vitest";
import { buildPlist, LABEL } from "../src/app/launchd.ts";

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
