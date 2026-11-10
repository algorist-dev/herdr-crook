import { describe, expect, it } from "vitest";
import { createPiModels, parsePiModels, piCurrentModel, piInput } from "../../src/providers/pi/models.ts";
import type { ProviderPaneContext } from "../../src/providers/types.ts";

// pi 1.5 の実物の形
const LIST = `provider   model                       context  max-out  thinking  images
anthropic  claude-haiku-4-5            200K     64K      yes       yes
anthropic  claude-haiku-5-5            1M       128K     yes       yes
`;
const rule = "─".repeat(80);
const screen = (model: string, input = "") =>
  ["note.txt says hello", rule, input, rule, "/private/tmp/piproj", `↑6.6k ↓251 $0.008 1.7%/200k (auto)      ${model} • medium`].join("\n");

function pane(screens: string[]) {
  const sent: unknown[] = [];
  let i = 0;
  const ctx = {
    paneId: "w1:p1",
    pane: {},
    herdr: { request: async (method: string, params: Record<string, unknown>) => (sent.push({ method, ...params }), {}) },
    readScreen: async () => screens[Math.min(i++, screens.length - 1)]!,
    wait: async () => {},
    poke: () => {},
    log: () => {},
  } as unknown as ProviderPaneContext;
  return { ctx, sent };
}

const models = createPiModels(async () => parsePiModels(LIST));
const req = { provider: "anthropic", model: "claude-haiku-5-5", variant: null };

describe("Pi のモデル", () => {
  it("一覧の表を読む", () => {
    expect(parsePiModels(LIST)).toEqual([
      { provider: "anthropic", id: "claude-haiku-4-5", name: "claude-haiku-4-5", providerName: "anthropic", variants: [], contextLimit: 200000 },
      { provider: "anthropic", id: "claude-haiku-5-5", name: "claude-haiku-5-5", providerName: "anthropic", variants: [], contextLimit: 1000000 },
    ]);
  });

  it("入力欄と帯を読む", () => {
    expect(piInput(screen("x"))).toEqual({ ready: true, draft: false });
    expect(piInput(screen("x", "書きかけ"))).toEqual({ ready: true, draft: true });
    expect(piInput("no rules")).toEqual({ ready: false, draft: false });
    expect(piCurrentModel(screen("claude-haiku-4-5"))).toBe("claude-haiku-4-5");
  });

  it("候補の確定で止まったら、もう一度 Enter を押す", async () => {
    const stuck = screen("claude-haiku-4-5", "/model anthropic/claude-haiku-5-5");
    const { ctx, sent } = pane([screen("claude-haiku-4-5"), stuck, stuck, stuck, stuck, stuck, screen("claude-haiku-5-5")]);
    expect(await models.switch(ctx, req)).toMatchObject({ ok: true, current: { provider: "anthropic", id: "claude-haiku-5-5" } });
    expect(sent).toEqual([
      { method: "pane.send_text", pane_id: "w1:p1", text: "/model anthropic/claude-haiku-5-5" },
      { method: "pane.send_keys", pane_id: "w1:p1", keys: ["enter"] },
      { method: "pane.send_keys", pane_id: "w1:p1", keys: ["enter"] },
    ]);
  });

  it("もう一度の Enter は 1 回だけ（入力欄の文字を何度も送らない）", async () => {
    const stuck = screen("claude-haiku-4-5", "/model anthropic/claude-haiku-5-5");
    const { ctx, sent } = pane([screen("claude-haiku-4-5"), stuck]);
    expect((await models.switch(ctx, req)).ok).toBe(false);
    expect(sent).toHaveLength(3);
  });

  it("一覧に無い提供元・モデルは打たない。書きかけがあれば打たない", async () => {
    const a = pane([screen("claude-haiku-4-5")]);
    expect((await models.switch(a.ctx, { ...req, provider: "other" })).ok).toBe(false);
    expect(a.sent).toEqual([]);
    const b = pane([screen("claude-haiku-4-5", "書きかけ")]);
    expect((await models.switch(b.ctx, req)).ok).toBe(false);
    expect(b.sent).toEqual([]);
  });

  it("いまのモデルは一覧にあるものだけ返す", async () => {
    expect((await models.list(pane([screen("claude-haiku-4-5")]).ctx)).current).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    expect((await models.list(pane([screen("unknown-model")]).ctx)).current).toBeNull();
  });
});
