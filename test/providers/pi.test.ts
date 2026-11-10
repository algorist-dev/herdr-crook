import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiProvider } from "../../src/providers/pi/index.ts";
import { findPiSession, parsePiLines, piAgentDir, piSessionDirName, piToolDetail } from "../../src/providers/pi/transcript.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "pi-1.5-session.jsonl");
const fixtureLines = () => readFileSync(fixture, "utf8").split("\n").filter((l) => l.trim());

describe("Pi の会話の記録（実物の見本、Pi 1.5）", () => {
  it("あなたの発言・ツール・返事を読み、システム・考え・ツールの結果は出さない", () => {
    const parsed = parsePiLines(fixtureLines());
    expect(parsed.items).toEqual([
      {
        id: "1f1f1b55",
        role: "user",
        kind: "text",
        text: "Read note.txt, then run `ls -1` with bash. Reply in one short line.",
      },
      { id: "44075b41:t1", role: "assistant", kind: "tool", tool: "read", text: "note.txt" },
      { id: "44075b41:t2", role: "assistant", kind: "tool", tool: "bash", text: "ls -1" },
      {
        id: "a3a1e13a:t1",
        role: "assistant",
        kind: "text",
        text: "note.txt says \"hello\" and it's the only file in this directory.",
      },
    ]);
  });

  it("題名は最初の発言（/name があればそちら）", () => {
    expect(parsePiLines(fixtureLines()).title).toBe("Read note.txt, then run `ls -1` with bash. Reply in one short line.");
    const named = [
      ...fixtureLines(),
      JSON.stringify({ type: "session_info", id: "n1", parentId: "a3a1e13a", timestamp: "t", name: "認証を直す" }),
    ];
    expect(parsePiLines(named).title).toBe("認証を直す");
  });

  it("使用量：返事ごとのトークンを足し、費用も足す。コンテキストは最後の返事", () => {
    const usage = parsePiLines(fixtureLines()).usage!;
    expect(usage.source).toBe("pi");
    expect(usage.model).toBe("claude-haiku-4-5");
    expect(usage.provider).toBe("anthropic");
    expect(usage.tokensDelta).toEqual({ input: 3173 + 3436, output: 191 + 60, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(usage.costDelta).toBeCloseTo(0.004128 + 0.0037359999999999997, 9);
    expect(usage.contextUsed).toBe(3436 + 60);
  });

  it("ツールの中身：呼び出しと結果を結びつける", () => {
    const detail = piToolDetail(fixture, "44075b41:t2");
    expect(detail).not.toBeNull();
    expect(detail!.running).toBe(false);
    expect(detail!.error).toBe(false);
    expect(detail!.sections.map((s) => s.text)).toEqual(expect.arrayContaining(["ls -1", "note.txt\n"]));
    expect(piToolDetail(fixture, "44075b41:t9")).toBeNull();
    expect(piToolDetail(fixture, "nope")).toBeNull();
  });

  it("読めない行は飛ばす", () => {
    expect(parsePiLines(["{", "", JSON.stringify({ type: "custom", id: "c", parentId: null })]).items).toEqual([]);
  });
});

describe("Pi の記録の場所", () => {
  it("作業フォルダの名前の作り方（先頭の / を取り、/ \\ : を - に、前後に --）", () => {
    expect(piSessionDirName("/private/tmp/a-b/proj")).toBe("--private-tmp-a-b-proj--");
    expect(piSessionDirName("/Users/me/x:y")).toBe("--Users-me-x-y--");
  });

  it("PI_CODING_AGENT_DIR があればそこ、なければ ~/.pi/agent", () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/a/b" }, "/home/me")).toBe("/a/b");
    expect(piAgentDir({}, "/home/me")).toBe("/home/me/.pi/agent");
  });

  it("その作業フォルダのいちばん新しい記録（/private の有る無しも同じフォルダ）", () => {
    const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
    const dir = join(agent, "sessions", piSessionDirName("/private/tmp/proj"));
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "2026-11-01T00-00-00-000Z_a.jsonl");
    const neu = join(dir, "2026-11-08T00-00-00-000Z_b.jsonl");
    writeFileSync(old, "{}\n");
    writeFileSync(neu, "{}\n");
    utimesSync(old, new Date(1000), new Date(1000));
    expect(findPiSession("/private/tmp/proj", agent)).toBe(neu);
    expect(findPiSession("/tmp/proj", agent)).toBe(neu);
    expect(findPiSession("/tmp/other", agent)).toBeNull();
  });
});

describe("Pi のプロバイダ", () => {
  it("Herdr が記録の場所を知らせていればそれを使い、無ければ作業フォルダから探す", () => {
    const p = createPiProvider({ agentDir: "/nowhere" });
    expect(p.chatKey({ agent: "pi", sessionSource: "herdr:pi", sessionValue: "/x/.pi/agent/sessions/--a--/s.jsonl" }, "/a")).toBe(
      "/x/.pi/agent/sessions/--a--/s.jsonl",
    );
    // 場所でなく ID だけのときは作業フォルダから
    expect(p.chatKey({ agent: "pi", sessionSource: "herdr:pi", sessionValue: "0199-abc" }, "/a")).toBe("pi:/a");
    expect(p.chatKey({ agent: "pi", sessionSource: null, sessionValue: null }, "/a")).toBe("pi:/a");
    expect(p.chatKey({ agent: "pi", sessionSource: null, sessionValue: null }, null)).toBeNull();
  });

  it("Pi はもともと承認を求めないので、確認なしの引数を持たない", () => {
    expect(createPiProvider().unattendedArgs).toBeUndefined();
  });

  it("会話を開くと、見本の記録を読める", () => {
    const p = createPiProvider();
    const stream = p.chat!.open(() => fixture);
    const first = stream.poll();
    expect(first.chat?.available).toBe(true);
    expect(first.chat?.items).toHaveLength(4);
    expect(first.usage?.cost).toBeCloseTo(0.007864, 6);
    expect(first.usage?.tokens).toEqual({ input: 6609, output: 251, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    stream.close();
    expect(p.chat!.title(fixture)).toBe("Read note.txt, then run `ls -1` with bash. Reply in one short line.");
  });

  it("記録でないものは読まない（絶対パスの .jsonl だけ）", () => {
    const p = createPiProvider();
    expect(p.chat!.title("/etc/passwd")).toBeNull();
    expect(p.chat!.title("relative/s.jsonl")).toBeNull();
  });
});

describe("Pi：続きを読むとき（レビューの指摘）", () => {
  it("続きの行だけを読んでも、題名を後の発言で上書きしない", () => {
    const more = [JSON.stringify({ type: "message", id: "u2", parentId: "a3a1e13a", timestamp: "t", message: { role: "user", content: "次はテスト" } })];
    expect(parsePiLines(more, 9).title).toBeNull();
    expect(parsePiLines(more, 0).title).toBe("次はテスト");
  });

  it("usage が全部 0 の返事では、コンテキストを 0 にしない", () => {
    const zero = [JSON.stringify({ type: "message", id: "a9", parentId: "x", timestamp: "t", message: { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } })];
    expect(parsePiLines(zero).usage?.contextUsed).toBeUndefined();
  });
});
