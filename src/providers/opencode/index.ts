// OpenCode のプロバイダ。会話はデータベース（opencode.ts）、モデルは画面の操作
// （opencodeModels.ts）に任せ、ここでは AgentProvider の形にまとめるだけにする。
import { OpenCodeStore, type OpenCodeChat } from "./store.ts";
import type { ToolDetail } from "../shared/toolDetail.ts";
import {
  currentModelOnScreen,
  loadOpenCodeModels,
  loadRecentModels,
  switchOpenCodeModel,
  switchOpenCodeVariant,
  variantOnScreen,
} from "./models.ts";
import type { AgentModel } from "../types.ts";
import type { ModelRef } from "../../protocol/messages.ts";
import { applyModelInfo } from "../../features/usage.ts";
import { discoverOpenCodeCommands, openCodeBuiltinCommands } from "./commands.ts";
import type {
  AgentProvider,
  ChatPoll,
  ChatSource,
  ChatUpdate,
  ModelControl,
  ModelListing,
  ModelSwitchResult,
  ProviderPaneContext,
} from "../types.ts";

const PREFIX = "opencode:";

export interface OpenCodeProviderOptions {
  /** 会話を読むもの。既定は new OpenCodeStore()（作るだけではデータベースを開かない） */
  store?: {
    read(directory: string): OpenCodeChat | null;
    title(directory: string): string | null;
    toolDetail?(itemId: string): ToolDetail | null;
  };
  /** 入っているモデルと最近使ったもの。既定は list: loadOpenCodeModels()・recent: loadRecentModels() */
  models?: { list(): Promise<AgentModel[]>; recent(): ModelRef[] };
  /** モデルの表示名とコンテキストの上限（使用量の % を出すため）。既定は null を返す */
  modelInfo?: (provider: string, id: string) => { name?: string | null; contextLimit?: number | null } | null;
}

/**
 * 既定のモデルの一覧。opencode models は数秒かかるので、1 回読んだら覚えておき、
 * 読んでいる途中にまた呼ばれたら同じ Promise を返す（cli.ts の refreshOpenCode と同じ考え方）。
 * 空だったときは、あとで入れたときのために次の呼び出しで読み直す。
 */
function defaultModelList(): () => Promise<AgentModel[]> {
  let cached: AgentModel[] | null = null;
  let loading: Promise<AgentModel[]> | null = null;
  return () => {
    if (cached) return Promise.resolve(cached);
    if (loading) return loading;
    loading = loadOpenCodeModels()
      .then((list) => {
        if (list.length) cached = list;
        return list;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };
}

export function createOpenCodeProvider(opts: OpenCodeProviderOptions = {}): AgentProvider {
  const store = opts.store ?? new OpenCodeStore();
  const listModels = opts.models?.list ?? defaultModelList();
  const recentModels = opts.models ? opts.models.recent : () => loadRecentModels();
  const modelInfo = opts.modelInfo ?? (() => null);

  const chat: ChatSource = {
    open(key) {
      // 送ったものの JSON。返事は書きかわりながら伸びるので、変わったら毎回全部送り直す
      let last = "";
      let first = true;
      return {
        poll(): ChatPoll {
          const id = key() ?? "";
          const wasFirst = first;
          first = false;

          // このペインが OpenCode でなければ、何も読まずに「まだない」を 1 回だけ
          if (!id.startsWith(PREFIX)) {
            if (wasFirst) return { chat: { available: false, reset: true, title: null, items: [] } };
            return { chat: null };
          }

          const found = store.read(id.slice(PREFIX.length));
          const update: ChatUpdate = found
            ? { available: true, reset: true, title: found.title, items: found.items }
            : { available: false, reset: true, title: null, items: [] };

          let out: ChatUpdate | null = null;
          const serialized = JSON.stringify(update);
          if (serialized !== last) {
            last = serialized;
            out = update;
          }

          // 使用量はいつもキーを付ける（分からなければ null）
          const raw = found?.usage ?? null;
          const info = raw && raw.provider && raw.model ? modelInfo(raw.provider, raw.model) : null;
          return { chat: out, usage: raw ? applyModelInfo(raw, info) : null };
        },
        close() {
          // 読むものはデータベースを開くだけなので、閉じるものはない
        },
      };
    },
    title(chatKey) {
      return chatKey.startsWith(PREFIX) ? store.title(chatKey.slice(PREFIX.length)) : null;
    },
    toolDetail(chatKey, itemId) {
      return chatKey.startsWith(PREFIX) ? store.toolDetail?.(itemId) ?? null : null;
    },
  };

  const models: ModelControl = {
    async list(ctx: ProviderPaneContext): Promise<ModelListing> {
      const text = await ctx.readScreen();
      const list = await listModels();
      const label = currentModelOnScreen(text);
      const current = label ? list.find((m) => `${m.name} ${m.providerName}` === label) ?? null : null;
      return {
        current: current ? { provider: current.provider, id: current.id } : null,
        variant: label ? variantOnScreen(text) ?? "default" : null,
        recent: recentModels(),
        models: list,
      };
    },

    async switch(ctx: ProviderPaneContext, req): Promise<ModelSwitchResult> {
      const target = (await listModels()).find((m) => m.provider === req.provider && m.id === req.model);
      if (!target) {
        return { ok: false, current: null, variant: null, message: "そのモデルは Mac の OpenCode に入っていません" };
      }

      // 画面がすでにそのモデルなら、一覧（ctrl+x m）は開かない
      const label = currentModelOnScreen(await ctx.readScreen());
      if (label !== `${target.name} ${target.providerName}`) {
        const r = await switchOpenCodeModel(ctx.herdr, ctx.paneId, target, ctx.wait);
        if (!r.ok) return { ok: false, current: null, variant: null, message: r.message ?? null };
      }

      let variant = variantOnScreen(await ctx.readScreen()) ?? "default";
      if (req.variant && req.variant !== variant) {
        const v = await switchOpenCodeVariant(ctx.herdr, ctx.paneId, target.variants, req.variant, ctx.wait);
        variant = v.variant ?? "default";
        // 失敗しても、いまのモデル（target）は分かっているので current に入れて返す（いまと同じ）
        if (!v.ok) {
          return {
            ok: false,
            current: { provider: target.provider, id: target.id },
            variant,
            message: v.message ?? null,
          };
        }
      }

      return { ok: true, current: { provider: target.provider, id: target.id }, variant, message: null };
    },
  };

  return {
    id: "opencode",
    unattendedArgs: ["--auto"],
    chatKey: (_record, cwd) => (cwd ? `${PREFIX}${cwd}` : null),
    chat,
    models,
    builtinCommands: () => openCodeBuiltinCommands(),
    discoverCommands: (cwd, home, env) => discoverOpenCodeCommands(cwd, home, env),
  };
}
