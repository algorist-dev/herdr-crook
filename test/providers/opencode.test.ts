import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeProvider } from "../../src/providers/opencode/index.ts";
import { OpenCodeStore } from "../../src/providers/opencode/store.ts";
import type { ProviderPaneContext } from "../../src/providers/types.ts";
import type { OpenCodeChat } from "../../src/providers/opencode/store.ts";
import type { AgentModel } from "../../src/providers/types.ts";
import type { ModelRef } from "../../src/protocol/messages.ts";
import { paneFixture } from "../helpers/fakeSession.ts";

const items = [{ id: "prt_1", role: "user" as const, kind: "text" as const, text: "ログインが落ちる" }];

function chat(over: Partial<OpenCodeChat> = {}): OpenCodeChat {
  return { title: "ログインを直す", items, ...over };
}

function fakeStore(initial: OpenCodeChat | null = chat()) {
  let current = initial;
  const readDirs: string[] = [];
  const titleDirs: string[] = [];
  const titles = new Map<string, string | null>();
  return {
    store: {
      read(directory: string) {
        readDirs.push(directory);
        return current;
      },
      title(directory: string) {
        titleDirs.push(directory);
        return titles.get(directory) ?? null;
      },
    },
    readDirs,
    titleDirs,
    titles,
    set(value: OpenCodeChat | null) {
      current = value;
    },
  };
}

const deepseek: AgentModel = {
  provider: "opencode-go",
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  providerName: "OpenCode Go",
  variants: ["high", "max"],
};

function fakeModels(models: AgentModel[], recent: ModelRef[] = []) {
  return { list: async () => models, recent: () => recent };
}

function fakeCtx(opts: { screen?: string } = {}) {
  let screen = opts.screen ?? "";
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const ctx: ProviderPaneContext = {
    paneId: "w1:p1",
    pane: paneFixture({ agent: "opencode", label: "opencode", chatId: "opencode:/repo/app" }),
    herdr: {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "pane.read") return { read: { text: screen } };
        return {};
      },
    },
    async readScreen() {
      return screen;
    },
    async wait() {},
    poke() {},
    log() {},
  };
  return {
    ctx,
    calls,
    keys: () => calls.filter((c) => c.method === "pane.send_keys").map((c) => c.params.keys),
    setScreen(next: string) {
      screen = next;
    },
  };
}

describe("OpenCode の chatKey", () => {
  it("作業フォルダから opencode:<フォルダ> を作り、フォルダがなければ null", () => {
    const provider = createOpenCodeProvider({ store: fakeStore().store });
    const record = { agent: "opencode", sessionSource: null, sessionValue: null };
    expect(provider.chatKey(record, "/repo/app")).toBe("opencode:/repo/app");
    expect(provider.chatKey(record, null)).toBeNull();
  });
});

describe("OpenCode の会話", () => {
  it("1 回目は全部を送り、変わらなければ何も送らない", () => {
    const s = fakeStore();
    const provider = createOpenCodeProvider({ store: s.store });
    const stream = provider.chat!.open(() => "opencode:/repo/app");

    expect(stream.poll()).toEqual({
      chat: { available: true, reset: true, title: "ログインを直す", items },
      usage: null,
    });
    expect(stream.poll()).toEqual({ chat: null, usage: null });
    expect(s.readDirs).toEqual(["/repo/app", "/repo/app"]);
  });

  it("あとから会話が変わったら、全部を reset で送り直す（返事は伸びるので）", () => {
    const s = fakeStore();
    const provider = createOpenCodeProvider({ store: s.store });
    const stream = provider.chat!.open(() => "opencode:/repo/app");
    stream.poll();

    const longer = [...items, { id: "prt_2", role: "assistant" as const, kind: "text" as const, text: "直しました" }];
    s.set(chat({ title: "ログインを直す（続き）", items: longer }));
    expect(stream.poll()).toEqual({
      chat: { available: true, reset: true, title: "ログインを直す（続き）", items: longer },
      usage: null,
    });
  });

  it("store が null を返したら available:false。変わらなければ 2 回目からは何も送らない", () => {
    const s = fakeStore(null);
    const provider = createOpenCodeProvider({ store: s.store });
    const stream = provider.chat!.open(() => "opencode:/repo/app");

    expect(stream.poll()).toEqual({
      chat: { available: false, reset: true, title: null, items: [] },
      usage: null,
    });
    expect(stream.poll()).toEqual({ chat: null, usage: null });
  });

  it("opencode: で始まらない chatId なら 1 回目だけ available:false（store は読まない）", () => {
    const s = fakeStore();
    const provider = createOpenCodeProvider({ store: s.store });
    const stream = provider.chat!.open(() => "codex:/repo/app");

    expect(stream.poll()).toEqual({ chat: { available: false, reset: true, title: null, items: [] } });
    expect(stream.poll()).toEqual({ chat: null });
    expect(s.readDirs).toEqual([]);
  });

  it("usage は provider と model から modelInfo を当てて contextPercent を出す", () => {
    const s = fakeStore(
      chat({
        usage: {
          model: "deepseek-v4.1-flash",
          provider: "opencode-go",
          contextUsed: 50000,
          contextLimit: null,
          contextPercent: null,
          tokens: null,
          cost: null,
          limits: [],
          source: "opencode",
        },
      }),
    );
    const provider = createOpenCodeProvider({
      store: s.store,
      modelInfo: (provider, id) =>
        provider === "opencode-go" && id === "deepseek-v4.1-flash" ? { name: "DeepSeek V4.1 Flash", contextLimit: 200000 } : null,
    });

    expect(provider.chat!.open(() => "opencode:/repo/app").poll().usage).toMatchObject({
      model: "DeepSeek V4.1 Flash",
      contextLimit: 200000,
      contextPercent: 25,
    });
  });

  it("usage がなければ null（キーはある）", () => {
    const s = fakeStore(chat({ usage: undefined }));
    const provider = createOpenCodeProvider({ store: s.store });
    expect(provider.chat!.open(() => "opencode:/repo/app").poll()).toEqual({
      chat: { available: true, reset: true, title: "ログインを直す", items },
      usage: null,
    });
  });

  it("題名は opencode: のときだけ、フォルダを store.title に渡して読む", () => {
    const s = fakeStore();
    s.titles.set("/repo/app", "ログインを直す");
    const provider = createOpenCodeProvider({ store: s.store });
    expect(provider.chat!.title("opencode:/repo/app")).toBe("ログインを直す");
    expect(provider.chat!.title("codex:/repo/app")).toBeNull();
    expect(s.titleDirs).toEqual(["/repo/app"]);
  });
});

describe("OpenCode のツールの中身", () => {
  function database(parts: { id: string; data: object }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "hm-oc-tool-"));
    const path = join(dir, "opencode.db");
    const db = new DatabaseSync(path);
    db.exec("create table part (id text primary key, data text)");
    const insert = db.prepare("insert into part (id, data) values (?, ?)");
    for (const part of parts) insert.run(part.id, JSON.stringify(part.data));
    db.close();
    return path;
  }

  it("part の state.input と state.output を返す（running・error も）", () => {
    const path = database([
      { id: "prt_1", data: { type: "text", text: "直して" } },
      {
        id: "prt_2",
        data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "file.txt" } },
      },
      {
        id: "prt_3",
        data: { type: "tool", tool: "read", state: { status: "running", input: { filePath: "/tmp/a.ts" } } },
      },
      {
        id: "prt_4",
        data: { type: "tool", tool: "bash", state: { status: "error", input: { command: "false" }, output: "だめ" } },
      },
    ]);
    const store = new OpenCodeStore(path);
    expect(store.toolDetail("prt_2")).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "コマンド", style: "code", text: "ls", truncated: false },
        { label: "出力", style: "code", text: "file.txt", truncated: false },
      ],
    });
    expect(store.toolDetail("prt_3")).toMatchObject({ running: true, sections: [{ label: "ファイル" }] });
    expect(store.toolDetail("prt_4")).toMatchObject({ running: false, error: true });
    expect(store.toolDetail("nope")).toBeNull();
    store.close();
  });

  it("provider の chat.toolDetail は opencode: のときだけ store に渡す", () => {
    const calls: string[] = [];
    const detail = { running: false, error: false, sections: [] };
    const provider = createOpenCodeProvider({
      store: {
        read: () => chat(),
        title: () => null,
        toolDetail: (id) => {
          calls.push(id);
          return detail;
        },
      },
    });
    expect(provider.chat!.toolDetail!("opencode:/repo/app", "prt_2")).toEqual(detail);
    expect(provider.chat!.toolDetail!("codex:/repo/app", "prt_2")).toBeNull();
    expect(calls).toEqual(["prt_2"]);
  });
});

describe("OpenCode のモデルの一覧", () => {
  it("画面の「Build · モデル 提供元 · 考える量」から current と variant を出す", async () => {
    const recent: ModelRef[] = [{ provider: "opencode-go", id: "deepseek-v4.1-flash" }];
    const provider = createOpenCodeProvider({ store: fakeStore().store, models: fakeModels([deepseek], recent) });
    const c = fakeCtx({ screen: "  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · high\n" });

    expect(await provider.models!.list(c.ctx)).toEqual({
      current: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      variant: "high",
      recent,
      models: [deepseek],
    });
  });

  it("画面にモデルの表示がなければ、current も variant も null", async () => {
    const provider = createOpenCodeProvider({ store: fakeStore().store, models: fakeModels([deepseek]) });
    const c = fakeCtx({ screen: "まだ何もない\n" });

    expect(await provider.models!.list(c.ctx)).toEqual({
      current: null,
      variant: null,
      recent: [],
      models: [deepseek],
    });
  });
});

describe("OpenCode のモデルの切り替え", () => {
  it("入っていないモデルなら文言を返し、何も送らない", async () => {
    const provider = createOpenCodeProvider({ store: fakeStore().store, models: fakeModels([deepseek]) });
    const c = fakeCtx({ screen: "  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · high\n" });

    expect(await provider.models!.switch(c.ctx, { provider: "opencode-go", model: "nope", variant: null })).toEqual({
      ok: false,
      current: null,
      variant: null,
      message: "そのモデルは Mac の OpenCode に入っていません",
    });
    expect(c.keys()).toEqual([]);
  });

  it("画面がすでにそのモデルで、考える量も同じなら一覧を開かない（ctrl+x などを送らない）", async () => {
    const provider = createOpenCodeProvider({ store: fakeStore().store, models: fakeModels([deepseek]) });
    const c = fakeCtx({ screen: "  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · high\n" });

    expect(
      await provider.models!.switch(c.ctx, { provider: "opencode-go", model: "deepseek-v4.1-flash", variant: "high" }),
    ).toEqual({
      ok: true,
      current: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      variant: "high",
      message: null,
    });
    expect(c.keys()).toEqual([]);
  });

  it("画面がすでにそのモデルで、考える量を指定しなければ画面の考える量（なければ既定）を返す", async () => {
    const provider = createOpenCodeProvider({ store: fakeStore().store, models: fakeModels([deepseek]) });
    const c = fakeCtx({ screen: "  ┃  Build · DeepSeek V4.1 Flash OpenCode Go\n" });

    expect(
      await provider.models!.switch(c.ctx, { provider: "opencode-go", model: "deepseek-v4.1-flash", variant: null }),
    ).toEqual({
      ok: true,
      current: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      variant: "default",
      message: null,
    });
    expect(c.keys()).toEqual([]);
  });
});

describe("OpenCode の / コマンド", () => {
  it("組み込みのコマンドを返す（clear・compact など）", () => {
    const provider = createOpenCodeProvider({ store: fakeStore().store });
    const names = provider.builtinCommands!().map((c) => c.name);
    expect(names).toContain("clear");
    expect(names).toContain("compact");
  });

  it("Mac の設定フォルダのコマンドを集める", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-oc-provider-"));
    mkdirSync(join(home, ".config", "opencode", "command"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "command", "review.md"), "---\ndescription: いまの変更を見直す\n---\n");
    const provider = createOpenCodeProvider({ store: fakeStore().store });

    expect(provider.discoverCommands!(null, home, {})).toEqual([
      { name: "review", summary: "いまの変更を見直す", kind: "command" },
    ]);
  });
});
