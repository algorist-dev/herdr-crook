// Codex の「/」に出すコマンド。組み込みの一覧と、Mac のファイルから集める場所。
import { join } from "node:path";
import type { SlashCommandInfo } from "../../features/slashCommands.ts";
import { command, readCommands } from "../shared/commandFiles.ts";

const CODEX: SlashCommandInfo[] = [
  command("clear", "会話を消して、最初からにする"),
  command("compact", "会話を要約して短くする"),
  command("new", "新しい会話を始める"),
  command("model", "モデルとエフォートを選ぶ"),
  command("plan", "プランモードに切り替える"),
  command("review", "いまの変更を見直す"),
  command("init", "AGENTS.md を作る"),
  command("status", "状態と使用量を見る"),
  command("help", "使えるコマンドを見る"),
];

export function codexBuiltinCommands(): SlashCommandInfo[] {
  return CODEX;
}

export function discoverCodexCommands(home: string, env: NodeJS.ProcessEnv): SlashCommandInfo[] {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  return readCommands([join(codexHome, "prompts")], "command");
}
