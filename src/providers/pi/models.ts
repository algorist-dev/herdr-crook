// Pi のモデル。一覧は pi --list-models、切り替えは /model <提供元>/<モデル>。
// 候補の一覧が開いていると最初の Enter は確定だけで止まる（2 回目で切り替わる。switchBySlash が見て押す）。
import type { AgentModel, ModelControl, ModelListing, ModelSwitchResult } from "../types.ts";
import { cachedList, runListCommand, switchBySlash, type InputState } from "../shared/slashModel.ts";

const SIZE: Record<string, number> = { K: 1_000, M: 1_000_000 };

/** `pi --list-models` の表（provider model context max-out thinking images） */
export function parsePiModels(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const [provider, id, context] = line.trim().split(/\s+/);
    if (!provider || !id || !/^[\w.-]+$/.test(provider) || !/^[\w.:/-]+$/.test(id)) continue;
    const size = /^([\d.]+)([KM])$/.exec(context ?? "");
    models.push({
      provider,
      id,
      name: id,
      providerName: provider,
      variants: [],
      ...(size ? { contextLimit: Number(size[1]) * SIZE[size[2]!]! } : {}),
    });
  }
  return models;
}

const lines = (screen: string) => screen.split("\n");
const isRule = (line: string) => /^─{10,}\s*$/.test(line);

/** 入力欄は下の 2 本の線のあいだ */
export function piInput(screen: string): InputState {
  const all = lines(screen);
  const rules = all.flatMap((l, i) => (isRule(l) ? [i] : []));
  if (rules.length < 2) return { ready: false, draft: false };
  const between = all.slice(rules.at(-2)! + 1, rules.at(-1)!);
  return { ready: true, draft: between.some((l) => l.trim() !== "") };
}

/** いちばん下の帯の右端（`claude-haiku-4-5 • medium`） */
export function piCurrentModel(screen: string): string | null {
  const last = lines(screen).filter((l) => l.trim()).at(-1) ?? "";
  return /\s(\S+?)(?:\s+•\s+\S+)?\s*$/.exec(last)?.[1] ?? null;
}

export function createPiModels(load?: () => Promise<AgentModel[]>): ModelControl {
  const list = cachedList(load ?? (async () => parsePiModels(await runListCommand("pi", ["--list-models"]))));
  return {
    async list(ctx): Promise<ModelListing> {
      const models = await list();
      const id = piCurrentModel(await ctx.readScreen());
      const found = models.find((m) => m.id === id);
      return { current: found ? { provider: found.provider, id: found.id } : null, variant: null, recent: [], models };
    },
    async switch(ctx, req): Promise<ModelSwitchResult> {
      const target = (await list()).find((m) => m.id === req.model && m.provider === req.provider);
      if (!target) return { ok: false, current: null, variant: null, message: "そのモデルは選べません" };
      const r = await switchBySlash(ctx, { command: `/model ${target.provider}/${target.id}`, target: target.id, input: piInput, current: piCurrentModel });
      if (!r.ok) return { ok: false, current: null, variant: null, message: r.message ?? null };
      ctx.poke();
      return { ok: true, current: { provider: target.provider, id: target.id }, variant: null, message: null };
    },
  };
}
