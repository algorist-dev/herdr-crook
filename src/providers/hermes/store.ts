// Hermes Agent の会話（$HERMES_HOME/state.db、既定 ~/.hermes/state.db）を、Claude と同じチャットの形にする。
// 0.23 で実物を見て作った（docs/agents-support.md の 5）。書くのは Hermes の gateway だけなので、こちらは読むだけ（readOnly）。
// messages の active=0 は縮めたときの古い世代なので読まない。
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatItem, Transcript } from "../shared/transcript.ts";
import { buildToolDetail, type ToolDetail } from "../shared/toolDetail.ts";
import { contextPercent, type TranscriptUsage } from "../../features/usage.ts";

type Rec = Record<string, unknown>;

export function hermesHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const h = env.HERMES_HOME;
  return h && h.trim() ? h : join(home, ".hermes");
}

export interface HermesChat extends Transcript {
  usage: TranscriptUsage | null;
}

interface MessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  message_uid: string | null;
  display_kind: string | null;
}

interface ToolCallJson {
  id: string;
  name: string;
  args: unknown;
}

function callsOf(json: string | null): ToolCallJson[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return [];
    return (list as Rec[]).flatMap((c) => {
      const fn = (c?.function ?? {}) as Rec;
      const id = typeof c?.id === "string" ? c.id : typeof c?.call_id === "string" ? c.call_id : null;
      if (!id) return [];
      let args: unknown = fn.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          // 文字のまま
        }
      }
      return [{ id, name: typeof fn.name === "string" ? fn.name : "tool", args }];
    });
  } catch {
    return [];
  }
}

function toolText(args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Rec;
    for (const k of ["command", "path", "file_path", "pattern", "query", "url"]) if (typeof a[k] === "string") return (a[k] as string).slice(0, 300);
    return JSON.stringify(args).slice(0, 300);
  }
  return typeof args === "string" ? args.slice(0, 300) : "";
}

const keyOf = (row: MessageRow) => row.message_uid ?? `m${row.id}`;

const SUMMARY_END = "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---";
const PRIOR_START = "[PRIOR CONTEXT — for reference only; not a new message]";
const PRIOR_END = "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]";

/**
 * 会話に出す文。Hermes が自分で入れた行（要約・お知らせ）は人の発言にしない（Hermes 自身の画面と同じ）。
 * 要約は本当の発言の行に混ざることがあるので、そのときは発言のところだけ残す
 */
function chatText(row: MessageRow): string {
  const text = (row.content ?? "").trim();
  if (row.display_kind === "hidden") return "";
  if (row.role === "user" && row.display_kind && row.display_kind !== "steer") return "";
  if (row.role === "user" && text.startsWith("[System:")) {
    // お知らせのすぐ後に人の発言が続くと、Hermes は 1 行にまとめる。発言は消さない
    const paragraphs = text.split("\n\n");
    return paragraphs.slice(paragraphs.findIndex((p) => !p.startsWith("[System:")) >>> 0).join("\n\n").trim();
  }
  if (text.startsWith(PRIOR_START)) {
    const end = text.indexOf(PRIOR_END);
    if (end >= 0) return text.slice(PRIOR_START.length, end).trim();
  }
  if (text.startsWith("[CONTEXT COMPACTION") || text.startsWith("[CONTEXT SUMMARY]")) {
    const end = text.indexOf(SUMMARY_END);
    return end >= 0 ? text.slice(end + SUMMARY_END.length).trim() : "";
  }
  return text;
}

// ツールの名前 → 中身の見せ方（shared/toolDetail.ts の名前）
const DETAIL_NAME: Record<string, string> = {
  terminal: "bash",
  read_file: "read",
  write_file: "write",
  patch: "edit",
  search_files: "grep",
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export class HermesStore {
  private db: DatabaseSync | null = null;
  private readonly path: string;

  constructor(path = join(hermesHome(), "state.db")) {
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

  /** chatOnly：会話に出す行（発言と返事）だけ。ツールの結果は大きいことがあるので、中身を見るときだけ読む */
  private messages(sessionId: string, chatOnly = false): MessageRow[] {
    const db = this.open();
    if (!db) return [];
    // display_kind の列が無い古い Hermes でも、会話が読めなくならないように
    const columns = db.prepare("PRAGMA table_info(messages)").all() as unknown as { name: string }[];
    const displayKind = columns.some((c) => c.name === "display_kind") ? "display_kind" : "NULL AS display_kind";
    return db
      .prepare(
        `SELECT id, role, content, tool_calls, tool_call_id, message_uid, ${displayKind} FROM messages WHERE session_id = ? AND active = 1${
          chatOnly ? " AND role IN ('user', 'assistant')" : ""
        } ORDER BY id`,
      )
      .all(sessionId) as unknown as MessageRow[];
  }

  /** その会話。見つからなければ null、読んでいる途中のエラー（書き込みと重なったなど）なら undefined */
  read(sessionId: string, limit = 150): HermesChat | null | undefined {
    const db = this.open();
    if (!db) return null;
    try {
      const session = db
        .prepare(
          "SELECT title, model, billing_provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd FROM sessions WHERE id = ?",
        )
        .get(sessionId) as Rec | undefined;
      if (!session) return null;
      const items: ChatItem[] = [];
      for (const row of this.messages(sessionId, true)) {
        const key = keyOf(row);
        const text = chatText(row);
        if (row.role === "user") {
          if (text) items.push({ id: key, role: "user", kind: "text", text });
        } else if (row.role === "assistant") {
          if (text) items.push({ id: key, role: "assistant", kind: "text", text });
          for (const call of callsOf(row.tool_calls)) {
            items.push({ id: `${key}:${call.id}`, role: "assistant", kind: "tool", tool: call.name, text: toolText(call.args) });
          }
        }
      }
      const tokens = {
        input: num(session.input_tokens),
        output: num(session.output_tokens),
        cacheRead: num(session.cache_read_tokens),
        cacheWrite: num(session.cache_write_tokens),
        reasoning: num(session.reasoning_tokens),
      };
      const usage: TranscriptUsage = {
        model: typeof session.model === "string" ? session.model : null,
        provider: typeof session.billing_provider === "string" ? session.billing_provider : null,
        contextUsed: null,
        contextLimit: null,
        contextPercent: contextPercent(null, null),
        tokens,
        cost: typeof session.estimated_cost_usd === "number" ? session.estimated_cost_usd : null,
        limits: [],
        source: "hermes",
      };
      return { title: typeof session.title === "string" ? session.title : null, items: items.slice(-limit), usage };
    } catch {
      // 書き込みと重なった・ファイルが入れ替わった・形が違う（Hermes の版が違う）など。次は開き直す
      this.close();
      return undefined;
    }
  }

  title(sessionId: string): string | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare("SELECT title FROM sessions WHERE id = ?").get(sessionId) as Rec | undefined;
      return typeof row?.title === "string" ? row.title : null;
    } catch {
      return null;
    }
  }

  /** 1 件のツール（item.id は `<message_uid>:<呼び出しの id>`）の中身。無ければ null */
  toolDetail(sessionId: string, itemId: string): ToolDetail | null {
    try {
      const rows = this.messages(sessionId);
      for (const row of rows) {
        if (row.role !== "assistant" || !itemId.startsWith(`${keyOf(row)}:`)) continue;
        const callId = itemId.slice(keyOf(row).length + 1);
        const call = callsOf(row.tool_calls).find((c) => c.id === callId);
        if (!call) continue;
        const result = rows.find((r) => r.role === "tool" && r.tool_call_id === callId);
        const parsed = resultOf(result?.content ?? null);
        return buildToolDetail({
          name: DETAIL_NAME[call.name] ?? call.name,
          input: call.args,
          output: result ? parsed.text : null,
          running: !result,
          error: parsed.error,
        });
      }
      return null;
    } catch {
      return null;
    }
  }
}

/** ツールの結果（多くは JSON の文字：{output, exit_code, error} や {content, ...}） */
function resultOf(content: string | null): { text: string; error: boolean } {
  if (!content) return { text: "", error: false };
  try {
    const r = JSON.parse(content) as Rec;
    if (r && typeof r === "object") {
      const error = typeof r.error === "string" && r.error.length > 0 || (typeof r.exit_code === "number" && r.exit_code !== 0);
      const text = typeof r.output === "string" ? r.output : typeof r.content === "string" ? r.content : typeof r.error === "string" ? r.error : content;
      return { text, error };
    }
  } catch {
    // ただの文字
  }
  return { text: content, error: false };
}
