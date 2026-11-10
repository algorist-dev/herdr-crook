// 通知をどこから送るか選ぶ。
//   1. Mac に自分の APNs の鍵（push-setup）があれば、今までどおり直接
//   2. 無ければ、iPhone が封をした宛先を中継サーバーに渡して送ってもらう（docs/architecture/relay-push.md）
// どちらも無ければ送らない。
import type { PushPayload } from "./apns.ts";
import type { PushTarget } from "./notifier.ts";

export type SendResult = { ok: boolean; invalidToken?: boolean; status?: number; reason?: string };

export interface DirectSender {
  send(target: { token: string; env: "sandbox" | "production" }, payload: PushPayload): Promise<SendResult>;
}

export interface RelaySender {
  send(target: { sealed: string }, payload: PushPayload): Promise<SendResult>;
}

export function createPushSender(opts: {
  /** いまの直接の送り手（鍵を入れ直したら替わるので、毎回聞く） */
  direct: () => DirectSender | null;
  /** 中継サーバー（使わない設定なら null） */
  relay: RelaySender | null;
}) {
  return {
    ready: () => opts.direct() !== null || opts.relay !== null,
    async send(target: PushTarget, payload: PushPayload): Promise<SendResult> {
      const direct = opts.direct();
      if (direct) return direct.send(target, payload);
      if (!opts.relay) return { ok: false, reason: "no push route" };
      if (!target.sealed) return { ok: false, reason: "no sealed destination" };
      return opts.relay.send({ sealed: target.sealed }, payload);
    },
  };
}
