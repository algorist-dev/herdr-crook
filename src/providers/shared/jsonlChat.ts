import { TranscriptReader, type ChatItem, type ParsedTranscript } from "./transcript.ts";
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
  /** 読んだ会話を覚えておく場所（プロバイダごとに 1 つ）。省略すると開くたびに最初から読む */
  cache?: ChatCache;
}

/** 1 つの会話記録を読んだ結果。最後のほうの発言だけを持ち、増えた分だけ読み足す */
class CachedChat {
  reader: TranscriptReader;
  /** 最後のほうの発言（keep 件まで） */
  items: ChatItem[] = [];
  /** これまでに足した発言の数（見ている側が、どこまで受け取ったかを比べる） */
  seq = 0;
  /** 最初から読み直した回数。変わったら見ている側は全部を送り直す */
  generation = 0;
  title: string | null = null;
  private readonly path: string;
  private readonly parse: ((lines: string[], base: number) => ParsedTranscript) | undefined;
  private readonly keep: number;

  constructor(path: string, parse: ((lines: string[], base: number) => ParsedTranscript) | undefined, keep: number) {
    this.path = path;
    this.parse = parse;
    this.keep = keep;
    this.reader = new TranscriptReader(path, parse);
  }

  /** 増えた分を読む */
  refresh(): void {
    let got = this.reader.read();
    if (this.reader.needsRestart) {
      // 巻き戻し・書き直しで出したものが消えた。最初から読み直して入れ替える（読み直しは 1 回だけ）
      this.reader = new TranscriptReader(this.path, this.parse);
      this.items = [];
      this.title = null;
      this.generation++;
      got = this.reader.read();
    }
    this.title = got.title;
    if (got.items.length === 0) return;
    // 長い記録の最初の読み取りは何万件にもなる。必要な分だけ残す（push(...) に全部渡すとスタックがあふれる）
    const tail = got.items.length > this.keep ? got.items.slice(-this.keep) : got.items;
    this.items = this.items.concat(tail);
    if (this.items.length > this.keep) this.items = this.items.slice(-this.keep);
    this.seq += got.items.length;
  }
}

/**
 * 開いた会話を覚えておく（プロバイダごとに 1 つ）。
 * 長い会話（100 MB を超える Claude の記録）を開き直すたびに最初から読むと、そのあいだ中継が 1 秒ほど止まり、
 * ほかの知らせも遅れていた（2026-11-16）。覚えておけば、開き直したときは増えた分だけ読む
 */
export class ChatCache {
  private readonly entries = new Map<string, CachedChat>();
  private readonly max: number;

  constructor(max = 16) {
    this.max = max;
  }

  /** 題名を読むためだけに使う。あれば並びを変えずに返す（一覧の題名で、開いている会話を押し出さない） */
  peekOrAdd(path: string, parse: ((lines: string[], base: number) => ParsedTranscript) | undefined, keep: number): CachedChat {
    return this.entries.get(path) ?? this.get(path, parse, keep);
  }

  get(path: string, parse: ((lines: string[], base: number) => ParsedTranscript) | undefined, keep: number): CachedChat {
    let entry = this.entries.get(path);
    if (entry) {
      // 最近使ったものを後ろへ（古いものから捨てる）
      this.entries.delete(path);
    } else {
      entry = new CachedChat(path, parse, keep);
    }
    this.entries.set(path, entry);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }
}

export function jsonlChatStream(opts: JsonlChatOptions): ChatStream {
  const limit = opts.initialLimit ?? 150;
  const cache = opts.cache ?? new ChatCache(1);
  let entry: CachedChat | null = null;
  let entryKey: string | null = null;
  let entryPath: string | null = null;
  let generation = 0;
  let seen = 0;
  let first = true;

  const usageOf = (e: CachedChat, key: string) => (opts.mapUsage ? opts.mapUsage(e.reader.usage, key) : e.reader.usage);

  const sendAll = (e: CachedChat, key: string): ChatPoll => {
    generation = e.generation;
    seen = e.seq;
    return { chat: { available: true, reset: true, title: e.title, items: e.items.slice(-limit) }, usage: usageOf(e, key) };
  };

  const start = (path: string, key: string): ChatPoll => {
    const e = cache.get(path, opts.parse, limit * 2);
    entry = e;
    entryKey = key;
    entryPath = path;
    e.refresh();
    return sendAll(e, key);
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
      if (key && path && (key !== entryKey || path !== entryPath)) return start(path, key);
      const e = entry;
      if (!e || entryKey === null) return { chat: null };
      e.refresh();
      // 巻き戻しで読み直した、または覚えている分より多く増えた（ほかの画面が先に読んだ）ら、全部を送り直す
      const added = e.seq - seen;
      if (e.generation !== generation || added > e.items.length) return sendAll(e, entryKey);
      seen = e.seq;
      return {
        chat: added > 0 ? { available: true, reset: false, title: e.title, items: e.items.slice(-added) } : null,
        usage: usageOf(e, entryKey),
      };
    },
    close() {
      entry = null;
    },
  };
}
