// Gemini CLI の会話の記録を、Claude と同じチャットの形にする（0.67 で実物を見て作った。docs/agents-support.md の 5）。
// 場所：<home>/.gemini/projects.json の projects[作業フォルダ] が短い名前 → <home>/.gemini/tmp/<名前>/chats/session-*.jsonl。
// 形：1 行目がメタデータ。あとはメッセージ（id・type: user／gemini／info…）と、{$set}・{$patch}・{$rewindTo}。
// 同じ id のメッセージが何度も書かれる（あとで toolCalls・tokens が付く）ので、出したものと数えたものを覚えておく。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatItem, ParsedTranscript } from "../shared/transcript.ts";
import { buildToolDetail, type ToolDetail } from "../shared/toolDetail.ts";
import type { ParsedUsage, UsageTokens } from "../../features/usage.ts";

type Rec = Record<string, unknown>;

/** <home>/.gemini（GEMINI_CLI_HOME があればそれが home） */
export function geminiHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const h = env.GEMINI_CLI_HOME;
  return join(h && h.trim() ? h : home, ".gemini");
}

/** その作業フォルダのいちばん新しい記録。無ければ null */
export function findGeminiSession(cwd: string, gemini = geminiHome()): string | null {
  let projects: Rec;
  try {
    projects = ((JSON.parse(readFileSync(join(gemini, "projects.json"), "utf8")) as Rec).projects ?? {}) as Rec;
  } catch {
    return null;
  }
  const variants = [cwd, cwd.replace(/^\/private(?=\/)/, ""), cwd.startsWith("/private/") ? cwd : `/private${cwd}`];
  let best: { path: string; mtime: number } | null = null;
  for (const v of new Set(variants)) {
    const slug = projects[v];
    if (typeof slug !== "string" || !slug || slug.includes("/") || slug.startsWith(".")) continue;
    const dir = join(gemini, "tmp", slug, "chats");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("session-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path, mtime: st.mtimeMs };
      } catch {
        // 消えたものは飛ばす
      }
    }
  }
  return best?.path ?? null;
}

/** content（文字か parts の配列）の文字だけ */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as Rec[])
    .filter((p) => p && typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text as string)
    .join("")
    .trim();
}

/** 見えない前置き（最初の user）か、ツールの結果だけの user か */
function isHiddenUser(content: unknown, text: string): boolean {
  if (text.startsWith("<session_context>")) return true;
  if (Array.isArray(content) && (content as Rec[]).length > 0 && (content as Rec[]).every((p) => p && p.functionResponse)) return true;
  return false;
}

function toolText(args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Rec;
    for (const k of ["command", "file_path", "absolute_path", "path", "dir_path", "pattern", "query", "url", "prompt"]) {
      if (typeof a[k] === "string") return (a[k] as string).slice(0, 300);
    }
    return JSON.stringify(args).slice(0, 300);
  }
  return typeof args === "string" ? args.slice(0, 300) : "";
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

function tokensOf(t: Rec): UsageTokens {
  const cached = n(t.cached);
  return { input: Math.max(0, n(t.input) - cached), output: n(t.output), cacheRead: cached, cacheWrite: 0, reasoning: n(t.thoughts) };
}

export interface GeminiParsed extends ParsedTranscript {
  usage?: ParsedUsage;

}

/**
 * 続きから読むための読み方。同じ記録には同じものを使う（出した項目と数えたトークンを覚える）。
 * base が 0 のときは最初から読み直しなので、覚えたものを消す
 */
export function createGeminiParser(): (lines: string[], base: number) => GeminiParsed {
  let shown = new Set<string>();
  let counted = new Map<string, UsageTokens>();
  /** 最初の発言を題名にした */
  let titled = false;
  return (lines, base) => {
    if (base === 0) {
      shown = new Set();
      counted = new Map();
      titled = false;
    }
    const items: ChatItem[] = [];
    let title: string | null = null;
    let usage: ParsedUsage | undefined;
    let restart = false;
    /** このまとまりで出てきたメッセージの id（順番） */
    const order: string[] = [];
    const inOrder = new Set<string>();
    const push = (item: ChatItem) => {
      if (shown.has(item.id)) return;
      shown.add(item.id);
      items.push(item);
    };
    /** そのメッセージたちの項目を消す（最初から読んでいるときだけ使う） */
    const drop = (gone: Set<string>) => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (gone.has(items[i]!.id.split(":")[0]!)) {
          shown.delete(items[i]!.id);
          items.splice(i, 1);
        }
      }
      for (let i = order.length - 1; i >= 0; i--) {
        if (gone.has(order[i]!)) {
          inOrder.delete(order[i]!);
          order.splice(i, 1);
        }
      }
    };
    const message = (row: Rec) => {
      if (typeof row.id !== "string" || typeof row.type !== "string") return;
      const id = row.id;
      if (!inOrder.has(id)) {
        inOrder.add(id);
        order.push(id);
      }
      if (row.type === "user") {
        const text = textOf(row.content);
        if (!text || isHiddenUser(row.content, text)) return;
        // 題名は最初の発言（読み方ごとに 1 回だけ。続きの発言で上書きしない）
        if (!titled) {
          titled = true;
          title ??= text.split("\n")[0]!.slice(0, 120);
        }
        push({ id, role: "user", kind: "text", text });
      } else if (row.type === "gemini") {
        const text = textOf(row.content);
        if (text) push({ id, role: "assistant", kind: "text", text });
        if (Array.isArray(row.toolCalls)) {
          for (const call of row.toolCalls as Rec[]) {
            if (!call || typeof call.id !== "string") continue;
            const label = typeof call.displayName === "string" && call.displayName ? call.displayName : typeof call.name === "string" ? call.name : "tool";
            push({ id: `${id}:${call.id}`, role: "assistant", kind: "tool", tool: label, text: toolText(call.args) });
          }
        }
        const t = row.tokens as Rec | null | undefined;
        if (t && typeof t === "object") {
          const now = tokensOf(t);
          const before = counted.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
          counted.set(id, now);
          const prev = usage?.tokensDelta ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
          usage = {
            ...(usage ?? { source: "gemini" }),
            tokensDelta: {
              input: prev.input + now.input - before.input,
              output: prev.output + now.output - before.output,
              cacheRead: prev.cacheRead + now.cacheRead - before.cacheRead,
              cacheWrite: 0,
              reasoning: prev.reasoning + now.reasoning - before.reasoning,
            },
            ...(n(t.total) > 0 ? { contextUsed: n(t.total) } : {}),
            ...(typeof row.model === "string" && row.model ? { model: row.model } : {}),
          };
        }
      }
    };
    for (const raw of lines) {
      let row: Rec;
      try {
        row = JSON.parse(raw) as Rec;
      } catch {
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const set = row.$set as Rec | undefined;
      const patch = row.$patch as Rec | undefined;
      if (set && typeof set.summary === "string" && set.summary.trim()) title = set.summary.trim();
      // 出したものが消える・書き換わる記録。続きを読んでいるときは送ったものを直せないので、最初から読み直してもらう
      const rewrites =
        typeof row.$rewindTo === "string" ||
        (set !== undefined && Array.isArray(set.messages)) ||
        (patch !== undefined && typeof patch === "object" && patch !== null);
      if (rewrites && base > 0) {
        restart = true;
        continue;
      }
      if (typeof row.$rewindTo === "string") {
        // そのメッセージから後ろを消す（見つからなければ全部）
        const at = order.indexOf(row.$rewindTo);
        drop(new Set(at < 0 ? order : order.slice(at)));
        continue;
      }
      if (set && Array.isArray(set.messages)) {
        // まるごと入れ替え
        drop(new Set(order));
        for (const m of set.messages as Rec[]) if (m && typeof m === "object") message(m);
        continue;
      }
      if (patch && typeof patch === "object") {
        if (Array.isArray(patch.removeIds)) drop(new Set((patch.removeIds as unknown[]).filter((x): x is string => typeof x === "string")));
        // 中身の差し替え：もう出した文を書き換える
        const updates = [patch, ...(Array.isArray(patch.updates) ? (patch.updates as Rec[]) : [])];
        for (const u of updates) {
          if (!u || typeof u.id !== "string" || !("content" in u)) continue;
          const text = textOf(u.content);
          const at = items.findIndex((it) => it.id === u.id && it.kind === "text");
          if (at >= 0 && text) items[at] = { ...items[at]!, text };
        }
        continue;
      }
      message(row);
    }
    return { title, items, ...(usage ? { usage } : {}), ...(restart ? { restart } : {}) };
  };
}

// ツールの名前 → 中身の見せ方（shared/toolDetail.ts の名前）
const DETAIL_NAME: Record<string, string> = {
  run_shell_command: "bash",
  read_file: "read",
  write_file: "write",
  replace: "edit",
  glob: "glob",
  grep_search: "grep",
  web_fetch: "webfetch",
  google_web_search: "websearch",
};

/** 1 件のツール（item.id は `<メッセージの id>:<呼び出しの id>`）の中身。無ければ null */
export function geminiToolDetail(path: string, itemId: string): ToolDetail | null {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return null;
  }
  // 同じメッセージが何度も書かれるので、最後に見つかったものを使う
  const found: { call: Rec | null } = { call: null };
  for (const raw of lines) {
    let row: Rec;
    try {
      row = JSON.parse(raw) as Rec;
    } catch {
      continue;
    }
    // 結果だけ $patch で届くこともある
    const patch = row.$patch as Rec | undefined;
    if (patch) {
      const current = found.call;
      if (current) {
        for (const u of [patch, ...(Array.isArray(patch.updates) ? (patch.updates as Rec[]) : [])]) {
          if (!u || !Array.isArray(u.toolCalls)) continue;
          for (const p of u.toolCalls as Rec[]) if (p && p.id === current.id && "result" in p) found.call = { ...current, result: p.result };
        }
      }
      continue;
    }
    if (row.type !== "gemini" || typeof row.id !== "string" || !itemId.startsWith(`${row.id}:`) || !Array.isArray(row.toolCalls)) continue;
    const callId = itemId.slice(row.id.length + 1);
    const hit = (row.toolCalls as Rec[]).find((c) => c && c.id === callId);
    if (hit) found.call = hit;
  }
  const call = found.call;
  if (!call) return null;
  const name = typeof call.name === "string" ? call.name : "tool";
  const output = resultText(call.result);
  const status = typeof call.status === "string" ? call.status : null;
  return buildToolDetail({
    name: DETAIL_NAME[name] ?? name,
    input: call.args ?? {},
    output,
    running: output === null && (status === null || status === "executing" || status === "scheduled"),
    error: status === "error" || status === "cancelled",
  });
}

/** result（functionResponse の parts）→ 文字。<untrusted_context> の囲みは外す */
function resultText(result: unknown): string | null {
  if (!Array.isArray(result)) return typeof result === "string" ? result : null;
  const parts: string[] = [];
  for (const p of result as Rec[]) {
    const fr = (p?.functionResponse ?? null) as Rec | null;
    const resp = (fr?.response ?? null) as Rec | null;
    if (resp && typeof resp.output === "string") parts.push(resp.output);
    else if (resp && typeof resp.error === "string") parts.push(resp.error);
    else if (typeof p?.text === "string") parts.push(p.text);
  }
  return parts.join("\n").replace(/<\/?untrusted_context>\n?/g, "").trim();
}
