// Claude Code の「/」に出すコマンド。組み込みの一覧と、Mac のファイルから集める場所。
import { join } from "node:path";
import type { SlashCommandInfo } from "../../features/slashCommands.ts";
import { command, readCommands, readSkills } from "../shared/commandFiles.ts";

const CLAUDE: SlashCommandInfo[] = [
  command("clear", "会話を消して、最初からにする"),
  command("compact", "会話を要約して短くする"),
  command("init", "CLAUDE.md を作る"),
  command("review", "いまの変更を見直す"),
  command("help", "使えるコマンドを見る"),
];

export function claudeBuiltinCommands(): SlashCommandInfo[] {
  return CLAUDE;
}

export function discoverClaudeCommands(cwd: string | null, home: string): SlashCommandInfo[] {
  return [
    ...readCommands([join(home, ".claude", "commands"), ...(cwd ? [join(cwd, ".claude", "commands")] : [])], "command"),
    ...readSkills([join(home, ".claude", "skills"), ...(cwd ? [join(cwd, ".claude", "skills")] : [])]),
  ];
}
