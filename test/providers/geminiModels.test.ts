import { describe, expect, it } from "vitest";
import { createGeminiModels, geminiCurrentModel, geminiInput, parseGeminiModels } from "../../src/providers/gemini/models.ts";
import type { ProviderPaneContext } from "../../src/providers/types.ts";

// gemini 0.67 の実物の形
const LIST = `Available Gemini Models:

auto (Auto)
  Description:   Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-3.5-flash
  Context limit: 1,048,576 input tokens / 8,192 output tokens

gemini-2.5-pro (gemini-2.5-pro)
  Context limit: 1,048,576 input tokens / 8,192 output tokens

gemini-3.1-flash-lite (gemini-3.1-flash-lite)
  Context limit: 1,048,576 input tokens / 8,192 output tokens
`;
const screen = (model: string, input = "Type your message or @path/to/file") =>
  [" ✦ Created hi.txt.", " Shift+Tab to accept edits     5 skills", "▄".repeat(80), ` >   ${input}`, "▀".repeat(80), " workspace (/directory)        sandbox        /model", ` /private/.../proj             no sandbox     ${model}`].join("\n");

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

const models = createGeminiModels(async () => parseGeminiModels(LIST));
const req = (model: string) => ({ provider: "gemini", model, variant: null });

describe("Gemini CLI のモデル", () => {
  it("一覧を読む（auto は帯で確かめられないので入れない）", () => {
    expect(parseGeminiModels(LIST)).toEqual([
      { provider: "gemini", id: "gemini-2.5-pro", name: "gemini-2.5-pro", providerName: "Google", variants: [], contextLimit: 1048576 },
      { provider: "gemini", id: "gemini-3.1-flash-lite", name: "gemini-3.1-flash-lite", providerName: "Google", variants: [], contextLimit: 1048576 },
    ]);
  });

  it("入力欄と帯のモデルを読む", () => {
    expect(geminiInput(screen("x"))).toEqual({ ready: true, draft: false });
    expect(geminiInput(screen("x", "書きかけ"))).toEqual({ ready: true, draft: true });
    expect(geminiInput("Allow execution of [Shell]?\n● 1. Allow once")).toEqual({ ready: false, draft: false });
    expect(geminiCurrentModel(screen("gemini-3.1-flash-lite"))).toBe("gemini-3.1-flash-lite");
    expect(geminiCurrentModel(screen("Auto (Gemini 3)"))).toBeNull();
  });

  it("/model set を打ち、帯が変わったら成功", async () => {
    const { ctx, sent } = pane([screen("gemini-3.1-flash-lite"), screen("gemini-3.1-flash-lite"), screen("gemini-2.5-pro")]);
    const r = await models.switch(ctx, req("gemini-2.5-pro"));
    expect(r).toMatchObject({ ok: true, current: { provider: "gemini", id: "gemini-2.5-pro" } });
    expect(sent).toEqual([
      { method: "pane.send_text", pane_id: "w1:p1", text: "/model set gemini-2.5-pro" },
      { method: "pane.send_keys", pane_id: "w1:p1", keys: ["enter"] },
    ]);
  });

  it("一覧に無いモデルは打たない（どんな文字も入力欄へ送らない）", async () => {
    const { ctx, sent } = pane([screen("gemini-3.1-flash-lite")]);
    expect((await models.switch(ctx, req("x; rm -rf ~"))).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("書きかけがあるとき・入力の画面でないときは打たない", async () => {
    for (const s of [screen("gemini-3.1-flash-lite", "書きかけ"), "Allow execution of [Shell]?"]) {
      const { ctx, sent } = pane([s]);
      expect((await models.switch(ctx, req("gemini-2.5-pro"))).ok).toBe(false);
      expect(sent).toEqual([]);
    }
  });

  it("もうそのモデルなら何も打たない。変わらなければ失敗", async () => {
    const same = pane([screen("gemini-2.5-pro")]);
    expect((await models.switch(same.ctx, req("gemini-2.5-pro"))).ok).toBe(true);
    expect(same.sent).toEqual([]);
    expect((await models.switch(pane([screen("gemini-3.1-flash-lite")]).ctx, req("gemini-2.5-pro"))).ok).toBe(false);
  });

  it("一覧といまのモデルを返す", async () => {
    const l = await models.list(pane([screen("gemini-3.1-flash-lite")]).ctx);
    expect(l.current).toEqual({ provider: "gemini", id: "gemini-3.1-flash-lite" });
    expect(l.models).toHaveLength(2);
  });
});
