// Claude Code のプロバイダ。会話・題名・モデル・「/」のコマンドを、この 1 つにまとめる。
// いまは claudeModels.ts・transcript.ts・slashCommands.ts を呼ぶだけ（中身を移すのは P4b）。
import { homedir } from "node:os";
import {
  CLAUDE_MODELS,
  effortOnScreen,
  lastModelInTranscript,
  matchClaudeModel,
  setClaudeEffort,
  switchClaudeModel,
} from "./models.ts";
import type { AgentModel } from "../types.ts";
import { findTranscript as findTranscriptIn, toolDetailFromTranscript } from "./transcript.ts";
import { TranscriptReader } from "../shared/transcript.ts";
import { applyClaudeStatusline } from "../../features/usage.ts";
import { claudeBuiltinCommands, discoverClaudeCommands } from "./commands.ts";
import { jsonlChatStream } from "../shared/jsonlChat.ts";
import type {
  AgentProvider,
  ChatSource,
  HerdrAgentRecord,
  ModelControl,
  ModelListing,
  ModelSwitchRequest,
  ModelSwitchResult,
  ProviderPaneContext,
} from "../types.ts";

export interface ClaudeProviderOptions {
  /** セッション ID → 会話記録のファイル。既定は transcript.ts の findTranscript(id, homedir()) */
  findTranscript?: (sessionId: string) => string | null;
  /** モデルの一覧。省略したら CLAUDE_MODELS（claudeModels.ts） */
  models?: () => Promise<AgentModel[]>;
  /** ふだんの考える量（settings.json の effortLevel）。省略したら null */
  defaultEffort?: () => string | null;
  /** statusline が残した JSON（セッション ID から）。省略したら null（重ねない） */
  statusline?: (sessionId: string) => Record<string, unknown> | null;
}

export function createClaudeProvider(opts: ClaudeProviderOptions = {}): AgentProvider {
  const findTranscript = opts.findTranscript ?? ((sessionId: string) => findTranscriptIn(sessionId, homedir()));
  // iPhone から頼んだモデルと考える量（キーはペイン ID）
  const asked = new Map<string, { model: string; effort: string | null }>();
  // 題名を読むための TranscriptReader（セッション ID ごと。読むたびに読み直さない）
  const titleReaders = new Map<string, TranscriptReader>();

  const chat: ChatSource = {
    open(key) {
      return jsonlChatStream({
        key,
        resolve: findTranscript,
        mapUsage: (usage, id) => applyClaudeStatusline(usage, opts.statusline?.(id) ?? null),
      });
    },
    title(chatKey) {
      let reader = titleReaders.get(chatKey);
      if (!reader) {
        const path = findTranscript(chatKey);
        // まだ記録ができていないセッションは Map に入れず、次の読み直しでまた探す
        if (!path) return null;
        reader = new TranscriptReader(path);
        titleReaders.set(chatKey, reader);
      }
      try {
        return reader.read().title;
      } catch {
        // 読めなくなったら、次はファイルを探し直す
        titleReaders.delete(chatKey);
        return null;
      }
    },
    toolDetail(chatKey, itemId) {
      const path = findTranscript(chatKey);
      return path ? toolDetailFromTranscript(path, itemId) : null;
    },
  };

  const models: ModelControl = {
    async list(ctx: ProviderPaneContext): Promise<ModelListing> {
      const list = (await opts.models?.()) ?? CLAUDE_MODELS;
      const path = ctx.pane.chatId ? findTranscript(ctx.pane.chatId) : null;
      const mine = asked.get(ctx.paneId);
      // 会話の記録の最後の返事のモデル（Mac で手で変えたときもこれで分かる）。まだ返事がなければ頼んだもの
      const current =
        matchClaudeModel(list, path ? lastModelInTranscript(path) : null) ??
        (mine ? list.find((m) => m.id === mine.model) ?? null : null);
      return {
        current: current ? { provider: "claude", id: current.id } : null,
        variant: effortOnScreen(await ctx.readScreen()) ?? mine?.effort ?? opts.defaultEffort?.() ?? null,
        recent: [],
        models: list,
      };
    },

    async switch(ctx: ProviderPaneContext, req: ModelSwitchRequest): Promise<ModelSwitchResult> {
      const list = (await opts.models?.()) ?? CLAUDE_MODELS;
      const target = list.find((m) => m.id === req.model);
      if (!target) return { ok: false, current: null, variant: null, message: "そのモデルは選べません" };
      if (req.variant && !target.variants.includes(req.variant)) {
        return { ok: false, current: null, variant: null, message: "このモデルではそのエフォートを選べません" };
      }
      const before = asked.get(ctx.paneId);
      // いまのモデル：会話の記録の最後の返事（なければ iPhone から頼んだもの）
      const path = ctx.pane.chatId ? findTranscript(ctx.pane.chatId) : null;
      const now = matchClaudeModel(list, path ? lastModelInTranscript(path) : null)?.id ?? before?.model ?? null;
      // 同じモデルで考える量だけなら /effort だけ。モデルを変えるときは確認の画面まで見届けてから
      const result =
        now === target.id && req.variant
          ? await setClaudeEffort(ctx.herdr, ctx.paneId, req.variant)
          : await switchClaudeModel(ctx.herdr, ctx.paneId, target, req.variant, ctx.wait);
      if (!result.ok) return { ok: false, current: null, variant: null, message: result.message ?? null };
      // 新しいモデルで選べない考える量は持ち越さない
      const carried = before?.effort && target.variants.includes(before.effort) ? before.effort : null;
      const effort = req.variant ?? carried;
      asked.set(ctx.paneId, { model: target.id, effort });
      ctx.poke();
      return { ok: true, current: { provider: "claude", id: target.id }, variant: effort, message: null };
    },
  };

  return {
    id: "claude",
    unattendedArgs: ["--dangerously-skip-permissions"],
    chatKey(record: HerdrAgentRecord) {
      return record.sessionValue ?? null;
    },
    chat,
    models,
    builtinCommands: () => claudeBuiltinCommands(),
    discoverCommands: (cwd, home) => discoverClaudeCommands(cwd, home),
  };
}
