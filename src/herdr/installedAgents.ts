// Mac に入っているエージェント（新しいタブ・新しいワークスペースで選べるもの）を調べる。
// Herdr の agent start が起動できる種類（herdr agent start --help）のうち、コマンドがあるものだけ。
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Herdr 0.9 の agent start の --kind（並びは画面に出す順） */
export const HERDR_AGENT_KINDS = [
  "claude", "codex", "gemini", "opencode", "cursor", "copilot", "amp", "droid", "cline", "kiro",
  "qwen", "kimi", "grok", "devin", "pi", "agy", "omp", "mastracode", "hermes", "kilo", "qodercli", "letta", "maki", "muse",
] as const;
export type AgentKind = (typeof HERDR_AGENT_KINDS)[number];

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (HERDR_AGENT_KINDS as readonly string[]).includes(value);
}

/** よく入れる場所（launchd から動くと、シェルの設定で足している PATH が見えないことがあるので直接も見る） */
function commonDirs(home: string): string[] {
  return [
    join(home, ".local", "bin"), join(home, ".claude", "local"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin"),
    join(home, ".opencode", "bin"), join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin",
  ];
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** ログインのシェルで command -v を試し、よく入れる場所も直接見る */
export async function detectAgents(
  run: (script: string) => Promise<string> = loginShell,
  exists: (path: string) => boolean = executable,
  home: string = homedir(),
): Promise<AgentKind[]> {
  const script = `for c in ${HERDR_AGENT_KINDS.join(" ")}; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done`;
  let found = new Set<string>();
  try {
    found = new Set((await run(script)).split("\n").map((s) => s.trim()));
  } catch {
    // シェルで調べられなくても、場所は見る
  }
  const dirs = commonDirs(home);
  const list = HERDR_AGENT_KINDS.filter((k) => found.has(k) || dirs.some((d) => exists(join(d, k))));
  return list.length > 0 ? list : ["claude"];
}

function loginShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.env.SHELL || "/bin/zsh", ["-lc", script], { timeout: 10_000 }, (err, stdout) =>
      err && !stdout ? reject(err) : resolve(stdout),
    );
  });
}
