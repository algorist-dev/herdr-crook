import { describe, expect, it } from "vitest";
import type { AgentProvider, ChatPoll, ChatStream } from "../../src/providers/types.ts";
import type { ChatItem } from "../../src/providers/shared/transcript.ts";
import type { TranscriptUsage } from "../../src/features/usage.ts";
import { chatHandlers, createChatController } from "../../src/session/chat.ts";
import { fakeSession, paneFixture } from "../helpers/fakeSession.ts";

const firstChat: ChatPoll = {
  chat: {
    available: true,
    reset: true,
    title: "認証を直す",
    items: [{ id: "u1", role: "user", kind: "text", text: "直して" }],
  },
};

const laterItems: ChatItem[] = [
  { id: "u1", role: "user", kind: "text", text: "直して" },
  { id: "a1:0", role: "assistant", kind: "text", text: "はい" },
];

const usage: TranscriptUsage = {
  model: "claude-opus-5-5",
  provider: null,
  contextUsed: 1152,
  contextLimit: null,
  contextPercent: null,
  tokens: { input: 2, output: 50, cacheRead: 1000, cacheWrite: 100, reasoning: 0 },
  cost: null,
  limits: [],
  source: "claude",
};

/** 決めた順に poll を返す偽の stream。尽きたら最後のものを返す */
function streamOf(steps: Array<ChatPoll | Error>): ChatStream & { calls: number; closed: boolean } {
  let index = 0;
  const stream = {
    calls: 0,
    closed: false,
    poll(): ChatPoll {
      const step = steps[Math.min(index, steps.length - 1)]!;
      index++;
      stream.calls++;
      if (step instanceof Error) throw step;
      return step;
    },
    close() {
      stream.closed = true;
    },
  };
  return stream;
}

function providerWith(stream: ChatStream): AgentProvider {
  return {
    id: "claude",
    chatKey: () => "chat-1",
    chat: {
      open: () => stream,
      title: () => null,
    },
  };
}

async function waitUntil(ok: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > timeoutMs) throw new Error("待ちきれませんでした");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createChatController", () => {
  it("最初の会話を送り、そのあと「/」のコマンドを送る", () => {
    const stream = streamOf([firstChat, { chat: null }]);
    const f = fakeSession({ providers: [providerWith(stream)] });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p1");

    expect(f.sent.map((m) => m.t)).toEqual(["chat", "commands"]);
    expect(f.sent[0]).toMatchObject({ t: "chat", pane: "w1:p1", available: true, reset: true, title: "認証を直す" });
    expect(f.sent[1]).toMatchObject({ t: "commands", pane: "w1:p1", agent: "claude" });
    chat.stop();
    expect(stream.closed).toBe(true);
  });

  it("会話の無いペイン（ターミナル）には available:false を 1 回だけ送る", async () => {
    const stream = streamOf([firstChat]);
    const f = fakeSession({
      panes: [paneFixture({ paneId: "w1:p2", kind: "terminal", agent: null, chatId: null })],
      providers: [providerWith(stream)],
    });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p2");
    await sleep(40);

    const chats = f.sent.filter((m) => m.t === "chat");
    expect(chats).toEqual([{ t: "chat", pane: "w1:p2", available: false, reset: true, title: null, items: [] }]);
    expect(stream.calls).toBe(0);
    chat.stop();
  });

  it("chat が null のとき・usage キーが無いときは何も送らない", async () => {
    const stream = streamOf([firstChat, { chat: null }]);
    const f = fakeSession({ providers: [providerWith(stream)] });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p1");
    await sleep(60);

    expect(f.sent.filter((m) => m.t === "chat")).toHaveLength(1);
    expect(f.sent.filter((m) => m.t === "usage")).toHaveLength(0);
    chat.stop();
  });

  it("同じ使用量は 2 回送らない（updatedAt は比べない）", async () => {
    const stream = streamOf([{ ...firstChat, usage }, { chat: null, usage }]);
    const f = fakeSession({ providers: [providerWith(stream)] });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p1");
    await sleep(60);

    expect(f.sent.filter((m) => m.t === "usage")).toHaveLength(1);
    chat.stop();
  });

  it("poll が投げたら見張りを止める（それ以上送らず、stream も閉じる）", async () => {
    const stream = streamOf([firstChat, new Error("こわれた"), { chat: { available: true, reset: false, title: null, items: laterItems } }]);
    const f = fakeSession({ providers: [providerWith(stream)] });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p1");
    await waitUntil(() => stream.closed);

    const sentAtStop = f.sent.length;
    expect(stream.calls).toBe(2);
    await sleep(40);
    expect(stream.calls).toBe(2);
    expect(f.sent).toHaveLength(sentAtStop);
  });

  it("最初の poll が投げたら、そのまま start から外へ出す（コマンドは送らない）", () => {
    const stream = streamOf([new Error("だめ")]);
    const f = fakeSession({ providers: [providerWith(stream)] });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    expect(() => chat.start("w1:p1")).toThrow("だめ");
    expect(f.sent).toEqual([]);
    chat.stop();
  });

  it("返事待ちのペインは画面から選択肢を読み、終わったら空の選択肢を 1 回送る", async () => {
    const screen = " Do you want to proceed?\n ❯ 1. Yes\n   2. No (esc)\n";
    const f = fakeSession({
      panes: [paneFixture({ status: "blocked" })],
      screen,
      providers: [providerWith(streamOf([firstChat, { chat: null }]))],
    });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p1");
    await waitUntil(() => f.sent.some((m) => m.t === "choices"));

    expect(f.sent.find((m) => m.t === "choices")).toEqual({
      t: "choices",
      pane: "w1:p1",
      question: "Do you want to proceed?",
      options: [
        { key: "1", label: "Yes", detail: null },
        { key: "2", label: "No (esc)", detail: null },
      ],
      selected: "1",
    });
    expect(f.herdrCalls.find((c) => c.method === "pane.read")?.params).toMatchObject({
      pane_id: "w1:p1",
      source: "visible",
      lines: 60,
    });

    f.setPanes([paneFixture({ status: "working" })]);
    await waitUntil(() => f.sent.filter((m) => m.t === "choices").length === 2);
    expect(f.sent.filter((m) => m.t === "choices")[1]).toMatchObject({ options: [] });

    await sleep(40);
    expect(f.sent.filter((m) => m.t === "choices")).toHaveLength(2);
    chat.stop();
  });

  it("見えている範囲で読めなければ、少し前まで広げて選択肢を探す", async () => {
    const screen = " 1. Yes\n 2. No\n";
    const f = fakeSession({
      panes: [paneFixture({ status: "blocked" })],
      providers: [providerWith(streamOf([firstChat, { chat: null }]))],
      herdr: (method, params) => {
        if (method !== "pane.read") return undefined;
        return params.source === "visible" ? { read: { text: "なにもない" } } : { read: { text: screen } };
      },
    });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p1");
    await waitUntil(() => f.sent.some((m) => m.t === "choices"));

    expect(f.herdrCalls.filter((c) => c.method === "pane.read").map((c) => c.params.source)).toEqual(["visible", "recent"]);
    expect(f.herdrCalls.find((c) => c.params.source === "recent")?.params).toMatchObject({ lines: 160 });
    expect(f.sent.find((m) => m.t === "choices")).toMatchObject({ options: [{ key: "1" }, { key: "2" }] });
    chat.stop();
  });

  it("usage メッセージには最後に送った使用量を返し、別のペインなら null", async () => {
    const stream = streamOf([{ ...firstChat, usage }, { chat: null, usage }]);
    const f = fakeSession({
      panes: [paneFixture(), paneFixture({ paneId: "w1:p2", kind: "terminal", agent: null, chatId: null })],
      providers: [providerWith(stream)],
    });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p1");
    await waitUntil(() => f.sent.some((m) => m.t === "usage"));
    // 本物の dispatch では ctx.chat がこの見張りになる
    f.ctx.chat = chat;

    chatHandlers.usage!(f.ctx, { t: "usage", pane: "w1:p1" });
    const answered = f.sent.filter((m) => m.t === "usage").at(-1);
    expect(answered).toMatchObject({ t: "usage", pane: "w1:p1", usage: { pane: "w1:p1", agent: "claude", model: "claude-opus-5-5" } });

    chatHandlers.usage!(f.ctx, { t: "usage", pane: "w1:p2" });
    expect(f.sent.filter((m) => m.t === "usage").at(-1)).toEqual({ t: "usage", pane: "w1:p2", usage: null });
    chat.stop();
  });

  it("stop のあとは何も送らない", async () => {
    const stream = streamOf([
      firstChat,
      { chat: { available: true, reset: false, title: null, items: laterItems } },
    ]);
    const f = fakeSession({ providers: [providerWith(stream)] });
    const chat = createChatController(f.ctx, { pollMs: 10 });

    chat.start("w1:p1");
    const sentAtStop = f.sent.length;
    chat.stop();
    await sleep(60);

    expect(f.sent).toHaveLength(sentAtStop);
    expect(stream.closed).toBe(true);
  });

  it("commands はペインのエージェントと作業フォルダで集め、無いペインなら何もしない", () => {
    const f = fakeSession({
      deps: {
        slashCommands: (agent, cwd) => [{ name: `${agent}:${cwd}`, summary: "", kind: "command" }],
      },
    });
    f.ctx.chat = createChatController(f.ctx);
    chatHandlers.commands!(f.ctx, { t: "commands", pane: "w1:p1" });
    expect(f.sent.at(-1)).toEqual({
      t: "commands",
      pane: "w1:p1",
      agent: "claude",
      commands: [{ name: "claude:/repo/api", summary: "", kind: "command" }],
    });

    const before = f.sent.length;
    chatHandlers.commands!(f.ctx, { t: "commands", pane: "w9:p9" });
    expect(f.sent).toHaveLength(before);
  });

  it("toolDetail はペインの provider に頼み、返事を detail 付きで送る", () => {
    const detail = {
      running: false,
      error: false,
      sections: [{ label: "コマンド", style: "code" as const, text: "npm test", truncated: false }],
    };
    const provider: AgentProvider = {
      ...providerWith(streamOf([firstChat])),
      chat: {
        open: () => streamOf([firstChat]),
        title: () => null,
        toolDetail: (chatKey, itemId) => (chatKey === "s1" && itemId === "a2:0" ? detail : null),
      },
    };
    const f = fakeSession({ panes: [paneFixture({ chatId: "s1" })], providers: [provider] });
    f.ctx.chat = createChatController(f.ctx);

    chatHandlers.toolDetail!(f.ctx, { t: "toolDetail", pane: "w1:p1", item: "a2:0" });
    expect(f.sent.at(-1)).toEqual({ t: "toolDetail", pane: "w1:p1", item: "a2:0", detail });
  });

  it("toolDetail：provider に無ければ detail:null、無いペインでも detail:null を返す", () => {
    const f = fakeSession({ providers: [providerWith(streamOf([firstChat]))] });
    f.ctx.chat = createChatController(f.ctx);
    chatHandlers.toolDetail!(f.ctx, { t: "toolDetail", pane: "w1:p1", item: "a2:0" });
    expect(f.sent.at(-1)).toEqual({ t: "toolDetail", pane: "w1:p1", item: "a2:0", detail: null });

    chatHandlers.toolDetail!(f.ctx, { t: "toolDetail", pane: "w9:p9", item: "a2:0" });
    expect(f.sent.at(-1)).toEqual({ t: "toolDetail", pane: "w9:p9", item: "a2:0", detail: null });
  });

  it("files はペインの作業フォルダから探し、無いペインなら何もしない", () => {
    const f = fakeSession({
      deps: { listFiles: (cwd, query) => [`${cwd}/${query}.ts`] },
    });
    f.ctx.chat = createChatController(f.ctx);
    chatHandlers.files!(f.ctx, { t: "files", pane: "w1:p1", query: "src/ap" });
    expect(f.sent.at(-1)).toEqual({ t: "files", pane: "w1:p1", query: "src/ap", files: ["/repo/api/src/ap.ts"] });

    const before = f.sent.length;
    chatHandlers.files!(f.ctx, { t: "files", pane: "w9:p9", query: "x" });
    expect(f.sent).toHaveLength(before);
  });
});
