import { TranscriptReader, type ParsedTranscript } from "./transcript.ts";
import type { TranscriptUsage } from "../../features/usage.ts";
import type { ChatPoll, ChatStream } from "../types.ts";

export interface JsonlChatOptions {
  /** いまの chatId（毎回呼ぶ） */
  key: () => string | null;
  /** chatId → 会話記録のファイル。まだなければ null */
  resolve: (key: string) => string | null;
  /** 読み方。省略すると Claude の読み方 */
  parse?: (lines: string[], base: number) => ParsedTranscript;
  /** 最初に送る件数（長い会話は最後のほうだけ） */
  initialLimit?: number;
  /** 送る前に使用量を手直しする（Claude が statusline の JSON を重ねるため）。key は読んでいる会話の chatId */
  mapUsage?: (usage: TranscriptUsage | null, key: string) => TranscriptUsage | null;
}

export function jsonlChatStream(opts: JsonlChatOptions): ChatStream {
  const limit = opts.initialLimit ?? 150;
  let reader: TranscriptReader | null = null;
  let readerKey: string | null = null;
  let first = true;

  const usageOf = (r: TranscriptReader, key: string) => (opts.mapUsage ? opts.mapUsage(r.usage, key) : r.usage);

  const start = (path: string, key: string): ChatPoll => {
    const r = new TranscriptReader(path, opts.parse);
    reader = r;
    readerKey = key;
    const got = r.read();
    return { chat: { available: true, reset: true, title: got.title, items: got.items.slice(-limit) }, usage: usageOf(r, key) };
  };

  return {
    poll(): ChatPoll {
      const key = opts.key();
      const path = key ? opts.resolve(key) : null;
      if (first) {
        first = false;
        // 起動したばかりの Claude は、最初に送るまで記録がない。できるまで available:false
        if (key && path) return start(path, key);
        return { chat: { available: false, reset: true, title: null, items: [] } };
      }
      // /clear や /new で会話が切り替わったら、新しい記録を最初から送り直す
      if (key && path && (key !== readerKey || path !== reader?.path)) return start(path, key);
      const r = reader;
      if (!r || readerKey === null) return { chat: null };
      const more = r.read();
      return {
        chat: more.items.length > 0 ? { available: true, reset: false, title: more.title, items: more.items } : null,
        usage: usageOf(r, readerKey),
      };
    },
    close() {
      reader = null;
    },
  };
}
