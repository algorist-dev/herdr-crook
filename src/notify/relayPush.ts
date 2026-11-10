// 中継サーバー（relay-server の POST /p/<部屋>）に「この端末に通知を送って」と頼む。
// Mac に APNs の鍵が無くても、裏の通知が届く（docs/architecture/relay-push.md）。
// 宛先は iPhone が中継サーバーにしか開けない封をしたもの。Mac は開けずにそのまま渡す。
import type { CloudRoom } from "../net/cloudRelay.ts";
import { untilNextUtcDay } from "../net/cloudRelay.ts";
import type { PushPayload } from "./apns.ts";

/** 1 回に頼める宛先（relay-server/src/push/handle.ts の MAX_PUSHES） */
const MAX_PUSHES = 8;
/** 中継サーバーに鍵が無いときに休む時間 */
const REST_MS = 10 * 60 * 1000;
/** 部屋がまだ無い（トンネルがつなぐ前）・合言葉が合わないときに休む時間（すぐ直ることが多いので短く） */
const SHORT_REST_MS = 60 * 1000;

export type RelaySendResult = { ok: boolean; invalidToken?: boolean; status?: number; reason?: string };

/** トンネルの入口（wss://…）から、通知を頼む入口（https://…）を作る */
export function httpBase(server: string): string {
  return server.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
}

interface Waiting {
  sealed: string;
  payload: PushPayload;
  resolve: (r: RelaySendResult) => void;
}

export class RelayPushClient {
  private readonly url: string;
  private readonly room: CloudRoom;
  private readonly now: () => number;
  private readonly log?: (message: string) => void;
  private readonly timeoutMs: number;
  private queue: Waiting[] = [];
  private scheduled = false;
  private pausedUntil = 0;

  constructor(opts: { server: string; room: CloudRoom; now?: () => number; log?: (message: string) => void; timeoutMs?: number }) {
    this.url = `${httpBase(opts.server)}/p/${opts.room.room}`;
    this.room = opts.room;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** 1 台に送る。同じときに頼まれたもの（1 つの知らせを何台にも）は 1 回の頼みにまとめる */
  send(target: { sealed: string }, payload: PushPayload): Promise<RelaySendResult> {
    if (this.now() < this.pausedUntil) return Promise.resolve({ ok: false, reason: "paused" });
    return new Promise((resolve) => {
      this.queue.push({ sealed: target.sealed, payload, resolve });
      if (this.scheduled) return;
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        const waiting = this.queue;
        this.queue = [];
        for (let i = 0; i < waiting.length; i += MAX_PUSHES) void this.flush(waiting.slice(i, i + MAX_PUSHES));
      });
    });
  }

  private async flush(batch: Waiting[]): Promise<void> {
    const fail = (r: RelaySendResult) => batch.forEach((w) => w.resolve(r));
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-herdr-host-secret": this.room.secret },
        body: JSON.stringify({ pushes: batch.map((w) => ({ sealed: w.sealed, payload: w.payload })) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return fail({ ok: false, reason: (err as Error).message || "fetch failed" });
    }
    let body: { results?: unknown; error?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // 中身がなければ status だけ
    }
    if (res.status !== 200 || !Array.isArray(body.results)) {
      const reason = typeof body.error === "string" ? body.error : `status ${res.status}`;
      // 今日の分（この Mac か全体）を使い切った：中継サーバーの数が戻る 00:00 UTC まで頼まない
      if (res.status === 429 && (reason === "daily limit" || reason === "global limit")) {
        this.pausedUntil = this.now() + untilNextUtcDay(this.now());
      }
      // 鍵が入っていない：しばらく休む
      if (res.status === 503) this.pausedUntil = this.now() + REST_MS;
      // 部屋の合言葉が合わない（トンネルがまだ部屋を作っていない）：少しだけ休む
      if (res.status === 401 || res.status === 403) this.pausedUntil = this.now() + SHORT_REST_MS;
      this.log?.(`relay push: ${res.status} ${reason}`);
      return fail({ ok: false, status: res.status, reason });
    }
    const results = body.results as { ok?: unknown; gone?: unknown; reason?: unknown }[];
    batch.forEach((w, i) => {
      const r = results[i];
      if (r?.ok === true) w.resolve({ ok: true });
      else if (r?.gone === true) w.resolve({ ok: false, invalidToken: true, reason: "gone" });
      else w.resolve({ ok: false, reason: typeof r?.reason === "string" ? r.reason : "failed" });
    });
  }
}
