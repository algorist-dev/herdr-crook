// Codex のモデルと考える量。Codex には外から決める入口がないので、人と同じように /model の画面で選ぶ。
// 1 段目：モデル（番号キー）→ 2 段目：考える量（カーソルを動かして「s」＝この会話だけ。Enter や番号だと Codex のふだんの設定まで変わる）。
// max などは 2 段目の「More reasoning…」の先（Advanced Reasoning）にある。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModel } from "../types.ts";

export function codexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME : join(home, ".codex");
}

/** ~/.codex/models_cache.json の、一覧に出すモデル（visibility: list） */
export function parseCodexModels(json: string): AgentModel[] {
  try {
    const v = JSON.parse(json) as { models?: unknown };
    if (!Array.isArray(v.models)) return [];
    return (v.models as Record<string, unknown>[]).flatMap((m) => {
      if (m?.visibility !== "list" || typeof m.slug !== "string") return [];
      const levels = Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as { effort?: unknown }[]) : [];
      return [
        {
          provider: "codex",
          id: m.slug,
          name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
          providerName: "Codex",
          variants: levels.flatMap((l) => (typeof l.effort === "string" ? [l.effort] : [])),
        },
      ];
    });
  } catch {
    return [];
  }
}

export function loadCodexModels(home = codexHome()): AgentModel[] {
  try {
    return parseCodexModels(readFileSync(join(home, "models_cache.json"), "utf8"));
  } catch {
    return [];
  }
}

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
const EFFORT_BY_LABEL = Object.fromEntries(Object.entries(EFFORT_LABELS).map(([k, v]) => [v.toLowerCase(), k]));

/** 入力欄の下の「GPT-5.6-Luna low · /private/tmp」から、いまのモデルの名前と考える量 */
export function codexStatus(screen: string): { name: string; effort: string | null } | null {
  for (const line of screen.split("\n").reverse()) {
    const m = /^ {2}(\S.*?) (none|minimal|low|medium|high|xhigh|max|ultra) · \S/.exec(line);
    if (m) return { name: m[1]!, effort: m[2]! };
  }
  return null;
}

/** Codex が最初から出している例の文字（書きかけではない） */
const PLACEHOLDERS = [
  "Ask Codex to do anything",
  "Explain this codebase",
  "Summarize recent commits",
  "Implement {feature}",
  "Find and fix a bug in @filename",
  "Write tests for @filename",
  "Improve documentation in @filename",
  "Run /review on my current changes",
  "Use /skills to list available skills",
];

/** いつもの入力の画面か（「› …」の行のすぐ下にモデルの表示がある）。書きかけがあれば draft */
export function codexInput(screen: string): { ready: boolean; draft: string | null } {
  const lines = screen.split("\n").filter((l) => l.trim());
  const at = lines.findLastIndex((l) => codexStatus(l) !== null);
  if (at < 1) return { ready: false, draft: null };
  const m = /^› ?(.*)$/.exec(lines[at - 1]!);
  if (!m) return { ready: false, draft: null };
  const text = m[1]!.trim();
  return { ready: true, draft: text && !PLACEHOLDERS.includes(text) ? text : null };
}

interface Row {
  key: string;
  label: string;
  cursor: boolean;
}

/** /model の画面の行（「› 3. GPT-5.6-Luna (current)  説明」）。見出しの下から「enter …」の行まで */
export function pickerRows(screen: string, heading: RegExp): Row[] | null {
  const lines = screen.split("\n");
  const head = lines.findLastIndex((l) => heading.test(l));
  if (head < 0) return null;
  const rows: Row[] = [];
  for (const line of lines.slice(head + 1)) {
    if (/^\s*enter /.test(line)) break;
    const m = /^\s*(›)?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?$/.exec(line);
    if (!m) continue;
    rows.push({ key: m[2]!, label: m[3]!.replace(/\s*\((?:current|default)\)/g, "").trim(), cursor: !!m[1] });
  }
  return rows;
}

type Herdr = { request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };

export async function switchCodexModel(
  herdr: Herdr,
  pane: string,
  target: AgentModel,
  effort: string | null,
  defaultEffort: string | null,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: boolean; effort: string | null; message?: string }> {
  const read = async () => {
    const r = (await herdr.request("pane.read", { pane_id: pane, source: "visible", lines: 60 })) as { read?: { text?: unknown } } | null;
    return typeof r?.read?.text === "string" ? r.read.text : "";
  };
  const keys = (k: string[]) => herdr.request("pane.send_keys", { pane_id: pane, keys: k });
  const want = effort ?? codexStatus(await read())?.effort ?? defaultEffort ?? "medium";
  if (!target.variants.includes(want)) return { ok: false, effort: null, message: "このモデルではそのエフォートを選べません" };
  const input = codexInput(await read());
  if (!input.ready) return { ok: false, effort: null, message: "Codex がメッセージを打てる画面になっていません。Mac の画面を見てください" };
  if (input.draft) return { ok: false, effort: null, message: "Mac の入力欄に書きかけの文章があります。送るか消してから切り替えてください" };

  /** 見出しが出るまで待って、その行を返す */
  const waitFor = async (heading: RegExp) => {
    for (let i = 0; i < 12; i++) {
      await wait(250);
      const rows = pickerRows(await read(), heading);
      if (rows && rows.length) return rows;
    }
    return null;
  };
  const back = async (message: string) => {
    // 開いている画面を閉じる（最大 3 段）
    for (let i = 0; i < 3 && /enter (select|default)/.test(await read()); i++) {
      await keys(["esc"]);
      await wait(250);
    }
    return { ok: false, effort: null, message };
  };

  // Codex は長い文字を貼り付けと見なすので、/model は文字として打ってから Enter
  await herdr.request("pane.send_text", { pane_id: pane, text: "/model" });
  await wait(200);
  await keys(["enter"]);
  const models = await waitFor(/Select Model and Effort/);
  if (!models) return back("Codex のモデルの画面を開けませんでした");
  const row = models.find((r) => r.label === target.name);
  if (!row) return back(`「${target.name}」が一覧にありませんでした`);
  await keys([row.key]);

  const levelHeading = new RegExp(`Select Reasoning Level for ${target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  let levels = await waitFor(levelHeading);
  if (!levels) return back("エフォートの画面になりませんでした");
  let label = EFFORT_LABELS[want] ?? want;
  if (!levels.some((r) => r.label === label)) {
    // max・ultra は「More reasoning…」の先
    const more = levels.find((r) => /^More reasoning/.test(r.label));
    if (!more) return back("そのエフォートは選べませんでした");
    await keys([more.key]);
    levels = await waitFor(/Advanced Reasoning/);
    if (!levels) return back("エフォートの画面になりませんでした");
    label = EFFORT_LABELS[want] ?? want;
  }
  const to = levels.findIndex((r) => r.label === label);
  const from = levels.findIndex((r) => r.cursor);
  if (to < 0) return back("そのエフォートは選べませんでした");
  const steps = to - (from < 0 ? 0 : from);
  if (steps !== 0) await keys(Array.from({ length: Math.abs(steps) }, () => (steps > 0 ? "down" : "up")));
  await wait(200);
  // 決める直前に、カーソルが目当ての行にあるか確かめる
  const check = pickerRows(await read(), /Select Reasoning Level|Advanced Reasoning/);
  if (!check || check.findIndex((r) => r.cursor) !== to) return back("カーソルが合わなかったので、選ぶのをやめました");
  await keys(["s"]);
  for (let i = 0; i < 8; i++) {
    await wait(250);
    const now = codexStatus(await read());
    if (now && now.name === target.name && now.effort === want) return { ok: true, effort: want };
  }
  return { ok: false, effort: null, message: "切り替わったか確かめられませんでした。Mac の画面を見てください" };
}

export { EFFORT_BY_LABEL };
