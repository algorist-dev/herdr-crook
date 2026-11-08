// Claude Code の statusline に渡る JSON を残して、iPhone から使用量（5h/7d・正確なコンテキスト%）を読めるようにする。
// Claude の statusLine は 1 つしか設定できないので、いまのスクリプトの「入力を読んだすぐあと」に 1 行足す。
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StatuslineSave {
  path: string | null;
  sessionId: string | null;
}

/** statusline の JSON から会話の ID を読む（session_id がなければ transcript のファイル名） */
export function sessionIdFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const object = payload as Record<string, unknown>;
  for (const key of ["session_id", "sessionId"]) {
    const value = object[key];
    if (typeof value === "string" && /^[A-Za-z0-9-]{1,80}$/.test(value)) return value;
  }
  const transcript = object.transcript_path;
  if (typeof transcript === "string") {
    const base = transcript.split("/").pop()?.replace(/\.jsonl$/, "") ?? "";
    if (/^[A-Za-z0-9-]{1,80}$/.test(base)) return base;
  }
  return null;
}

/** 1 回分の statusline を 0600 のファイルに残す（0.5 秒で消えないよう、いったん別名で書いてから置きかえる） */
export function saveStatusline(dir: string, payload: unknown, now = Date.now()): StatuslineSave {
  const sessionId = sessionIdFrom(payload);
  if (!sessionId) return { path: null, sessionId: null };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  cleanup(dir, now);
  return { path, sessionId };
}

/** 中継が読む。無ければ null */
export function readStatusline(dir: string, sessionId: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(sessionId)) return null;
  try {
    const value = JSON.parse(readFileSync(join(dir, `${sessionId}.json`), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 1 週間より前の statusline は消す */
function cleanup(dir: string, now: number): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > 7 * 86_400_000) unlinkSync(path);
      } catch {
        // 消えていればそのまま
      }
    }
  } catch {
    // フォルダが読めなくても止めない
  }
}

/** ~/.claude/settings.json の statusLine.command から、実行しているスクリプトを探す */
export function findStatuslineScript(settingsPath: string, home = homedir()): string | null {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const statusLine = settings.statusLine as { command?: unknown } | undefined;
  if (typeof statusLine?.command !== "string") return null;
  // "sh ~/.claude/statusline.sh" や "~/.claude/statusline.sh" の形を想定する
  const words = statusLine.command.match(/(?:'[^']*'|"[^"]*"|\S+)/g) ?? [];
  const script = [...words].reverse().find((word) => /\.sh$/.test(word.replace(/^['"]|['"]$/g, "")));
  if (!script) return null;
  const path = expandHome(script.replace(/^['"]|['"]$/g, ""), home);
  return existsSync(path) ? path : null;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export interface HookOptions {
  /** node の場所 */
  node: string;
  /** cli.ts の場所 */
  cli: string;
  /** 中継の設定フォルダ（CROOK_HOME） */
  home: string;
}

/** 入力の変数（input=$(cat)）のすぐあとに、同じ JSON を残す 1 行を足す。足したら true */
export function installStatuslineHook(scriptPath: string, options: HookOptions): { ok: boolean; message: string } {
  let current: string;
  try {
    current = readFileSync(scriptPath, "utf8");
  } catch {
    return { ok: false, message: `${scriptPath} が読めません` };
  }
  const marker = "crook statusline";
  if (current.includes(marker)) return { ok: true, message: "statusline の連携はもう入っています" };
  const lines = current.split("\n");
  const at = lines.findIndex((line) => /^[A-Za-z_][A-Za-z0-9_]*=\$\(cat\)\s*$/.test(line.trim()));
  if (at < 0) {
    return { ok: false, message: "statusline のスクリプトで「input=$(cat)」の行が見つかりませんでした。手で 1 行足してください" };
  }
  const variable = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(lines[at]!.trim())?.[1];
  if (!variable) return { ok: false, message: "statusline の入力を読む変数が分かりませんでした" };
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const injected =
    `# ${marker}: iPhone の使用量表示のために同じ JSON を残す（消すときはこの行を消す）\n` +
    `printf '%s' "$${variable}" | CROOK_HOME=${quote(options.home)} ${quote(options.node)} ${quote(options.cli)} statusline >/dev/null 2>&1 &`;
  const before = current;
  lines.splice(at + 1, 0, injected);
  const backup = `${scriptPath}.bak-crook`;
  try {
    if (!existsSync(backup)) writeFileSync(backup, before, { mode: 0o600 });
    writeFileSync(scriptPath, lines.join("\n"));
  } catch (err) {
    return { ok: false, message: `${scriptPath} に書けません: ${(err as Error).message}` };
  }
  return { ok: true, message: `${scriptPath} に足しました（元は ${backup}）` };
}
