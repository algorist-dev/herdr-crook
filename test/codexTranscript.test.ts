import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCodexRollout, isCodexRollout, parseCodexLines } from "../src/providers/codex/transcript.ts";

const row = (payload: object) => JSON.stringify({ type: "response_item", payload });

describe("Codex の会話の記録", () => {
  it("発言と返事とツールを読み、決まった指示は外す", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp" } }),
      row({ type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex" }] }),
      row({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/tmp</cwd>" }] }),
      row({ type: "message", role: "user", content: [{ type: "input_text", text: "直して" }] }),
      row({ type: "reasoning", summary: [] }),
      row({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls", "-la"] }) }),
      row({ type: "function_call_output", output: "..." }),
      row({ type: "message", role: "assistant", content: [{ type: "output_text", text: "直しました" }] }),
    ];
    expect(parseCodexLines(lines, 100)).toEqual({
      title: "直して",
      items: [
        { id: "cx103", role: "user", kind: "text", text: "直して" },
        { id: "cx105", role: "assistant", kind: "tool", tool: "shell", text: "ls -la" },
        { id: "cx107", role: "assistant", kind: "text", text: "直しました" },
      ],
    });
  });

  it("token_count から、コンテキスト・累計・レート制限を読む", () => {
    const lines = [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5-codex" } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 12543, cached_input_tokens: 9600, cache_write_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 2 },
            last_token_usage: { input_tokens: 12543, cached_input_tokens: 9600, output_tokens: 6 },
            model_context_window: 258400,
          },
          rate_limits: {
            primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1796597802 },
            secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1796597802 },
          },
        },
      }),
    ];
    expect(parseCodexLines(lines).usage).toEqual({
      source: "codex",
      model: "gpt-5.5-codex",
      contextUsed: 12549,
      contextLimit: 258400,
      tokensTotal: { input: 2943, output: 6, cacheRead: 9600, cacheWrite: 0, reasoning: 2 },
      limits: [
        { label: "5h", usedPercent: 12.5, resetsAt: 1796597802000, windowMinutes: 300 },
        { label: "7d", usedPercent: 3, resetsAt: 1796597802000, windowMinutes: 10080 },
      ],
    });
  });

  it("その作業フォルダのいちばん新しい会話を探す（/private の有無も同じに見る）", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-cx-"));
    const now = new Date(2026, 10, 7, 12);
    const dir = join(home, "sessions", "2026", "11", "07");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-a.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: "/private/tmp" } }) + "\n");
    writeFileSync(join(dir, "rollout-b.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n");
    expect(findCodexRollout("/tmp", home, now)).toBe(join(dir, "rollout-a.jsonl"));
    expect(findCodexRollout("/nowhere", home, now)).toBeNull();
    expect(isCodexRollout(join(dir, "rollout-a.jsonl"))).toBe(true);
    expect(isCodexRollout("/x/sess-1.jsonl")).toBe(false);
  });
});
