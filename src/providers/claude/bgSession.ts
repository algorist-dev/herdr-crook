// Claude Code を bg（`claude agents`）で動かしているペインで、Herdr が知っているセッション ID が
// 「spare」（次の仕事のために前もって立てておく Claude）を指してしまうときの手当て。
//
// spare もペインの環境（HERDR_PANE_ID）を受けついでいて、立ち上がると SessionStart を Herdr に知らせる。
// 本当に会話している Claude より後に立つので、Herdr の記録が spare の ID に上書きされる。
// spare は使われるまで会話の記録（.jsonl）を作らないので、チャットは「まだ会話がありません」のままになる（2026-11-26）。
// そこで、記録のない ID が spare のものなら、同じペインで動いている Claude の記録を代わりに使う。
// Claude が動いている Claude ごとに残す ~/.claude/sessions/<pid>.json と、プロセスの環境（ps eww）で同じペインかを見る。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeSessionEntry {
  pid: number;
  sessionId: string;
  spare?: boolean;
  updatedAt?: number;
}

export interface BgSessionDeps {
  /** 動いている（か、動いていた）Claude の一覧 */
  sessions(): ClaudeSessionEntry[];
  alive(pid: number): boolean;
  /** そのプロセスがどの Herdr のどのペインのものか（比べるためだけの文字）。分からなければ null */
  paneOf(pid: number): string | null;
  /** セッション ID → 会話記録のファイル */
  transcript(sessionId: string): string | null;
}

/** 記録のない sessionId が spare のものなら、同じペインで動いている Claude の記録。なければ null */
export function findBgStandIn(sessionId: string, deps: BgSessionDeps): string | null {
  const entries = deps.sessions();
  const me = entries.find((e) => e.sessionId === sessionId);
  if (!me?.spare) return null;
  const pane = deps.paneOf(me.pid);
  if (!pane) return null;
  const others = entries
    .filter((e) => e.sessionId !== sessionId && !e.spare && deps.alive(e.pid) && deps.paneOf(e.pid) === pane)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const e of others) {
    const path = deps.transcript(e.sessionId);
    if (path) return path;
  }
  return null;
}

/** ~/.claude/sessions/*.json を読む（読めないものは飛ばす） */
export function readClaudeSessions(home: string): ClaudeSessionEntry[] {
  const dir = join(home, ".claude", "sessions");
  if (!existsSync(dir)) return [];
  const out: ClaudeSessionEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") continue;
      out.push({
        pid: raw.pid,
        sessionId: raw.sessionId,
        spare: raw.spare === true,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
      });
    } catch {
      // 書いている途中など
    }
  }
  return out;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** プロセスの環境から、Herdr のソケットとペイン ID を読む（ps eww。自分のプロセスだけ読める） */
export function herdrPaneOf(pid: number): string | null {
  const r = spawnSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const pane = /(?:^|\s)HERDR_PANE_ID=(\S+)/.exec(r.stdout)?.[1];
  if (!pane) return null;
  const socket = /(?:^|\s)HERDR_SOCKET_PATH=(\S+)/.exec(r.stdout)?.[1] ?? "";
  return `${socket}|${pane}`;
}

/** 同じ ID を 700ms ごとに聞かれるので、しばらく覚えておく */
export class StandInCache {
  private readonly memo = new Map<string, { at: number; path: string | null }>();
  private readonly lookup: (sessionId: string) => string | null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(lookup: (sessionId: string) => string | null, ttlMs = 5000, now: () => number = Date.now) {
    this.lookup = lookup;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(sessionId: string): string | null {
    const hit = this.memo.get(sessionId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.path;
    const path = this.lookup(sessionId);
    if (this.memo.size > 64) this.memo.clear();
    this.memo.set(sessionId, { at: this.now(), path });
    return path;
  }
}
