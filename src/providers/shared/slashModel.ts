// /model で切り替えるエージェント（Gemini CLI・Pi・Hermes）の共通の手順。
// 打つのは CLI の一覧にあったモデルだけ。いつもの入力の画面で書きかけが無いときだけ打ち、下の帯のモデル名で確かめる。
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { ProviderPaneContext } from "../types.ts";

export interface InputState {
  /** いつもの入力の画面か */
  ready: boolean;
  /** 入力欄に文字があるか */
  draft: boolean;
}

export interface SlashSwitch {
  /** 打つ文（一覧から作ったもの） */
  command: string;
  /** 帯に出るはずのモデル名 */
  target: string;
  input(screen: string): InputState;
  current(screen: string): string | null;
}

const POLLS = 24;
const POLL_MS = 250;
/** 候補の一覧を確定するだけで止まる CLI（Pi）のために、もう一度 Enter を押すまでの回数 */
const RESUBMIT_AFTER = 3;

export async function switchBySlash(ctx: ProviderPaneContext, s: SlashSwitch): Promise<{ ok: boolean; message?: string }> {
  const before = await ctx.readScreen();
  const input = s.input(before);
  if (!input.ready) return { ok: false, message: "このエージェントがメッセージを打てる画面になっていません。Mac の画面を見てください" };
  if (input.draft) return { ok: false, message: "Mac の入力欄に書きかけの文章があります。送るか消してから切り替えてください" };
  if (s.current(before) === s.target) return { ok: true };

  await ctx.herdr.request("pane.send_text", { pane_id: ctx.paneId, text: s.command });
  await ctx.wait(POLL_MS);
  await ctx.herdr.request("pane.send_keys", { pane_id: ctx.paneId, keys: ["enter"] });
  let resubmitted = false;
  for (let i = 0; i < POLLS; i++) {
    await ctx.wait(POLL_MS);
    const screen = await ctx.readScreen();
    if (s.current(screen) === s.target) return { ok: true };
    if (!resubmitted && i >= RESUBMIT_AFTER && s.input(screen).draft) {
      resubmitted = true;
      await ctx.herdr.request("pane.send_keys", { pane_id: ctx.paneId, keys: ["enter"] });
    }
  }
  return { ok: false, message: "モデルが変わったか確かめられませんでした。Mac の画面を見てください" };
}

/** 一覧を聞くコマンドの出力。動かせなければ ""（シェルは通さない） */
export function runListCommand(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, cwd: homedir() }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
}

/** 一覧を覚えておく（毎回 CLI を動かすと重いので 10 分）。空の答えは覚えない */
export function cachedList<T>(load: () => Promise<T[]>, now: () => number = Date.now, ttlMs = 10 * 60_000): () => Promise<T[]> {
  let value: T[] = [];
  let at = -Infinity;
  return async () => {
    if (value.length > 0 && now() - at < ttlMs) return value;
    const next = await load();
    if (next.length > 0) {
      value = next;
      at = now();
    }
    return value;
  };
}
