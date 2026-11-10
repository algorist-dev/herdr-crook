// Pi（earendil-works/pi）の会話の記録を、Claude と同じチャットの形にする。
// 形は公式の docs/session-format.md（version 3）：1 行 1 エントリの JSONL。id／parentId の木だが、ふつうは 1 本道なので
// 書かれた順に読む（/tree で枝を替えたときは、古い枝も並んで見える）。
// 場所は ~/.pi/agent/sessions/--<作業フォルダ>--/<日時>_<ID>.jsonl。Herdr の Pi の連携があれば、Herdr がこの場所そのものを知らせる。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatItem, ParsedTranscript } from "../shared/transcript.ts";
import { buildToolDetail, type ToolDetail } from "../shared/toolDetail.ts";
import type { ParsedUsage } from "../../features/usage.ts";

type Rec = Record<string, unknown>;

/** Pi のエージェントのフォルダ（PI_CODING_AGENT_DIR か ~/.pi/agent） */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR;
  return dir && dir.trim() ? dir : join(home, ".pi", "agent");
}

/** 作業フォルダ → sessions の下のフォルダの名前（先頭の区切りを取り、/ \ : を - にして、前後に --） */
export function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** その作業フォルダのいちばん新しい記録。無ければ null */
export function findPiSession(cwd: string, agentDir = piAgentDir()): string | null {
  const variants = new Set([cwd, cwd.replace(/^\/private(?=\/)/, ""), cwd.startsWith("/private/") ? cwd : `/private${cwd}`]);
  let best: { path: string; mtime: number } | null = null;
  for (const v of variants) {
    const dir = join(agentDir, "sessions", piSessionDirName(v));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const mtime = statSync(path).mtimeMs;
        if (!best || mtime > best.mtime) best = { path, mtime };
      } catch {
        // 消えたものは飛ばす
      }
    }
  }
  return best?.path ?? null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as Rec[])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

function toolText(args: unknown): string {
  if (typeof args === "string") return args.slice(0, 300);
  if (args && typeof args === "object") {
    const a = args as Rec;
    for (const k of ["command", "path", "pattern", "query", "url"]) if (typeof a[k] === "string") return (a[k] as string).slice(0, 300);
    return JSON.stringify(args).slice(0, 300);
  }
  return "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** base：これまでに読んだ行の数。最初の発言を題名にするのは、最初から読んだとき（base が 0）だけ */
export function parsePiLines(lines: string[], base = 0): ParsedTranscript & { usage?: ParsedUsage } {
  const items: ChatItem[] = [];
  let title: string | null = null;
  let firstUser: string | null = null;
  let usage: ParsedUsage | undefined;
  for (const raw of lines) {
    let row: Rec;
    try {
      row = JSON.parse(raw) as Rec;
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    if (row.type === "session_info" && typeof row.name === "string" && row.name.trim()) {
      title = row.name.trim();
      continue;
    }
    if (row.type !== "message" || typeof row.id !== "string") continue;
    const id = row.id;
    const m = (row.message ?? {}) as Rec;
    if (m.role === "user") {
      const text = textOf(m.content);
      if (!text) continue;
      firstUser ??= text;
      items.push({ id, role: "user", kind: "text", text });
    } else if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        (m.content as Rec[]).forEach((b, i) => {
          if (!b) return;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            items.push({ id: `${id}:t${i}`, role: "assistant", kind: "text", text: b.text.trim() });
          } else if (b.type === "toolCall") {
            const name = typeof b.name === "string" ? b.name : "tool";
            items.push({ id: `${id}:t${i}`, role: "assistant", kind: "tool", tool: name, text: toolText(b.arguments) });
          }
        });
      }
      const u = m.usage as Rec | undefined;
      if (u) {
        const input = count(u.input);
        const output = count(u.output);
        const cacheRead = count(u.cacheRead);
        const cacheWrite = count(u.cacheWrite);
        const prev: ParsedUsage = usage ?? { source: "pi", tokensDelta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
        const t = prev.tokensDelta!;
        usage = {
          ...prev,
          tokensDelta: { input: t.input + input, output: t.output + output, cacheRead: t.cacheRead + cacheRead, cacheWrite: t.cacheWrite + cacheWrite, reasoning: 0 },
          // 途中で止めた返事は usage が全部 0 のことがある。そのときは前のコンテキストのまま
          ...(input + cacheRead + cacheWrite + output > 0 ? { contextUsed: input + cacheRead + cacheWrite + output } : {}),
          costDelta: (prev.costDelta ?? 0) + count((u.cost as Rec | undefined)?.total),
          ...(typeof m.model === "string" ? { model: m.model } : {}),
          ...(typeof m.provider === "string" ? { provider: m.provider } : {}),
        };
      }
    }
  }
  const fallback = base === 0 && firstUser ? firstUser.split("\n")[0]!.slice(0, 120) : null;
  return { title: title ?? fallback, items, ...(usage ? { usage } : {}) };
}

/** 1 件のツール（item.id は `<エントリの id>:t<content の番号>`）の中身。無ければ null */
export function piToolDetail(path: string, itemId: string): ToolDetail | null {
  const match = /^(.*):t(\d+)$/.exec(itemId);
  if (!match) return null;
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return null;
  }
  let call: { id: string | null; name: string; input: unknown } | null = null;
  for (const raw of lines) {
    let row: Rec;
    try {
      row = JSON.parse(raw) as Rec;
    } catch {
      continue;
    }
    const m = (row.message ?? {}) as Rec;
    if (!call) {
      if (row.type !== "message" || row.id !== match[1] || m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const b = (m.content as Rec[])[Number(match[2])];
      if (!b || b.type !== "toolCall") return null;
      call = { id: typeof b.id === "string" ? b.id : null, name: typeof b.name === "string" ? b.name : "tool", input: b.arguments ?? {} };
      continue;
    }
    if (row.type === "message" && m.role === "toolResult" && call.id && m.toolCallId === call.id) {
      const output = Array.isArray(m.content)
        ? (m.content as Rec[]).filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n")
        : typeof m.content === "string" ? m.content : "";
      return buildToolDetail({ name: call.name, input: call.input, output, error: m.isError === true });
    }
  }
  return call ? buildToolDetail({ name: call.name, input: call.input, output: null, running: true }) : null;
}
