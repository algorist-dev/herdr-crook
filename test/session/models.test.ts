import { describe, expect, it } from "vitest";
import { fakeSession, paneFixture } from "../helpers/fakeSession.ts";
import { modelHandlers } from "../../src/session/models.ts";
import type {
  AgentProvider,
  ModelControl,
  ModelListing,
  ModelSwitchRequest,
  ModelSwitchResult,
  ProviderPaneContext,
} from "../../src/providers/types.ts";

const listing: ModelListing = {
  current: { provider: "p", id: "m1" },
  variant: "high",
  recent: [{ provider: "p", id: "m0" }],
  models: [{ provider: "p", id: "m1", name: "M1", providerName: "P", variants: ["low", "high"] }],
};

const switched: ModelSwitchResult = {
  ok: true,
  current: { provider: "p", id: "m2" },
  variant: "low",
  message: null,
};

interface FakeProviderCalls {
  list: ProviderPaneContext[];
  switch: { ctx: ProviderPaneContext; req: ModelSwitchRequest }[];
}

function fakeProvider(opts: {
  id?: string;
  list?: (ctx: ProviderPaneContext) => Promise<ModelListing>;
  switch?: (ctx: ProviderPaneContext, req: ModelSwitchRequest) => Promise<ModelSwitchResult>;
} = {}): { provider: AgentProvider; calls: FakeProviderCalls } {
  const calls: FakeProviderCalls = { list: [], switch: [] };
  const models: ModelControl = {
    async list(ctx) {
      calls.list.push(ctx);
      return opts.list ? opts.list(ctx) : listing;
    },
    async switch(ctx, req) {
      calls.switch.push({ ctx, req });
      return opts.switch ? opts.switch(ctx, req) : switched;
    },
  };
  return { provider: { id: opts.id ?? "p", chatKey: () => null, models }, calls };
}

function plainProvider(id = "p"): AgentProvider {
  return { id, chatKey: () => null };
}

const modelsMsg = { t: "models" as const, pane: "w1:p1" };
const setModelMsg = { t: "setModel" as const, pane: "w1:p1", provider: "p", model: "m2", variant: "low" };

describe("modelHandlers.models", () => {
  it("プロバイダの一覧を、その id と一緒に送る", async () => {
    const fake = fakeProvider();
    const f = fakeSession({ providers: [fake.provider], panes: [paneFixture({ agent: "p" })] });

    await modelHandlers.models!(f.ctx, modelsMsg);

    expect(f.sent).toEqual([{ t: "models", pane: "w1:p1", agent: "p", ...listing }]);
    expect(fake.calls.list).toHaveLength(1);
    expect(fake.calls.list[0]?.paneId).toBe("w1:p1");
  });

  it("models を持たないプロバイダなら何も送らない", async () => {
    const f = fakeSession({ providers: [plainProvider()], panes: [paneFixture({ agent: "p" })] });

    await modelHandlers.models!(f.ctx, modelsMsg);

    expect(f.sent).toEqual([]);
  });

  it("知らないペインなら何も送らない", async () => {
    const fake = fakeProvider();
    const f = fakeSession({ providers: [fake.provider], panes: [] });

    await modelHandlers.models!(f.ctx, modelsMsg);

    expect(f.sent).toEqual([]);
    expect(fake.calls.list).toEqual([]);
  });

  it("切り替えているあいだは何も送らない", async () => {
    const fake = fakeProvider();
    const f = fakeSession({ providers: [fake.provider], panes: [paneFixture({ agent: "p" })] });
    f.ctx.services.modelSwitching.add("w1:p1");

    await modelHandlers.models!(f.ctx, modelsMsg);

    expect(f.sent).toEqual([]);
    expect(fake.calls.list).toEqual([]);
  });
});

describe("modelHandlers.setModel", () => {
  const fails = [
    {
      name: "知らないペイン",
      setup: (f: ReturnType<typeof fakeSession>) => void f.setPanes([]),
      message: "このタブのモデルは切り替えられません",
      switching: false,
    },
    {
      name: "models を持たないプロバイダ",
      setup: (f: ReturnType<typeof fakeSession>) => f.setPanes([paneFixture({ agent: "plain" })]),
      message: "このタブのモデルは切り替えられません",
      switching: false,
    },
    {
      name: "返事待ち",
      setup: (f: ReturnType<typeof fakeSession>) => void f.setPanes([paneFixture({ agent: "p", status: "blocked" })]),
      message: "返事待ちのあいだは切り替えられません。先に返事をしてください",
      switching: false,
    },
    {
      name: "作業中",
      setup: (f: ReturnType<typeof fakeSession>) => void f.setPanes([paneFixture({ agent: "p", status: "working" })]),
      message: "作業中は切り替えられません。終わってから切り替えてください",
      switching: false,
    },
    {
      name: "すでに切り替え中",
      setup: (f: ReturnType<typeof fakeSession>) => void f.ctx.services.modelSwitching.add("w1:p1"),
      message: "いま切り替えています",
      switching: true,
    },
  ];

  for (const c of fails) {
    it(`${c.name}なら切り替えずに断る`, async () => {
      const fake = fakeProvider();
      const f = fakeSession({ providers: [fake.provider, plainProvider("plain")], panes: [paneFixture({ agent: "p" })] });
      c.setup(f);

      await modelHandlers.setModel!(f.ctx, setModelMsg);

      expect(f.sent).toEqual([{ t: "modelSet", pane: "w1:p1", ok: false, current: null, variant: null, message: c.message }]);
      expect(fake.calls.switch).toEqual([]);
      expect(f.announced).toEqual([]);
      expect(f.ctx.services.modelSwitching.has("w1:p1")).toBe(c.switching);
    });
  }

  it("成功したらプロバイダの結果をそのまま送り、Mac に知らせて、切り替え中を解く", async () => {
    const fake = fakeProvider();
    const f = fakeSession({ providers: [fake.provider], panes: [paneFixture({ agent: "p" })] });

    await modelHandlers.setModel!(f.ctx, setModelMsg);

    expect(fake.calls.switch).toHaveLength(1);
    expect(fake.calls.switch[0]?.req).toEqual({ provider: "p", model: "m2", variant: "low" });
    expect(f.sent).toEqual([{ t: "modelSet", pane: "w1:p1", ok: true, current: switched.current, variant: "low", message: null }]);
    expect(f.announced).toEqual([{ pane: "w1:p1", resized: false }]);
    expect(f.ctx.services.modelSwitching.has("w1:p1")).toBe(false);
  });

  it("プロバイダが失敗を返したら、その message を送る", async () => {
    const fake = fakeProvider({
      switch: async () => ({ ok: false, current: null, variant: null, message: "そのモデルは選べません" }),
    });
    const f = fakeSession({ providers: [fake.provider], panes: [paneFixture({ agent: "p" })] });

    await modelHandlers.setModel!(f.ctx, setModelMsg);

    expect(f.sent).toEqual([
      { t: "modelSet", pane: "w1:p1", ok: false, current: null, variant: null, message: "そのモデルは選べません" },
    ]);
    expect(f.ctx.services.modelSwitching.has("w1:p1")).toBe(false);
  });

  it("プロバイダが投げても、切り替え中は解く", async () => {
    const fake = fakeProvider({
      switch: async () => {
        throw new Error("切り替えられませんでした");
      },
    });
    const f = fakeSession({ providers: [fake.provider], panes: [paneFixture({ agent: "p" })] });

    await expect(modelHandlers.setModel!(f.ctx, setModelMsg)).rejects.toThrow("切り替えられませんでした");

    expect(f.ctx.services.modelSwitching.has("w1:p1")).toBe(false);
  });
});
