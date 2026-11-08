import { describe, expect, it } from "vitest";
import { detectAgents, HERDR_AGENT_KINDS } from "../src/herdr/installedAgents.ts";

describe("Mac に入っているエージェントを調べる", () => {
  it("Herdr が起動できる種類のうち、コマンドがあるものだけを Herdr の順で返す", async () => {
    let script = "";
    const found = await detectAgents(
      async (s) => {
        script = s;
        return "opencode\nclaude\n";
      },
      () => false,
    );
    expect(found).toEqual(["claude", "opencode"]);
    // ログインのシェルで探す（launchd の PATH は短いので）
    expect(script).toContain("command -v");
    for (const kind of HERDR_AGENT_KINDS) expect(script).toContain(kind);
  });

  it("シェルで見つからなくても、よく入れる場所（~/.local/bin など）にあれば入れる", async () => {
    const found = await detectAgents(async () => "opencode\n", (path) => path === "/home/me/.local/bin/claude", "/home/me");
    expect(found).toEqual(["claude", "opencode"]);
  });

  it("知らない名前は返さない。調べられなければ claude だけ", async () => {
    expect(await detectAgents(async () => "claude\nrm -rf\n", () => false)).toEqual(["claude"]);
    expect(await detectAgents(async () => { throw new Error("no shell"); }, () => false)).toEqual(["claude"]);
  });
});
