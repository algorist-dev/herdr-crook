// スマホの入力欄で「/」を打ったときのコマンド一覧。
// 組み込みのコマンド（固定）に、Mac にあるコマンドとスキルのファイル（動的）を足して返す。
// どのエージェントが何を出すかはプロバイダ（providers/<名前>/commands.ts）が決める。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { defaultProviders } from "../providers/defaults.ts";
import { COMMON } from "../providers/shared/commandFiles.ts";

export type SlashCommandKind = "command" | "skill";

export interface SlashCommandInfo {
  name: string;
  summary: string;
  kind: SlashCommandKind;
}

const MAX_COMMANDS = 200;

/** そのエージェントの組み込みコマンド。分からない種類でも clear と help は出す */
export function builtinSlashCommands(agent: string | null | undefined): SlashCommandInfo[] {
  return defaultProviders().get(agent)?.builtinCommands?.() ?? COMMON;
}

export interface SlashCommandSources {
  agent: string | null | undefined;
  cwd?: string | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** 組み込み＋Mac のファイルから集めた一覧。同じ名前は動的なほうを優先する */
export function listSlashCommands(sources: SlashCommandSources): SlashCommandInfo[] {
  const home = sources.home ?? homedir();
  const env = sources.env ?? process.env;
  const cwd = sources.cwd && existsSync(sources.cwd) ? sources.cwd : null;
  const discovered = discoverSlashCommands(sources.agent, cwd, home, env);
  const merged = new Map<string, SlashCommandInfo>();
  for (const item of builtinSlashCommands(sources.agent)) merged.set(item.name, item);
  for (const item of discovered) {
    const existing = merged.get(item.name);
    // スキルが同じ名前のコマンドを隠さない（/clear などが別物にならないように）
    if (existing?.kind === "command" && item.kind === "skill") continue;
    merged.set(item.name, item);
  }
  return [...merged.values()].slice(0, MAX_COMMANDS);
}

/** Mac にあるコマンドとスキルのファイルから一覧を作る（読めなくても止めない） */
export function discoverSlashCommands(
  agent: string | null | undefined,
  cwd: string | null,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): SlashCommandInfo[] {
  return defaultProviders().get(agent)?.discoverCommands?.(cwd, home, env) ?? [];
}
