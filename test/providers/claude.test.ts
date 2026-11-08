import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeProvider } from "../../src/providers/claude/index.ts";
import type { AgentModel } from "../../src/providers/types.ts";
import type { ProviderPaneContext } from "../../src/providers/types.ts";
import { paneFixture } from "../helpers/fakeSession.ts";

const line = (o: object) => JSON.stringify(o) + "\n";
const user = (id: string, text: string) => line({ type: "user", uuid: id, message: { role: "user", content: text } });
const assistant = (model: string) => line({ type: "assistant", message: { model, content: [{ type: "text", text: "返事" }] } });

const box = "\n" + "─".repeat(40) + "\n❯ \n" + "─".repeat(40) + "\n  Opus 5.5 · status";

const models: AgentModel[] = [
  { provider: "claude", id: "opus", name: "Opus 5.5", providerName: "Claude", variants: ["low", "high", "max"] },
  { provider: "claude", id: "sonnet", name: "Sonnet 5.5", providerName: "Claude", variants: ["low", "high"] },
];

/** 小さな ProviderPaneContext。readScreen は画面、herdr は呼ばれたものを記録する */
function fakeCtx(opts: {
  screen?: string;
  chatId?: string | null;
  herdr?: (method: string, params: Record<string, unknown>) => unknown;
} = {}): { ctx: ProviderPaneContext; calls: { method: string; params: Record<string, unknown> }[]; pokes: () => number } {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let pokes = 0;
  const pane = paneFixture({ chatId: opts.chatId ?? null });
  const ctx: ProviderPaneContext = {
    paneId: pane.paneId,
    pane,
    herdr: {
      async request(method, params) {
        calls.push({ method, params });
        return opts.herdr ? opts.herdr(method, params) : {};
      },
    },
    readScreen: async () => opts.screen ?? "",
    wait: async () => {},
    poke: () => void pokes++,
    log: () => {},
  };
  return { ctx, calls, pokes: () => pokes };
}

/** モデルを切り替えるときの画面の移り変わりをまねる（claudeModels.test.ts と同じ形） */
function switchScreen(steps: string[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let screen = "old text" + box;
  let i = 0;
  return {
    calls,
    herdr: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "pane.read") return { read: { text: screen } };
      if (method === "agent.prompt" && String(params.text).startsWith("/model")) screen = steps[i++] ?? screen;
      if (method === "pane.send_keys") screen = steps[i++] ?? screen;
      return {};
    },
  };
}

describe("Claude のプロバイダ", () => {
  it("id と chatKey", () => {
    const provider = createClaudeProvider();
    expect(provider.id).toBe("claude");
    expect(provider.chatKey({ agent: "claude", sessionSource: null, sessionValue: "s1" }, null)).toBe("s1");
    expect(provider.chatKey({ agent: "claude", sessionSource: "herdr:claude", sessionValue: "s1" }, null)).toBe("s1");
    expect(provider.chatKey({ agent: "claude", sessionSource: "herdr:claude", sessionValue: null }, null)).toBeNull();
  });

  it("chat：一時フォルダの会話記録を読める（statusline を重ねる）", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-claude-"));
    const path = join(dir, "s1.jsonl");
    writeFileSync(
      path,
      line({ type: "ai-title", aiTitle: "題名" }) + user("u1", "こんにちは") + assistant("claude-opus-5-5"),
    );
    let statuslineId: string | null = null;
    const provider = createClaudeProvider({
      findTranscript: (id) => (id === "s1" ? path : null),
      statusline: (id) => {
        statuslineId = id;
        return { context_window: { used_percentage: 42, context_window_size: 1000 } };
      },
    });
    const got = provider.chat!.open(() => "s1").poll();
    expect(got.chat).toMatchObject({
      available: true,
      reset: true,
      title: "題名",
      items: [
        { id: "u1", role: "user", kind: "text", text: "こんにちは" },
        { id: "1:0", role: "assistant", kind: "text", text: "返事" },
      ],
    });
    expect(got.usage).toMatchObject({ contextPercent: 42, contextLimit: 1000 });
    expect(statuslineId).toBe("s1");
  });

  it("title：記録がまだなければ null、できたら題名を返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-claude-title-"));
    let path: string | null = null;
    const provider = createClaudeProvider({ findTranscript: () => path });
    expect(provider.chat!.title("s1")).toBeNull();
    path = join(dir, "s1.jsonl");
    writeFileSync(path, line({ type: "ai-title", aiTitle: "あとでできた題名" }) + user("u1", "a"));
    expect(provider.chat!.title("s1")).toBe("あとでできた題名");
  });

  it("models.list：会話の記録の最後の返事のモデルと、画面の考える量", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-claude-list-"));
    const path = join(dir, "s1.jsonl");
    writeFileSync(path, assistant("claude-opus-5-5"));
    const provider = createClaudeProvider({
      findTranscript: (id) => (id === "s1" ? path : null),
      models: async () => models,
      defaultEffort: () => "high",
    });
    const f = fakeCtx({ chatId: "s1", screen: "   text\n   ◐ medium · /effort\n───" });
    const list = await provider.models!.list(f.ctx);
    expect(list.current).toEqual({ provider: "claude", id: "opus" });
    expect(list.variant).toBe("medium");
    expect(list.recent).toEqual([]);
    expect(list.models).toBe(models);
  });

  it("models.list：記録がなくても、頼んだモデルと考える量を返す", async () => {
    const provider = createClaudeProvider({
      findTranscript: () => null,
      models: async () => models,
      defaultEffort: () => "low",
    });
    const f = fakeCtx({ screen: "" });
    const switched = switchScreen(["⎿ Set model to Sonnet 5.5" + box]);
    const ctx: ProviderPaneContext = { ...f.ctx, herdr: { request: switched.herdr } };
    const result = await provider.models!.switch(ctx, { provider: "claude", model: "sonnet", variant: "high" });
    expect(result).toMatchObject({ ok: true, current: { provider: "claude", id: "sonnet" }, variant: "high" });
    const list = await provider.models!.list(ctx);
    expect(list.current).toEqual({ provider: "claude", id: "sonnet" });
    expect(list.variant).toBe("high");
  });

  it("models.switch：一覧にないモデル・そのモデルにない考える量は断る", async () => {
    const provider = createClaudeProvider({ models: async () => models });
    const f = fakeCtx();
    expect(await provider.models!.switch(f.ctx, { provider: "claude", model: "nope", variant: null })).toEqual({
      ok: false,
      current: null,
      variant: null,
      message: "そのモデルは選べません",
    });
    expect(await provider.models!.switch(f.ctx, { provider: "claude", model: "sonnet", variant: "max" })).toEqual({
      ok: false,
      current: null,
      variant: null,
      message: "このモデルではそのエフォートを選べません",
    });
    expect(f.calls).toEqual([]);
  });

  it("models.switch：同じモデルで考える量だけなら /effort だけを送る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-claude-effort-"));
    const path = join(dir, "s1.jsonl");
    writeFileSync(path, assistant("claude-opus-5-5"));
    const provider = createClaudeProvider({
      findTranscript: (id) => (id === "s1" ? path : null),
      models: async () => models,
    });
    const f = fakeCtx({
      chatId: "s1",
      screen: "old" + box,
      herdr: async (method) => (method === "pane.read" ? { read: { text: "old" + box } } : {}),
    });
    const result = await provider.models!.switch(f.ctx, { provider: "claude", model: "opus", variant: "high" });
    expect(result).toEqual({ ok: true, current: { provider: "claude", id: "opus" }, variant: "high", message: null });
    expect(f.calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text)).toEqual(["/effort high"]);
    expect(f.calls.some((c) => String(c.params.text ?? "").startsWith("/model"))).toBe(false);
    expect(f.pokes()).toBe(1);
  });

  it("models.switch：モデルを変えて、next の list に反映される", async () => {
    const provider = createClaudeProvider({ findTranscript: () => null, models: async () => models });
    const switched = switchScreen(["⎿ Set model to Sonnet 5.5" + box]);
    const f = fakeCtx();
    const ctx: ProviderPaneContext = { ...f.ctx, herdr: { request: switched.herdr } };
    const result = await provider.models!.switch(ctx, { provider: "claude", model: "sonnet", variant: "high" });
    expect(result).toEqual({ ok: true, current: { provider: "claude", id: "sonnet" }, variant: "high", message: null });
    expect(switched.calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text)).toEqual([
      "/model sonnet",
      "/effort high",
    ]);
    expect(f.pokes()).toBe(1);
    const list = await provider.models!.list(ctx);
    expect(list.current).toEqual({ provider: "claude", id: "sonnet" });
    expect(list.variant).toBe("high");
  });

  it("chat.toolDetail：ツールの id から渡したものと返ってきたものを返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-claude-tool-"));
    const path = join(dir, "s1.jsonl");
    writeFileSync(
      path,
      [
        line({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "テストを動かす" } }] } }),
        line({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      ].join("\n") + "\n",
    );
    const provider = createClaudeProvider({ findTranscript: (id) => (id === "s1" ? path : null) });
    expect(provider.chat!.toolDetail!("s1", "a2:0")).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "説明", style: "text", text: "テストを動かす", truncated: false },
        { label: "コマンド", style: "code", text: "npm test", truncated: false },
        { label: "出力", style: "code", text: "ok", truncated: false },
      ],
    });
  });

  it("chat.toolDetail：結果がまだなら running、is_error は error、無い id は null", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-claude-tool-more-"));
    const path = join(dir, "s1.jsonl");
    writeFileSync(
      path,
      line({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/a.png" } }] } }) + "\n",
    );
    const provider = createClaudeProvider({ findTranscript: () => path });
    expect(provider.chat!.toolDetail!("s1", "a2:0")).toMatchObject({ running: true, sections: [{ label: "ファイル" }] });
    expect(provider.chat!.toolDetail!("s1", "nope:0")).toBeNull();

    writeFileSync(
      path,
      [
        line({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/a.png" } }] } }),
        line({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "だめ" }, { type: "image", source: {} }] }] } }),
      ].join("\n") + "\n",
    );
    expect(provider.chat!.toolDetail!("s1", "a2:0")).toEqual({
      running: false,
      error: true,
      sections: [
        { label: "ファイル", style: "code", text: "/tmp/a.png", truncated: false },
        { label: "中身", style: "code", text: "だめ\n（画像）", truncated: false },
      ],
    });
  });

  it("builtinCommands に clear がある", () => {
    const provider = createClaudeProvider();
    expect(provider.builtinCommands!().some((c) => c.name === "clear")).toBe(true);
  });
});
