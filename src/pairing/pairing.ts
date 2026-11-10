// スマホとのペアリング。
// QR に入れる「合言葉」は 5 分だけ・1 回だけ使える。合言葉を使うと、その端末だけの「鍵」を渡す。
// ファイルには合言葉も鍵もハッシュでしか残さない（ファイルを見られても、なりすませない）。
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { NotificationPrefs } from "../notify/prefs.ts";

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  /** 通知の宛先（Apple のデバイストークン）と、その端末の通知の設定。アプリが送ってきたときだけ */
  push?: { token: string; env: "sandbox" | "production"; prefs?: NotificationPrefs; sealed?: string };
  /** アプリの言語（BCP 47）。hello・lang で送られてきたときだけ。無ければ日本語 */
  lang?: string;
}

interface PendingCode {
  codeHash: string;
  expiresAt: number;
}

interface StoreFile {
  devices: Device[];
  pending: PendingCode | null;
}

export type RedeemResult =
  | { ok: true; token: string; deviceId: string }
  | { ok: false; reason: "invalid_code" };

export class PairingStore {
  private readonly path: string;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  /** 新しい合言葉を出す。前の合言葉は使えなくなる。 */
  createPairingCode(): string {
    const code = randomBytes(18).toString("base64url");
    const data = this.load();
    data.pending = { codeHash: hash(code), expiresAt: this.now() + PAIRING_CODE_TTL_MS };
    this.save(data);
    return code;
  }

  /** 合言葉が正しければ、端末を登録して鍵を返す。 */
  redeem(code: string, deviceName: string): RedeemResult {
    const data = this.load();
    const pending = data.pending;
    if (!pending || pending.expiresAt < this.now() || !safeEqualHex(pending.codeHash, hash(code))) {
      return { ok: false, reason: "invalid_code" };
    }
    const token = randomBytes(32).toString("base64url");
    const device: Device = {
      id: randomUUID(),
      name: cleanName(deviceName),
      tokenHash: hash(token),
      createdAt: this.now(),
      lastSeenAt: this.now(),
    };
    data.pending = null;
    data.devices.push(device);
    this.save(data);
    return { ok: true, token, deviceId: device.id };
  }

  /** 鍵が登録済みの端末のものなら、その端末を返す。読むだけでファイルは書かない。 */
  verify(token: string): Device | null {
    if (!token) return null;
    const tokenHash = hash(token);
    const device = this.load().devices.find((d) => safeEqualHex(d.tokenHash, tokenHash));
    return device ? { ...device } : null;
  }

  /** その端末がまだ登録されているか（消されたら、つながっている接続も切るため）。 */
  isActive(deviceId: string): boolean {
    return this.load().devices.some((d) => d.id === deviceId);
  }

  /** 最後につないだ時刻を残す（読んですぐ書く。中継から、つないだときに 1 回だけ呼ぶ）。 */
  markSeen(deviceId: string): void {
    const data = this.load();
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device) return;
    device.lastSeenAt = this.now();
    this.save(data);
  }

  /** 合言葉がまだ使われていないか（QR を出している画面が「つながった」を知るため）。 */
  hasPendingCode(): boolean {
    const pending = this.load().pending;
    return pending !== null && pending.expiresAt >= this.now();
  }

  /**
   * 端末の通知の宛先と設定をしまう（null の token なら止める。何も変わらなければ書かない）。
   * sealed は中継サーバーにしか開けない封をした宛先（無ければ中継サーバーからは送らない）
   */
  setPush(deviceId: string, token: string | null, env: "sandbox" | "production", prefs?: NotificationPrefs, sealed?: string | null): void {
    const data = this.load();
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device) return;
    if (token === null) {
      if (!device.push) return;
      delete device.push;
    } else {
      const samePrefs =
        (prefs === undefined && device.push?.prefs === undefined) ||
        (prefs !== undefined && device.push?.prefs !== undefined && JSON.stringify(device.push.prefs) === JSON.stringify(prefs));
      const seal = sealed ?? undefined;
      if (device.push?.token === token && device.push.env === env && samePrefs && device.push.sealed === seal) return;
      // 同じ iPhone をつなぎ直したとき、前の登録にも同じ宛先が残っていると 2 回鳴るので外す
      for (const other of data.devices) if (other !== device && other.push?.token === token) delete other.push;
      device.push = { token, env, ...(prefs ? { prefs } : {}), ...(seal ? { sealed: seal } : {}) };
    }
    this.save(data);
  }

  /** アプリの言語を覚える（変わったときだけ書く） */
  setLang(deviceId: string, lang: string): void {
    const data = this.load();
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device || device.lang === lang) return;
    device.lang = lang;
    this.save(data);
  }

  /** Apple に「もう使えない」と言われた宛先を消す */
  clearPushToken(token: string): void {
    const data = this.load();
    let changed = false;
    for (const d of data.devices) {
      if (d.push?.token === token) {
        delete d.push;
        changed = true;
      }
    }
    if (changed) this.save(data);
  }

  pushTargets(): { deviceId: string; token: string; env: "sandbox" | "production"; lang?: string; prefs?: NotificationPrefs; sealed?: string }[] {
    return this.load().devices.flatMap((d) =>
      d.push
        ? [
            {
              deviceId: d.id,
              token: d.push.token,
              env: d.push.env,
              ...(d.lang ? { lang: d.lang } : {}),
              ...(d.push.prefs ? { prefs: d.push.prefs } : {}),
              ...(d.push.sealed ? { sealed: d.push.sealed } : {}),
            },
          ]
        : [],
    );
  }

  listDevices(): Device[] {
    return this.load().devices.map((d) => ({ ...d }));
  }

  revoke(deviceId: string): boolean {
    const data = this.load();
    const before = data.devices.length;
    data.devices = data.devices.filter((d) => d.id !== deviceId);
    this.save(data);
    return data.devices.length !== before;
  }

  private load(): StoreFile {
    if (!existsSync(this.path)) return { devices: [], pending: null };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoreFile>;
      return {
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        pending: parsed.pending ?? null,
      };
    } catch {
      return { devices: [], pending: null };
    }
  }

  private save(data: StoreFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return cleaned || "スマホ";
}
