import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCopilotSession, isCopilotEvents, parseCopilotLines } from "../src/providers/copilot/transcript.ts";

describe("Copilot の会話の記録", () => {
  it("あなたの発言・返事・ツールを読み、ほかの出来事は外す", () => {
    const lines = [
      JSON.stringify({ type: "session.start", data: { sessionId: "s" } }),
      JSON.stringify({ type: "system.message", data: { role: "system", content: "You are the GitHub Copilot CLI" } }),
      JSON.stringify({ type: "user.message", data: { content: "直して", messageId: "u1" } }),
      JSON.stringify({ type: "assistant.message", data: { messageId: "a1", content: "見ます", toolRequests: [{ name: "bash", arguments: { command: "ls" } }] } }),
      JSON.stringify({ type: "assistant.message", data: { messageId: "a2", content: "直しました", toolRequests: [] } }),
    ];
    expect(parseCopilotLines(lines)).toEqual({
      title: null,
      items: [
        { id: "u1", role: "user", kind: "text", text: "直して" },
        { id: "a1", role: "assistant", kind: "text", text: "見ます" },
        { id: "a1:t0", role: "assistant", kind: "tool", tool: "bash", text: "ls" },
        { id: "a2", role: "assistant", kind: "text", text: "直しました" },
      ],
    });
  });

  it("usage から、トークン・コンテキスト・モデルを読む（キャッシュは分けて数える）", () => {
    const lines = [
      JSON.stringify({
        type: "session.usage_record",
        data: {
          usage: {
            modelDisplayName: "MAI-Code-1.1-Flash",
            inputTokens: 16981,
            outputTokens: 14,
            cacheReadTokens: 2560,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            maxPromptTokens: 128000,
          },
        },
      }),
      JSON.stringify({
        type: "session.usage_record",
        data: {
          usage: {
            modelDisplayName: "MAI-Code-1.1-Flash",
            inputTokens: 17021,
            outputTokens: 6,
            cacheReadTokens: 16896,
            cacheWriteTokens: 0,
            reasoningTokens: 2,
            maxPromptTokens: 128000,
          },
        },
      }),
      JSON.stringify({ type: "user.message", data: { content: "直して", messageId: "u1" } }),
    ];
    expect(parseCopilotLines(lines).usage).toEqual({
      source: "copilot",
      model: "MAI-Code-1.1-Flash",
      contextUsed: 17029,
      contextLimit: 128000,
      tokensDelta: { input: 14546, output: 20, cacheRead: 19456, cacheWrite: 0, reasoning: 2 },
    });
  });

  it("その作業フォルダのいちばん新しい会話と題名（会話の記録がまだないものは飛ばす）", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-cp-"));
    const mk = (id: string, cwd: string, name: string | null, events: boolean) => {
      const dir = join(home, "session-state", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\n${name ? `name: ${name}\n` : ""}`);
      if (events) writeFileSync(join(dir, "events.jsonl"), "{}\n");
      return join(dir, "events.jsonl");
    };
    const a = mk("a", "/repo", "認証を直す", true);
    mk("b", "/repo", null, false);
    mk("c", "/other", "別", true);
    expect(findCopilotSession("/repo", home)).toEqual({ path: a, title: "認証を直す" });
    expect(findCopilotSession("/nowhere", home)).toBeNull();
    expect(isCopilotEvents(a)).toBe(true);
  });
});
