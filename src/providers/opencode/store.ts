// OpenCode の会話（~/.local/share/opencode/opencode.db）を読んで、Claude と同じチャットの形にする。
// Orca にはない Crook の強み：OpenCode もスマホで会話として見られる。
// データベースは読むだけ（readOnly）。OpenCode が書いている途中でも読めるように、そのつど短く問い合わせる。
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { ChatItem, Transcript } from "../shared/transcript.ts";
import { buildToolDetail, type ToolDetail } from "../shared/toolDetail.ts";
import { tokenTotal, type TranscriptUsage, type UsageTokens } from "../../features/usage.ts";

export const DEFAULT_OPENCODE_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");

type Rec = Record<string, unknown>;

export interface OpenCodeChat extends Transcript {
  usage?: TranscriptUsage;
}

interface SessionRow {
  id: string;
  title: string;
  cost?: number | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_reasoning?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  model?: string | null;
}

export class OpenCodeStore {
  private db: DatabaseSync | null = null;
  private readonly path: string;

  constructor(path = DEFAULT_OPENCODE_DB) {
    this.path = path;
  }

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    if (!existsSync(this.path)) return null;
    try {
      this.db = new DatabaseSync(this.path, { readOnly: true });
      return this.db;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** そのフォルダのいちばん新しい会話。なければ null */
  read(directory: string, limit = 150): OpenCodeChat | null {
    const db = this.open();
    if (!db) return null;
    try {
      const session = db
        .prepare(
          `select id, title, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model
             from session where directory = ? and parent_id is null and time_archived is null order by time_updated desc limit 1`,
        )
        .get(directory) as SessionRow | undefined;
      if (!session) return null;
      const rows = db
        .prepare(
          `select p.id as id, p.data as data, m.data as message
             from part p join message m on m.id = p.message_id
            where p.session_id = ?
            order by m.time_created, p.id`,
        )
        .all(session.id) as { id: string; data: string; message: string }[];
      const items: ChatItem[] = [];
      for (const row of rows) {
        const item = toItem(row.id, parse(row.data), parse(row.message), directory);
        if (item) items.push(item);
      }
      const title = session.title.startsWith("New session - ") ? null : session.title;
      const usage = usageOf(db, session);
      return { title, items: items.slice(-limit), ...(usage ? { usage } : {}) };
    } catch {
      // OpenCode が作り直したなど。次は開き直す
      this.close();
      return null;
    }
  }

  /** 1 件のツール（part の id）の中身。無ければ null */
  toolDetail(itemId: string): ToolDetail | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare("select data from part where id = ?").get(itemId) as { data: string } | undefined;
      return row ? toolDetailFromPart(parse(row.data)) : null;
    } catch {
      this.close();
      return null;
    }
  }

  title(directory: string): string | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db
        .prepare("select title from session where directory = ? and parent_id is null and time_archived is null order by time_updated desc limit 1")
        .get(directory) as { title: string } | undefined;
      return row && !row.title.startsWith("New session - ") ? row.title : null;
    } catch {
      this.close();
      return null;
    }
  }
}

/** part の state.input と state.output から、ツールの中身を作る */
export function toolDetailFromPart(part: Rec): ToolDetail | null {
  if (part.type !== "tool") return null;
  const state = (part.state ?? {}) as Rec;
  const status = typeof state.status === "string" ? state.status : null;
  const output = state.output;
  return buildToolDetail({
    name: typeof part.tool === "string" ? part.tool : "tool",
    input: state.input ?? {},
    output: typeof output === "string" ? output : output === undefined || output === null ? "" : JSON.stringify(output),
    running: status === "running",
    error: status === "error",
  });
}

/** セッションの集計と、いちばん新しい返事のトークンから、使用量を読む */
function usageOf(db: DatabaseSync, session: SessionRow): TranscriptUsage | null {
  const model = modelOf(session.model);
  const tokens: UsageTokens = {
    input: count(session.tokens_input),
    output: count(session.tokens_output),
    cacheRead: count(session.tokens_cache_read),
    cacheWrite: count(session.tokens_cache_write),
    reasoning: count(session.tokens_reasoning),
  };
  const hasTokens = tokenTotal(tokens) > 0;
  let contextUsed: number | null = null;
  const rows = db
    .prepare("select data from message where session_id = ? order by time_created desc limit 20")
    .all(session.id) as { data: string }[];
  for (const row of rows) {
    const message = parse(row.data);
    if (message.role !== "assistant") continue;
    const t = message.tokens as Rec | undefined;
    if (!t || typeof t !== "object") continue;
    const cache = (t.cache ?? {}) as Rec;
    const total = count(t.total);
    const used = total > 0 ? total : count(t.input) + count(t.output) + count(t.reasoning) + count(cache.read) + count(cache.write);
    if (used > 0) {
      contextUsed = used;
      break;
    }
  }
  if (!model.id && !hasTokens && contextUsed === null && !session.cost) return null;
  return {
    model: model.id,
    provider: model.provider,
    contextUsed,
    contextLimit: null,
    contextPercent: null,
    tokens: hasTokens ? tokens : null,
    cost: typeof session.cost === "number" ? session.cost : null,
    limits: [],
    source: "opencode",
  };
}

function modelOf(raw: string | null | undefined): { id: string | null; provider: string | null } {
  if (!raw) return { id: null, provider: null };
  const v = parse(raw);
  return {
    id: typeof v.id === "string" ? v.id : null,
    provider: typeof v.providerID === "string" ? v.providerID : null,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function parse(text: string): Rec {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Rec) : {};
  } catch {
    return {};
  }
}

function toItem(id: string, part: Rec, message: Rec, directory: string): ChatItem | null {
  const role = message.role === "user" ? "user" : "assistant";
  if (part.type === "text") {
    if (part.synthetic === true || typeof part.text !== "string" || !part.text.trim()) return null;
    return { id, role, kind: "text", text: part.text };
  }
  if (part.type === "tool" && role === "assistant") {
    const name = typeof part.tool === "string" ? part.tool : "tool";
    const input = ((part.state as Rec | undefined)?.input ?? {}) as Rec;
    return { id, role, kind: "tool", tool: name.charAt(0).toUpperCase() + name.slice(1), text: summarize(input, directory) };
  }
  return null;
}

/** ツールの中身を 1 行で（コマンド・ファイル・探した言葉など） */
function summarize(input: Rec, directory: string): string {
  for (const key of ["command", "filePath", "path", "pattern", "url", "query", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value) {
      return key === "filePath" || key === "path" ? shortPath(value, directory) : value.split("\n")[0]!;
    }
  }
  const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  return first?.split("\n")[0] ?? "";
}

function shortPath(path: string, directory: string): string {
  const rel = relative(directory, path);
  return rel && !rel.startsWith("..") ? rel : path;
}
