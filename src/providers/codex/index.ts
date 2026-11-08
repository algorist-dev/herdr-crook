import { TranscriptReader } from "../shared/transcript.ts";
import { codexHome, codexStatus, loadCodexModels, switchCodexModel } from "./models.ts";
import { codexToolDetail, findCodexRollout, parseCodexLines } from "./transcript.ts";
import { codexBuiltinCommands, discoverCodexCommands } from "./commands.ts";
import { jsonlChatStream } from "../shared/jsonlChat.ts";
import type { AgentModel } from "../types.ts";
import type { AgentProvider } from "../types.ts";

export interface CodexProviderOptions {
  /** 作業フォルダ → いちばん新しい rollout。既定は findCodexRollout(dir, codexHome()) */
  findRollout?: (cwd: string) => string | null;
  /** モデルの一覧。既定は loadCodexModels(codexHome())（呼ばれたときに読む） */
  models?: () => AgentModel[];
  /** ふだんの考える量（~/.codex/config.toml の model_reasoning_effort）。既定は null */
  defaultEffort?: () => string | null;
}

export function createCodexProvider(opts: CodexProviderOptions = {}): AgentProvider {
  const findRollout = opts.findRollout ?? ((cwd: string) => findCodexRollout(cwd, codexHome()));
  const models = opts.models ?? (() => loadCodexModels(codexHome()));
  const defaultEffort = opts.defaultEffort ?? (() => null);
  const titleReaders = new Map<string, TranscriptReader>();

  const pathOf = (key: string): string | null => (key.startsWith("codex:") ? findRollout(key.slice("codex:".length)) : null);

  return {
    id: "codex",
    unattendedArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    chatKey: (_record, cwd) => (cwd ? `codex:${cwd}` : null),
    chat: {
      open(key) {
        return jsonlChatStream({ key, resolve: pathOf, parse: parseCodexLines });
      },
      title(key) {
        let reader = titleReaders.get(key);
        if (!reader) {
          const path = pathOf(key);
          if (!path) return null;
          reader = new TranscriptReader(path, parseCodexLines);
          titleReaders.set(key, reader);
        }
        try {
          return reader.read().title;
        } catch {
          titleReaders.delete(key);
          return null;
        }
      },
      toolDetail(key, itemId) {
        const path = pathOf(key);
        return path ? codexToolDetail(path, itemId) : null;
      },
    },
    models: {
      async list(ctx) {
        const all = models();
        const status = codexStatus(await ctx.readScreen());
        const cur = status ? all.find((m) => m.name === status.name) ?? null : null;
        return { current: cur ? { provider: cur.provider, id: cur.id } : null, variant: status?.effort ?? null, recent: [], models: all };
      },
      async switch(ctx, req) {
        const target = models().find((m) => m.id === req.model);
        if (!target) return { ok: false, current: null, variant: null, message: "そのモデルは Mac の Codex にありません" };
        const r = await switchCodexModel(ctx.herdr, ctx.paneId, target, req.variant, defaultEffort(), ctx.wait);
        if (!r.ok) return { ok: false, current: null, variant: null, message: r.message ?? null };
        return { ok: true, current: { provider: target.provider, id: target.id }, variant: r.effort, message: null };
      },
    },
    builtinCommands: () => codexBuiltinCommands(),
    discoverCommands: (_cwd, home, env) => discoverCodexCommands(home, env),
  };
}
