// session/ のハンドラを、本物の WebSocket や Herdr なしで試すための偽物。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneSummary } from "../../src/herdr/agents.ts";
import type { ServerMessage } from "../../src/protocol/messages.ts";
import type { RelayDeps, WatcherLike } from "../../src/relay.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import type { AgentProvider } from "../../src/providers/types.ts";
import type { WatchState } from "../../src/herdr/paneWatcher.ts";
import type { ChatController, PaneSize, RelayServices, RestoreManager, SessionContext, TerminalController } from "../../src/session/types.ts";

/** 一覧の 1 件。足りないところは決まった値で埋める */
export function paneFixture(over: Partial<PaneSummary> = {}): PaneSummary {
  return {
    paneId: "w1:p1", kind: "agent", label: "claude", agent: "claude", status: "idle", title: null,
    workspace: "api", workspaceNumber: 1, tab: "1", folder: "api", cwd: "/repo/api", focused: false,
    stateChangeSeq: 1, workspaceId: "w1", cols: 120, rows: 40, since: null, chatId: null, chatTitle: null,
    caps: { chat: false, models: false }, unattended: false,
    ...over,
  };
}

export interface FakeSessionOptions {
  panes?: PaneSummary[];
  /** pane.read が返す文字 */
  screen?: string;
  /** Herdr への頼みごとに返すもの（なければ {}） */
  herdr?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  providers?: AgentProvider[];
  /** Herdr が見分けず、こちらで見分けたエージェントのペイン（kindOf が recognized を返す） */
  recognized?: string[];
  /** RelayDeps の一部を差しかえる（uploadDir・dirExists・slashCommands・listFiles・notify・openCodeWait は services にも効く） */
  deps?: Partial<RelayDeps>;
  /** services の一部を差しかえる（いちばん強い） */
  services?: Partial<RelayServices>;
}

export type RestoreCall =
  | { op: "restoreNow" | "schedule"; pane: string; size: PaneSize }
  | { op: "take"; pane: string }
  | { op: "shutdown" };

export interface FakeSession {
  ctx: SessionContext;
  sent: ServerMessage[];
  herdrCalls: { method: string; params: Record<string, unknown> }[];
  notices: { title: string; body: string }[];
  announced: { pane: string; resized: boolean }[];
  pokes: number;
  setPanes(panes: PaneSummary[]): void;
  setScreen(text: string): void;
  /** terminal・chat は呼ばれたことを覚えるだけの偽物。差しかえてもよい */
  terminalCalls: string[];
  chatCalls: string[];
  /** watcher.markUnattended が呼ばれたペイン */
  markedUnattended: string[];
  /** services.restores が呼ばれた記録（take はいつも null を返す） */
  restoreCalls: RestoreCall[];
  /** watcher の "change" を出す（welcome のあとの panes など） */
  emitChange(): void;
  /** 画像を置く一時フォルダ（テストごとに別） */
  uploadDir: string;
}

export function fakeSession(opts: FakeSessionOptions = {}): FakeSession {
  let panes = opts.panes ?? [paneFixture()];
  let screen = opts.screen ?? "";
  const sent: ServerMessage[] = [];
  const herdrCalls: FakeSession["herdrCalls"] = [];
  const notices: FakeSession["notices"] = [];
  const announced: FakeSession["announced"] = [];
  const terminalCalls: string[] = [];
  const chatCalls: string[] = [];

  const herdr = {
    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
      herdrCalls.push({ method, params });
      const answer = opts.herdr ? await opts.herdr(method, params) : undefined;
      // pane.read は、opts.herdr が何も返さなければ setScreen の文字
      if (answer === undefined && method === "pane.read") return { read: { text: screen } };
      return answer ?? {};
    },
  };

  const listeners = new Set<(state: WatchState) => void>();
  const markedUnattended: string[] = [];
  const ownWatcher: WatcherLike = {
    current: () => ({ herdr: true, panes }),
    kindOf: (id) => {
      const kind = panes.find((p) => p.paneId === id)?.kind ?? null;
      return kind === "agent" && opts.recognized?.includes(id) ? "recognized" : kind;
    },
    poke: () => {
      fake.pokes++;
    },
    markUnattended: (paneId) => void markedUnattended.push(paneId),
    on: (_event, fn) => void listeners.add(fn),
    off: (_event, fn) => void listeners.delete(fn),
  };

  const providers = new ProviderRegistry(opts.providers ?? []);

  const deps: RelayDeps = {
    store: {
      redeem: () => ({ ok: false, reason: "invalid_code" }),
      verify: () => null,
      isActive: () => true,
      markSeen: () => {},
    },
    watcher: ownWatcher,
    herdr,
    openTerminal: () => ({ input() {}, resize() {}, scroll() {}, close() {} }),
    isAllowedPeer: async () => true,
    machine: "Mac",
    agents: () => ["claude"],
    providers,
    ...opts.deps,
  };

  // ctx.pane などは、差しかえた watcher があればそれを見る（一覧がずれないように）
  const watcher = deps.watcher;
  const uploadDir = mkdtempSync(join(tmpdir(), "hm-fake-uploads-"));

  const restoreCalls: RestoreCall[] = [];
  const restores: RestoreManager = {
    restoreNow: (pane, size) => void restoreCalls.push({ op: "restoreNow", pane, size }),
    schedule: (pane, size) => void restoreCalls.push({ op: "schedule", pane, size }),
    take: (pane) => (restoreCalls.push({ op: "take", pane }), null),
    shutdown: () => void restoreCalls.push({ op: "shutdown" }),
  };

  const services: RelayServices = {
    deps,
    providers,
    restores,
    modelSwitching: new Set(),
    notify: deps.notify ?? ((title, body) => void notices.push({ title, body })),
    uploadDir: deps.uploadDir ?? (() => uploadDir),
    dirExists: deps.dirExists ?? (() => true),
    slashCommands: deps.slashCommands ?? (() => []),
    listFiles: deps.listFiles ?? (() => []),
    wait: deps.openCodeWait ?? (async () => {}),
    log: deps.log ?? (() => {}),
    ...opts.services,
  };

  const terminal: TerminalController = {
    open: () => void terminalCalls.push("open"),
    input: () => void terminalCalls.push("input"),
    resize: () => void terminalCalls.push("resize"),
    scroll: () => void terminalCalls.push("scroll"),
    close: (why) => void terminalCalls.push(`close:${why}`),
    currentPane: () => null,
  };

  const chat: ChatController = {
    start: () => void chatCalls.push("start"),
    stop: () => void chatCalls.push("stop"),
    lastUsage: () => null,
    sendCommands: () => void chatCalls.push("sendCommands"),
    sendFiles: () => void chatCalls.push("sendFiles"),
  };

  const ctx: SessionContext = {
    services,
    deviceId: "device-1",
    send: (msg) => void sent.push(msg),
    pane: (id) => watcher.current().panes.find((p) => p.paneId === id),
    kindOf: (id) => watcher.kindOf(id),
    poke: () => watcher.poke(),
    announce: (pane, resized = false) => void announced.push({ pane, resized }),
    async readScreen(paneId, lines = 80) {
      const r = (await herdr.request("pane.read", { pane_id: paneId, source: "visible", lines })) as { read?: { text?: unknown } } | null;
      return typeof r?.read?.text === "string" ? r.read.text : "";
    },
    terminal,
    chat,
  };

  const fake: FakeSession = {
    ctx,
    sent,
    herdrCalls,
    notices,
    announced,
    pokes: 0,
    setPanes: (next) => void (panes = next),
    setScreen: (text) => void (screen = text),
    terminalCalls,
    chatCalls,
    markedUnattended,
    restoreCalls,
    emitChange: () => {
      const state = watcher.current();
      for (const fn of [...listeners]) fn(state);
    },
    uploadDir,
  };
  return fake;
}
