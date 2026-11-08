// GitHub Copilot CLI の会話の記録（~/.copilot/session-state/<ID>/events.jsonl）を、Claude と同じチャットの形にする。
// 作業フォルダと題名は同じ場所の workspace.yaml。Herdr は会話の ID を知らないので、その作業フォルダのいちばん新しい会話を読む（copilot:<フォルダ>）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatItem, ParsedTranscript } from "../shared/transcript.ts";
import { buildToolDetail, type ToolDetail } from "../shared/toolDetail.ts";
import { EMPTY_TOKENS, addTokens, type ParsedUsage, type UsageTokens } from "../../features/usage.ts";

type Rec = Record<string, unknown>;

export function copilotHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.COPILOT_HOME && env.COPILOT_HOME.trim() ? env.COPILOT_HOME : join(home, ".copilot");
}

function toolText(req: Rec): string {
  const args = req.arguments ?? req.input;
  if (typeof args === "string") return args.slice(0, 300);
  if (args && typeof args === "object") {
    const a = args as Rec;
    for (const k of ["command", "path", "pattern", "query", "url"]) if (typeof a[k] === "string") return (a[k] as string).slice(0, 300);
    return JSON.stringify(args).slice(0, 300);
  }
  return "";
}

export function parseCopilotLines(lines: string[], base = 0): ParsedTranscript {
  const items: ChatItem[] = [];
  let usage: ParsedUsage | undefined;
  lines.forEach((raw, i) => {
    let row: Rec;
    try {
      row = JSON.parse(raw) as Rec;
    } catch {
      return;
    }
    const d = (row.data ?? {}) as Rec;
    const id = typeof d.messageId === "string" ? d.messageId : `cp${base + i}`;
    if (row.type === "session.usage_record") {
      const found = usageOf(d.usage as Rec | undefined);
      if (found) {
        usage ??= { source: "copilot", tokensDelta: { ...EMPTY_TOKENS } };
        usage.tokensDelta = addTokens(usage.tokensDelta!, found.tokens);
        usage.contextUsed = found.contextUsed;
        if (found.contextLimit) usage.contextLimit = found.contextLimit;
        if (found.model) usage.model = found.model;
      }
      return;
    }
    if (row.type === "user.message" && typeof d.content === "string" && d.content.trim()) {
      items.push({ id, role: "user", kind: "text", text: d.content.trim() });
    } else if (row.type === "assistant.message") {
      if (typeof d.content === "string" && d.content.trim()) items.push({ id, role: "assistant", kind: "text", text: d.content.trim() });
      if (Array.isArray(d.toolRequests)) {
        (d.toolRequests as Rec[]).forEach((req, j) => {
          const name = typeof req.name === "string" ? req.name : typeof req.toolName === "string" ? req.toolName : "tool";
          items.push({ id: `${id}:t${j}`, role: "assistant", kind: "tool", tool: name, text: toolText(req) });
        });
      }
    }
  });
  return { title: null, items, ...(usage ? { usage } : {}) };
}

/** 1 件のツール（item.id は `<messageId>:t<index>`）の中身。無ければ null */
export function copilotToolDetail(path: string, itemId: string): ToolDetail | null {
  const match = /^(.*):t(\d+)$/.exec(itemId);
  if (!match) return null;
  const messageId = match[1]!;
  const index = Number(match[2]);
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return null;
  }

  let found: { name: string; input: unknown; toolCallId: string | null } | null = null;
  let start = 0;
  for (; start < lines.length; start++) {
    let row: Rec;
    try {
      row = JSON.parse(lines[start]!) as Rec;
    } catch {
      continue;
    }
    if (row.type !== "assistant.message") continue;
    const d = (row.data ?? {}) as Rec;
    if (d.messageId !== messageId || !Array.isArray(d.toolRequests)) continue;
    const req = (d.toolRequests as Rec[])[index];
    if (!req) return null;
    found = {
      name: typeof req.name === "string" ? req.name : typeof req.toolName === "string" ? req.toolName : "tool",
      input: req.arguments ?? req.input ?? {},
      toolCallId: typeof req.toolCallId === "string" ? req.toolCallId : typeof req.tool_call_id === "string" ? req.tool_call_id : null,
    };
    break;
  }
  if (!found) return null;

  let output: string | null = null;
  if (found.toolCallId) {
    for (let i = start + 1; i < lines.length; i++) {
      let row: Rec;
      try {
        row = JSON.parse(lines[i]!) as Rec;
      } catch {
        continue;
      }
      if (row.type !== "tool.execution_complete") continue;
      const d = (row.data ?? {}) as Rec;
      if (d.toolCallId !== found.toolCallId) continue;
      output = resultText(d.result);
      break;
    }
  }
  return buildToolDetail({ name: found.name, input: found.input, output, running: output === null });
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const result = value as Rec;
    if (typeof result.content === "string") return result.content;
    return JSON.stringify(result);
  }
  return value === undefined || value === null ? "" : String(value);
}

/** 1 回の API 呼び出しの usage から、足す分と、いまのコンテキストを出す */
function usageOf(usage: Rec | undefined): { tokens: UsageTokens; contextUsed: number; contextLimit: number | null; model: string | null } | null {
  if (!usage) return null;
  const inputAll = count(usage.inputTokens);
  const cacheRead = count(usage.cacheReadTokens);
  const cacheWrite = count(usage.cacheWriteTokens);
  const output = count(usage.outputTokens);
  const reasoning = count(usage.reasoningTokens);
  const limit = count(usage.maxPromptTokens);
  const display = typeof usage.modelDisplayName === "string" && usage.modelDisplayName
    ? usage.modelDisplayName
    : typeof usage.model === "string" && usage.model
      ? usage.model
      : null;
  return {
    tokens: { input: Math.max(0, inputAll - cacheRead), output, cacheRead, cacheWrite, reasoning },
    // inputTokens はキャッシュを含むプロンプト全体。返事の分も次のコンテキストに入る
    contextUsed: inputAll + output + reasoning,
    contextLimit: limit > 0 ? limit : null,
    model: display,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** workspace.yaml の「key: value」を読む（1 行のものだけ） */
function yamlValue(text: string, key: string): string | null {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text);
  if (!m) return null;
  return m[1]!.trim().replace(/^["']|["']$/g, "");
}

/** その作業フォルダの、いちばん新しい Copilot の会話（events.jsonl があるもの）と題名 */
export function findCopilotSession(cwd: string, home = copilotHome()): { path: string; title: string | null } | null {
  const root = join(home, "session-state");
  if (!existsSync(root)) return null;
  const want = new Set([cwd, cwd.replace(/^\/private/, ""), `/private${cwd}`]);
  let best: { path: string; title: string | null; mtime: number } | null = null;
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    const events = join(dir, "events.jsonl");
    try {
      if (!existsSync(events)) continue;
      const yaml = readFileSync(join(dir, "workspace.yaml"), "utf8");
      if (!want.has(yamlValue(yaml, "cwd") ?? "")) continue;
      const mtime = statSync(events).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: events, title: yamlValue(yaml, "name"), mtime };
    } catch {
      // 読めないものは飛ばす
    }
  }
  return best ? { path: best.path, title: best.title } : null;
}

export function isCopilotEvents(path: string): boolean {
  return /\/session-state\/[^/]+\/events\.jsonl$/.test(path);
}
