import { choicesFingerprint } from "../src/notify/notifier.ts";
import { parseChoices } from "../src/features/choices.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PairingStore } from "../src/pairing/pairing.ts";
import { startRelay, type Relay, type RelayDeps } from "../src/relay.ts";
import type { ChatItem } from "../src/providers/shared/transcript.ts";
import type { WatchState } from "../src/herdr/paneWatcher.ts";
import type { Terminal, TerminalHandlers } from "../src/herdr/terminalSession.ts";
import { waitFor } from "./herdrClient.test.ts";
import { clientChannelForTest, keyPairFromSecret, type Channel } from "../src/net/e2ee.ts";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createDefaultProviders } from "../src/providers/defaults.ts";
import type { AgentModel } from "../src/providers/types.ts";
import type { TranscriptUsage } from "../src/features/usage.ts";

class FakeWatcher extends EventEmitter {
  state: WatchState = {
    herdr: true,
    panes: [
      { paneId: "w1:p1", kind: "agent", label: "claude", agent: "claude", status: "blocked", title: null, workspace: "api", workspaceNumber: 1, tab: "1", folder: "api", cwd: "/repo/api", focused: false, stateChangeSeq: 1, workspaceId: "w1", cols: 120, rows: 40, since: null, chatId: "sess-1", chatTitle: null, caps: { chat: true, models: true }, unattended: false },
      { paneId: "w1:p2", kind: "terminal", label: "ターミナル", agent: null, status: "unknown", title: "zsh", workspace: "api", workspaceNumber: 1, tab: "1", folder: "api", cwd: "/repo/api", focused: false, stateChangeSeq: 0, workspaceId: "w1", cols: 120, rows: 40, since: null, chatId: null, chatTitle: null, caps: { chat: false, models: false }, unattended: false },
    ],
  };
  current() {
    return this.state;
  }
  kindOf(pane: string) {
    return this.state.panes.find((p) => p.paneId === pane)?.kind ?? null;
  }
  poke() {}
  markUnattended(_paneId: string) {}
  set(state: WatchState) {
    this.state = state;
    this.emit("change", state);
  }
}

interface Opened {
  pane: string;
  observe: boolean;
  cols: number;
  rows: number;
  handlers: TerminalHandlers;
  inputs: string[];
  resizes: [number, number][];
  closed: boolean;
}

let relay: Relay | null = null;
let deps: RelayDeps;
let store: PairingStore;
let watcher: FakeWatcher;
let opened: Opened[];
let herdrCalls: { method: string; params: Record<string, unknown> }[];
let allowPeer: boolean;
let promptError: Error | null;
let transcriptPath: string;
let notices: { title: string; body: string }[];
let agentStartError: Error | null;
let uploadDir: string;
let paneScreen: string;
let findTranscript: (chatId: string) => string | null;
let claudeDefaultEffort: () => string | null;
let claudeStatusline: (sessionId: string) => Record<string, unknown> | null;
let openCodeReader: ((dir: string) => { title: string | null; items: ChatItem[]; usage?: TranscriptUsage | null } | null) | null;
let openCodeModels: { list(): Promise<AgentModel[]>; recent(): { provider: string; id: string }[] } | null;
let openCodeModelInfo: ((provider: string, id: string) => { name?: string | null; contextLimit?: number | null } | null) | null;

beforeEach(() => {
  store = new PairingStore(join(mkdtempSync(join(tmpdir(), "hm-relay-")), "devices.json"));
  watcher = new FakeWatcher();
  opened = [];
  herdrCalls = [];
  allowPeer = true;
  promptError = null;
  notices = [];
  paneScreen = "";
  agentStartError = null;
  uploadDir = mkdtempSync(join(tmpdir(), "hm-up-"));
  transcriptPath = join(mkdtempSync(join(tmpdir(), "hm-chat-")), "sess-1.jsonl");
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: "ai-title", aiTitle: "認証を直す" }) + "\n" + JSON.stringify({ type: "user", uuid: "u1", message: { content: "直して" } }) + "\n",
  );
  findTranscript = (id) => (id === "sess-1" ? transcriptPath : null);
  claudeDefaultEffort = () => null;
  claudeStatusline = () => null;
  openCodeReader = null;
  openCodeModels = null;
  openCodeModelInfo = null;
  deps = {
    store,
    watcher,
    herdr: {
      request: async (method: string, params: Record<string, unknown>) => {
        herdrCalls.push({ method, params });
        if (method === "agent.prompt" && promptError) throw promptError;
        if (method === "tab.create") return { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p9" } };
        if (method === "pane.read") return { read: { text: paneScreen } };
        if (method === "workspace.create") return { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } };
        if (method === "agent.start" && agentStartError) throw agentStartError;
        return {};
      },
    },
    openTerminal: (pane, cols, rows, handlers, observe): Terminal => {
      const o: Opened = { pane, observe, cols, rows, handlers, inputs: [], resizes: [], closed: false };
      opened.push(o);
      return {
        input: (b) => o.inputs.push(b),
        resize: (c, r) => o.resizes.push([c, r]),
        scroll: () => {},
        close: () => (o.closed = true),
      };
    },
    isAllowedPeer: async () => allowPeer,
    machine: "Mac mini",
    checkDevicesMs: 30,
    restoreGraceMs: 150,
    notify: (title: string, body: string) => notices.push({ title, body }),
    uploadDir: () => uploadDir,
    dirExists: (path: string) => path !== "/no/such/folder",
    chatPollMs: 30,
    agents: () => ["claude", "opencode"],
    providers: createDefaultProviders({
      claude: {
        findTranscript: (id) => findTranscript(id),
        defaultEffort: () => claudeDefaultEffort(),
        statusline: (id) => claudeStatusline(id),
      },
      codex: {
        findRollout: (dir) => findTranscript(`codex:${dir}`),
        models: () => [],
        defaultEffort: () => null,
      },
      opencode: {
        store: {
          read: (dir) => {
            const chat = openCodeReader?.(dir) ?? null;
            return chat ? { title: chat.title, items: chat.items, usage: chat.usage ?? undefined } : null;
          },
          title: () => null,
        },
        models: { list: async () => (await openCodeModels?.list()) ?? [], recent: () => openCodeModels?.recent() ?? [] },
        modelInfo: (provider, id) => openCodeModelInfo?.(provider, id) ?? null,
      },
      copilot: {
        find: (dir) => {
          const path = findTranscript(`copilot:${dir}`);
          return path ? { path, title: null } : null;
        },
      },
    }),
  };
});

afterEach(async () => {
  await relay?.close();
  relay = null;
});

const macKey = keyPairFromSecret(Buffer.alloc(32, 7));

/** 暗号化してつなぐ（同じ Wi-Fi・中継サーバーのとき） */
async function connectSealed(listen: { requireSeal?: boolean; checkPeer?: boolean } = {}, key = macKey.publicKey) {
  deps.keyPair = macKey;
  relay = relay ?? (await startRelay(deps, [{ host: "127.0.0.1", port: 0, ...listen }]));
  const ws = new WebSocket(`ws://127.0.0.1:${relay.ports[0]}/`);
  const { clientPub, client } = clientChannelForTest(key, Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)));
  const messages: Record<string, unknown>[] = [];
  let unreadable = 0;
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      messages.push({ plaintext: JSON.parse(data.toString()) });
      return;
    }
    const text = client.open(Buffer.from(data as Buffer));
    if (text === null) unreadable++;
    else messages.push(JSON.parse(text));
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  ws.send(JSON.stringify({ t: "seal", pk: clientPub.toString("base64") }));
  const sendSealed = (m: unknown) => ws.send(client.seal(JSON.stringify(m)));
  return { ws, messages, sendSealed, client: client as Channel, unreadable: () => unreadable };
}

async function connect(headers: Record<string, string> = {}): Promise<{ ws: WebSocket; messages: Record<string, unknown>[] }> {
  relay = relay ?? (await startRelay(deps, [{ host: "127.0.0.1", port: 0 }]));
  const ws = new WebSocket(`ws://127.0.0.1:${relay.ports[0]}/`, { headers });
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  return { ws, messages };
}

async function pairedClient() {
  const c = await connect();
  c.ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" }));
  await waitFor(() => c.messages.some((m) => m.t === "panes"));
  return c;
}

describe("relay", () => {
  it("合言葉でペアリングすると鍵と一覧がもらえる", async () => {
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" }));
    await waitFor(() => messages.some((m) => m.t === "panes"));
    const paired = messages.find((m) => m.t === "paired");
    expect(paired?.machine).toBe("Mac mini");
    expect(typeof paired?.token).toBe("string");
    expect(messages.find((m) => m.t === "panes")?.panes).toHaveLength(2);
    ws.close();
  });

  it("つながったら、Mac に入っているエージェントも知らせる", async () => {
    const { messages } = await pairedClient();
    expect(messages.find((m) => m.t === "welcome")).toMatchObject({ agents: ["claude", "opencode"] });
  });

  it("確認なしで立ち上げられるのは、エージェントのうち引数があるものだけ", async () => {
    deps.agents = () => ["claude", "opencode", "amp"];
    const { messages } = await pairedClient();
    expect(messages.find((m) => m.t === "welcome")).toMatchObject({
      agents: ["claude", "opencode", "amp"],
      unattended: ["claude", "opencode"],
    });
  });

  it("中継サーバーから送れるときは welcome で部屋を教え、封をした宛先をしまう", async () => {
    deps.pushReady = () => true;
    deps.pushRoom = () => "Rm0123456789abcdefghij";
    const { ws, messages } = await pairedClient();
    expect(messages.find((m) => m.t === "welcome")).toMatchObject({ push: true, pushRoom: "Rm0123456789abcdefghij" });
    const token = "ab".repeat(32);
    const sealed = "A".repeat(120);
    ws.send(JSON.stringify({ t: "push", token, env: "production", sealed }));
    await waitFor(() => store.pushTargets().length === 1);
    expect(store.pushTargets()[0]).toMatchObject({ token, env: "production", sealed });
  });

  it("中継サーバーから送れないときは welcome に部屋を入れない", async () => {
    const { messages } = await pairedClient();
    expect(messages.find((m) => m.t === "welcome")).not.toHaveProperty("pushRoom");
  });

  it("通知の宛先を受け取ってしまい、つながっている間は「開いている端末」として数える", async () => {
    const present = new Set<string>();
    deps.presence = { add: (id) => present.add(id), remove: (id) => present.delete(id) };
    deps.pushReady = () => true;
    const { ws, messages } = await pairedClient();
    expect(messages.find((m) => m.t === "welcome")).toMatchObject({ push: true });
    const token = "ab".repeat(32);
    ws.send(JSON.stringify({ t: "push", token, env: "sandbox" }));
    await waitFor(() => store.pushTargets().length === 1);
    expect(store.pushTargets()[0]).toMatchObject({ token, env: "sandbox" });
    expect(present.size).toBe(1);
    ws.close();
    await waitFor(() => present.size === 0);
  });

  it("次からは鍵でつながる", async () => {
    const first = await pairedClient();
    const token = first.messages.find((m) => m.t === "paired")?.token as string;
    first.ws.close();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ t: "hello", token }));
    await waitFor(() => messages.some((m) => m.t === "welcome"));
    expect(messages.find((m) => m.t === "welcome")).toMatchObject({ machine: "Mac mini", herdr: true });
    ws.close();
  });

  it("違う合言葉や鍵では断って切る", async () => {
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ t: "hello", token: "nope" }));
    await new Promise((r) => ws.once("close", r));
    expect(messages).toEqual([{ t: "denied", reason: "invalid_token" }]);
  });

  it("つながる前に他の操作をしても何もしない", async () => {
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 40, rows: 20, mode: "fit" }));
    await new Promise((r) => ws.once("close", r));
    expect(opened).toHaveLength(0);
    expect(messages[0]).toEqual({ t: "denied", reason: "invalid_token" });
  });

  it("Tailscale で別のアカウントの端末なら断る", async () => {
    allowPeer = false;
    const { ws, messages } = await connect();
    await new Promise((r) => ws.once("close", r));
    expect(messages).toEqual([{ t: "denied", reason: "not_same_tailnet_user" }]);
  });

  it("何度も間違えたら、しばらく断る", async () => {
    for (let i = 0; i < 10; i++) {
      const { ws } = await connect();
      ws.send(JSON.stringify({ t: "pair", code: "wrong", device: "x" }));
      await new Promise((r) => ws.once("close", r));
    }
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "x" }));
    await new Promise((r) => ws.once("close", r));
    expect(messages).toEqual([{ t: "denied", reason: "too_many_attempts" }]);
  });

  it("つながっている最中に端末を消したら、その接続を切る", async () => {
    const { ws, messages } = await pairedClient();
    const device = store.listDevices()[0]!;
    store.revoke(device.id);
    await new Promise((r) => ws.once("close", r));
    expect(messages.at(-1)).toEqual({ t: "denied", reason: "invalid_token" });
  });

  it("ブラウザのページから（Origin 付きで）つないできたら断る", async () => {
    const relayNow = relay ?? (await startRelay(deps, [{ host: "127.0.0.1", port: 0 }]));
    relay = relayNow;
    const ws = new WebSocket(`ws://127.0.0.1:${relayNow.ports[0]}/`, { headers: { Origin: "https://evil.example" } });
    const err = await new Promise((r) => ws.once("error", r));
    expect(err).toBeTruthy();
  });

  it("相手を確かめている間に切れたら、合言葉を使わない", async () => {
    let release: (ok: boolean) => void = () => {};
    deps.isAllowedPeer = () => new Promise((r) => (release = r));
    const code = store.createPairingCode();
    const { ws } = await connect();
    ws.send(JSON.stringify({ t: "pair", code, device: "x" }));
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    release(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.listDevices()).toHaveLength(0);
  });

  it("一覧が変わったら送る", async () => {
    const { ws, messages } = await pairedClient();
    watcher.set({ herdr: false, panes: [] });
    await waitFor(() => messages.filter((m) => m.t === "panes").length === 2);
    expect(messages.at(-1)).toEqual({ t: "panes", panes: [], herdr: false });
    ws.close();
  });

  it("ターミナルを開いて、画面を受け取り、キーを送る", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "fit" }));
    await waitFor(() => opened.length === 1);
    expect(opened[0]).toMatchObject({ pane: "w1:p1", cols: 44, rows: 30 });
    opened[0]!.handlers.onFrame({ seq: 1, full: true, cols: 44, rows: 30, b64: "aGk=" });
    await waitFor(() => messages.some((m) => m.t === "frame"));
    expect(messages.find((m) => m.t === "frame")).toEqual({ t: "frame", seq: 1, full: true, cols: 44, rows: 30, b64: "aGk=" });
    ws.send(JSON.stringify({ t: "input", b64: "DQ==" }));
    ws.send(JSON.stringify({ t: "resize", cols: 50, rows: 20 }));
    await waitFor(() => opened[0]!.resizes.length === 1);
    expect(opened[0]!.inputs).toEqual(["DQ=="]);
    ws.close();
  });

  it("別のペインを開くと前のは閉じる。切れたら閉じる", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "mirror" }));
    ws.send(JSON.stringify({ t: "open", pane: "w1:p2", cols: 44, rows: 30, mode: "mirror" }));
    const mirrors = () => opened.filter((o) => o.observe);
    await waitFor(() => mirrors().length === 2);
    expect(mirrors()[0]!.closed).toBe(true);
    ws.close();
    await waitFor(() => mirrors()[1]!.closed);
  });

  it("Herdr 側でペインが閉じたら知らせる", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "mirror" }));
    await waitFor(() => opened.length === 1);
    opened[0]!.handlers.onClosed("pane_closed");
    await waitFor(() => messages.some((m) => m.t === "closed"));
    expect(messages.find((m) => m.t === "closed")).toEqual({ t: "closed", reason: "pane_closed" });
    ws.close();
  });

  it("Mac と同じ表示（mirror）は observe で開き、キーは Herdr の API で送る", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p2", cols: 120, rows: 40, mode: "mirror" }));
    await waitFor(() => opened.some((o) => o.observe));
    const mirror = opened.find((o) => o.observe)!;
    expect(mirror).toMatchObject({ pane: "w1:p2", observe: true, cols: 120, rows: 40 });
    ws.send(JSON.stringify({ t: "input", b64: Buffer.from("ls\r").toString("base64") }));
    await waitFor(() => herdrCalls.length === 2);
    expect(herdrCalls).toEqual([
      { method: "pane.send_text", params: { pane_id: "w1:p2", text: "ls" } },
      { method: "pane.send_keys", params: { pane_id: "w1:p2", keys: ["enter"] } },
    ]);
    expect(mirror.inputs).toEqual([]);
    ws.close();
  });

  it("スマホに合わせる表示（fit）を閉じたら、ペインを元の大きさに戻す", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "fit" }));
    await waitFor(() => opened.length === 1);
    expect(opened[0]!.observe).toBe(false);
    ws.send(JSON.stringify({ t: "close" }));
    await waitFor(() => opened.length === 2);
    // 元の大きさ（一覧の 120×40）で制御を取り直し、すぐ返す
    expect(opened[1]).toMatchObject({ pane: "w1:p1", observe: false, cols: 120, rows: 40 });
    await waitFor(() => opened[1]!.closed);
    ws.close();
  });

  it("スマホ表示のまま接続が切れたら、少し待ってから元の大きさに戻す", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "fit" }));
    await waitFor(() => opened.some((o) => !o.observe && o.cols === 44));
    ws.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(opened.some((o) => o.cols === 120)).toBe(false);
    await waitFor(() => opened.some((o) => !o.observe && o.cols === 120 && o.rows === 40));
  });

  it("待っている間に同じペインをスマホ表示で開き直したら、戻さない", async () => {
    const first = await pairedClient();
    const token = first.messages.find((m) => m.t === "paired")?.token as string;
    first.ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "fit" }));
    await waitFor(() => opened.some((o) => o.cols === 44));
    first.ws.close();
    const again = await connect();
    again.ws.send(JSON.stringify({ t: "hello", token }));
    await waitFor(() => again.messages.some((m) => m.t === "welcome"));
    again.ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "fit" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(opened.some((o) => o.cols === 120)).toBe(false);
    again.ws.close();
  });

  it("中継を止めるときは、スマホ表示のペインをすぐ元に戻す", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "fit" }));
    await waitFor(() => opened.some((o) => o.cols === 44));
    await relay!.close();
    relay = null;
    expect(opened.some((o) => !o.observe && o.cols === 120 && o.rows === 40)).toBe(true);
  });

  it("スマホ表示で開いたら、Mac に「スマホから操作中」と知らせる", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "open", pane: "w1:p2", cols: 44, rows: 30, mode: "fit" }));
    await waitFor(() => notices.length === 1);
    expect(notices[0]).toEqual({ title: "スマホから操作中", body: "api のターミナル（スマホの幅にしています。離れると元に戻ります）" });
    ws.close();
  });

  it("スマホから操作を始めたら、Mac に「スマホから操作中」と知らせる（同じペインは続けて出さない）", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "a" }));
    ws.send(JSON.stringify({ t: "keys", pane: "w1:p1", keys: ["esc"] }));
    ws.send(JSON.stringify({ t: "prompt", pane: "w1:p2", text: "ls" }));
    await waitFor(() => herdrCalls.length === 4);
    await new Promise((r) => setTimeout(r, 30));
    expect(notices).toEqual([
      { title: "スマホから操作中", body: "api のエージェント（claude）" },
      { title: "スマホから操作中", body: "api のターミナル" },
    ]);
    ws.close();
  });

  it("新しいワークスペースを作り、エージェントを起動して、開くペインを返す", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "create", req: "r1", cwd: "~/src/api", label: "api 2", agent: "claude" }));
    await waitFor(() => messages.some((m) => m.t === "created"));
    expect(herdrCalls).toEqual([
      { method: "workspace.create", params: { cwd: join(homedir(), "src/api"), label: "api 2", focus: false } },
      { method: "agent.start", params: { name: "claude", kind: "claude", pane_id: "w9:p1", timeout_ms: 60000 } },
    ]);
    expect(messages.find((m) => m.t === "created")).toEqual({ t: "created", req: "r1", workspaceId: "w9", pane: "w9:p1", agentStarted: true });
    ws.close();
  });

  it("エージェントが起動しきれなくても、ワークスペースはできたので開く", async () => {
    agentStartError = new Error("agent_not_ready");
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "create", req: "r2", cwd: "/tmp", agent: "codex" }));
    await waitFor(() => messages.some((m) => m.t === "created"));
    expect(messages.find((m) => m.t === "created")).toMatchObject({ req: "r2", pane: "w9:p1", agentStarted: false });
    ws.close();
  });

  it("フォルダが無ければ作らずにわけを返す", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "create", req: "r3", cwd: "/no/such/folder" }));
    await waitFor(() => messages.some((m) => m.t === "error"));
    expect(messages.find((m) => m.t === "error")).toEqual({ t: "error", req: "r3", message: "Mac にそのフォルダがありません: /no/such/folder" });
    expect(herdrCalls).toEqual([]);
    ws.close();
  });

  it("画像付きの文章は、画像を Mac に保存し、その場所を添えて送る", async () => {
    const { ws } = await pairedClient();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    ws.send(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "この画面を直して", images: [png.toString("base64")] }));
    await waitFor(() => herdrCalls.length === 1);
    const text = String(herdrCalls[0]!.params.text);
    const path = text.split("\n").pop()!.replace(/`/g, "");
    expect(text.startsWith("この画面を直して\n\n")).toBe(true);
    expect(path.startsWith(uploadDir)).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(readFileSync(path)).toEqual(png);
    ws.close();
  });

  it("形の合わない「新しいワークスペース」には req 付きでわけを返す", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "create", req: "r4", cwd: "src/api" }));
    await waitFor(() => messages.some((m) => m.t === "error"));
    expect(messages.find((m) => m.t === "error")).toMatchObject({ req: "r4" });
    ws.close();
  });

  it("確かめる前の大きなメッセージは断って切る", async () => {
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ t: "hello", token: "x".repeat(5000) }));
    await waitFor(() => messages.some((m) => m.t === "denied"));
  });

  it("Mac の鍵で暗号化してペアリングでき、返事も暗号で届く", async () => {
    const c = await connectSealed();
    c.sendSealed({ t: "pair", code: store.createPairingCode(), device: "iPhone" });
    await waitFor(() => c.messages.some((m) => m.t === "panes"));
    expect(c.messages.some((m) => m.t === "paired")).toBe(true);
    expect(c.messages.some((m) => "plaintext" in m)).toBe(false);
    c.ws.close();
  });

  it("同じ Wi-Fi 側（requireSeal）では、暗号化していない相手は断る", async () => {
    deps.keyPair = macKey;
    relay = await startRelay(deps, [{ host: "127.0.0.1", port: 0, requireSeal: true, checkPeer: false }]);
    const { ws, messages } = await connect();
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" }));
    expect(await closed).toBe(4002);
    expect(messages.some((m) => m.t === "paired")).toBe(false);
  });

  it("同じ Wi-Fi 側では Tailscale の相手確認はしない（合言葉と鍵で確かめる）", async () => {
    allowPeer = false;
    const c = await connectSealed({ requireSeal: true, checkPeer: false });
    c.sendSealed({ t: "pair", code: store.createPairingCode(), device: "iPhone" });
    await waitFor(() => c.messages.some((m) => m.t === "paired"));
    c.ws.close();
  });

  it("違う Mac の鍵で暗号化してきた相手には、読める返事を返さない", async () => {
    const other = keyPairFromSecret(Buffer.alloc(32, 8));
    const c = await connectSealed({}, other.publicKey);
    const closed = new Promise<void>((r) => c.ws.once("close", () => r()));
    c.sendSealed({ t: "pair", code: store.createPairingCode(), device: "iPhone" });
    await closed;
    expect(c.messages.some((m) => m.t === "paired")).toBe(false);
  });

  it("暗号化したあとに暗号化していないものが来たら切る", async () => {
    const c = await connectSealed();
    const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
    c.ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" }));
    expect(await closed).toBe(4002);
  });

  it("ワークスペースに新しいタブを作り、エージェントを起動して、開くペインを返す", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "newTab", req: "t1", workspace: "w1", agent: "codex" }));
    await waitFor(() => messages.some((m) => m.t === "created"));
    expect(herdrCalls).toEqual([
      { method: "tab.create", params: { workspace_id: "w1", focus: false } },
      { method: "agent.start", params: { name: "codex", kind: "codex", pane_id: "w1:p9", timeout_ms: 60000 } },
    ]);
    expect(messages.find((m) => m.t === "created")).toEqual({ t: "created", req: "t1", workspaceId: "w1", pane: "w1:p9", agentStarted: true });
    ws.close();
  });

  it("通知からの返事（answer）は、同じ質問のままのときだけキーを送る", async () => {
    paneScreen = " Do you want to proceed?\n ❯ 1. Yes\n   2. No (esc)\n";
    const expectNow = choicesFingerprint(parseChoices(paneScreen)!);
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "answer", pane: "w1:p1", key: "1", expect: "0000000000000000" }));
    await waitFor(() => messages.some((m) => m.t === "error"));
    expect(herdrCalls.some((c) => c.method === "pane.send_keys")).toBe(false);
    ws.send(JSON.stringify({ t: "answer", pane: "w1:p1", key: "1", expect: expectNow }));
    await waitFor(() => herdrCalls.some((c) => c.method === "pane.send_keys"));
    expect(herdrCalls.find((c) => c.method === "pane.send_keys")?.params).toEqual({ pane_id: "w1:p1", keys: ["1"] });
  });

  it("横に並ぶ許可の通知からは、右に動かしてから Enter で選ぶ", async () => {
    paneScreen = [
      " △ Permission required",
      " # Shell command",
      " $ npm test",
      "   Allow once     Allow always     Reject",
    ].join("\n");
    const expectNow = choicesFingerprint(parseChoices(paneScreen)!);
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "answer", pane: "w1:p1", key: "2", expect: expectNow }));
    await waitFor(() => herdrCalls.some((c) => c.method === "pane.send_keys"));
    expect(herdrCalls.find((c) => c.method === "pane.send_keys")?.params).toEqual({ pane_id: "w1:p1", keys: ["right", "enter"] });
  });

  it("Claude のモデルと考える量は /model と /effort を送り、次に一覧を頼むとそれが出る", async () => {
    deps.openCodeWait = async () => {};
    claudeDefaultEffort = () => "xhigh";
    const inputBox = "\n" + "─".repeat(40) + "\n❯ \n" + "─".repeat(40) + "\n  ◐ medium · /effort";
    paneScreen = "hello" + inputBox;
    // /model を送ったら、Claude が「Set model to …」と出す
    const request = deps.herdr.request;
    deps.herdr = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "agent.prompt" && String(params.text).startsWith("/model ")) paneScreen = "⎿  Set model to Sonnet 5.5" + inputBox;
        if (method === "agent.prompt" && String(params.text).startsWith("/effort ")) paneScreen = paneScreen.replace(/\S \w+ · \/effort/, `● ${String(params.text).slice(8)} · /effort`);
        return request(method, params);
      },
    };
    watcher.set({ ...watcher.state, panes: watcher.state.panes.map((p) => (p.paneId === "w1:p1" ? { ...p, status: "idle" } : p)) });
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "models", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "models"));
    // 考える量は Claude の画面（◐ medium · /effort）から
    expect(messages.find((m) => m.t === "models")).toMatchObject({ agent: "claude", variant: "medium" });
    ws.send(JSON.stringify({ t: "setModel", pane: "w1:p1", provider: "claude", model: "sonnet", variant: "high" }));
    await waitFor(() => messages.some((m) => m.t === "modelSet"));
    expect(messages.find((m) => m.t === "modelSet")).toMatchObject({ ok: true, current: { provider: "claude", id: "sonnet" }, variant: "high" });
    expect(herdrCalls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text)).toEqual(["/model sonnet", "/effort high"]);
    ws.send(JSON.stringify({ t: "models", pane: "w1:p1" }));
    await waitFor(() => messages.filter((m) => m.t === "models").length === 2);
    expect(messages.filter((m) => m.t === "models")[1]).toMatchObject({ current: { provider: "claude", id: "sonnet" }, variant: "high" });
  });

  it("返事待ちのタブのモデルは切り替えない（何も送らない）", async () => {
    openCodeModels = { list: async () => [{ provider: "opencode-go", id: "kimi-k3", name: "Kimi K3", providerName: "OpenCode Go", variants: [] }], recent: () => [] };
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "setModel", pane: "w1:p1", provider: "opencode-go", model: "kimi-k3" }));
    await waitFor(() => messages.some((m) => m.t === "modelSet"));
    expect(messages.find((m) => m.t === "modelSet")).toMatchObject({ ok: false });
    expect(herdrCalls.some((c) => c.method === "pane.send_keys")).toBe(false);
  });

  it("その場だけのつながり（once）は「開いている端末」に数えない（次の通知を止めない）", async () => {
    const present = new Set<string>();
    deps.presence = { add: (id) => present.add(id), remove: (id) => present.delete(id) };
    const first = await pairedClient();
    const token = first.messages.find((m) => m.t === "paired")?.token as string;
    first.ws.close();
    await waitFor(() => present.size === 0);
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ t: "hello", token, once: true }));
    await waitFor(() => messages.some((m) => m.t === "welcome"));
    expect(present.size).toBe(0);
    ws.close();
  });

  it("会話を見ているペインが返事待ちなら、画面から選択肢を読んで送る", async () => {
    paneScreen = " Do you want to proceed?\n ❯ 1. Yes\n   2. No (esc)\n";
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "choices"));
    expect(messages.find((m) => m.t === "choices")).toEqual({
      t: "choices",
      pane: "w1:p1",
      question: "Do you want to proceed?",
      options: [
        { key: "1", label: "Yes", detail: null },
        { key: "2", label: "No (esc)", detail: null },
      ],
      selected: "1",
    });
    expect(herdrCalls.find((c) => c.method === "pane.read")?.params).toMatchObject({ pane_id: "w1:p1", source: "visible" });
    // 返事待ちでなくなったら、空の選択肢を送る
    watcher.set({ ...watcher.state, panes: watcher.state.panes.map((p) => (p.paneId === "w1:p1" ? { ...p, status: "working" } : p)) });
    await waitFor(() => messages.filter((m) => m.t === "choices").length === 2);
    expect(messages.filter((m) => m.t === "choices")[1]).toMatchObject({ options: [] });
    ws.close();
  });

  it("ターミナルに画像を貼ると、保存した場所を文字で送り、Enter は押さない", async () => {
    const { ws } = await pairedClient();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    ws.send(JSON.stringify({ t: "attach", pane: "w1:p2", images: [png.toString("base64")] }));
    await waitFor(() => herdrCalls.length === 1);
    expect(herdrCalls[0]!.method).toBe("pane.send_text");
    const text = String(herdrCalls[0]!.params.text);
    expect(text.startsWith(uploadDir)).toBe(true);
    expect(text.endsWith(".png ")).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(herdrCalls.some((c) => c.method === "pane.send_keys")).toBe(false);
    ws.close();
  });

  it("タブの操作：エージェントの名前は agent.rename、ターミナルは pane.rename。消す・閉じるも Herdr に頼む", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "paneAction", pane: "w1:p1", action: "rename", label: "レビュー" }));
    ws.send(JSON.stringify({ t: "paneAction", pane: "w1:p2", action: "rename", label: "dev" }));
    ws.send(JSON.stringify({ t: "paneAction", pane: "w1:p2", action: "clear" }));
    ws.send(JSON.stringify({ t: "paneAction", pane: "w1:p2", action: "close" }));
    await waitFor(() => herdrCalls.length === 4);
    expect(herdrCalls).toEqual([
      { method: "agent.rename", params: { target: "w1:p1", name: "レビュー" } },
      { method: "pane.rename", params: { pane_id: "w1:p2", label: "dev" } },
      { method: "pane.clear", params: { pane_id: "w1:p2" } },
      { method: "pane.close", params: { pane_id: "w1:p2" } },
    ]);
    ws.close();
  });

  it("画像でないものは保存せずに断る", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "x", images: [Buffer.from("#!/bin/sh\nrm -rf /").toString("base64")] }));
    await waitFor(() => messages.some((m) => m.t === "error"));
    expect(String(messages.find((m) => m.t === "error")?.message)).toContain("画像");
    expect(herdrCalls).toEqual([]);
    ws.close();
  });

  it("会話を見ると、題名とこれまでの会話が届き、増えたら続きが届く", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "chat"));
    expect(messages.find((m) => m.t === "chat")).toEqual({
      t: "chat",
      pane: "w1:p1",
      available: true,
      reset: true,
      title: "認証を直す",
      items: [{ id: "u1", role: "user", kind: "text", text: "直して" }],
    });
    appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "はい" }] } }) + "\n");
    await waitFor(() => messages.filter((m) => m.t === "chat").length === 2);
    expect(messages.filter((m) => m.t === "chat")[1]).toMatchObject({ reset: false, items: [{ id: "a1:0", text: "はい" }] });
    ws.close();
  });

  it("会話が切り替わったら（/clear など）、新しい記録を最初から送り直す", async () => {
    const nextPath = join(mkdtempSync(join(tmpdir(), "hm-chat-")), "sess-2.jsonl");
    writeFileSync(
      nextPath,
      JSON.stringify({ type: "ai-title", aiTitle: "新しい会話" }) + "\n" + JSON.stringify({ type: "user", uuid: "u2", message: { content: "もう一度" } }) + "\n",
    );
    findTranscript = (id) => (id === "sess-1" ? transcriptPath : id === "sess-2" ? nextPath : null);
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "chat"));
    watcher.set({ ...watcher.state, panes: watcher.state.panes.map((p) => (p.paneId === "w1:p1" ? { ...p, chatId: "sess-2" } : p)) });
    await waitFor(() => messages.filter((m) => m.t === "chat").length === 2);
    expect(messages.filter((m) => m.t === "chat")[1]).toEqual({
      t: "chat",
      pane: "w1:p1",
      available: true,
      reset: true,
      title: "新しい会話",
      items: [{ id: "u2", role: "user", kind: "text", text: "もう一度" }],
    });
    ws.close();
  });

  it("「/」に出すコマンドは、Mac の組み込みとファイルから集めて送る", async () => {
    deps.slashCommands = (agent, cwd) => {
      expect(agent).toBe("claude");
      expect(cwd).toBe("/repo/api");
      return [
        { name: "clear", summary: "会話を消す", kind: "command" },
        { name: "deploy", summary: "本番に出す", kind: "command" },
      ];
    };
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "commands", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "commands"));
    expect(messages.find((m) => m.t === "commands")).toEqual({
      t: "commands",
      pane: "w1:p1",
      agent: "claude",
      commands: [
        { name: "clear", summary: "会話を消す", kind: "command" },
        { name: "deploy", summary: "本番に出す", kind: "command" },
      ],
    });
    ws.close();
  });

  it("会話を開くと、使用量（コンテキストとトークン）も届く", async () => {
    const usagePath = join(mkdtempSync(join(tmpdir(), "hm-usage-")), "sess-usage.jsonl");
    writeFileSync(
      usagePath,
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "はい" }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
        },
      }) + "\n",
    );
    findTranscript = (id) => (id === "sess-1" ? usagePath : null);
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "usage"));
    expect(messages.find((m) => m.t === "usage")).toEqual({
      t: "usage",
      pane: "w1:p1",
      usage: {
        pane: "w1:p1",
        agent: "claude",
        model: "claude-opus-5-5",
        provider: null,
        contextUsed: 1152,
        contextLimit: null,
        contextPercent: null,
        tokens: { input: 2, output: 50, cacheRead: 1000, cacheWrite: 100, reasoning: 0 },
        cost: null,
        limits: [],
        source: "claude",
        updatedAt: expect.any(Number),
      },
    });
    ws.send(JSON.stringify({ t: "usage", pane: "w1:p1" }));
    await waitFor(() => messages.filter((m) => m.t === "usage").length === 2);
    expect(messages.filter((m) => m.t === "usage")[1]).toMatchObject({ t: "usage", pane: "w1:p1", usage: { source: "claude" } });
    ws.close();
  });

  it("Claude の statusline があれば、正確なコンテキスト%・5h/7d を重ねる", async () => {
    const usagePath = join(mkdtempSync(join(tmpdir(), "hm-usage-")), "sess-usage.jsonl");
    writeFileSync(
      usagePath,
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "はい" }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
        },
      }) + "\n",
    );
    findTranscript = (id) => (id === "sess-1" ? usagePath : null);
    claudeStatusline = (id) =>
      id === "sess-1"
        ? {
            model: { display_name: "Opus 5.5" },
            context_window: { used_percentage: 42.5, context_window_size: 200000 },
            rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1796597802 } },
            cost: { total_cost_usd: 1.25 },
          }
        : null;
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "usage"));
    expect(messages.find((m) => m.t === "usage")).toMatchObject({
      t: "usage",
      pane: "w1:p1",
      usage: {
        agent: "claude",
        model: "Opus 5.5",
        contextUsed: 85000,
        contextLimit: 200000,
        contextPercent: 42.5,
        cost: 1.25,
        limits: [{ label: "5h", usedPercent: 23.5, resetsAt: 1796597802000, windowMinutes: 300 }],
        source: "claude-statusline",
        tokens: { input: 2, output: 50, cacheRead: 1000, cacheWrite: 100, reasoning: 0 },
      },
    });
    ws.close();
  });

  it("OpenCode の使用量は、モデルの一覧の上限からコンテキスト % を出す", async () => {
    watcher.state = {
      ...watcher.state,
      panes: watcher.state.panes.map((p) => (p.paneId === "w1:p1" ? { ...p, agent: "opencode", chatId: "opencode:/repo/api" } : p)),
    };
    openCodeReader = () => ({
      title: "直す",
      items: [],
      usage: {
        model: "deepseek-v4.1-flash",
        provider: "opencode-go",
        contextUsed: 230000,
        contextLimit: null,
        contextPercent: null,
        tokens: { input: 1000, output: 200, cacheRead: 228700, cacheWrite: 0, reasoning: 100 },
        cost: 0.14,
        limits: [],
        source: "opencode",
      },
    });
    openCodeModelInfo = (provider, id) =>
      provider === "opencode-go" && id === "deepseek-v4.1-flash" ? { name: "DeepSeek V4.1 Flash", contextLimit: 1_000_000 } : null;
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "usage"));
    expect(messages.find((m) => m.t === "usage")).toMatchObject({
      t: "usage",
      pane: "w1:p1",
      usage: {
        agent: "opencode",
        model: "DeepSeek V4.1 Flash",
        contextUsed: 230000,
        contextLimit: 1000000,
        contextPercent: 23,
        cost: 0.14,
        source: "opencode",
      },
    });
    ws.close();
  });

  it("「@」に出すファイルの候補は、ペインの作業フォルダから探して送る", async () => {
    deps.listFiles = (cwd, query) => {
      expect(cwd).toBe("/repo/api");
      expect(query).toBe("src/ap");
      return ["src/app.ts", "src/api.ts"];
    };
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "files", pane: "w1:p1", query: "src/ap" }));
    await waitFor(() => messages.some((m) => m.t === "files"));
    expect(messages.find((m) => m.t === "files")).toEqual({
      t: "files",
      pane: "w1:p1",
      query: "src/ap",
      files: ["src/app.ts", "src/api.ts"],
    });
    ws.close();
  });

  it("会話の記録があとからできたら、そこから読み始める（起動したばかりの Claude）", async () => {
    const { ws, messages } = await pairedClient();
    watcher.state = { ...watcher.state, panes: watcher.state.panes.map((p) => (p.paneId === "w1:p1" ? { ...p, chatId: null } : p)) };
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p1" }));
    await waitFor(() => messages.some((m) => m.t === "chat"));
    expect(messages.find((m) => m.t === "chat")).toMatchObject({ available: false });
    watcher.state = { ...watcher.state, panes: watcher.state.panes.map((p) => (p.paneId === "w1:p1" ? { ...p, chatId: "sess-1" } : p)) };
    await waitFor(() => messages.some((m) => m.t === "chat" && m.available === true));
    expect(messages.find((m) => m.t === "chat" && m.available === true)).toMatchObject({ reset: true, title: "認証を直す" });
    ws.close();
  });

  it("OpenCode の会話も読み、返事が書きかわったら全部送り直す", async () => {
    let items: ChatItem[] = [{ id: "p1", role: "user", kind: "text", text: "直して" }];
    openCodeReader = (dir: string) => (dir === "/repo/app" ? { title: "ログイン", items } : null);
    watcher.state = {
      ...watcher.state,
      panes: [...watcher.state.panes, { ...watcher.state.panes[0]!, paneId: "w1:p7", agent: "opencode", chatId: "opencode:/repo/app" }],
    };
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p7" }));
    await waitFor(() => messages.some((m) => m.t === "chat"));
    expect(messages.find((m) => m.t === "chat")).toEqual({ t: "chat", pane: "w1:p7", available: true, reset: true, title: "ログイン", items });
    // 返事が流れてきて、同じ id の文が伸びる
    items = [...items, { id: "p2", role: "assistant", kind: "text", text: "はい" }];
    await waitFor(() => messages.filter((m) => m.t === "chat").length === 2);
    items = [items[0]!, { id: "p2", role: "assistant", kind: "text", text: "はい、直しました" }];
    await waitFor(() => messages.filter((m) => m.t === "chat").length === 3);
    expect(messages.filter((m) => m.t === "chat")[2]).toMatchObject({ reset: true, items: [{ id: "p1" }, { id: "p2", text: "はい、直しました" }] });
    ws.close();
  });

  it("会話の記録がないペインなら available: false", async () => {
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "chat", pane: "w1:p2" }));
    await waitFor(() => messages.some((m) => m.t === "chat"));
    expect(messages.find((m) => m.t === "chat")).toEqual({ t: "chat", pane: "w1:p2", available: false, reset: true, title: null, items: [] });
    ws.close();
  });

  it("文章は、エージェントには agent.prompt、ターミナルには文字と Enter で送る", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "テストを直して" }));
    ws.send(JSON.stringify({ t: "prompt", pane: "w1:p2", text: "ls" }));
    await waitFor(() => herdrCalls.length === 3);
    expect(herdrCalls).toEqual([
      { method: "agent.prompt", params: { target: "w1:p1", text: "テストを直して" } },
      { method: "pane.send_text", params: { pane_id: "w1:p2", text: "ls" } },
      { method: "pane.send_keys", params: { pane_id: "w1:p2", keys: ["enter"] } },
    ]);
    ws.close();
  });

  it("返事待ちのエージェントに文章を送れなかったら、わけを返す", async () => {
    const { HerdrError } = await import("../src/herdr/herdrClient.ts");
    promptError = new HerdrError("agent_blocked", "agent is blocked");
    const { ws, messages } = await pairedClient();
    ws.send(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "hi" }));
    await waitFor(() => messages.some((m) => m.t === "error"));
    expect(String(messages.find((m) => m.t === "error")?.message)).toContain("返事待ち");
    ws.close();
  });

  it("キーを送る", async () => {
    const { ws } = await pairedClient();
    ws.send(JSON.stringify({ t: "keys", pane: "w1:p1", keys: ["esc"] }));
    await waitFor(() => herdrCalls.length === 1);
    expect(herdrCalls[0]).toEqual({ method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["esc"] } });
    ws.close();
  });
});
