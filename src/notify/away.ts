// Mac から離れているか（setting：キーボードとマウスに 3 分さわっていない、または Mac がロックされている）。
// 設定「Mac から離れているときだけ」で Mac の知らせを出すかどうかの判断に使う。
// ioreg の出力の見本は test/away.test.ts で確かめる（本物の Mac の状態には頼らない）。

/** ioreg を引数だけ替えて動かす（シェルは通さない）。読めなければ null */
export interface AwayRunner {
  run(args: string[]): Promise<string | null>;
}

const IDLE_MS = 3 * 60 * 1000;
const CACHE_MS = 5000;

/** キーボードとマウスのいじり止め。HIDIdleTime はナノ秒（"HIDIdleTime" = 1234567890） */
export function idleSecondsFromIoreg(output: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output);
  if (!match) return null;
  return Number(match[1]) / 1e9;
}

/**
 * Mac のロック。`ioreg -n Root -d 1 -a`（XML の plist）の IOConsoleUsers に
 * `<key>CGSSessionScreenIsLocked</key><true/>` があればロック中（ロックしていないときはキーごと無い）
 */
export function isScreenLocked(output: string): boolean {
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(output);
}

export class IoregRunner implements AwayRunner {
  async run(args: string[]): Promise<string | null> {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve) => {
      const child = execFile("/usr/sbin/ioreg", args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        resolve(err && !stdout ? null : String(stdout));
      });
      child.on("error", () => resolve(null));
    });
  }
}

export function isAwayFromSamples(idle: string | null, consoleUsers: string | null): boolean {
  if (consoleUsers !== null && isScreenLocked(consoleUsers)) return true;
  if (idle === null) return true;
  const seconds = idleSecondsFromIoreg(idle);
  if (seconds === null) return true;
  return seconds >= IDLE_MS / 1000;
}

/** isAway：どちらか当てはまれば true。コマンドが失敗したら true（知らせない方に倒さない）。5 秒は覚えておいて読み直さない */
export function isAway(runner: AwayRunner = defaultRunner): Promise<boolean> {
  const cached = last;
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  if (loading) return loading;
  loading = read()
    .catch(() => true)
    .then((value) => {
      last = { at: now, value };
      return value;
    })
    .finally(() => {
      loading = null;
    });
  return loading;

  async function read(): Promise<boolean> {
    const [idle, consoleUsers] = await Promise.all([
      runner.run(["-c", "IOHIDSystem", "-d", "4", "-k", "HIDIdleTime"]),
      runner.run(["-n", "Root", "-d", "1", "-a"]),
    ]);
    return isAwayFromSamples(idle, consoleUsers);
  }
}

let last: { at: number; value: boolean } | null = null;
let loading: Promise<boolean> | null = null;
const defaultRunner = new IoregRunner();

/** 試しにする（タイマーで動かすための呼び方。既定では何もしない） */
export function resetAwayCache(): void {
  last = null;
  loading = null;
}
