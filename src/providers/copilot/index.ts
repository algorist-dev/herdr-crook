// GitHub Copilot CLI のプロバイダ。会話・題名・「/」のコマンドを、いまの copilotTranscript.ts と
// slashCommands.ts に任せる。モデルの切り替えはまだ無いので models は付けない。
import type { AgentProvider } from "../types.ts";
import { jsonlChatStream } from "../shared/jsonlChat.ts";
import { copilotHome, copilotToolDetail, findCopilotSession, parseCopilotLines } from "./transcript.ts";
import { copilotBuiltinCommands, discoverCopilotCommands } from "./commands.ts";

export interface CopilotProviderOptions {
  /** 作業フォルダ → いちばん新しい会話。既定は findCopilotSession(dir, copilotHome()) */
  find?: (cwd: string) => { path: string; title: string | null } | null;
}

const PREFIX = "copilot:";

export function createCopilotProvider(opts: CopilotProviderOptions = {}): AgentProvider {
  const find = opts.find ?? ((cwd: string) => findCopilotSession(cwd, copilotHome()));

  // chatId から作業フォルダを取り出して、その会話を探す。copilot: でなければ読まない
  const sessionOf = (key: string) => {
    if (!key.startsWith(PREFIX)) return null;
    return find(key.slice(PREFIX.length));
  };

  return {
    id: "copilot",
    unattendedArgs: ["--allow-all"],
    chatKey: (_record, cwd) => (cwd ? `${PREFIX}${cwd}` : null),
    chat: {
      open: (key) =>
        jsonlChatStream({
          key,
          resolve: (k) => sessionOf(k)?.path ?? null,
          parse: parseCopilotLines,
        }),
      title: (chatKey) => sessionOf(chatKey)?.title ?? null,
      toolDetail: (chatKey, itemId) => {
        const path = sessionOf(chatKey)?.path;
        return path ? copilotToolDetail(path, itemId) : null;
      },
    },
    builtinCommands: () => copilotBuiltinCommands(),
    discoverCommands: (_cwd, home) => discoverCopilotCommands(home),
  };
}
