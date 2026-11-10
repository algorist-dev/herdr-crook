// Gemini CLI のモデル。一覧は gemini --list-models、切り替えは /model set（この会話だけ。設定ファイルは変えない）。
import type { AgentModel, ModelControl, ModelListing, ModelSwitchResult } from "../types.ts";
import { cachedList, runListCommand, switchBySlash, type InputState } from "../shared/slashModel.ts";

const PROVIDER = "gemini";

/** `gemini --list-models` の出力。auto は帯に具体的な名前が出ず確かめられないので入れない */
export function parseGeminiModels(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of stdout.split("\n")) {
    const head = /^([a-z0-9][a-z0-9.-]*) \((.+)\)\s*$/.exec(line);
    if (head) {
      if (head[1] !== "auto") models.push({ provider: PROVIDER, id: head[1]!, name: head[2]!, providerName: "Google", variants: [] });
      continue;
    }
    const limit = /^\s+Context limit:\s*([\d,]+) input/.exec(line);
    const last = models.at(-1);
    if (limit && last && last.contextLimit === undefined) last.contextLimit = Number(limit[1]!.replaceAll(",", ""));
  }
  return models;
}

const bottom = (screen: string) => screen.split("\n").filter((l) => l.trim()).slice(-12);

/** 入力欄（` > …`）。空のときは案内の文が出ている */
export function geminiInput(screen: string): InputState {
  const line = bottom(screen).reverse().find((l) => /^\s*>(\s|$)/.test(l));
  if (line === undefined) return { ready: false, draft: false };
  const text = line.replace(/^\s*>\s*/, "").trim();
  return { ready: true, draft: text !== "" && !text.startsWith("Type your message") };
}

/** いちばん下の帯の右端のモデル名 */
export function geminiCurrentModel(screen: string): string | null {
  const lines = screen.split("\n").filter((l) => l.trim());
  return /\s(gemini-[a-z0-9.-]+)\s*$/.exec(lines.at(-1) ?? "")?.[1] ?? null;
}

export function createGeminiModels(load?: () => Promise<AgentModel[]>): ModelControl {
  const list = cachedList(load ?? (async () => parseGeminiModels(await runListCommand("gemini", ["--list-models"]))));
  return {
    async list(ctx): Promise<ModelListing> {
      const models = await list();
      const id = geminiCurrentModel(await ctx.readScreen());
      return { current: id ? { provider: PROVIDER, id } : null, variant: null, recent: [], models };
    },
    async switch(ctx, req): Promise<ModelSwitchResult> {
      const target = (await list()).find((m) => m.id === req.model);
      if (!target) return { ok: false, current: null, variant: null, message: "そのモデルは選べません" };
      const r = await switchBySlash(ctx, { command: `/model set ${target.id}`, target: target.id, input: geminiInput, current: geminiCurrentModel });
      if (!r.ok) return { ok: false, current: null, variant: null, message: r.message ?? null };
      ctx.poke();
      return { ok: true, current: { provider: PROVIDER, id: target.id }, variant: null, message: null };
    },
  };
}
