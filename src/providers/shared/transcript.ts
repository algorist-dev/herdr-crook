// 会話記録をスマホのチャット表示に出す形と、前回の続きから読む部品。
// 読み方（Claude・Codex・Copilot）はプロバイダごとに渡す。
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { mergeUsage, type ParsedUsage, type TranscriptUsage } from "../../features/usage.ts";
import { parseTranscriptLines } from "../claude/transcript.ts";

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  kind: "text" | "tool";
  text: string;
  /** kind が tool のときのツールの名前（Bash・Read など） */
  tool?: string;
}

export interface Transcript {
  title: string | null;
  items: ChatItem[];
}

/** 1 回の読み取りの結果。usage は「今回読んだ分」で、TranscriptReader が足していく */
export interface ParsedTranscript extends Transcript {
  usage?: ParsedUsage;
  /** 出したものの一部が消えた（Gemini の巻き戻し）。最初から読み直す */
  restart?: boolean;
}

/** 会話記録を前回の続きから読む。最初は全部、そのあとは増えた分だけ。 */
export class TranscriptReader {
  private offset = 0;
  private carry = "";
  private title: string | null = null;
  /** これまでの使用量（読んだ分を足していく） */
  private usageState: TranscriptUsage | null = null;
  /** 読んだ行の数（Codex の ID に使う） */
  private lineCount = 0;
  /** 読み方が「最初から読み直して」と言った */
  private restartWanted = false;
  readonly path: string;
  private readonly parse: (lines: string[], base: number) => ParsedTranscript;

  /** parse：読み方（ふつうは Claude。Codex は parseCodexLines） */
  constructor(path: string, parse: (lines: string[], base: number) => ParsedTranscript = (lines) => parseTranscriptLines(lines)) {
    this.path = path;
    this.parse = parse;
  }

  /** 最初から読み直すべきか（jsonlChatStream が見て、読み直して reset で送る） */
  get needsRestart(): boolean {
    return this.restartWanted;
  }

  /** いままでに読んだ使用量（まだ無ければ null） */
  get usage(): TranscriptUsage | null {
    return this.usageState;
  }

  read(): Transcript {
    const size = statSync(this.path).size;
    if (size < this.offset) {
      // 書き直された（小さくなった）ら最初から
      this.offset = 0;
      this.carry = "";
      this.lineCount = 0;
      this.usageState = null;
    }
    if (size === this.offset) return { title: this.title, items: [] };
    const fd = openSync(this.path, "r");
    try {
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, this.offset);
      this.offset = size;
      const text = this.carry + buffer.toString("utf8");
      const lines = text.split("\n");
      this.carry = lines.pop() ?? "";
      const kept = lines.filter((l) => l.trim());
      const parsed = this.parse(kept, this.lineCount);
      this.lineCount += kept.length;
      if (parsed.restart) this.restartWanted = true;
      if (parsed.title) this.title = parsed.title;
      if (parsed.usage) this.usageState = mergeUsage(this.usageState, parsed.usage);
      return { title: this.title, items: parsed.items };
    } finally {
      closeSync(fd);
    }
  }
}
