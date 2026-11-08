import { describe, expect, it } from "vitest";
import {
  addTokens,
  applyClaudeStatusline,
  applyModelInfo,
  contextPercent,
  mergeUsage,
  millisAt,
  tokenTotal,
  usageSnapshot,
  windowLabel,
  type TranscriptUsage,
} from "../src/features/usage.ts";

describe("使用量の計算", () => {
  it("トークンを足す・合計する", () => {
    const a = { input: 10, output: 2, cacheRead: 100, cacheWrite: 3, reasoning: 1 };
    expect(addTokens(a, a)).toEqual({ input: 20, output: 4, cacheRead: 200, cacheWrite: 6, reasoning: 2 });
    expect(tokenTotal(a)).toBe(116);
  });

  it("コンテキストの % は小数 1 桁。上限がなければ null", () => {
    expect(contextPercent(42400, 200000)).toBe(21.2);
    expect(contextPercent(0, 100)).toBe(0);
    expect(contextPercent(10, null)).toBeNull();
    expect(contextPercent(null, 100)).toBeNull();
    expect(contextPercent(10, 0)).toBeNull();
  });

  it("レート制限の窓を 5h・7d のように書く", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10080)).toBe("7d");
    expect(windowLabel(43200)).toBe("30d");
    expect(windowLabel(90)).toBe("90m");
    expect(windowLabel(null)).toBe("使用量");
  });

  it("リセット時刻は秒・ミリ秒・ISO のどれでも読む", () => {
    expect(millisAt(1796597802)).toBe(1796597802000);
    expect(millisAt(1796597802000)).toBe(1796597802000);
    expect(millisAt("2026-11-07T00:00:00Z")).toBe(Date.parse("2026-11-07T00:00:00Z"));
    expect(millisAt("not a date")).toBeNull();
  });

  it("読むたびに足すもの（Claude）と、累計を置きかえるもの（Codex）", () => {
    const first = mergeUsage(null, {
      source: "claude",
      model: "claude-opus-5-5",
      contextUsed: 300,
      tokensDelta: { input: 10, output: 5, cacheRead: 200, cacheWrite: 0, reasoning: 0 },
    });
    expect(first.tokens).toEqual({ input: 10, output: 5, cacheRead: 200, cacheWrite: 0, reasoning: 0 });
    expect(first.contextUsed).toBe(300);
    const next = mergeUsage(first, {
      source: "claude",
      contextUsed: 500,
      tokensDelta: { input: 20, output: 8, cacheRead: 100, cacheWrite: 2, reasoning: 0 },
    });
    expect(next.tokens).toEqual({ input: 30, output: 13, cacheRead: 300, cacheWrite: 2, reasoning: 0 });
    expect(next.contextUsed).toBe(500);
    expect(next.model).toBe("claude-opus-5-5");

    const codex = mergeUsage(next, {
      source: "codex",
      tokensTotal: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
      contextUsed: 100,
      contextLimit: 1000,
    });
    expect(codex.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 });
    expect(codex.contextPercent).toBe(10);
    expect(codex.limits).toEqual([]);
  });

  it("モデルの一覧の上限を当てると % が変わる（OpenCode）", () => {
    const base: TranscriptUsage = {
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
      contextUsed: 230000,
      contextLimit: null,
      contextPercent: null,
      tokens: null,
      cost: 0.14,
      limits: [],
      source: "opencode",
    };
    const withInfo = applyModelInfo(base, { name: "DeepSeek V4.1 Flash", contextLimit: 1000000 });
    expect(withInfo.model).toBe("DeepSeek V4.1 Flash");
    expect(withInfo.contextPercent).toBe(23);
    expect(applyModelInfo(base, null)).toBe(base);
  });

  it("Claude の statusline から、正確なコンテキストと 5h/7d・費用を重ねる", () => {
    const base: TranscriptUsage = {
      model: "claude-opus-5-5",
      provider: null,
      contextUsed: 89739,
      contextLimit: null,
      contextPercent: null,
      tokens: { input: 202, output: 23659, cacheRead: 5362764, cacheWrite: 290040, reasoning: 0 },
      cost: null,
      limits: [],
      source: "claude",
    };
    const payload = {
      model: { display_name: "Opus 5.5" },
      context_window: { used_percentage: 42.5, context_window_size: 200000 },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1796597802 },
        seven_day: { used_percentage: 41.2, resets_at: 1796597802 },
      },
      cost: { total_cost_usd: 1.2345 },
    };
    expect(applyClaudeStatusline(base, payload)).toEqual({
      ...base,
      model: "Opus 5.5",
      contextUsed: 85000,
      contextLimit: 200000,
      contextPercent: 42.5,
      cost: 1.2345,
      limits: [
        { label: "5h", usedPercent: 23.5, resetsAt: 1796597802000, windowMinutes: 300 },
        { label: "7d", usedPercent: 41.2, resetsAt: 1796597802000, windowMinutes: 10080 },
      ],
      source: "claude-statusline",
    });
  });

  it("statusline だけでも使用量を作る。関係ない JSON なら何もしない", () => {
    const made = applyClaudeStatusline(null, { context_window: { used_percentage: 10, context_window_size: 100000 } });
    expect(made).toMatchObject({ source: "claude-statusline", contextUsed: 10000, contextLimit: 100000, contextPercent: 10 });
    expect(applyClaudeStatusline(null, { foo: "bar" })).toBeNull();
    expect(applyClaudeStatusline(null, null)).toBeNull();
  });

  it("iPhone に送る形にする（null なら送らない）", () => {
    const usage: TranscriptUsage = {
      model: "x",
      provider: null,
      contextUsed: 10,
      contextLimit: 100,
      contextPercent: 10,
      tokens: null,
      cost: null,
      limits: [],
      source: "codex",
    };
    expect(usageSnapshot("w1:p1", "codex", usage, 123)).toEqual({ ...usage, pane: "w1:p1", agent: "codex", updatedAt: 123 });
    expect(usageSnapshot("w1:p1", "codex", null, 123)).toBeNull();
  });
});
