// Apple の通知（APNs）に Mac から直接送る。自分用なので、送るための鍵（.p8）は Mac に置く。
// 鍵は ~/.config/crook/apns/ に本人だけが読めるようにしまう。
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { sign } from "node:crypto";
import { basename, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AttentionKind, ReplyCategory } from "./notifier.ts";

export type ApnsEnv = "sandbox" | "production";

export interface PushPayload {
  aps: {
    alert: { title: string; body: string };
    sound?: "default";
    "thread-id": string;
    category: ReplyCategory;
    /** 鳴らさない時間の中は passive（音もバナーも出さず、通知の一覧にだけ入る） */
    "interruption-level"?: "passive";
  };
  pane: string;
  kind: AttentionKind;
  /** どの Mac からか（公開鍵の印。iPhone は返事をこの Mac に送る） */
  m?: string;
  /** どの質問か（choicesFingerprint）。ボタンの返事は、Mac がこれと今の画面を比べてから送る */
  q?: string;
}

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  topic: string;
  /** .p8 の中身（PEM） */
  key: string;
}

export function apnsHost(env: ApnsEnv): string {
  return env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
}

/** push の payload。sound を書かなければ無音（iPhone 側の設定で鳴らさないとき）。passive は aps の interruption-level で伝える */
export function pushPayload(
  e: { paneId: string; kind: AttentionKind; title: string; body: string },
  category: ReplyCategory = "hm.reply",
  machine?: string,
  opts: { sound?: boolean; passive?: boolean } = {},
): PushPayload {
  const aps: PushPayload["aps"] = { alert: { title: e.title, body: e.body }, "thread-id": e.paneId, category };
  if (opts.sound !== false) aps.sound = "default";
  if (opts.passive) aps["interruption-level"] = "passive";
  return {
    aps,
    pane: e.paneId,
    kind: e.kind,
    ...(machine ? { m: machine } : {}),
  };
}

/** Apple に「この鍵の持ち主です」と示す合図（ES256 の JWT。1 時間まで使える） */
export function makeProviderToken(cfg: Pick<ApnsConfig, "keyId" | "teamId" | "key">, nowMs: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${enc({ alg: "ES256", kid: cfg.keyId })}.${enc({ iss: cfg.teamId, iat: Math.floor(nowMs / 1000) })}`;
  const sig = sign("sha256", Buffer.from(head), { key: cfg.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${sig}`;
}

/** 鍵ファイルを home/apns/ にしまい、設定を書く。keyId を書かなければファイル名（AuthKey_<ID>.p8）から読む */
export function saveApnsConfig(home: string, opts: { keyPath: string; keyId?: string; teamId: string; topic: string }): void {
  const keyId = opts.keyId ?? /^AuthKey_([A-Z0-9]{10})\.p8$/.exec(basename(opts.keyPath))?.[1];
  if (!keyId) throw new Error("鍵の ID が分かりません（AuthKey_XXXXXXXXXX.p8 の名前のまま渡すか、ID も書いてください）");
  if (!/^[A-Z0-9]{10}$/.test(opts.teamId)) throw new Error("チーム ID は 10 文字の英数字です");
  const pem = readFileSync(opts.keyPath, "utf8");
  if (!pem.includes("PRIVATE KEY")) throw new Error("鍵ファイル（.p8）ではないようです");
  const dir = join(home, "apns");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dest = join(dir, `AuthKey_${keyId}.p8`);
  writeFileSync(dest, pem, { mode: 0o600 });
  chmodSync(dest, 0o600);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ keyId, teamId: opts.teamId, topic: opts.topic }, null, 2), { mode: 0o600 });
}

export function loadApnsConfig(home: string): ApnsConfig | null {
  const dir = join(home, "apns");
  const path = join(dir, "config.json");
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as { keyId?: unknown; teamId?: unknown; topic?: unknown };
    if (typeof c.keyId !== "string" || !/^[A-Z0-9]{10}$/.test(c.keyId) || typeof c.teamId !== "string" || typeof c.topic !== "string") return null;
    const key = readFileSync(join(dir, `AuthKey_${c.keyId}.p8`), "utf8");
    return { keyId: c.keyId, teamId: c.teamId, topic: c.topic, key };
  } catch {
    return null;
  }
}

/** 宛先ごとの HTTP/2 のつながりを使い回して送る */
export class ApnsClient {
  private readonly sessions = new Map<ApnsEnv, ClientHttp2Session>();
  private token: { value: string; at: number } | null = null;
  private readonly cfg: ApnsConfig;
  private readonly now: () => number;

  private readonly keepAlive: boolean;
  private readonly timeoutMs: number;

  /** keepAlive：つながりがあってもプロセスを終わらせない（中継）。push-test では false にして返事を待つ */
  private readonly hostFor: (env: ApnsEnv) => string;

  constructor(cfg: ApnsConfig, opts: { now?: () => number; keepAlive?: boolean; host?: (env: ApnsEnv) => string; timeoutMs?: number } = {}) {
    this.cfg = cfg;
    this.hostFor = opts.host ?? apnsHost;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.keepAlive = opts.keepAlive ?? true;
  }

  get keyId(): string {
    return this.cfg.keyId;
  }

  get topic(): string {
    return this.cfg.topic;
  }

  async send(
    target: { token: string; env: ApnsEnv },
    payload: PushPayload,
  ): Promise<{ ok: boolean; invalidToken?: boolean; status?: number; reason?: string }> {
    const body = JSON.stringify(payload);
    const session = this.session(target.env);
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { ok: boolean; invalidToken?: boolean; status?: number; reason?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${target.token}`,
        authorization: `bearer ${this.providerToken()}`,
        "apns-topic": this.cfg.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": "0",
        "content-type": "application/json",
      });
      let status = 0;
      let text = "";
      req.setEncoding("utf8");
      req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
      req.on("data", (c: string) => (text += c));
      req.on("end", () => {
        if (status === 200) return done({ ok: true, status });
        let reason = "";
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? "";
        } catch {
          // 中身がなければ status だけ
        }
        // 403 の ExpiredProviderToken なら次は作り直す
        if (reason === "ExpiredProviderToken") this.token = null;
        // 「アプリが消された」ときだけ宛先を消す。BadDeviceToken や DeviceTokenNotForTopic は設定の間違いでも出るので残す
        const invalidToken = status === 410 || reason === "Unregistered";
        done({ ok: false, invalidToken, status, reason });
      });
      req.on("error", (err) => done({ ok: false, reason: err.message }));
      // 途中でつながりが閉じた・時間切れのときも、待ち続けない
      req.on("close", () => done({ ok: false, status, reason: "closed" }));
      req.setTimeout(this.timeoutMs, () => req.close(constants.NGHTTP2_CANCEL));
      req.end(body);
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private session(env: ApnsEnv): ClientHttp2Session {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(this.hostFor(env));
    s.on("error", () => this.sessions.delete(env));
    s.on("close", () => this.sessions.delete(env));
    // だまっている間はつながりを閉じてよい
    s.setTimeout(10 * 60 * 1000, () => s.close());
    if (this.keepAlive) s.unref();
    this.sessions.set(env, s);
    return s;
  }

  /** Apple は 20 分〜1 時間ごとに作り直すことを求める */
  private providerToken(): string {
    const now = this.now();
    if (!this.token || now - this.token.at > 40 * 60 * 1000) this.token = { value: makeProviderToken(this.cfg, now), at: now };
    return this.token.value;
  }
}
