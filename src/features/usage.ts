// エージェントの使用量（コンテキスト・トークン・費用・レート制限）。
// 取れるものはエージェントごとに違うので、無い項目は null のままにして画面で出し分ける。
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface UsageLimit {
  /** 画面に出す短い名前（5h・7d・30d など） */
  label: string;
  /** 0〜100 */
  usedPercent: number;
  /** リセットする時刻（ミリ秒） */
  resetsAt: number | null;
  windowMinutes: number | null;
}

export type UsageSource = "claude" | "claude-statusline" | "codex" | "opencode" | "copilot" | "pi" | "gemini" | "hermes";

/** 会話の記録から読んだ使用量（ペインにはまだ結びつけていない） */
export interface TranscriptUsage {
  model: string | null;
  provider: string | null;
  /** いまのコンテキストが使っているトークン */
  contextUsed: number | null;
  contextLimit: number | null;
  contextPercent: number | null;
  /** この会話の累計 */
  tokens: UsageTokens | null;
  /** ドル（分かるときだけ） */
  cost: number | null;
  limits: UsageLimit[];
  source: UsageSource;
}

/** 1 回の読み取りで分かった分（読むたびに mergeUsage で足す） */
export interface ParsedUsage {
  source: UsageSource;
  model?: string;
  provider?: string;
  contextUsed?: number;
  contextLimit?: number;
  /** 前の読み取りに足すトークン（Claude のように、読んだ分だけ増えるもの） */
  tokensDelta?: UsageTokens;
  /** いまの累計（Codex のように、もともと累計が入っているもの） */
  tokensTotal?: UsageTokens;
  cost?: number;
  /** 前の読み取りに足す費用（Pi のように、返事ごとに費用が書いてあるもの） */
  costDelta?: number;
  limits?: UsageLimit[];
}

/** iPhone に送る形（ペインと読んだ時刻を足したもの） */
export interface UsageSnapshot extends TranscriptUsage {
  pane: string;
  agent: string | null;
  /** 読んだ時刻（ミリ秒） */
  updatedAt: number;
}

export const EMPTY_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

export function addTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

export function tokenTotal(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}

/** 0〜100（小数 1 桁）。上限が分からなければ null */
export function contextPercent(used: number | null | undefined, limit: number | null | undefined): number | null {
  if (used === null || used === undefined || limit === null || limit === undefined || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}

/** 分を「5h」「7d」のような短い名前にする */
export function windowLabel(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "使用量";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** 秒・ミリ秒・ISO 文字列のどれでも、ミリ秒にする */
export function millisAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

export function mergeUsage(state: TranscriptUsage | null, parsed: ParsedUsage): TranscriptUsage {
  let tokens = state?.tokens ?? null;
  if (parsed.tokensTotal) tokens = parsed.tokensTotal;
  else if (parsed.tokensDelta) tokens = addTokens(tokens ?? EMPTY_TOKENS, parsed.tokensDelta);
  const contextUsed = parsed.contextUsed ?? state?.contextUsed ?? null;
  const contextLimit = parsed.contextLimit ?? state?.contextLimit ?? null;
  return {
    model: parsed.model ?? state?.model ?? null,
    provider: parsed.provider ?? state?.provider ?? null,
    contextUsed,
    contextLimit,
    contextPercent: contextPercent(contextUsed, contextLimit),
    tokens,
    cost: parsed.cost ?? (parsed.costDelta !== undefined ? (state?.cost ?? 0) + parsed.costDelta : state?.cost ?? null),
    limits: parsed.limits ?? state?.limits ?? [],
    source: parsed.source,
  };
}

/** モデルの一覧から分かった表示名・コンテキストの上限を当てる（OpenCode） */
export function applyModelInfo(
  usage: TranscriptUsage,
  info: { name?: string | null; contextLimit?: number | null } | null,
): TranscriptUsage {
  if (!info) return usage;
  const contextLimit = info.contextLimit ?? usage.contextLimit;
  return {
    ...usage,
    model: info.name ?? usage.model,
    contextLimit,
    contextPercent: contextPercent(usage.contextUsed, contextLimit),
  };
}

/** Claude の statusline の JSON（5h/7d・正確なコンテキスト%）を、会話の記録から読んだ使用量に重ねる */
export function applyClaudeStatusline(base: TranscriptUsage | null, payload: unknown): TranscriptUsage | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return base;
  const object = payload as Record<string, unknown>;
  const context = object.context_window as Record<string, unknown> | undefined;
  const model = object.model as Record<string, unknown> | undefined;
  const cost = object.cost as Record<string, unknown> | undefined;
  const percent = numberValue(context?.used_percentage) ?? numberValue(context?.used_percent);
  const size = numberValue(context?.context_window_size);
  const display = typeof model?.display_name === "string" && model.display_name ? model.display_name : null;
  const totalCost = numberValue(cost?.total_cost_usd);
  const limits = claudeLimits(object.rate_limits);
  if (percent === null && size === null && display === null && totalCost === null && limits.length === 0) return base;

  const usage: TranscriptUsage = base
    ? { ...base }
    : {
        model: null,
        provider: null,
        contextUsed: null,
        contextLimit: null,
        contextPercent: null,
        tokens: null,
        cost: null,
        limits: [],
        source: "claude-statusline",
      };
  if (display) usage.model = display;
  if (size !== null) usage.contextLimit = Math.round(size);
  if (percent !== null) usage.contextPercent = percent;
  // statusline の % と上限から、いま使っているトークンを出す（会話の記録より新しい）
  if (size !== null && percent !== null) usage.contextUsed = Math.round((size * percent) / 100);
  if (usage.contextUsed !== null && usage.contextLimit) {
    usage.contextPercent = contextPercent(usage.contextUsed, usage.contextLimit) ?? usage.contextPercent;
  }
  if (limits.length > 0) usage.limits = limits;
  if (totalCost !== null) usage.cost = totalCost;
  usage.source = "claude-statusline";
  return usage;
}

function claudeLimits(value: unknown): UsageLimit[] {
  if (!value || typeof value !== "object") return [];
  const rates = value as Record<string, unknown>;
  const limits: UsageLimit[] = [];
  for (const [key, label, windowMinutes] of [
    ["five_hour", "5h", 300],
    ["seven_day", "7d", 10080],
    ["spend_limit", "spend", null],
  ] as const) {
    const block = rates[key] as Record<string, unknown> | undefined;
    const used = numberValue(block?.used_percentage) ?? numberValue(block?.used_percent);
    if (used === null) continue;
    limits.push({ label, usedPercent: used, resetsAt: millisAt(block?.resets_at), windowMinutes });
  }
  return limits;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function usageSnapshot(
  pane: string,
  agent: string | null,
  usage: TranscriptUsage | null,
  now = Date.now(),
): UsageSnapshot | null {
  return usage ? { pane, agent, ...usage, updatedAt: now } : null;
}
