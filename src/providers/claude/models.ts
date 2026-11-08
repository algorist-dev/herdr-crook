// Claude Code のモデルと考える量（/model・/effort）。iPhone には OpenCode と同じ形で見せる。
// モデルの一覧の聞き方（list_models）と、切り替えの確認の読み方は Orca と同じやり方にした。
import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModel } from "../types.ts";

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** /model に渡せる名前（Claude Code の別名） */
export const CLAUDE_MODELS: AgentModel[] = [
  { provider: "claude", id: "default", name: "おすすめ（既定）", providerName: "Claude", variants: CLAUDE_EFFORTS },
  { provider: "claude", id: "opus", name: "Opus", providerName: "Claude", variants: CLAUDE_EFFORTS },
  { provider: "claude", id: "sonnet", name: "Sonnet", providerName: "Claude", variants: CLAUDE_EFFORTS },
  { provider: "claude", id: "haiku", name: "Haiku", providerName: "Claude", variants: CLAUDE_EFFORTS },
  { provider: "claude", id: "fable", name: "Fable", providerName: "Claude", variants: CLAUDE_EFFORTS },
];

/** 会話の記録に残るモデルの名前（claude-opus-5-5）から、/model の別名（opus） */
export function claudeAlias(modelId: string | null): string | null {
  if (!modelId) return null;
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) if (modelId.includes(alias)) return alias;
  return null;
}

/** 表示名（Opus 5.5）から、会話の記録に残る名前の形（claude-opus-5-5） */
function familyId(label: string): string {
  return `claude-${label.toLowerCase().replace(/[\s.]+/g, "-")}`;
}

/**
 * 会話の記録のモデル（claude-opus-5-5）が、一覧のどれか。別名（opus）を先に、なければそのものの名前。
 * 「おすすめ（default）」はどのモデルか分からないので選ばない
 */
export function matchClaudeModel(models: AgentModel[], modelId: string | null): AgentModel | null {
  if (!modelId) return null;
  const exact = models.find((m) => m.id === modelId);
  const byLabel = models.filter((m) => m.id !== "default" && familyId(m.name) === modelId.replace(/-\d{8}$/, ""));
  return byLabel.find((m) => !m.id.startsWith("claude-")) ?? exact ?? byLabel[0] ?? null;
}

/** claude -p に「モデルの一覧を」と頼む（メッセージは送らない）。答えの JSON を読む */
export function parseClaudeModelList(stdout: string): AgentModel[] {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.includes("control_response")) continue;
    let parsed: { type?: string; response?: { subtype?: string; response?: { models?: unknown } } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "control_response" || parsed.response?.subtype !== "success") continue;
    const models = parsed.response.response?.models;
    if (!Array.isArray(models)) continue;
    const seen = new Set<string>();
    const list: AgentModel[] = [];
    for (const m of models as Record<string, unknown>[]) {
      const id = typeof m?.value === "string" ? m.value.trim() : "";
      if (!id || m.disabled === true || seen.has(id) || !/^[A-Za-z0-9._:@\[\]-]{1,100}$/.test(id)) continue;
      seen.add(id);
      const name = id === "default" ? "おすすめ（既定）" : typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : id;
      const variants =
        m.supportsEffort === true && Array.isArray(m.supportedEffortLevels)
          ? (m.supportedEffortLevels as unknown[]).filter((v): v is string => typeof v === "string" && /^[a-z]{1,16}$/.test(v))
          : [];
      list.push({ provider: "claude", id, name, providerName: "Claude", variants });
    }
    if (list.length > 0) return list;
  }
  return [];
}

export function loadClaudeModels(bin = "claude"): Promise<AgentModel[]> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, cwd: homedir() },
      (err, stdout) => {
        void err;
        resolve(parseClaudeModelList(stdout ?? ""));
      },
    );
    child.stdin?.end(`${JSON.stringify({ type: "control_request", request_id: "crook-models", request: { subtype: "list_models" } })}\n`);
  });
}

/** 画面の下のほう（入力欄のまわり）だけ。会話の中に残った古い文字に反応しないように */
function bottom(screen: string, lines = 15): string {
  return screen.split("\n").filter((l) => l.trim()).slice(-lines).join("\n");
}

/** 入力欄のすぐ上に出る「◐ medium · /effort」から、いまの考える量（いちばん下のもの） */
export function effortOnScreen(screen: string): string | null {
  const found = [...bottom(screen, 10).matchAll(/(?:^|\s)\S (low|medium|high|xhigh|max) · \/effort\s*$/gm)];
  return found.length ? found[found.length - 1]![1]! : null;
}

/**
 * Claude がいつもの入力の画面か。入力欄は「───」の線にはさまれた「❯」の行。
 * 書きかけの文章があれば draft に入れる（「Try "…"」のような薄い例の文字は書きかけではない）
 */
export function claudeInput(screen: string): { ready: boolean; draft: string | null } {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    const m = /^❯\s?(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const ruled = (l: string | undefined) => !!l && /^─{10,}/.test(l.trim());
    if (!ruled(lines[i - 1]) || !(ruled(lines[i + 1]) || ruled(lines[i + 2]))) return { ready: false, draft: null };
    const text = m[1]!.trim();
    return { ready: true, draft: text && !/^Try "/.test(text) ? text : null };
  }
  return { ready: false, draft: null };
}

type Herdr = { request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };

function squash(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/** 「Switch model? This conversation is cached for the current model…」の確認が出ているか */
export function isSwitchConfirmation(screen: string): boolean {
  const t = squash(screen);
  return t.includes("switchmodel?") && t.includes("thisconversationiscachedforthecurrentmodel");
}

/** 「Set model to Sonnet 5.5」が出たか（表示名の言葉が順に出ていればよい） */
export function modelApplied(screen: string, label: string): boolean {
  const t = squash(screen);
  if (t.includes(`setmodelto${squash(label)}`)) return true;
  const at = t.lastIndexOf("setmodelto");
  const words = label.toLowerCase().match(/[a-z]+|\d+[a-z]*/g) ?? [];
  if (at < 0 || words.length === 0) return false;
  let pos = at;
  for (const w of words) {
    const i = t.indexOf(w, pos);
    if (i < 0) return false;
    pos = i + w.length;
  }
  return true;
}

/**
 * /model を送り、確認が出たら Enter で進め、「Set model to」で確かめる。「Kept model as」なら断られた。
 * そのあと考える量（/effort）を送る（確認の画面に /effort が入らないように、モデルの結果を待ってから）
 */
export async function switchClaudeModel(
  herdr: Herdr,
  pane: string,
  target: AgentModel,
  effort: string | null,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: boolean; message?: string }> {
  const read = async () => {
    const r = (await herdr.request("pane.read", { pane_id: pane, source: "visible", lines: 60 })) as { read?: { text?: unknown } } | null;
    return typeof r?.read?.text === "string" ? r.read.text : "";
  };
  const before = await read();
  const input = claudeInput(before);
  if (!input.ready || isSwitchConfirmation(bottom(before))) return { ok: false, message: "Claude がメッセージを打てる画面になっていません。Mac の画面を見てください" };
  if (input.draft) return { ok: false, message: "Mac の入力欄に書きかけの文章があります。送るか消してから切り替えてください" };
  const appliedBefore = modelApplied(bottom(before), target.name);
  await herdr.request("agent.prompt", { target: pane, text: `/model ${target.id}` });
  let confirmed = false;
  let applied = false;
  for (let i = 0; i < 20 && !applied; i++) {
    await wait(250);
    const screen = bottom(await read());
    if (squash(screen).includes("keptmodelas") && !squash(bottom(before)).includes("keptmodelas")) {
      return { ok: false, message: "Claude がモデルを変えませんでした" };
    }
    if (!confirmed && isSwitchConfirmation(screen)) {
      confirmed = true;
      await herdr.request("pane.send_keys", { pane_id: pane, keys: ["enter"] });
      continue;
    }
    // 前からあった「Set model to」と区別する（入力欄のまわりに新しく出たか）
    applied = squash(screen).includes("setmodelto") && (target.id === "default" || (modelApplied(screen, target.name) && (!appliedBefore || confirmed || i > 2)));
  }
  if (!applied) return { ok: false, message: "モデルが変わったか確かめられませんでした。Mac の画面を見てください" };
  if (effort) {
    if (!target.variants.includes(effort)) return { ok: false, message: "このモデルではそのエフォートを選べません" };
    await wait(300);
    return setClaudeEffort(herdr, pane, effort, read);
  }
  return { ok: true };
}

/** 考える量だけ変える（/effort）。いつもの入力の画面で、書きかけがないときだけ */
export async function setClaudeEffort(
  herdr: Herdr,
  pane: string,
  effort: string,
  read?: () => Promise<string>,
): Promise<{ ok: boolean; message?: string }> {
  const screen = read
    ? await read()
    : (((await herdr.request("pane.read", { pane_id: pane, source: "visible", lines: 60 })) as { read?: { text?: string } } | null)?.read?.text ?? "");
  const input = claudeInput(screen);
  if (!input.ready) return { ok: false, message: "Claude がメッセージを打てる画面になっていません。Mac の画面を見てください" };
  if (input.draft) return { ok: false, message: "Mac の入力欄に書きかけの文章があります。送るか消してから切り替えてください" };
  await herdr.request("agent.prompt", { target: pane, text: `/effort ${effort}` });
  return { ok: true };
}

/** 会話の記録（JSONL）の終わりから、いちばん新しい返事のモデル */
export function lastModelInTranscript(path: string, maxBytes = 512 * 1024): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const v = JSON.parse(line) as { type?: string; message?: { model?: unknown } };
        if (v.type === "assistant" && typeof v.message?.model === "string" && !v.message.model.startsWith("<")) return v.message.model;
      } catch {
        // 途中で切れた行
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** ふだんの考える量（~/.claude/settings.json の effortLevel） */
export function defaultClaudeEffort(home = homedir()): string | null {
  try {
    const v = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { effortLevel?: unknown };
    return typeof v.effortLevel === "string" && CLAUDE_EFFORTS.includes(v.effortLevel) ? v.effortLevel : null;
  } catch {
    return null;
  }
}
