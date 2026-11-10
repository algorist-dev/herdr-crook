// Gemini CLI のプロバイダ。会話の表示・題名・ツールの中身・使用量と、確認なしの立ち上げ（--yolo）。
// Herdr に Gemini の連携は無いので、作業フォルダのいちばん新しい記録を読む（gemini:<フォルダ>。Codex・Copilot と同じ）。
// モデルの切り替えは /model set（models.ts）。「/」の候補はまだ入れない。
import type { AgentModel, AgentProvider } from "../types.ts";
import { jsonlChatStream } from "../shared/jsonlChat.ts";
import { TranscriptReader } from "../shared/transcript.ts";
import { createGeminiModels } from "./models.ts";
import { createGeminiParser, findGeminiSession, geminiHome, geminiToolDetail } from "./transcript.ts";

export interface GeminiProviderOptions {
  /** 作業フォルダ → いちばん新しい記録。既定は findGeminiSession(dir, geminiHome()) */
  find?: (cwd: string) => string | null;
  /** モデルの一覧。既定は gemini --list-models（テストでは差しかえる） */
  models?: () => Promise<AgentModel[]>;
}

const PREFIX = "gemini:";

export function createGeminiProvider(opts: GeminiProviderOptions = {}): AgentProvider {
  const find = opts.find ?? ((cwd: string) => findGeminiSession(cwd, geminiHome()));
  const titleReaders = new Map<string, TranscriptReader>();
  const pathOf = (key: string): string | null => (key.startsWith(PREFIX) ? find(key.slice(PREFIX.length)) : null);

  return {
    id: "gemini",
    unattendedArgs: ["--yolo"],
    chatKey: (_record, cwd) => (cwd ? `${PREFIX}${cwd}` : null),
    models: createGeminiModels(opts.models),
    chat: {
      // 読み方は記録ごとに覚えることがあるので、開くたびに作る
      open: (key) => jsonlChatStream({ key, resolve: pathOf, parse: createGeminiParser() }),
      title(key) {
        const path = pathOf(key);
        if (!path) return null;
        let reader = titleReaders.get(path);
        if (!reader) {
          if (titleReaders.size >= 64) titleReaders.clear();
          reader = new TranscriptReader(path, createGeminiParser());
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
        return path ? geminiToolDetail(path, itemId) : null;
      },
    },
  };
}
