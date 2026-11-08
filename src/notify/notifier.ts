// エージェントが返事待ちになった・終わったときに、裏にいる iPhone へ知らせる（Orca のモバイルと同じ考え方）。
// 一覧の変わり目だけを見る。アプリを開いて Mac につながっている端末には送らない（アプリが自分で出す）。
import type { PaneSummary } from "../herdr/agents.ts";
import { createHash } from "node:crypto";
import { pushPayload, type PushPayload } from "./apns.ts";
import { DEFAULT_PREFS, inQuietHours, shouldNotify, shouldSound, type NotificationPrefs } from "./prefs.ts";
import { isAway } from "./away.ts";
import type { Choices } from "../features/choices.ts";
import { localize } from "../i18n/index.ts";

/**
 * 通知を長押ししたときに出すボタンの組（iPhone の Notifications.swift と名前をそろえる）。
 * ボタンの文字は iPhone 側で決まっているので、選択肢の中身は本文に書く。
 */
export type ReplyCategory = "hm.permission" | "hm.choices2" | "hm.choices3" | "hm.reply";

export function replyCategory(kind: AttentionKind, choices: Choices | null): ReplyCategory {
  if (kind !== "needs-input" || !choices || choices.options.length < 2) return "hm.reply";
  const o = choices.options;
  // Claude Code の許可の確認：1. Yes / 2. Yes, … / 3. No, …
  if (o.length === 3 && /^yes\b/i.test(o[0]!.label) && /^yes\b/i.test(o[1]!.label) && /^no\b/i.test(o[2]!.label)) return "hm.permission";
  return o.length === 2 ? "hm.choices2" : "hm.choices3";
}

/** 質問の印（聞かれていることと選択肢から。カーソルの位置は入れない）。古い通知のボタンで別の質問に答えないため */
export function choicesFingerprint(choices: Choices): string {
  const text = JSON.stringify([choices.question, choices.options.map((o) => [o.key, o.label])]);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Mac の印（公開鍵の SHA-256 の先頭 8 バイト）。iPhone はこれで、どの Mac に返事するか決める */
export function machineHint(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

/** 本文：聞かれていることと選択肢（ボタンには番号しか出せないので） */
function choicesBody(choices: Choices): string {
  const list = choices.options
    .slice(0, 3)
    .map((o) => `${o.key} ${o.label}`)
    .join(" ／ ");
  return choices.question ? `${choices.question}\n${list}` : list;
}

export type AttentionKind = "needs-input" | "finished";

export interface AttentionEvent {
  paneId: string;
  kind: AttentionKind;
  /** 通知の題名（1:claude · web）。訳す言葉は入らない */
  title: string;
  /** 会話の題名（訳さない。無ければ null） */
  what: string | null;
  /** ワークスペースの id（設定の「このワークスペースを知らせない」で使う） */
  workspaceId: string;
}

export interface PushTarget {
  deviceId: string;
  token: string;
  env: "sandbox" | "production";
  /** 宛先の端末の言語（無ければ日本語） */
  lang?: string;
  /** その端末の通知の設定（iPhone が push で送ってきたもの。無ければ既定） */
  prefs?: NotificationPrefs;
}

/** 宛先の言語で通知の文を作る（what＝会話の題名は訳さない） */
export function attentionText(event: AttentionEvent, lang: string): { title: string; body: string } {
  const lead = localize(lang, event.kind === "needs-input" ? "返事を待っています" : "終わりました");
  return { title: event.title, body: event.what ? `${lead} — ${event.what}` : lead };
}

/** 前の一覧と今の一覧から「知らせること」を出す。最初の一覧（prev が null）では何も出さない */
export function attentionEvents(prev: PaneSummary[] | null, next: PaneSummary[]): AttentionEvent[] {
  if (!prev) return [];
  const before = new Map(prev.map((p) => [p.paneId, p.status]));
  const events: AttentionEvent[] = [];
  for (const pane of next) {
    if (pane.kind !== "agent") continue;
    const was = before.get(pane.paneId);
    if (was === undefined) continue;
    let kind: AttentionKind | null = null;
    if (pane.status === "blocked" && was !== "blocked") kind = "needs-input";
    else if (pane.status === "done" && was === "working") kind = "finished";
    if (!kind) continue;
    const what = pane.chatTitle || pane.title;
    events.push({
      paneId: pane.paneId,
      kind,
      title: `${pane.tab}:${pane.agent ?? pane.label} · ${pane.workspace}`,
      what: what || null,
      workspaceId: pane.workspaceId,
    });
  }
  return events;
}

/** いまアプリを開いてつながっている端末（受け口が何本かあるので、本数で数える） */
export class Presence {
  private readonly counts = new Map<string, number>();

  add(deviceId: string): void {
    this.counts.set(deviceId, (this.counts.get(deviceId) ?? 0) + 1);
  }

  remove(deviceId: string): void {
    const n = (this.counts.get(deviceId) ?? 0) - 1;
    if (n > 0) this.counts.set(deviceId, n);
    else this.counts.delete(deviceId);
  }

  has(deviceId: string): boolean {
    return this.counts.has(deviceId);
  }
}

/** 同じペインの同じ知らせを出さない間（状態が行ったり来たりしても鳴り続けないように） */
const REPEAT_MS = 5000;

export class Notifier {
  private prev: PaneSummary[] | null = null;
  private readonly recent = new Map<string, number>();
  private readonly deps: {
    targets: () => PushTarget[];
    clearToken: (token: string) => void;
    presence: Presence;
    send: (target: PushTarget, payload: PushPayload) => Promise<{ ok: boolean; invalidToken?: boolean }>;
    /** 返事待ちの画面の選択肢を読む（なければ「返事を書く」だけになる） */
    choicesOf?: (paneId: string) => Promise<Choices | null>;
    /** この Mac の印（machineHint） */
    machine?: string;
    /** Mac から離れているか（設定「Mac から離れているときだけ」と鳴らさない時間に使う。省くと isAway() を動かす） */
    isAway?: () => Promise<boolean>;
    now?: () => number;
    log?: (message: string) => void;
  };

  constructor(deps: Notifier["deps"]) {
    this.deps = deps;
  }

  /** Herdr が止まって一覧が空になったら、次の一覧は「最初」として扱う */
  reset(): void {
    this.prev = null;
  }

  async update(panes: PaneSummary[]): Promise<void> {
    const events = attentionEvents(this.prev, panes);
    this.prev = panes;
    const now = (this.deps.now ?? Date.now)();
    for (const [key, at] of this.recent) if (now - at >= REPEAT_MS) this.recent.delete(key);
    const fresh = events.filter((e) => {
      const key = `${e.paneId}|${e.kind}`;
      if (this.recent.has(key)) return false;
      this.recent.set(key, now);
      return true;
    });
    if (fresh.length === 0) return;
    const targets = this.deps.targets().filter((t) => !this.deps.presence.has(t.deviceId));
    if (targets.length === 0) return;
    // Mac から離れているかは、設定も宛先も全部共通で 1 回読む（away.ts が 5 秒は覚えておく）
    let awayFromMac: boolean;
    try {
      awayFromMac = await (this.deps.isAway ?? (() => isAway()))();
    } catch {
      awayFromMac = true;
    }
    await Promise.all(
      fresh.map(async (event) => {
        let choices: Choices | null = null;
        if (event.kind === "needs-input" && this.deps.choicesOf) {
          try {
            choices = await this.deps.choicesOf(event.paneId);
          } catch {
            choices = null;
          }
        }
        const category = replyCategory(event.kind, choices);
        // 選択肢が読めたときの本文は、Mac の画面の言葉なので訳さない
        const body = choices && category !== "hm.reply" ? choicesBody(choices) : null;
        const fingerprint = choices && category !== "hm.reply" ? choicesFingerprint(choices) : null;
        await this.sendAll(targets, event, category, body, fingerprint, awayFromMac);
      }),
    );
  }

  private async sendAll(
    targets: PushTarget[],
    event: AttentionEvent,
    category: ReplyCategory,
    choiceBody: string | null,
    fingerprint: string | null,
    awayFromMac: boolean,
  ): Promise<void> {
    await Promise.all(
      targets.map(async (target) => {
        // その端末の設定（iPhone から届いていない宛先は既定＝ぜんぶオン）
        const prefs = target.prefs ?? DEFAULT_PREFS;
        if (!shouldNotify(prefs, event.kind, event.workspaceId, awayFromMac, null)) return;
        const now = new Date((this.deps.now ?? Date.now)());
        const sound = shouldSound(prefs, now);
        const passive = inQuietHours(prefs, now);
        try {
          const text = attentionText(event, target.lang ?? "ja");
          const payload = pushPayload(
            { paneId: event.paneId, kind: event.kind, title: text.title, body: choiceBody ?? text.body },
            category,
            this.deps.machine,
            { sound, passive },
          );
          if (fingerprint !== null) payload.q = fingerprint;
          const result = await this.deps.send(target, payload);
          if (!result.ok && result.invalidToken) this.deps.clearToken(target.token);
        } catch (err) {
          this.deps.log?.(`push failed: ${(err as Error).message}`);
        }
      }),
    );
  }
}
