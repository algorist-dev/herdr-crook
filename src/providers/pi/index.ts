// Pi のプロバイダ。会話の表示・題名・ツールの中身・使用量。
// Pi はもともとツールを使う前に承認を求めない（公式の security.md）ので、「確認なし」の引数は持たない（iPhone にも切り替えを出さない）。
// モデルの切り替えは /model（models.ts）。「/」の候補はまだ入れない。
import { isAbsolute } from "node:path";
import type { AgentModel, AgentProvider } from "../types.ts";
import { createPiModels } from "./models.ts";
import { jsonlChatStream } from "../shared/jsonlChat.ts";
import { TranscriptReader } from "../shared/transcript.ts";
import { findPiSession, parsePiLines, piAgentDir, piToolDetail } from "./transcript.ts";

export interface PiProviderOptions {
  /** Pi のエージェントのフォルダ。既定は piAgentDir()（呼ばれたときに決める） */
  agentDir?: string;
  /** モデルの一覧。既定は pi --list-models（テストでは差しかえる） */
  models?: () => Promise<AgentModel[]>;
}

const PREFIX = "pi:";

export function createPiProvider(opts: PiProviderOptions = {}): AgentProvider {
  const agentDir = () => opts.agentDir ?? piAgentDir();
  const titleReaders = new Map<string, TranscriptReader>();

  // chatId：Herdr が知らせた記録の場所（絶対パスの .jsonl）か、pi:<作業フォルダ>
  const pathOf = (key: string): string | null => {
    if (key.startsWith(PREFIX)) return findPiSession(key.slice(PREFIX.length), agentDir());
    return isAbsolute(key) && key.endsWith(".jsonl") ? key : null;
  };

  return {
    id: "pi",
    models: createPiModels(opts.models),
    chatKey: (record, cwd) => {
      const value = record.sessionSource === "herdr:pi" ? record.sessionValue : null;
      if (value && isAbsolute(value) && value.endsWith(".jsonl")) return value;
      return cwd ? `${PREFIX}${cwd}` : null;
    },
    chat: {
      open: (key) => jsonlChatStream({ key, resolve: pathOf, parse: parsePiLines }),
      title(key) {
        const path = pathOf(key);
        if (!path) return null;
        let reader = titleReaders.get(path);
        if (!reader) {
          // 古い会話の分をためこまない（一覧に出るのは今あるペインの分だけ）
          if (titleReaders.size >= 64) titleReaders.clear();
          reader = new TranscriptReader(path, parsePiLines);
          titleReaders.set(path, reader);
        }
        try {
          return reader.read().title;
        } catch {
          titleReaders.delete(path);
          return null;
        }
      },
      toolDetail: (key, itemId) => {
        const path = pathOf(key);
        return path ? piToolDetail(path, itemId) : null;
      },
    },
  };
}
