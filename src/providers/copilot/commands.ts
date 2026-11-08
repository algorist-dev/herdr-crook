// Copilot の「/」に出すコマンド。組み込みは共通のものだけ、ファイルは ~/.copilot/prompts から集める。
import { join } from "node:path";
import type { SlashCommandInfo } from "../../features/slashCommands.ts";
import { COMMON, readCommands } from "../shared/commandFiles.ts";

export function copilotBuiltinCommands(): SlashCommandInfo[] {
  return COMMON;
}

export function discoverCopilotCommands(home: string): SlashCommandInfo[] {
  return readCommands([join(home, ".copilot", "prompts")], "command");
}
