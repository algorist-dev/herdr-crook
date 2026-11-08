// Herdr のペインとエージェントの一覧を見張り、変わったら "change" を出す。
// イベントは「読み直しのきっかけ」にだけ使い、中身はいつも session.snapshot から作る
// （Herdr のドキュメントがすすめるやり方。取りこぼしがあっても一覧はずれない）。
import { EventEmitter } from "node:events";
import { summarize, type PaneSummary } from "./agents.ts";
import type { HerdrClient, HerdrEvent } from "./herdrClient.ts";
import { defaultProviders } from "../providers/defaults.ts";
import type { ProviderRegistry } from "../providers/registry.ts";

export interface WatchState {
  herdr: boolean;
  panes: PaneSummary[];
}

const GLOBAL_EVENTS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
].map((type) => ({ type }));

type ClientLike = Pick<HerdrClient, "request" | "subscribe">;

export class PaneWatcher extends EventEmitter {
  private state: WatchState = { herdr: false, panes: [] };
  private lastJson = "";
  private subscription: { close(): void } | null = null;
  private subscribedPanes = "";
  private subscribing = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private again = false;
  private stopped = true;

  private readonly client: ClientLike;
  private readonly providers: ProviderRegistry;
  private readonly opts: {
    pollMs: number;
    debounceMs: number;
    now?: () => number;
  };
  /** ペインごとの「いまの状態」と「その状態になった時刻」 */
  private readonly statusSince = new Map<string, { status: string; since: number }>();
  /** 確認なしで立ち上げたペイン（ファイルには残さない。中継を再起動すると消える） */
  private readonly unattended = new Set<string>();

  constructor(
    client: ClientLike,
    opts: {
      pollMs: number;
      debounceMs: number;
      now?: () => number;
      /** エージェントごとの読み方。省略すると既定のプロバイダ */
      providers?: ProviderRegistry;
    } = { pollMs: 5000, debounceMs: 120 },
  ) {
    super();
    this.client = client;
    this.providers = opts.providers ?? defaultProviders();
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), this.opts.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.subscription?.close();
    this.subscription = null;
  }

  current(): WatchState {
    return this.state;
  }

  /** ペインがエージェントかどうか（文章の送り方を変えるため） */
  kindOf(paneId: string): "agent" | "terminal" | null {
    return this.state.panes.find((p) => p.paneId === paneId)?.kind ?? null;
  }

  /** すぐ読み直す（スマホから操作したあとなど） */
  poke(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(), this.opts.debounceMs);
  }

  /** 確認なしで立ち上げたペインとして覚える（一覧から消えると忘れる） */
  markUnattended(paneId: string): void {
    this.unattended.add(paneId);
    this.poke();
  }

  private refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    if (this.stopped) return;
    let next: WatchState;
    try {
      const result = (await this.client.request("session.snapshot", {})) as { snapshot?: object };
      const now = (this.opts.now ?? Date.now)();
      // まず状態だけ読んで時刻を更新し、その時刻を入れて作り直す
      const chatKeyOf = (record: Parameters<ProviderRegistry["chatKey"]>[0], cwd: string | null) =>
        this.providers.chatKey(record, cwd);
      const capsOf = (agent: string | null, chatId: string | null) => ({
        chat: chatId !== null || this.providers.get(agent)?.chat !== undefined,
        models: this.providers.get(agent)?.models !== undefined,
      });
      const seen = new Set<string>();
      for (const pane of summarize(result.snapshot ?? {}, undefined, undefined, chatKeyOf, capsOf)) {
        seen.add(pane.paneId);
        const prev = this.statusSince.get(pane.paneId);
        if (!prev || prev.status !== pane.status) this.statusSince.set(pane.paneId, { status: pane.status, since: now });
      }
      for (const id of [...this.statusSince.keys()]) if (!seen.has(id)) this.statusSince.delete(id);
      next = {
        herdr: true,
        panes: summarize(
          result.snapshot ?? {},
          (id) => this.statusSince.get(id)?.since ?? null,
          (chatId, agent) => this.chatTitle(chatId, agent),
          chatKeyOf,
          capsOf,
        ),
      };
    } catch {
      next = { herdr: false, panes: [] };
      this.subscription?.close();
      this.subscription = null;
      this.subscribedPanes = "";
    }
    // Herdr が止まっている間（一覧が読めない）は印を残す。読めたときだけ写して、消えたものを忘れる
    if (next.herdr) this.applyUnattended(next.panes);
    if (this.stopped) return;
    this.publish(next);
    if (next.herdr) void this.ensureSubscription(next.panes);
  }

  /** 印を一覧に写し、消えたペイン・エージェントでなくなったペインの印は忘れる */
  private applyUnattended(panes: PaneSummary[]): void {
    const seen = new Set(panes.map((p) => p.paneId));
    for (const id of [...this.unattended]) if (!seen.has(id)) this.unattended.delete(id);
    for (const pane of panes) {
      const marked = this.unattended.has(pane.paneId);
      if (marked && pane.kind !== "agent") this.unattended.delete(pane.paneId);
      pane.unattended = marked && pane.kind === "agent";
    }
  }

  private chatTitle(chatId: string, agent: string | null): string | null {
    return this.providers.title(agent, chatId);
  }

  private publish(next: WatchState): void {
    const json = JSON.stringify(next);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.state = next;
    this.emit("change", next);
  }

  private async ensureSubscription(panes: PaneSummary[]): Promise<void> {
    const ids = panes.map((p) => p.paneId).sort().join(",");
    if (this.subscribing || (this.subscription && ids === this.subscribedPanes)) return;
    this.subscribing = true;
    try {
      const subs = [...GLOBAL_EVENTS, ...panes.map((p) => ({ type: "pane.agent_status_changed", pane_id: p.paneId }))];
      const next = await this.client.subscribe(
        subs,
        (_e: HerdrEvent) => this.poke(),
        () => {
          if (this.subscription === next) {
            this.subscription = null;
            this.subscribedPanes = "";
          }
          this.poke();
        },
      );
      if (this.stopped) {
        next.close();
        return;
      }
      this.subscription?.close();
      this.subscription = next;
      this.subscribedPanes = ids;
    } catch {
      // ペインが途中で消えると購読ごと断られる。次の読み直しでやり直す
      this.poke();
    } finally {
      this.subscribing = false;
    }
  }
}
