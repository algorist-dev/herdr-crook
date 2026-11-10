import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscript, parseTranscriptLines } from "../src/providers/claude/transcript.ts";
import { TranscriptReader } from "../src/providers/shared/transcript.ts";

const line = (o: object) => JSON.stringify(o);

const sample = [
  line({ type: "ai-title", aiTitle: "認証を直す" }),
  line({ type: "user", uuid: "u1", message: { role: "user", content: "テストを直して" } }),
  line({ type: "assistant", uuid: "a1", message: { content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "直します。\n\n- まず読む" }] } }),
  line({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "テストを動かす" } }] } }),
  line({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  line({ type: "user", uuid: "u3", isMeta: true, message: { content: [{ type: "text", text: "<system-reminder>" }] } }),
  line({ type: "user", uuid: "u4", message: { content: [{ type: "text", text: "ありがとう" }, { type: "image", source: {} }] } }),
  line({ type: "assistant", uuid: "a3", isSidechain: true, message: { content: [{ type: "text", text: "サブエージェント" }] } }),
  "壊れた行",
  line({ type: "ai-title", aiTitle: "認証を直してテスト" }),
];

describe("parseTranscriptLines", () => {
  it("ユーザーの文・返事・使ったツールを順に取り出す", () => {
    const { items } = parseTranscriptLines(sample);
    expect(items).toEqual([
      { id: "u1", role: "user", kind: "text", text: "テストを直して" },
      { id: "a1:1", role: "assistant", kind: "text", text: "直します。\n\n- まず読む" },
      { id: "a2:0", role: "assistant", kind: "tool", text: "テストを動かす", tool: "Bash" },
      { id: "u4", role: "user", kind: "text", text: "ありがとう（画像 1 枚）" },
    ]);
  });

  it("会話を縮めたときの要約は、ユーザーの発言として出さない", () => {
    const { items } = parseTranscriptLines([
      line({ type: "user", uuid: "u1", message: { content: "前の話" } }),
      line({ type: "user", uuid: "s1", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: "This session is being continued from a previous conversation" } }),
      line({ type: "user", uuid: "u2", message: { content: "This session is being continued と貼り付けた文" } }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["u1", "u2"]);
  });

  it("裏の作業の知らせ・コマンドの出力・中断の印は、ユーザーの発言として出さない", () => {
    const notice = "<task-notification>\n<status>completed</status>\n</task-notification>";
    const { items } = parseTranscriptLines([
      line({ type: "user", uuid: "n1", origin: { kind: "task-notification" }, message: { content: notice } }),
      line({ type: "user", uuid: "n2", message: { content: "<local-command-stdout>Compacted</local-command-stdout>" } }),
      line({ type: "user", uuid: "n3", message: { content: "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>" } }),
      line({ type: "user", uuid: "n4", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
      line({ type: "user", uuid: "u1", origin: { kind: "human" }, message: { content: notice } }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["u1"]);
  });

  it("題名は最後の ai-title", () => {
    expect(parseTranscriptLines(sample).title).toBe("認証を直してテスト");
  });

  it("ツールの説明がなければ、コマンドやファイル名を短く出す", () => {
    const { items } = parseTranscriptLines([
      line({ type: "assistant", uuid: "x", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/a/b/c.ts" } }] } }),
      line({ type: "assistant", uuid: "y", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(200) } }] } }),
    ]);
    expect(items[0]?.text).toBe("c.ts");
    expect(items[1]?.text.length).toBeLessThanOrEqual(80);
  });

  it("ユーザーの文に混ざる「[Image: source: …]」の行は出さない", () => {
    const { items } = parseTranscriptLines([
      line({ type: "user", uuid: "z", message: { content: [{ type: "text", text: "[Image: source: /tmp/a.png]" }] } }),
    ]);
    expect(items).toEqual([]);
  });

  it("Claude の usage から、いまのコンテキストと累計トークンを読む（サブエージェントは数えない）", () => {
    const { usage } = parseTranscriptLines([
      line({ type: "assistant", uuid: "a1", message: { model: "claude-opus-5-5", content: [], usage: { input_tokens: 2, cache_creation_input_tokens: 28834, cache_read_input_tokens: 28086, output_tokens: 212 } } }),
      line({ type: "assistant", uuid: "a2", isSidechain: true, message: { model: "claude-opus-5-5", content: [], usage: { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 999 } } }),
      line({ type: "assistant", uuid: "a3", message: { model: "claude-opus-5-5", content: [], usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 50000, output_tokens: 50 } } }),
    ]);
    expect(usage).toEqual({
      source: "claude",
      model: "claude-opus-5-5",
      contextUsed: 50155,
      tokensDelta: { input: 7, output: 262, cacheRead: 78086, cacheWrite: 28934, reasoning: 0 },
    });
  });
});

describe("findTranscript", () => {
  it("~/.claude/projects のどこかにある <セッション ID>.jsonl を探す", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-home-"));
    mkdirSync(join(home, ".claude", "projects", "-Users-me-repo"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-Users-me-repo", "abc-123.jsonl"), "");
    expect(findTranscript("abc-123", home)).toBe(join(home, ".claude", "projects", "-Users-me-repo", "abc-123.jsonl"));
    expect(findTranscript("nope", home)).toBeNull();
    expect(findTranscript("../../etc/passwd", home)).toBeNull();
  });
});

describe("TranscriptReader", () => {
  it("はじめは全部、そのあとは増えた分だけ返す（行の途中で切れていても）", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-tr-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, sample.slice(0, 3).join("\n") + "\n");
    const reader = new TranscriptReader(path);
    const first = reader.read();
    expect(first.items.map((i) => i.id)).toEqual(["u1", "a1:1"]);
    const more = line({ type: "user", uuid: "u9", message: { content: "つぎ" } });
    appendFileSync(path, more.slice(0, 10));
    expect(reader.read().items).toEqual([]);
    appendFileSync(path, more.slice(10) + "\n");
    expect(reader.read().items).toEqual([{ id: "u9", role: "user", kind: "text", text: "つぎ" }]);
  });

  it("使用量は読んだ分だけ足していく", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-tr-"));
    const path = join(dir, "s.jsonl");
    const usageLine = (uuid: string, input: number) =>
      line({ type: "assistant", uuid, message: { model: "claude-opus-5-5", content: [], usage: { input_tokens: input, cache_read_input_tokens: 100, output_tokens: 10 } } });
    writeFileSync(path, usageLine("a1", 5) + "\n");
    const reader = new TranscriptReader(path);
    reader.read();
    expect(reader.usage?.tokens).toEqual({ input: 5, output: 10, cacheRead: 100, cacheWrite: 0, reasoning: 0 });
    expect(reader.usage?.contextUsed).toBe(115);
    appendFileSync(path, usageLine("a2", 7) + "\n");
    reader.read();
    expect(reader.usage?.tokens).toEqual({ input: 12, output: 20, cacheRead: 200, cacheWrite: 0, reasoning: 0 });
    expect(reader.usage?.contextUsed).toBe(117);
  });
});
