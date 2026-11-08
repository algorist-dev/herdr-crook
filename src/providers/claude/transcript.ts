// Claude Code の会話記録（~/.claude/projects/<フォルダ>/<セッション ID>.jsonl）を読んで、
// スマホのチャット表示に出す形にする。Orca モバイルの「native chat」と同じ考え方。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EMPTY_TOKENS, addTokens, type ParsedUsage, type UsageTokens } from "../../features/usage.ts";
import type { ChatItem, ParsedTranscript } from "../shared/transcript.ts";
import { buildToolDetail, type ToolDetail } from "../shared/toolDetail.ts";

type Rec = Record<string, unknown>;

export function parseTranscriptLines(lines: string[]): ParsedTranscript {
  let title: string | null = null;
  const items: ChatItem[] = [];
  const usage: ParsedUsage = { source: "claude", tokensDelta: { ...EMPTY_TOKENS } };
  let hasUsage = false;
  for (const raw of lines) {
    let row: Rec;
    try {
      row = JSON.parse(raw) as Rec;
    } catch {
      continue;
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string") {
      title = row.aiTitle;
      continue;
    }
    if ((row.type !== "user" && row.type !== "assistant") || row.isMeta === true || row.isSidechain === true) continue;
    const uuid = typeof row.uuid === "string" ? row.uuid : String(items.length);
    const message = row.message as Rec | undefined;
    const content = message?.content;

    if (row.type === "assistant") {
      const used = claudeUsage(message);
      if (used) {
        usage.tokensDelta = addTokens(usage.tokensDelta!, used.tokens);
        usage.contextUsed = used.contextUsed;
        if (used.model) usage.model = used.model;
        hasUsage = true;
      }
    }

    if (row.type === "user") {
      if (typeof content === "string") {
        if (!isNoise(content)) items.push({ id: uuid, role: "user", kind: "text", text: content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const blocks = content as Rec[];
      if (blocks.some((b) => b.type === "tool_result")) continue;
      const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string" && !isNoise(b.text as string)).map((b) => b.text as string);
      const images = blocks.filter((b) => b.type === "image").length;
      if (texts.length === 0 && images === 0) continue;
      if (texts.length === 0) continue;
      const text = texts.join("\n") + (images > 0 ? `（画像 ${images} 枚）` : "");
      items.push({ id: uuid, role: "user", kind: "text", text });
      continue;
    }

    if (!Array.isArray(content)) continue;
    (content as Rec[]).forEach((block, index) => {
      const id = `${uuid}:${index}`;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        items.push({ id, role: "assistant", kind: "text", text: block.text });
      } else if (block.type === "tool_use") {
        const tool = typeof block.name === "string" ? block.name : "ツール";
        items.push({ id, role: "assistant", kind: "tool", text: describeTool(block.input as Rec | undefined), tool });
      }
    });
  }
  return { title, items, ...(hasUsage ? { usage } : {}) };
}

/** Claude の 1 回の返事の usage から、足す分と、いまのコンテキストの大きさを出す */
function claudeUsage(message: Rec | undefined): { tokens: UsageTokens; contextUsed: number; model: string | null } | null {
  const u = message?.usage as Rec | undefined;
  if (!u) return null;
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  const cacheRead = count(u.cache_read_input_tokens);
  const cacheWrite = count(u.cache_creation_input_tokens);
  const tokens = { input, output, cacheRead, cacheWrite, reasoning: 0 };
  // いまのコンテキスト＝この返事を書くのに使ったプロンプトと、書いた分
  return { tokens, contextUsed: input + output + cacheRead + cacheWrite, model: typeof message?.model === "string" ? message.model : null };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function isNoise(text: string): boolean {
  const t = text.trim();
  return t === "" || t.startsWith("[Image: source:") || t.startsWith("<system-reminder>") || t.startsWith("<command-");
}

function describeTool(input: Rec | undefined): string {
  if (!input) return "";
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const text =
    pick(input.description) ??
    (pick(input.file_path) ? basename(input.file_path as string) : null) ??
    pick(input.command) ??
    pick(input.pattern) ??
    pick(input.query) ??
    pick(input.url) ??
    pick(input.prompt) ??
    "";
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

/** 1 件のツール（item.id は `<uuid>:<index>`）の中身。無ければ null */
export function toolDetailFromTranscript(path: string, itemId: string): ToolDetail | null {
  const match = /^(.*):(\d+)$/.exec(itemId);
  if (!match) return null;
  const uuid = match[1]!;
  const index = Number(match[2]);
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return null;
  }

  let found: { name: string; input: unknown; toolUseId: string | null } | null = null;
  let result: { output: string; error: boolean } | null = null;
  for (const raw of lines) {
    let row: Rec;
    try {
      row = JSON.parse(raw) as Rec;
    } catch {
      continue;
    }
    if (row.isMeta === true || row.isSidechain === true) continue;
    const message = row.message as Rec | undefined;
    const content = message?.content;

    if (!found) {
      if (row.type !== "assistant" || row.uuid !== uuid || !Array.isArray(content)) continue;
      const block = (content as Rec[])[index];
      if (!block || block.type !== "tool_use") return null;
      found = {
        name: typeof block.name === "string" ? block.name : "ツール",
        input: block.input,
        toolUseId: typeof block.id === "string" ? block.id : null,
      };
      continue;
    }

    if (row.type !== "user" || !Array.isArray(content)) continue;
    for (const block of content as Rec[]) {
      if (block.type !== "tool_result") continue;
      if (found.toolUseId && block.tool_use_id !== found.toolUseId) continue;
      result = { output: resultText(block.content), error: block.is_error === true };
      break;
    }
    if (result) break;
  }

  if (!found) return null;
  return buildToolDetail({
    name: found.name,
    input: found.input,
    output: result?.output,
    error: result?.error ?? false,
    running: result === null,
  });
}

/** tool_result の content（文字か、text／image の配列）を文字にする。画像は中身を出さない */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let images = 0;
  for (const block of content as Rec[]) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") images++;
  }
  if (images > 0) parts.push("（画像）");
  return parts.join("\n");
}

/** セッション ID から会話記録のファイルを探す。見つからなければ null */
export function findTranscript(sessionId: string, home: string): string | null {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(sessionId)) return null;
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const path = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}
