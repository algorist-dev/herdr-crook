import { homedir } from "node:os";
import { join } from "node:path";
import { findStatuslineScript, installStatuslineHook } from "../../providers/claude/statusline.ts";
import { CLI, HOME } from "../paths.ts";

/** Claude の statusline に、使用量を残す 1 行を足す（statusLine が無ければ何もしない） */
export function installStatusline(): { ok: boolean; message: string } {
  const script = findStatuslineScript(join(homedir(), ".claude", "settings.json"));
  if (!script) return { ok: false, message: "Claude の statusline が見つかりません（settings.json の statusLine）" };
  return installStatuslineHook(script, { node: process.execPath, cli: CLI, home: HOME });
}

/** statusline-install コマンド */
export async function run(_args: string[]): Promise<void> {
  const result = installStatusline();
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
}
