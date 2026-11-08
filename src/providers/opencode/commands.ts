// OpenCode の「/」に出すコマンド。組み込みの一覧と、Mac の設定フォルダから集める場所。
import { join } from "node:path";
import type { SlashCommandInfo } from "../../features/slashCommands.ts";
import { command, readCommands } from "../shared/commandFiles.ts";

const OPENCODE: SlashCommandInfo[] = [
  command("clear", "会話を消して、最初からにする"),
  command("compact", "会話を要約して短くする"),
  command("init", "AGENTS.md を作る"),
  command("help", "使えるコマンドを見る"),
];

export function openCodeBuiltinCommands(): SlashCommandInfo[] {
  return OPENCODE;
}

export function discoverOpenCodeCommands(cwd: string | null, home: string, env: NodeJS.ProcessEnv): SlashCommandInfo[] {
  const config = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : join(home, ".config", "opencode");
  return readCommands(
    [join(config, "command"), join(config, "commands"), ...(cwd ? [join(cwd, ".opencode", "command")] : [])],
    "command",
  );
}
