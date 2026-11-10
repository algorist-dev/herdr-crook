import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { choicesFingerprint } from "../../src/notify/notifier.ts";
import { parseChoices } from "../../src/features/choices.ts";
import { createDefaultProviders } from "../../src/providers/defaults.ts";
import { actionHandlers } from "../../src/session/actions.ts";
import { fakeSession, paneFixture } from "../helpers/fakeSession.ts";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const terminalPane = paneFixture({ paneId: "w1:p2", kind: "terminal", label: "ターミナル", agent: null });

describe("actions：文章を送る", () => {
  it("エージェントには agent.prompt、ターミナルには文字と Enter で送る", async () => {
    const f = fakeSession({ panes: [paneFixture(), terminalPane] });
    await actionHandlers.prompt!(f.ctx, { t: "prompt", pane: "w1:p1", text: "テストを直して" });
    await actionHandlers.prompt!(f.ctx, { t: "prompt", pane: "w1:p2", text: "ls" });
    expect(f.herdrCalls).toEqual([
      { method: "agent.prompt", params: { target: "w1:p1", text: "テストを直して" } },
      { method: "pane.send_text", params: { pane_id: "w1:p2", text: "ls" } },
      { method: "pane.send_keys", params: { pane_id: "w1:p2", keys: ["enter"] } },
    ]);
    expect(f.announced).toEqual([
      { pane: "w1:p1", resized: false },
      { pane: "w1:p2", resized: false },
    ]);
    expect(f.pokes).toBe(2);
  });

  it("Herdr が見分けていないエージェント（Hermes など）には、文字と Enter で送る（agent.prompt は届かない）", async () => {
    const f = fakeSession({ panes: [paneFixture({ paneId: "w1R:p1", agent: "hermes" })], recognized: ["w1R:p1"] });
    await actionHandlers.prompt!(f.ctx, { t: "prompt", pane: "w1R:p1", text: "rm -rf ./scratch" });
    expect(f.herdrCalls).toEqual([
      { method: "pane.send_text", params: { pane_id: "w1R:p1", text: "rm -rf ./scratch" } },
      { method: "pane.send_keys", params: { pane_id: "w1R:p1", keys: ["enter"] } },
    ]);
  });

  it("Herdr が見分けていないエージェントへの複数行は、貼り付けの形で入れてから Enter（途中で送られないように）", async () => {
    const f = fakeSession({ panes: [paneFixture({ paneId: "w1R:p1", agent: "hermes" })], recognized: ["w1R:p1"] });
    await actionHandlers.prompt!(f.ctx, { t: "prompt", pane: "w1R:p1", text: "1 行目\n2 行目" });
    expect(f.herdrCalls).toEqual([
      { method: "pane.send_text", params: { pane_id: "w1R:p1", text: "\x1b[200~1 行目\n2 行目\x1b[201~" } },
      { method: "pane.send_keys", params: { pane_id: "w1R:p1", keys: ["enter"] } },
    ]);
  });

  it("名前を変えるときも、Herdr が見分けていないエージェントは pane.rename", async () => {
    const f = fakeSession({ panes: [paneFixture({ paneId: "w1R:p1", agent: "hermes" })], recognized: ["w1R:p1"] });
    await actionHandlers.paneAction!(f.ctx, { t: "paneAction", pane: "w1R:p1", action: "rename", label: "h" });
    expect(f.herdrCalls).toEqual([{ method: "pane.rename", params: { pane_id: "w1R:p1", label: "h" } }]);
  });

  it("文章の前後の空白は落とす", async () => {
    const f = fakeSession();
    await actionHandlers.prompt!(f.ctx, { t: "prompt", pane: "w1:p1", text: "  直して\n" });
    expect(f.herdrCalls[0]).toEqual({ method: "agent.prompt", params: { target: "w1:p1", text: "直して" } });
  });

  it("画像は保存し、場所を `` で囲んで文章の後ろに付ける", async () => {
    const f = fakeSession();
    await actionHandlers.prompt!(f.ctx, {
      t: "prompt",
      pane: "w1:p1",
      text: "この画面を直して",
      images: [png.toString("base64")],
    });
    const text = String(f.herdrCalls[0]!.params.text);
    expect(text.startsWith("この画面を直して\n\n`")).toBe(true);
    const path = text.split("\n").pop()!.replace(/`/g, "");
    expect(path.startsWith(f.uploadDir)).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(readFileSync(path)).toEqual(png);
  });

  it("画像でないものは保存せずに断る", async () => {
    const f = fakeSession();
    await expect(
      actionHandlers.prompt!(f.ctx, {
        t: "prompt",
        pane: "w1:p1",
        text: "x",
        images: [Buffer.from("#!/bin/sh\nrm -rf /").toString("base64")],
      }),
    ).rejects.toThrow("画像（JPEG・PNG・GIF・WebP）だけ送れます");
    expect(f.herdrCalls).toEqual([]);
  });
});

describe("actions：新しいワークスペース", () => {
  it("フォルダが無ければ、req 付きでわけを返す", async () => {
    const f = fakeSession({ deps: { dirExists: () => false } });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r3", cwd: "/no/such/folder", label: null, agent: null, unattended: false });
    expect(f.sent).toEqual([{ t: "error", req: "r3", message: "Mac にそのフォルダがありません: /no/such/folder" }]);
    expect(f.herdrCalls).toEqual([]);
  });

  it("フォルダがあれば、~ を展開して作り、エージェントを起動して、開くペインを返す", async () => {
    const f = fakeSession({
      herdr: (method) => {
        if (method === "workspace.create") return { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } };
        return {};
      },
    });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r1", cwd: "~/src/api", label: "api 2", agent: "claude", unattended: false });
    expect(f.herdrCalls).toEqual([
      { method: "workspace.create", params: { cwd: join(homedir(), "src/api"), label: "api 2", focus: false } },
      { method: "agent.start", params: { name: "claude", kind: "claude", pane_id: "w9:p1", timeout_ms: 60000 } },
    ]);
    expect(f.sent).toEqual([{ t: "created", req: "r1", workspaceId: "w9", pane: "w9:p1", agentStarted: true }]);
    expect(f.pokes).toBe(1);
  });

  it("エージェントが起動しきれなくても、ワークスペースはできたので開く", async () => {
    const f = fakeSession({
      herdr: (method) => {
        if (method === "workspace.create") return { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } };
        if (method === "agent.start") throw new Error("agent_not_ready");
        return {};
      },
    });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r2", cwd: "/tmp", label: null, agent: "codex", unattended: false });
    expect(f.sent).toEqual([{ t: "created", req: "r2", workspaceId: "w9", pane: "w9:p1", agentStarted: false }]);
  });

  it("ワークスペースを作れなかったら、req 付きでわけを返す", async () => {
    const f = fakeSession({
      herdr: (method) => {
        if (method === "workspace.create") throw new Error("herdr down");
        return {};
      },
    });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r5", cwd: "/tmp", label: null, agent: null, unattended: false });
    expect(f.sent).toEqual([{ t: "error", req: "r5", message: "herdr down" }]);
  });

  it("Herdr がワークスペースを返さなければ、わけを返す", async () => {
    const f = fakeSession();
    await actionHandlers.create!(f.ctx, { t: "create", req: "r6", cwd: "/tmp", label: null, agent: null, unattended: false });
    expect(f.sent).toEqual([{ t: "error", req: "r6", message: "Herdr がワークスペースを作れませんでした" }]);
  });

  it("確認なしなら、エージェントの引数を付けて起動し、印を覚える", async () => {
    const f = fakeSession({
      providers: createDefaultProviders().all(),
      herdr: (method) => {
        if (method === "workspace.create") return { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } };
        return {};
      },
    });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r7", cwd: "/tmp", label: null, agent: "claude", unattended: true });
    expect(f.herdrCalls).toEqual([
      { method: "workspace.create", params: { cwd: "/tmp", focus: false } },
      {
        method: "agent.start",
        params: { name: "claude", kind: "claude", pane_id: "w9:p1", timeout_ms: 60000, args: ["--dangerously-skip-permissions"] },
      },
    ]);
    expect(f.markedUnattended).toEqual(["w9:p1"]);
    expect(f.sent).toEqual([{ t: "created", req: "r7", workspaceId: "w9", pane: "w9:p1", agentStarted: true }]);
  });

  it("確認なしでなければ、args のキーを書かず、印も覚えない", async () => {
    const f = fakeSession({
      providers: createDefaultProviders().all(),
      herdr: (method) => {
        if (method === "workspace.create") return { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } };
        return {};
      },
    });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r8", cwd: "/tmp", label: null, agent: "claude", unattended: false });
    const start = f.herdrCalls.find((c) => c.method === "agent.start");
    expect(start?.params).toEqual({ name: "claude", kind: "claude", pane_id: "w9:p1", timeout_ms: 60000 });
    expect("args" in (start?.params ?? {})).toBe(false);
    expect(f.markedUnattended).toEqual([]);
  });

  it("確認なしに対応していないエージェントなら、ワークスペースを作る前に断る", async () => {
    const f = fakeSession({ providers: createDefaultProviders().all() });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r9", cwd: "/tmp", label: null, agent: "amp", unattended: true });
    expect(f.sent).toEqual([{ t: "error", req: "r9", message: "このエージェントは YOLO モードで起動できません" }]);
    expect(f.herdrCalls).toEqual([]);
  });

  it("エージェントの起動に失敗したら、印を覚えない", async () => {
    const f = fakeSession({
      providers: createDefaultProviders().all(),
      herdr: (method) => {
        if (method === "workspace.create") return { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } };
        if (method === "agent.start") throw new Error("agent_not_ready");
        return {};
      },
    });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r10", cwd: "/tmp", label: null, agent: "claude", unattended: true });
    expect(f.markedUnattended).toEqual([]);
    expect(f.sent).toEqual([{ t: "created", req: "r10", workspaceId: "w9", pane: "w9:p1", agentStarted: false }]);
  });

  it("ターミナルだけなら、確認なしでも印を付けずにふつうに作る", async () => {
    const f = fakeSession({
      providers: createDefaultProviders().all(),
      herdr: (method) => {
        if (method === "workspace.create") return { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } };
        return {};
      },
    });
    await actionHandlers.create!(f.ctx, { t: "create", req: "r11", cwd: "/tmp", label: null, agent: null, unattended: true });
    expect(f.markedUnattended).toEqual([]);
    expect(f.herdrCalls.map((c) => c.method)).toEqual(["workspace.create"]);
    expect(f.sent).toEqual([{ t: "created", req: "r11", workspaceId: "w9", pane: "w9:p1", agentStarted: false }]);
  });
});

describe("actions：新しいタブ", () => {
  it("タブを作り、エージェントを起動して、開くペインを返す", async () => {
    const f = fakeSession({
      herdr: (method) => {
        if (method === "tab.create") return { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p9" } };
        return {};
      },
    });
    await actionHandlers.newTab!(f.ctx, { t: "newTab", req: "t1", workspace: "w1", agent: "codex", unattended: false });
    expect(f.herdrCalls).toEqual([
      { method: "tab.create", params: { workspace_id: "w1", focus: false } },
      { method: "agent.start", params: { name: "codex", kind: "codex", pane_id: "w1:p9", timeout_ms: 60000 } },
    ]);
    expect(f.sent).toEqual([{ t: "created", req: "t1", workspaceId: "w1", pane: "w1:p9", agentStarted: true }]);
  });

  it("タブを作れなかったら、req 付きでわけを返す", async () => {
    const f = fakeSession({
      herdr: (method) => {
        if (method === "tab.create") throw new Error("no workspace");
        return {};
      },
    });
    await actionHandlers.newTab!(f.ctx, { t: "newTab", req: "t2", workspace: "w1", agent: null, unattended: false });
    expect(f.sent).toEqual([{ t: "error", req: "t2", message: "no workspace" }]);
  });

  it("確認なしなら、エージェントの引数を付けて起動し、印を覚える", async () => {
    const f = fakeSession({
      providers: createDefaultProviders().all(),
      herdr: (method) => {
        if (method === "tab.create") return { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p9" } };
        return {};
      },
    });
    await actionHandlers.newTab!(f.ctx, { t: "newTab", req: "t3", workspace: "w1", agent: "codex", unattended: true });
    expect(f.herdrCalls).toEqual([
      { method: "tab.create", params: { workspace_id: "w1", focus: false } },
      {
        method: "agent.start",
        params: { name: "codex", kind: "codex", pane_id: "w1:p9", timeout_ms: 60000, args: ["--dangerously-bypass-approvals-and-sandbox"] },
      },
    ]);
    expect(f.markedUnattended).toEqual(["w1:p9"]);
  });

  it("確認なしでなければ、args のキーを書かず、印も覚えない", async () => {
    const f = fakeSession({
      providers: createDefaultProviders().all(),
      herdr: (method) => {
        if (method === "tab.create") return { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p9" } };
        return {};
      },
    });
    await actionHandlers.newTab!(f.ctx, { t: "newTab", req: "t4", workspace: "w1", agent: "codex", unattended: false });
    const start = f.herdrCalls.find((c) => c.method === "agent.start");
    expect("args" in (start?.params ?? {})).toBe(false);
    expect(f.markedUnattended).toEqual([]);
  });

  it("確認なしに対応していないエージェントなら、タブを作る前に断る", async () => {
    const f = fakeSession({ providers: createDefaultProviders().all() });
    await actionHandlers.newTab!(f.ctx, { t: "newTab", req: "t5", workspace: "w1", agent: "amp", unattended: true });
    expect(f.sent).toEqual([{ t: "error", req: "t5", message: "このエージェントは YOLO モードで起動できません" }]);
    expect(f.herdrCalls).toEqual([]);
  });

  it("エージェントの起動に失敗したら、印を覚えない", async () => {
    const f = fakeSession({
      providers: createDefaultProviders().all(),
      herdr: (method) => {
        if (method === "tab.create") return { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p9" } };
        if (method === "agent.start") throw new Error("agent_not_ready");
        return {};
      },
    });
    await actionHandlers.newTab!(f.ctx, { t: "newTab", req: "t6", workspace: "w1", agent: "codex", unattended: true });
    expect(f.markedUnattended).toEqual([]);
  });
});

describe("actions：タブの操作", () => {
  it("エージェントの名前は agent.rename、ターミナルは pane.rename", async () => {
    const f = fakeSession({ panes: [paneFixture(), terminalPane] });
    await actionHandlers.paneAction!(f.ctx, { t: "paneAction", pane: "w1:p1", action: "rename", label: "レビュー" });
    await actionHandlers.paneAction!(f.ctx, { t: "paneAction", pane: "w1:p2", action: "rename", label: "dev" });
    expect(f.herdrCalls).toEqual([
      { method: "agent.rename", params: { target: "w1:p1", name: "レビュー" } },
      { method: "pane.rename", params: { pane_id: "w1:p2", label: "dev" } },
    ]);
    expect(f.pokes).toBe(2);
  });

  it("clear は pane.clear、close は pane.close を Herdr に頼む", async () => {
    const f = fakeSession({ panes: [paneFixture(), terminalPane] });
    await actionHandlers.paneAction!(f.ctx, { t: "paneAction", pane: "w1:p2", action: "clear", label: null });
    await actionHandlers.paneAction!(f.ctx, { t: "paneAction", pane: "w1:p2", action: "close", label: null });
    expect(f.herdrCalls).toEqual([
      { method: "pane.clear", params: { pane_id: "w1:p2" } },
      { method: "pane.close", params: { pane_id: "w1:p2" } },
    ]);
  });

  it("開いているターミナルを閉じるときは、先にターミナルも閉じる", async () => {
    const f = fakeSession({ panes: [paneFixture(), terminalPane] });
    f.ctx.terminal.currentPane = () => "w1:p2";
    await actionHandlers.paneAction!(f.ctx, { t: "paneAction", pane: "w1:p2", action: "close", label: null });
    expect(f.terminalCalls).toEqual(["close:explicit"]);
    expect(f.herdrCalls).toEqual([{ method: "pane.close", params: { pane_id: "w1:p2" } }]);
  });

  it("開いていないペインを閉じても、ターミナルは閉じない", async () => {
    const f = fakeSession({ panes: [paneFixture(), terminalPane] });
    f.ctx.terminal.currentPane = () => "w1:p1";
    await actionHandlers.paneAction!(f.ctx, { t: "paneAction", pane: "w1:p2", action: "close", label: null });
    expect(f.terminalCalls).toEqual([]);
  });
});

describe("actions：ターミナルに画像を貼る", () => {
  it("空白を含む場所は ' で囲み、最後に空白を付ける。Enter は送らない", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "hm-attach-")), "with space");
    const f = fakeSession({ services: { uploadDir: () => dir } });
    await actionHandlers.attach!(f.ctx, { t: "attach", pane: "w1:p2", images: [png.toString("base64")] });
    const text = String(f.herdrCalls[0]!.params.text);
    expect(text.startsWith(`'${dir}/iphone-`)).toBe(true);
    expect(text.endsWith(".png' ")).toBe(true);
    expect(f.herdrCalls).toHaveLength(1);
    expect(f.herdrCalls[0]!.method).toBe("pane.send_text");
    expect(f.announced).toEqual([{ pane: "w1:p2", resized: false }]);
  });
});

describe("actions：キーを送る", () => {
  it("pane.send_keys で送り、一覧を読み直す", async () => {
    const f = fakeSession();
    await actionHandlers.keys!(f.ctx, { t: "keys", pane: "w1:p1", keys: ["esc"] });
    expect(f.herdrCalls).toEqual([{ method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["esc"] } }]);
    expect(f.announced).toEqual([{ pane: "w1:p1", resized: false }]);
    expect(f.pokes).toBe(1);
  });
});

describe("actions：通知からの返事", () => {
  const screen = " Do you want to proceed?\n ❯ 1. Yes\n   2. No (esc)\n";

  it("画面の選択肢が変わっていたら押さずに、アプリで確かめるよう返す", async () => {
    const f = fakeSession({ screen });
    await actionHandlers.answer!(f.ctx, { t: "answer", pane: "w1:p1", key: "1", expect: "0000000000000000" });
    expect(f.sent).toEqual([
      { t: "error", message: "Mac の画面がもう変わっていたので、選びませんでした。画面を見て選び直してください" },
    ]);
    expect(f.herdrCalls.some((c) => c.method === "pane.send_keys")).toBe(false);
  });

  it("同じ質問のままなら、その選択肢のキーを送る", async () => {
    const f = fakeSession({ screen });
    const expectNow = choicesFingerprint(parseChoices(screen)!);
    await actionHandlers.answer!(f.ctx, { t: "answer", pane: "w1:p1", key: "2", expect: expectNow });
    expect(f.herdrCalls.filter((c) => c.method === "pane.send_keys")).toEqual([
      { method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["2"] } },
    ]);
    expect(f.announced).toEqual([{ pane: "w1:p1", resized: false }]);
    expect(f.pokes).toBe(1);
  });

  it("横に並ぶ許可の選択肢は、option のキーの並びで押す", async () => {
    const horizontal = [
      " △ Permission required",
      " # Shell command",
      " $ npm test",
      "   Allow once     Allow always     Reject",
    ].join("\n");
    const f = fakeSession({ screen: horizontal });
    const expectNow = choicesFingerprint(parseChoices(horizontal)!);
    await actionHandlers.answer!(f.ctx, { t: "answer", pane: "w1:p1", key: "2", expect: expectNow });
    expect(f.herdrCalls.find((c) => c.method === "pane.send_keys")?.params).toEqual({
      pane_id: "w1:p1",
      keys: ["right", "enter"],
    });
  });

  it("見えている画面に無ければ、少し前まで広げて探す", async () => {
    const f = fakeSession({ screen: "" });
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const origRequest = f.ctx.services.deps.herdr.request;
    f.ctx.services.deps.herdr.request = async (method, params) => {
      calls.push({ method, params });
      if (method === "pane.read" && params.source === "recent") return { read: { text: screen } };
      return origRequest(method, params);
    };
    const expectNow = choicesFingerprint(parseChoices(screen)!);
    await actionHandlers.answer!(f.ctx, { t: "answer", pane: "w1:p1", key: "1", expect: expectNow });
    expect(calls.filter((c) => c.method === "pane.read").map((c) => c.params.source)).toEqual(["visible", "recent"]);
    expect(f.herdrCalls.find((c) => c.method === "pane.send_keys")?.params).toEqual({ pane_id: "w1:p1", keys: ["1"] });
  });
});
