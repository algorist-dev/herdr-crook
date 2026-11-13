import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHermesModels,
  hermesBarName,
  hermesCurrentModel,
  hermesHasDraft,
  hermesInput,
  hermesInputFromAnsi,
  listFromAcp,
  parseHermesModels,
  persistentList,
} from "../../src/providers/hermes/models.ts";
import type { AgentModel, ProviderPaneContext } from "../../src/providers/types.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Hermes 0.23 の実物の画面（hmtest で撮った）
const IDLE_ANSI = fixture("hermes-0.23-idle.ansi");
const DRAFT_ANSI = fixture("hermes-0.23-draft.ansi");
const WORKING_ANSI = fixture("hermes-0.23-working.ansi");
const APPROVAL = fixture("hermes-0.23-approval.txt");
const IDLE = strip(IDLE_ANSI);
const DRAFT = strip(DRAFT_ANSI);
const WORKING = strip(WORKING_ANSI);
const on = (model: string) => IDLE_ANSI.replace("claude-haiku-4-5", model);
// 高いモデルなどで Hermes が出す確認の画面（先頭の選択肢は「切り替える」）
const CONFIRM = IDLE_ANSI.replace(/\x1b\[0m\x1b\[38;5;230m❯ .*/, "\x1b[0m!!! Expensive model !!!");

// hermes acp の session/new の答え（0.23 の実物の形）
const ACP = {
  sessionId: "local-x",
  models: {
    currentModelId: "anthropic:claude-haiku-4-5",
    availableModels: [
      { modelId: "anthropic:claude-haiku-4-5", name: "Anthropic · claude-haiku-4-5", description: "Provider: Anthropic • current" },
      { modelId: "anthropic:claude-haiku-5-5", name: "Anthropic · claude-haiku-5-5" },
      { modelId: "openrouter:z-ai/glm-5.1:free", name: "OpenRouter · z-ai/glm-5.1:free" },
      { modelId: "custom:lab:qwen-3", name: "lab · qwen-3" },
      { modelId: "anthropic:bad id; rm -rf", name: "x" },
      { modelId: "anthropic:--global", name: "x" },
      { modelId: "--provider:x", name: "x" },
      { modelId: "noprovider", name: "x" },
    ],
  },
};
const haiku5: AgentModel = { provider: "anthropic", id: "claude-haiku-5-5", name: "claude-haiku-5-5", providerName: "Anthropic", variants: [] };

function pane(screens: string[]) {
  const sent: Record<string, unknown>[] = [];
  let i = 0;
  const next = () => screens[Math.min(i++, screens.length - 1)]!;
  const ctx = {
    paneId: "w1:p1",
    pane: {},
    herdr: {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "pane.read") {
          expect(params.format).toBe("ansi");
          return { read: { text: next() } };
        }
        sent.push({ method, ...params });
        return {};
      },
    },
    readScreen: async () => strip(next()),
    wait: async () => {},
    poke: () => {},
    log: () => {},
  } as unknown as ProviderPaneContext;
  return { ctx, sent };
}

const tempFile = () => join(mkdtempSync(join(tmpdir(), "hm")), "hermes-models.json");
const models = createHermesModels(async () => parseHermesModels(ACP), tempFile());
const req = { provider: "anthropic", model: "claude-haiku-5-5", variant: null };

describe("Hermes のモデルの一覧", () => {
  it("ACP の答えから、打っても安全な ID だけを取り出す", () => {
    const list = parseHermesModels(ACP);
    expect(list.map((m) => `${m.provider}|${m.id}`)).toEqual([
      "anthropic|claude-haiku-4-5",
      "anthropic|claude-haiku-5-5",
      "openrouter|z-ai/glm-5.1:free",
      "custom:lab|qwen-3",
    ]);
    expect(list[1]).toEqual(haiku5);
    expect(list[3]?.providerName).toBe("lab");
  });

  it("形が違う答えは空にする", () => {
    expect(parseHermesModels(null)).toEqual([]);
    expect(parseHermesModels({ models: { availableModels: "x" } })).toEqual([]);
    expect(parseHermesModels({ models: { availableModels: [null, { modelId: 3 }] } })).toEqual([]);
  });

  it("hermes acp と initialize → session/new の順に話し、答えを返して閉じる", async () => {
    const script = `
      const rl = require("readline").createInterface({ input: process.stdin });
      console.log("not json");
      rl.on("line", (l) => {
        const m = JSON.parse(l);
        if (m.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
        if (m.method === "session/new") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { models: { availableModels: [{ modelId: "a:b", name: "A · b" }] } } }));
      });
      setInterval(() => {}, 1000);`;
    const r = await listFromAcp(process.execPath, ["-e", script], 10_000);
    expect(r.map((m) => m.id)).toEqual(["b"]);
  });

  it("Hermes からの問い合わせ（method つき）を答えと取り違えない", async () => {
    const script = `
      require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
        const m = JSON.parse(l);
        if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: {} }));
        if (m.method === "session/new") {
          console.log(JSON.stringify({ id: 2, method: "session/request_permission", params: {} }));
          console.log(JSON.stringify({ id: m.id, result: { models: { availableModels: [{ modelId: "a:b" }] } } }));
        }
      });`;
    expect((await listFromAcp(process.execPath, ["-e", script], 10_000)).map((m) => m.id)).toEqual(["b"]);
  });

  it("動かせない・答えがエラー・時間切れなら空", async () => {
    expect(await listFromAcp("/no/such/hermes", [], 5_000)).toEqual([]);
    const err = `require("readline").createInterface({ input: process.stdin }).on("line", (l) => console.log(JSON.stringify({ id: JSON.parse(l).id, error: { message: "no" } })));`;
    expect(await listFromAcp(process.execPath, ["-e", err], 5_000)).toEqual([]);
    expect(await listFromAcp(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100)).toEqual([]);
  });
});

describe("一覧を覚えておく（ACP は遅く、開くたびに空の会話が 1 行増えるため）", () => {
  const dir = () => join(mkdtempSync(join(tmpdir(), "hm")), "sub", "hermes-models.json");
  const m = (id: string): AgentModel => ({ provider: "p", id, name: id, providerName: "p", variants: [] });

  it("初めては待って読み、ファイル（600）に残す。24 時間は聞き直さない", async () => {
    const file = dir();
    let calls = 0;
    let t = 0;
    const list = persistentList(async () => (calls++, [m("a")]), file, () => t);
    expect((await list()).map((x) => x.id)).toEqual(["a"]);
    t = 23 * 3_600_000;
    await list();
    expect(calls).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = persistentList(async () => (calls++, [m("b")]), file, () => t);
    expect((await again()).map((x) => x.id)).toEqual(["a"]);
    expect(calls).toBe(1);
  });

  it("古いときは手元のをすぐ返し、裏で読み直す（同時に 1 つだけ）", async () => {
    const file = dir();
    let t = 0;
    let done: (v: AgentModel[]) => void = () => {};
    let calls = 0;
    await persistentList(async () => [m("old")], file, () => t)();
    t = 25 * 3_600_000;
    const list = persistentList(() => (calls++, new Promise<AgentModel[]>((r) => (done = r))), file, () => t);
    expect((await list()).map((x) => x.id)).toEqual(["old"]);
    expect((await list()).map((x) => x.id)).toEqual(["old"]);
    expect(calls).toBe(1);
    done([m("new")]);
    await new Promise((r) => setTimeout(r, 5));
    expect((await list()).map((x) => x.id)).toEqual(["new"]);
    expect(JSON.parse(readFileSync(file, "utf8")).models[0].id).toBe("new");
  });

  it("空の答えは残さず、10 分は試し直さない", async () => {
    const file = dir();
    let t = 0;
    let calls = 0;
    const list = persistentList(async () => (calls++, []), file, () => t);
    expect(await list()).toEqual([]);
    t = 60_000;
    await list();
    expect(calls).toBe(1);
    t = 11 * 60_000;
    await list();
    expect(calls).toBe(2);
  });

  it("壊れたファイル・打てない ID が混ざったファイルは使わない", async () => {
    const file = dir();
    await persistentList(async () => [m("a")], file, () => 0)();
    writeFileSync(file, "{broken");
    expect((await persistentList(async () => [m("x")], file, () => 0)()).map((v) => v.id)).toEqual(["x"]);
    writeFileSync(file, JSON.stringify({ at: 0, models: [{ ...m("x"), id: ["a"] }] }));
    expect((await persistentList(async () => [m("z")], file, () => 0)()).map((v) => v.id)).toEqual(["z"]);
    writeFileSync(file, JSON.stringify({ at: 0, models: [{ ...m("x"), id: "a b" }] }));
    expect((await persistentList(async () => [m("y")], file, () => 0)()).map((v) => v.id)).toEqual(["y"]);
  });
});

describe("Hermes の画面を読む（0.23 の実物）", () => {
  it("待機中だけ打てる", () => {
    expect(hermesInput(IDLE).ready).toBe(true);
    expect(hermesInput(DRAFT).ready).toBe(true);
  });

  it("作業中・承認待ち・知らない画面では打たない", () => {
    expect(hermesInput(WORKING).ready).toBe(false);
    expect(hermesInput(APPROVAL).ready).toBe(false);
    expect(hermesInput("").ready).toBe(false);
    expect(hermesInput("$ ls\nfoo\n").ready).toBe(false);
  });

  it("薄い字の案内は書きかけにしない。ふつうの字は書きかけ", () => {
    expect(hermesHasDraft(IDLE_ANSI)).toBe(false);
    expect(hermesHasDraft(DRAFT_ANSI)).toBe(true);
    expect(hermesHasDraft(IDLE_ANSI.replace(/❯ .*Research[^\n]*/, "❯ "))).toBe(false);
    expect(hermesHasDraft("")).toBe(true);
  });

  it("帯のモデル名", () => {
    expect(hermesCurrentModel(IDLE)).toBe("claude-haiku-4-5");
    expect(hermesCurrentModel(WORKING)).toBe("claude-haiku-4-5");
    expect(hermesCurrentModel("no bar")).toBeNull();
  });

  it("帯に出る形（/ の後ろだけ・26 文字まで）", () => {
    expect(hermesBarName("z-ai/glm-5.1:free")).toBe("glm-5.1:free");
    expect(hermesBarName("a-very-long-model-name-that-keeps-going")).toBe("a-very-long-model-name-...");
    expect(hermesBarName("m.gguf")).toBe("m");
  });
});

describe("Hermes のモデルの切り替え", () => {
  it("いまのモデルを帯から分かる", async () => {
    const { ctx } = pane([IDLE_ANSI]);
    const l = await models.list(ctx);
    expect(l.current).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    expect(l.models).toHaveLength(4);
  });

  it("/model をこの会話だけで打ち、帯で確かめる", async () => {
    const { ctx, sent } = pane([IDLE_ANSI, on("claude-haiku-5-5")]);
    const r = await models.switch(ctx, req);
    expect(r).toEqual({ ok: true, current: { provider: "anthropic", id: "claude-haiku-5-5" }, variant: null, message: null });
    expect(sent).toEqual([
      { method: "pane.send_text", pane_id: "w1:p1", text: "/model claude-haiku-5-5 --provider anthropic --session" },
      { method: "pane.send_keys", pane_id: "w1:p1", keys: ["enter"] },
    ]);
  });

  it("一覧に無いモデルは打たない", async () => {
    const { ctx, sent } = pane([IDLE_ANSI]);
    const r = await models.switch(ctx, { ...req, model: "evil --global" });
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it.each([
    ["作業中", WORKING_ANSI],
    ["承認待ち", APPROVAL],
  ])("%s は打たない（打つと今の作業を止めてしまう）", async (_name, screen) => {
    const { ctx, sent } = pane([screen]);
    const r = await models.switch(ctx, req);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Mac の画面");
    expect(sent).toEqual([]);
  });

  it("書きかけがあるときは打たない", async () => {
    const { ctx, sent } = pane([DRAFT_ANSI]);
    const r = await models.switch(ctx, req);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("書きかけ");
    expect(sent).toEqual([]);
  });

  it("確認の画面が出るなどで帯が変わらなければ、成功と言わない", async () => {
    const { ctx } = pane([IDLE_ANSI]);
    const r = await models.switch(ctx, req);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("確かめられません");
  });

  it("作業が終わった直後でも、打つ直前の画面で書きかけを見る", async () => {
    const { ctx, sent } = pane([DRAFT_ANSI]);
    const r = await models.switch(ctx, req);
    expect(r.message).toContain("書きかけ");
    expect(sent).toEqual([]);
  });

  it("確認の画面には Enter を送らない（先頭の選択肢は「切り替える」）", async () => {
    const { ctx, sent } = pane([IDLE_ANSI, CONFIRM]);
    const r = await models.switch(ctx, req);
    expect(r.ok).toBe(false);
    expect(sent.filter((m) => m.method === "pane.send_keys")).toHaveLength(1);
  });

  it("打てる画面でないときは書きかけと言わない", () => {
    expect(hermesInputFromAnsi(CONFIRM)).toEqual({ ready: false, draft: false });
    expect(hermesInputFromAnsi(IDLE_ANSI)).toEqual({ ready: true, draft: false });
    expect(hermesInputFromAnsi(DRAFT_ANSI)).toEqual({ ready: true, draft: true });
  });

  it("帯で区別できないモデルは、成功と言わず、いまのモデルにもしない", async () => {
    const same = createHermesModels(async () => [
      { provider: "anthropic", id: "claude-haiku-4-5", name: "claude-haiku-4-5", providerName: "Anthropic", variants: [] },
      { provider: "openrouter", id: "anthropic/claude-haiku-4-5", name: "anthropic/claude-haiku-4-5", providerName: "OpenRouter", variants: [] },
    ], tempFile());
    const a = pane([IDLE_ANSI]);
    expect((await same.list(a.ctx)).current).toBeNull();
    const r = await same.switch(a.ctx, { provider: "openrouter", model: "anthropic/claude-haiku-4-5", variant: null });
    expect(r.ok).toBe(false);
    expect(a.sent).toEqual([]);
  });
});
