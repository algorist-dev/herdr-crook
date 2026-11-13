// shared/protocol の見本で、Mac 側のやりとりの形を見張る。
// client は「読める・見本に書いたキーは同じ値・読み直しても同じ」、
// server は「型で書いたものと見本が同じ」を確かめる。
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "../src/protocol/messages.ts";
import { parseClientMessage } from "../src/protocol/parse.ts";
import { CLIENT_PARSERS } from "../src/protocol/parse.ts";

const root = join(import.meta.dirname, "..", "..", "shared", "protocol");
// 見本はアプリと同じリポジトリにだけある（公開しているプラグインだけのリポジトリでは見ない）
const hasFixtures = existsSync(root);
const files = (dir: string) => (hasFixtures ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".json")) : []);
const typeOf = (name: string) => name.replace(/\.json$/, "").split("-")[0]!;

const serverMessages: Record<string, ServerMessage> = {
  welcome: {
    t: "welcome",
    machine: "Mac mini",
    protocol: 1,
    herdr: true,
    agents: ["claude", "codex", "opencode"],
    push: true,
    unattended: ["claude", "codex", "opencode"],
  },
  "welcome-pushRoom": {
    t: "welcome",
    machine: "Mac mini",
    protocol: 1,
    herdr: true,
    agents: ["claude", "codex", "opencode"],
    push: true,
    unattended: ["claude", "codex", "opencode"],
    pushRoom: "Rm0123456789abcdefghij",
  },
  "welcome-plugin": {
    t: "welcome",
    machine: "Mac mini",
    protocol: 1,
    herdr: true,
    agents: ["claude", "codex", "opencode"],
    push: true,
    unattended: ["claude", "codex", "opencode"],
    plugin: "1.2.0",
  },
  "welcome-theme": {
    t: "welcome",
    machine: "Mac mini",
    protocol: 1,
    herdr: true,
    agents: ["claude", "codex", "opencode"],
    push: true,
    unattended: ["claude", "codex", "opencode"],
    theme: {
      name: "tokyo-night",
      autoSwitch: true,
      darkName: "dracula",
      lightName: "one-light",
      custom: { accent: "#ff0000" },
      customDark: { red: "#aa0000" },
      customLight: { red: "#bb0000" },
    },
  },
  paired: { t: "paired", token: "tok_0123456789abcdef", machine: "Mac mini" },
  denied: { t: "denied", reason: "invalid_token" },
  panes: {
    t: "panes",
    panes: [
      {
        paneId: "w1:p1",
        kind: "agent",
        label: "claude",
        agent: "claude",
        status: "blocked",
        title: "テストを直す",
        workspace: "api",
        workspaceNumber: 1,
        tab: "1",
        folder: "api",
        cwd: "/repo/api",
        focused: false,
        stateChangeSeq: 3,
        workspaceId: "w1",
        cols: 120,
        rows: 40,
        since: 1794000000000,
        chatId: "sess-1",
        chatTitle: "認証を直す",
        caps: { chat: true, models: true },
        unattended: true,
      },
      {
        paneId: "w1:p2",
        kind: "terminal",
        label: "ターミナル",
        agent: null,
        status: "unknown",
        title: "zsh",
        workspace: "api",
        workspaceNumber: 1,
        tab: "1",
        folder: "api",
        cwd: "/repo/api",
        focused: true,
        stateChangeSeq: 0,
        workspaceId: "w1",
        cols: 120,
        rows: 40,
        since: null,
        chatId: null,
        chatTitle: null,
        caps: { chat: false, models: false },
        unattended: false,
      },
    ],
    herdr: true,
  },
  frame: { t: "frame", seq: 7, full: true, cols: 40, rows: 30, b64: "G1sySmhp" },
  closed: { t: "closed", reason: "pane closed" },
  error: { t: "error", message: "そのペインはもうありません" },
  "error-req": { t: "error", message: "Mac にそのフォルダがありません: ~/nope", req: "req-1" },
  created: { t: "created", req: "req-1", workspaceId: "w9", pane: "w9:p1", agentStarted: true },
  choices: {
    t: "choices",
    pane: "w1:p1",
    question: "Do you want to proceed?",
    options: [
      { key: "1", label: "Yes", detail: null },
      { key: "2", label: "No", detail: "やめる", keys: ["down", "enter"] },
    ],
    selected: "1",
  },
  chat: {
    t: "chat",
    pane: "w1:p1",
    available: true,
    reset: true,
    title: "認証を直す",
    items: [
      { id: "u1", role: "user", kind: "text", text: "テストを直して" },
      { id: "a2:0", role: "assistant", kind: "tool", text: "テストを動かす", tool: "Bash" },
    ],
  },
  commands: {
    t: "commands",
    pane: "w1:p1",
    agent: "claude",
    commands: [
      { name: "clear", summary: "会話を消して新しく始める", kind: "command" },
      { name: "review", summary: "変更を見てもらう", kind: "skill" },
    ],
  },
  files: {
    t: "files",
    pane: "w1:p1",
    query: "src/rel",
    files: ["src/relay.ts", "src/relay-server.ts"],
  },
  usage: {
    t: "usage",
    pane: "w1:p1",
    usage: {
      model: "claude-opus-4-5",
      provider: "anthropic",
      contextUsed: 84000,
      contextLimit: 200000,
      contextPercent: 42,
      tokens: { input: 1200, output: 3400, cacheRead: 80000, cacheWrite: 2000, reasoning: 0 },
      cost: 1.25,
      limits: [
        { label: "5h", usedPercent: 30, resetsAt: 1794010000000, windowMinutes: 300 },
        { label: "7d", usedPercent: 12, resetsAt: null, windowMinutes: 10080 },
      ],
      source: "claude-statusline",
      pane: "w1:p1",
      agent: "claude",
      updatedAt: 1794000000000,
    },
  },
  "usage-null": { t: "usage", pane: "w1:p1", usage: null },
  models: {
    t: "models",
    pane: "w1:p1",
    agent: "claude",
    current: { provider: "claude", id: "opus" },
    variant: "high",
    recent: [],
    models: [
      {
        provider: "claude",
        id: "default",
        name: "おすすめ（既定）",
        providerName: "Claude",
        variants: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        provider: "claude",
        id: "opus",
        name: "Opus",
        providerName: "Claude",
        variants: ["low", "medium", "high", "xhigh", "max"],
      },
    ],
  },
  toolDetail: {
    t: "toolDetail",
    pane: "w1:p1",
    item: "a2:0",
    detail: {
      running: false,
      error: false,
      sections: [
        { label: "コマンド", style: "code", text: "npm test", truncated: false },
        { label: "出力", style: "code", text: "ok", truncated: false },
      ],
    },
  },
  modelSet: {
    t: "modelSet",
    pane: "w1:p1",
    ok: false,
    current: null,
    variant: null,
    message: "作業中は切り替えられません。終わってから切り替えてください",
  },
  away: { t: "away", away: true },
  pushTested: { t: "pushTested", ok: false, message: "Mac に Apple 通知の鍵がありません" },
  pong: { t: "pong" },
};

describe.skipIf(!hasFixtures)("やりとりの見本（client）", () => {
  it.each(files("client"))("%s は Mac が受け付け、読み直しても同じ", (name) => {
    const text = readFileSync(join(root, "client", name), "utf8");
    const sample = JSON.parse(text) as Record<string, unknown>;
    const parsed = parseClientMessage(text);
    expect(parsed).not.toBeNull();
    // 見本に書いたキーは、読んだあとも同じ値（省略したキーは Mac が null などで埋める）
    expect(parsed).toMatchObject(sample);
    expect(parseClientMessage(JSON.stringify(parsed))).toEqual(parsed);
  });

  it("ClientMessage の全種類に見本がある", () => {
    const inFixtures = new Set(files("client").map(typeOf));
    expect([...inFixtures].sort()).toEqual(Object.keys(CLIENT_PARSERS).sort());
  });
});

describe.skipIf(!hasFixtures)("やりとりの見本（server）", () => {
  it.each(files("server"))("%s は型で書いたものと同じ", (name) => {
    const expected = serverMessages[name.replace(/\.json$/, "")];
    expect(expected).toBeDefined();
    const sample = JSON.parse(readFileSync(join(root, "server", name), "utf8")) as unknown;
    expect(expected).toEqual(sample);
  });

  it("ServerMessage の見本に足りない・余分なファイルがない", () => {
    expect(Object.keys(serverMessages).sort()).toEqual(files("server").map((f) => f.replace(/\.json$/, "")).sort());
  });
});
