// Codex の会話の記録（~/.codex/sessions/年/月/日/rollout-….jsonl）を、Claude と同じチャットの形にする。
// Herdr は Codex の会話の ID を知らないので、OpenCode と同じく「その作業フォルダのいちばん新しい会話」を読む（codex:<フォルダ>）。
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChatItem, ParsedTranscript } from "../shared/transcript.ts";
import { buildToolDetail, type ToolDetail } from "../shared/toolDetail.ts";
import { millisAt, windowLabel, type ParsedUsage, type UsageLimit, type UsageTokens } from "../../features/usage.ts";

type Rec = Record<string, unknown>;

/** Codex への決まった指示（環境の説明など）。会話には出さない */
function isNoise(text: string): boolean {
  const t = text.trimStart();
  return (
    /^<(environment_context|user_instructions|skills_instructions|permissions|collaboration_mode|turn_aborted|skill|user_shell_command|subagent_notification)\b/.test(t) ||
    t.startsWith("# AGENTS.md instructions") ||
    t.startsWith("Another language model started to solve this problem") // 会話を縮めたときの要約
  );
}

function textOf(content: unknown, kind: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return "";
  return (content as Rec[])
    .filter((b) => b.type === kind && typeof b.text === "string" && !isNoise(b.text as string))
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

function toolText(p: Rec): string {
  const raw = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : "";
  try {
    const v = JSON.parse(raw) as Rec;
    const cmd = v.command ?? v.cmd;
    if (Array.isArray(cmd)) return cmd.join(" ");
    if (typeof cmd === "string") return cmd;
  } catch {
    // そのまま
  }
  return raw.slice(0, 300);
}

/** base：ファイルの何行目からか（少しずつ読むときも ID が重ならないように） */
export function parseCodexLines(lines: string[], base = 0): ParsedTranscript {
  let title: string | null = null;
  const items: ChatItem[] = [];
  let usage: ParsedUsage | undefined;
  lines.forEach((raw, i) => {
    let row: Rec;
    try {
      row = JSON.parse(raw) as Rec;
    } catch {
      return;
    }
    if (row.type === "turn_context") {
      const p = row.payload as Rec | undefined;
      if (typeof p?.model === "string") {
        usage ??= { source: "codex" };
        usage.model = p.model;
      }
      return;
    }
    if (row.type === "event_msg") {
      const p = row.payload as Rec | undefined;
      if (p?.type !== "token_count") return;
      const info = p.info as Rec | undefined;
      const found = tokenCountUsage(info, p.rate_limits);
      if (found) {
        usage ??= { source: "codex" };
        Object.assign(usage, found);
      }
      return;
    }
    if (row.type !== "response_item") return;
    const p = row.payload as Rec | undefined;
    if (!p) return;
    const id = `cx${base + i}`;
    if (p.type === "message" && p.role === "user") {
      const text = textOf(p.content, "input_text");
      if (!text) return;
      title ??= text.split("\n")[0]!.slice(0, 60);
      items.push({ id, role: "user", kind: "text", text });
    } else if (p.type === "message" && p.role === "assistant") {
      const text = textOf(p.content, "output_text");
      if (text) items.push({ id, role: "assistant", kind: "text", text });
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const name = typeof p.name === "string" ? p.name : "tool";
      items.push({ id, role: "assistant", kind: "tool", tool: name, text: toolText(p) });
    }
  });
  return { title, items, ...(usage ? { usage } : {}) };
}

/** 1 件のツール（item.id は cx<行番号>）の中身。無ければ null */
export function codexToolDetail(path: string, itemId: string): ToolDetail | null {
  const match = /^cx(\d+)$/.exec(itemId);
  if (!match) return null;
  const index = Number(match[1]);
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return null;
  }
  const raw = lines[index];
  if (!raw) return null;
  let row: Rec;
  try {
    row = JSON.parse(raw) as Rec;
  } catch {
    return null;
  }
  if (row.type !== "response_item") return null;
  const p = row.payload as Rec | undefined;
  if (!p || (p.type !== "function_call" && p.type !== "custom_tool_call" && p.type !== "local_shell_call")) return null;

  const name = typeof p.name === "string" ? p.name : p.type === "local_shell_call" ? "local_shell_call" : "tool";
  const input = codexInput(p);
  const callId = typeof p.call_id === "string" ? p.call_id : typeof p.id === "string" ? p.id : null;
  let output: string | null = null;
  if (callId) {
    for (let i = index + 1; i < lines.length; i++) {
      const next = lines[i]!;
      let found: Rec;
      try {
        found = JSON.parse(next) as Rec;
      } catch {
        continue;
      }
      if (found.type !== "response_item") continue;
      const q = found.payload as Rec | undefined;
      if (!q || (q.type !== "function_call_output" && q.type !== "custom_tool_call_output")) continue;
      if (q.call_id !== callId) continue;
      output = typeof q.output === "string" ? q.output : jsonText(q.output);
      break;
    }
  }
  return buildToolDetail({ name, input, output, running: output === null });
}

/** function_call の arguments／custom_tool_call の input／local_shell_call の action を、中身の形にそろえる */
function codexInput(p: Rec): unknown {
  if (typeof p.arguments === "string") {
    try {
      return JSON.parse(p.arguments) as unknown;
    } catch {
      return p.arguments;
    }
  }
  if (p.arguments !== undefined) return p.arguments;
  if (p.input !== undefined) return p.input;
  if (p.action !== undefined) {
    if (p.action !== null && typeof p.action === "object") {
      const action = p.action as Rec;
      if (Array.isArray(action.command) || typeof action.command === "string") return { command: action.command };
    }
    return p.action;
  }
  return {};
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/** Codex の token_count から、トークンの累計・いまのコンテキスト・レート制限を読む */
function tokenCountUsage(info: Rec | undefined, limits: unknown): Partial<ParsedUsage> | null {
  if (!info) return null;
  const found: Partial<ParsedUsage> = {};
  const total = tokensOf(info.total_token_usage);
  if (total) found.tokensTotal = total;
  const last = info.last_token_usage as Rec | undefined;
  const input = count(last?.input_tokens);
  const output = count(last?.output_tokens);
  if (input > 0 || output > 0) found.contextUsed = input + output;
  const limit = count(info.model_context_window);
  if (limit > 0) found.contextLimit = limit;
  const parsed = limitsOf(limits);
  if (parsed.length > 0) found.limits = parsed;
  return found;
}

function tokensOf(value: unknown): UsageTokens | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Rec;
  const allInput = count(v.input_tokens);
  const cached = count(v.cached_input_tokens);
  return {
    input: Math.max(0, allInput - cached),
    output: count(v.output_tokens),
    cacheRead: cached,
    cacheWrite: count(v.cache_write_input_tokens),
    reasoning: count(v.reasoning_output_tokens),
  };
}

function limitsOf(value: unknown): UsageLimit[] {
  if (!value || typeof value !== "object") return [];
  const r = value as Rec;
  const limits: UsageLimit[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const block = r[key] as Rec | undefined;
    if (!block) continue;
    const used = number(block.used_percent);
    if (used === null) continue;
    const window = number(block.window_minutes);
    limits.push({
      label: windowLabel(window),
      usedPercent: used,
      resetsAt: millisAt(block.resets_at),
      windowMinutes: window === null ? null : Math.round(window),
    });
  }
  return limits;
}

function count(value: unknown): number {
  const n = number(value);
  return n !== null && n > 0 ? Math.round(n) : 0;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** その作業フォルダの、いちばん新しい Codex の会話の記録（ここ 14 日の分から探す） */
export function findCodexRollout(cwd: string, codexHome: string, now = new Date()): string | null {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return null;
  const want = new Set([cwd, cwd.replace(/^\/private/, ""), `/private${cwd}`]);
  const files: { path: string; mtime: number }[] = [];
  for (let d = 0; d < 14; d++) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        files.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        // 消された
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files) if (want.has(sessionCwd(f.path) ?? "")) return f.path;
  return null;
}

/** 記録の最初の行（session_meta）の作業フォルダ */
function sessionCwd(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
    const v = JSON.parse(first) as { type?: string; payload?: { cwd?: unknown } };
    return v.type === "session_meta" && typeof v.payload?.cwd === "string" ? v.payload.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function isCodexRollout(path: string): boolean {
  return /\/rollout-[^/]+\.jsonl$/.test(path);
}
