// Tailscale から、この Mac のアドレスと、つないできた相手が「自分のアカウントの端末か」を調べる。
import { execFile } from "node:child_process";

export interface SelfInfo {
  ipv4: string;
  dnsName: string | null;
  hostName: string;
  userId: number;
}

/** 続けてこの回数だけ聞けなければ、Tailscale は止まっているとみなす。 */
export const UNKNOWN_LIMIT = 4;

export type SelfProbe = { state: "running"; self: SelfInfo } | { state: "stopped" } | { state: "unknown" };

export type RunTailscale = (args: string[]) => Promise<string>;

export function defaultRunner(bin = process.env.TAILSCALE_BIN ?? "tailscale"): RunTailscale {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

export function parseSelf(status: unknown): SelfInfo | null {
  const s = status as { BackendState?: string; Self?: Record<string, unknown> };
  if (s.BackendState !== "Running" || !s.Self) return null;
  const ips = Array.isArray(s.Self.TailscaleIPs) ? (s.Self.TailscaleIPs as string[]) : [];
  const ipv4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (!ipv4 || typeof s.Self.UserID !== "number") return null;
  const dns = typeof s.Self.DNSName === "string" ? s.Self.DNSName.replace(/\.$/, "") : "";
  return {
    ipv4,
    dnsName: dns || null,
    hostName: typeof s.Self.HostName === "string" ? s.Self.HostName : "Mac",
    userId: s.Self.UserID,
  };
}

export function parseWhoisUserId(whois: unknown): number | null {
  const id = (whois as { UserProfile?: { ID?: unknown } }).UserProfile?.ID;
  return typeof id === "number" ? id : null;
}

export class Tailscale {
  private readonly run: RunTailscale;
  private readonly allowed = new Map<string, { ok: boolean; at: number }>();
  private lastSelf: SelfInfo | null = null;
  private unknownStreak = 0;

  constructor(run: RunTailscale = defaultRunner()) {
    this.run = run;
  }

  /**
   * Tailscale の様子を聞く。止まっていると分かったとき（stopped）と、聞けなかったとき（unknown）を分ける。
   * Mac が混んでいると `tailscale status` が 5 秒で返らないことがあり、それを「止まっている」と扱うと受け口を閉じてしまう。
   */
  async probe(): Promise<SelfProbe> {
    let self: SelfInfo | null;
    try {
      const parsed: unknown = JSON.parse(await this.run(["status", "--json"]));
      if (typeof parsed !== "object" || parsed === null) throw new Error("unexpected status");
      self = parseSelf(parsed);
    } catch {
      // Tailscale を終了したままのときも聞けなくなる。続けて聞けなければ（中継では 15 秒ごとに 4 回＝1 分）止まったとみなす
      if (++this.unknownStreak < UNKNOWN_LIMIT) return { state: "unknown" };
      self = null;
    }
    if (self) this.unknownStreak = 0;
    this.lastSelf = self;
    return self ? { state: "running", self } : { state: "stopped" };
  }

  /** 自分の情報。聞けなかったときは、前に分かったものを返す（止まっていると分かっていれば null）。 */
  async self(): Promise<SelfInfo | null> {
    const p = await this.probe();
    if (p.state === "running") return p.self;
    return p.state === "unknown" ? this.lastSelf : null;
  }

  /** つないできた相手が、この Mac と同じ Tailscale のアカウントの端末か。 */
  async isSameUser(remoteAddress: string): Promise<boolean> {
    const ip = remoteAddress.replace(/^::ffff:/, "");
    if (ip === "127.0.0.1" || ip === "::1") return true;
    const cached = this.allowed.get(ip);
    // 通すと決めた相手は 10 分、通さないと決めた相手は 30 秒だけ覚える（Tailscale が一時的に落ちていたときのため）
    if (cached && Date.now() - cached.at < (cached.ok ? 10 * 60 * 1000 : 30 * 1000)) return cached.ok;
    let ok = false;
    try {
      const [me, whois] = await Promise.all([this.self(), this.run(["whois", "--json", ip]).then((t) => JSON.parse(t))]);
      const theirs = parseWhoisUserId(whois);
      ok = me !== null && theirs !== null && theirs === me.userId;
    } catch {
      ok = false;
    }
    this.allowed.set(ip, { ok, at: Date.now() });
    return ok;
  }
}
