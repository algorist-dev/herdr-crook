// OpenCode のモデルを iPhone から切り替える。
// OpenCode には動いている画面のモデルを外から決める入口がないので、人がするのと同じように
// モデルの一覧（ctrl+x m）を開き、名前で絞り込み、名前と提供元が合う行まで下げて決める。最後に画面の下の表示で確かめる。
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModel } from "../types.ts";

export type OpenCodeModel = AgentModel;

const PROVIDER_NAMES: Record<string, string> = { "opencode-go": "OpenCode Go", opencode: "OpenCode" };

/** opencode models --verbose の出力（「提供元/ID」の行のあとに JSON）を読む。使えなくなったモデルは外す */
export function parseModelList(out: string): OpenCodeModel[] {
  const list: OpenCodeModel[] = [];
  const re = /^([a-z0-9._-]+)\/([^\s]+)\n(\{[\s\S]*?\n\})/gm;
  for (const m of out.matchAll(re)) {
    try {
      const v = JSON.parse(m[3]!) as { id?: unknown; providerID?: unknown; name?: unknown; status?: unknown; variants?: unknown; limit?: unknown };
      if (v.status === "deprecated") continue;
      const provider = typeof v.providerID === "string" ? v.providerID : m[1]!;
      const id = typeof v.id === "string" ? v.id : m[2]!;
      const name = typeof v.name === "string" && v.name ? v.name : id;
      const variants = v.variants && typeof v.variants === "object" && !Array.isArray(v.variants) ? Object.keys(v.variants) : [];
      const limit = v.limit && typeof v.limit === "object" ? (v.limit as { context?: unknown }).context : undefined;
      const model: OpenCodeModel = { provider, id, name, providerName: PROVIDER_NAMES[provider] ?? provider, variants };
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) model.contextLimit = Math.round(limit);
      list.push(model);
    } catch {
      // 読めないものは飛ばす
    }
  }
  return list;
}

/** ~/.local/state/opencode/model.json の「最近使ったモデル」 */
export function parseRecent(json: string): { provider: string; id: string }[] {
  try {
    const v = JSON.parse(json) as { recent?: unknown };
    if (!Array.isArray(v.recent)) return [];
    return v.recent.flatMap((r: { providerID?: unknown; modelID?: unknown }) =>
      typeof r?.providerID === "string" && typeof r?.modelID === "string" ? [{ provider: r.providerID, id: r.modelID }] : [],
    );
  } catch {
    return [];
  }
}

/** 行の右端の飾り（広い画面だと作業フォルダの「/~」などが、間をあけて出る）を外す */
function withoutRightEdge(line: string): string {
  return line.replace(/\s{3,}\S.*$/, "").trimEnd();
}

/** 入力欄の枠（┃）の中の「Build · モデル 提供元 · 考える量」から「モデル 提供元」。会話の中の似た行は見ない */
export function currentModelOnScreen(screen: string): string | null {
  for (const raw of screen.split("\n").reverse()) {
    const line = raw.replace(/^(\s*┃\s+)/, "$1\u0000").split("\u0000").map((part, i) => (i === 1 ? withoutRightEdge(part) : part)).join("");
    const m = /^\s*┃\s+[A-Z][A-Za-z]* · (.+?)(?: · [A-Za-z]+)?\s*$/.exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** 入力欄の下の考える量（「· high」）。付いていなければ既定（null） */
export function variantOnScreen(screen: string): string | null {
  for (const raw of screen.split("\n").reverse()) {
    if (!/^\s*┃\s+[A-Z][A-Za-z]* · /.test(raw)) continue;
    const line = withoutRightEdge(raw.replace(/^\s*┃\s+/, ""));
    const m = / · ([a-z]+)\s*$/.exec(line);
    return m ? m[1]! : null;
  }
  return null;
}

/** 考える量を切り替える（ctrl+t で「段階…→既定→…」と回るので、目当てになるまで押す）。target が "default" なら印なし */
export async function switchOpenCodeVariant(
  herdr: Herdr,
  pane: string,
  variants: string[],
  target: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: boolean; variant: string | null; message?: string }> {
  const want = target === "default" ? null : target;
  if (want !== null && !variants.includes(want)) return { ok: false, variant: variantOnScreen(await readScreen(herdr, pane)), message: "このモデルではそのエフォートを選べません" };
  let now = await readScreen(herdr, pane);
  // 何かのダイアログ（見出しの右に「esc」）が開いているときは ctrl+t を押さない
  const dialog = (s: string) => pickerState(s).open || s.split("\n").some((l) => /\S\s{3,}esc\s*$/.test(l));
  if (currentModelOnScreen(now) === null || dialog(now)) return { ok: false, variant: null, message: "OpenCode がメッセージを打てる画面になっていません" };
  for (let i = 0; i <= variants.length + 1; i++) {
    if (variantOnScreen(now) === want) return { ok: true, variant: want };
    if (dialog(now)) return { ok: false, variant: variantOnScreen(now), message: "途中で画面が変わったので、やめました" };
    await herdr.request("pane.send_keys", { pane_id: pane, keys: ["ctrl+t"] });
    await wait(300);
    now = await readScreen(herdr, pane);
    if (currentModelOnScreen(now) === null) return { ok: false, variant: null, message: "途中で画面が変わったので、やめました" };
  }
  return { ok: false, variant: variantOnScreen(now), message: "エフォートを切り替えられませんでした" };
}

/** 画面の 1 文字の幅（日本語などの全角は 2） */
function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
    ? 2
    : 1;
}

function displayColumn(line: string, index: number): number {
  let col = 0;
  for (const ch of line.slice(0, index)) col += charWidth(ch);
  return col;
}

/** 表示の幅で col より右だけ */
function fromColumn(line: string, col: number): string {
  let w = 0;
  let out = "";
  for (const ch of line) {
    if (w >= col) out += ch;
    w += charWidth(ch);
  }
  return out;
}

/**
 * モデルの一覧（ダイアログ）の行だけを取り出す。広い画面ではダイアログが真ん中に重なって出て、
 * 左には会話の文字が残っているので、「Select model」の見出しの位置から右だけを読む
 */
function pickerLines(screen: string): string[] | null {
  const lines = screen.split("\n");
  const head = lines.findIndex((l) => /(?:^|\s)Select model\s{2,}esc\s*$/.test(l));
  if (head < 0) return null;
  const col = Math.max(0, displayColumn(lines[head]!, lines[head]!.indexOf("Select model")) - 2);
  return lines.slice(head).map((l) => fromColumn(l, col));
}

/** モデルの一覧が開いているか（「Select model … esc」の見出し）と、検索の文字 */
export function pickerState(screen: string): { open: boolean; query: string | null } {
  const lines = pickerLines(screen);
  if (!lines) return { open: false, query: null };
  let i = 1;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const q = (lines[i] ?? "").trim();
  return { open: true, query: q === "Search" ? "" : q };
}

/** 絞り込んだモデルの一覧の行（「Select model」・検索の行のあとから「Connect provider」の前まで） */
export function pickerRows(screen: string): { name: string; provider: string }[] {
  const lines = pickerLines(screen);
  if (!lines) return [];
  // 次の空でない行は検索の文字。その後ろから
  let i = 1;
  while (i < lines.length && !lines[i]!.trim()) i++;
  i++;
  const rows: { name: string; provider: string }[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (/Connect provider/.test(line)) break;
    const text = line.replace(/^[\s┃╹│]+/, "").replace(/^●\s*/, "").trimEnd();
    if (!text) continue;
    const cols = text.split(/\s{2,}/).filter(Boolean);
    // 右端に「Free」などの印が付くことがある
    // 右端の飾り（「/~」のような作業フォルダ）も外す
    while (cols.length > 2 && (/^(Free|Latest|New|Beta)$/.test(cols[cols.length - 1]!) || /^[/~]/.test(cols[cols.length - 1]!))) cols.pop();
    if (cols.length < 2) continue;
    rows.push({ name: cols[0]!, provider: cols[cols.length - 1]! });
  }
  return rows;
}

export function rowIndexFor(screen: string, target: { name: string; providerName: string }): number {
  return pickerRows(screen).findIndex((r) => r.name === target.name && r.provider === target.providerName);
}

type Herdr = { request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };

async function readScreen(herdr: Herdr, pane: string): Promise<string> {
  const r = (await herdr.request("pane.read", { pane_id: pane, source: "visible", lines: 80 })) as { read?: { text?: unknown } } | null;
  return typeof r?.read?.text === "string" ? r.read.text : "";
}

/** 一覧を開いて選ぶ。うまくいかなければ一覧を閉じて、何も変えずに理由を返す */
export async function switchOpenCodeModel(
  herdr: Herdr,
  pane: string,
  target: { name: string; providerName: string },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: boolean; current: string | null; message?: string }> {
  const keys = (k: string[]) => herdr.request("pane.send_keys", { pane_id: pane, keys: k });
  const screen = () => readScreen(herdr, pane);
  const before = await screen();
  // もう何かの画面（ほかのダイアログ）が開いていたら触らない
  if (pickerState(before).open || currentModelOnScreen(before) === null) {
    return { ok: false, current: currentModelOnScreen(before), message: "OpenCode がメッセージを打てる画面になっていません。Mac の画面を見てください" };
  }
  await keys(["ctrl+x", "m"]);
  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    await wait(250);
    opened = pickerState(await screen()).open;
  }
  if (!opened) {
    return { ok: false, current: currentModelOnScreen(await screen()), message: "OpenCode のモデルの一覧を開けませんでした。Mac の入力欄に「m」が残っていたら消してください" };
  }
  const cancel = async (message: string) => {
    if (pickerState(await screen()).open) await keys(["esc"]);
    await wait(200);
    return { ok: false, current: currentModelOnScreen(await screen()), message };
  };
  await herdr.request("pane.send_text", { pane_id: pane, text: target.name });
  // 検索の文字が出て、同じ一覧が 2 回続けて読めてから行を決める（絞り込む前の一覧で数えない）
  let index = -1;
  let last = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    await wait(250);
    const now = await screen();
    const state = pickerState(now);
    if (!state.open) return cancel("モデルの一覧が閉じられました");
    if (state.query !== target.name) continue;
    const rows = JSON.stringify(pickerRows(now));
    if (rows === last) {
      index = rowIndexFor(now, target);
      break;
    }
    last = rows;
  }
  if (index < 0) return cancel(`「${target.name}（${target.providerName}）」が一覧にありませんでした`);
  if (index > 0) await keys(Array.from({ length: index }, () => "down"));
  // 決める直前にもう一度：一覧が開いたままで、同じ行にいるか
  await wait(150);
  const check = await screen();
  if (!pickerState(check).open || pickerState(check).query !== target.name || rowIndexFor(check, target) !== index) {
    return cancel("途中で画面が変わったので、選ぶのをやめました");
  }
  await keys(["enter"]);
  const want = `${target.name} ${target.providerName}`;
  let current: string | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    await wait(250);
    current = currentModelOnScreen(await screen());
    if (current === want) return { ok: true, current };
  }
  return { ok: false, current, message: "切り替わったか確かめられませんでした。Mac の画面を見てください" };
}

/** 入っているモデルの一覧（opencode models --verbose）。数秒かかるので呼ぶ側で取っておく */
export function loadOpenCodeModels(bin = "opencode"): Promise<OpenCodeModel[]> {
  return new Promise((resolve) => {
    execFile(bin, ["models", "--verbose"], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : parseModelList(stdout)));
  });
}

export function loadRecentModels(home = homedir()): { provider: string; id: string }[] {
  try {
    return parseRecent(readFileSync(join(home, ".local", "state", "opencode", "model.json"), "utf8"));
  } catch {
    return [];
  }
}
