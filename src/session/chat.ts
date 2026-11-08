// 会話・返事待ちの選択肢・使用量・入力欄の「/」「@」の見張り。
// エージェントごとの読み方はプロバイダに任せ、ここでは「届いたものを iPhone に送る」だけをする。
import { parseChoices } from "../features/choices.ts";
import type { ChatPoll, ChatStream } from "../providers/types.ts";
import type { ToolDetail } from "../providers/shared/toolDetail.ts";
import type { ChatController, HandlerTable, SessionBase } from "./types.ts";
import { usageSnapshot, type UsageSnapshot } from "../features/usage.ts";

export function createChatController(ctx: SessionBase, opts: { pollMs?: number } = {}): ChatController {
  const pollMs = opts.pollMs ?? ctx.services.deps.chatPollMs ?? 700;

  /** いま見ている会話の見張り（1 つだけ） */
  let interval: NodeJS.Timeout | null = null;
  let stream: ChatStream | null = null;
  let lastChoices = "";
  let reading = false;
  let tick = 0;
  /** 見張りを始めるたびに増やす。止めたあとに届いた古い返事を捨てるため */
  let watchToken = 0;

  /** 最後に送った使用量（同じものを何度も送らない） */
  let lastUsage: UsageSnapshot | null = null;
  let lastUsageKey: string | null = null;
  let lastUsagePane: string | null = null;

  const sendUsage = (pane: string, usage: UsageSnapshot | null) => {
    const content = usage ? (({ updatedAt: _at, ...rest }) => rest)(usage) : null;
    const key = JSON.stringify(content);
    if (lastUsagePane === pane && lastUsageKey === key) return;
    lastUsage = usage;
    lastUsageKey = key;
    lastUsagePane = pane;
    ctx.send({ t: "usage", pane, usage });
  };

  const sendCommands = (pane: string) => {
    const p = ctx.pane(pane);
    if (!p) return;
    ctx.send({ t: "commands", pane, agent: p.agent ?? null, commands: ctx.services.slashCommands(p.agent ?? null, p.cwd ?? null) });
  };

  const sendFiles = (pane: string, query: string) => {
    const p = ctx.pane(pane);
    if (!p) return;
    ctx.send({ t: "files", pane, query, files: ctx.services.listFiles(p.cwd ?? null, query) });
  };

  const stop = () => {
    watchToken++;
    if (interval) clearInterval(interval);
    interval = null;
    const s = stream;
    stream = null;
    s?.close();
    lastChoices = "";
    reading = false;
    tick = 0;
    lastUsage = null;
    lastUsageKey = null;
    lastUsagePane = null;
  };

  const start = (pane: string) => {
    stop();
    const token = watchToken;

    const p = ctx.pane(pane) ?? { agent: null, chatId: null };
    const source = ctx.services.providers.chatSourceFor(p);
    const opened = source ? source.open(() => ctx.pane(pane)?.chatId ?? null) : null;
    stream = opened;

    const sendChoices = (found: ReturnType<typeof parseChoices>) => {
      const msg = {
        t: "choices" as const,
        pane,
        question: found?.question ?? null,
        options: found?.options ?? [],
        selected: found?.selected ?? null,
      };
      const key = JSON.stringify(msg);
      if (key === lastChoices) return;
      lastChoices = key;
      ctx.send(msg);
    };

    /** 返事待ちの画面を読む。見えている範囲で読めなければ、少し前まで広げて探す */
    const readChoices = async () => {
      for (const [source, lines] of [["visible", 60], ["recent", 160]] as const) {
        const r = (await ctx.services.deps.herdr.request("pane.read", { pane_id: pane, source, lines })) as {
          read?: { text?: unknown };
        } | null;
        const text = r?.read?.text;
        const found = typeof text === "string" ? parseChoices(text) : null;
        if (found) return found;
      }
      return null;
    };

    const checkChoices = () => {
      const blocked = ctx.pane(pane)?.status === "blocked";
      if (!blocked) {
        if (lastChoices) sendChoices(null);
        return;
      }
      if (reading) return;
      reading = true;
      readChoices()
        .then((found) => {
          if (token === watchToken && interval) sendChoices(found);
        })
        .catch(() => {})
        .finally(() => {
          if (token === watchToken) reading = false;
        });
    };

    const apply = (poll: ChatPoll) => {
      if (poll.chat) ctx.send({ t: "chat", pane, ...poll.chat });
      if (poll.usage !== undefined) sendUsage(pane, usageSnapshot(pane, ctx.pane(pane)?.agent ?? null, poll.usage));
    };

    // 最初の 1 回。ここで投げたら start から外へ出し、呼ぶ側が iPhone にエラーを返す
    if (opened) apply(opened.poll());
    else ctx.send({ t: "chat", pane, available: false, reset: true, title: null, items: [] });

    sendCommands(pane);
    checkChoices();

    interval = setInterval(() => {
      if (tick++ % 2 === 0) checkChoices();
      try {
        if (!stream) return;
        apply(stream.poll());
      } catch {
        stop();
      }
    }, pollMs);
    interval.unref?.();
  };

  return {
    start,
    stop,
    lastUsage: (pane) => (lastUsagePane === pane ? lastUsage : null),
    sendCommands,
    sendFiles,
  };
}

export const chatHandlers: HandlerTable = {
  chat: (ctx, m) => ctx.chat.start(m.pane),
  unchat: (ctx) => ctx.chat.stop(),
  usage: (ctx, m) => ctx.send({ t: "usage", pane: m.pane, usage: ctx.chat.lastUsage(m.pane) }),
  commands: (ctx, m) => ctx.chat.sendCommands(m.pane),
  files: (ctx, m) => ctx.chat.sendFiles(m.pane, m.query),
  toolDetail: (ctx, m) => {
    const p = ctx.pane(m.pane);
    // ペインがもう無いときも返す（返さないと iPhone の読み込み中が消えない）
    if (!p) {
      ctx.send({ t: "toolDetail", pane: m.pane, item: m.item, detail: null });
      return;
    }
    const source = ctx.services.providers.chatSourceFor(p);
    let detail: ToolDetail | null = null;
    try {
      detail = p.chatId ? source?.toolDetail?.(p.chatId, m.item) ?? null : null;
    } catch {
      detail = null;
    }
    ctx.send({ t: "toolDetail", pane: m.pane, item: m.item, detail });
  },
};
