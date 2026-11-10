// iPhone から来た 1 つのメッセージを、当てはまるハンドラに渡す。
// 形の確認・モデル切り替え中の断り・例外の文にすることを、ここ 1 か所でする。
import { parseClientMessage } from "../protocol/parse.ts";
import { actionHandlers } from "./actions.ts";
import { chatHandlers } from "./chat.ts";
import { modelHandlers } from "./models.ts";
import { terminalHandlers } from "./terminal.ts";
import { describeError, type Handler, type HandlerTable, type MessageType, type SessionContext } from "./types.ts";

const noop = () => {};

/** つながりごとの言語（session が作り、send と、あとから来る lang で共有する） */
export interface LangState {
  lang: string;
}

const langStates = new WeakMap<SessionContext, LangState>();

export function bindLang(ctx: SessionContext, state: LangState): void {
  langStates.set(ctx, state);
}

/** 言語を替えて、端末（devices.json）にも残す（同じなら書かない） */
export function setLang(ctx: SessionContext, lang: string): void {
  const state = langStates.get(ctx);
  if (!state || state.lang === lang) return;
  state.lang = lang;
  ctx.services.deps.store.setLang?.(ctx.deviceId, lang);
}

const lang: Handler<"lang"> = (ctx, msg) => setLang(ctx, msg.lang);

const push: Handler<"push"> = (ctx, msg) => {
  ctx.services.deps.store.setPush?.(ctx.deviceId, msg.token, msg.env, msg.prefs, msg.sealed);
};

const pushTest: Handler<"pushTest"> = async (ctx) => {
  // 試しの APNs は、鍵と宛先を持っている側（serve）に頼む。返事の文は送るときにこの端末の言語に替わる
  const result = await ctx.services.deps.pushTest?.(ctx.deviceId) ?? { ok: false, reason: "試しの通知を送れませんでした" };
  ctx.send({ t: "pushTested", ok: result.ok, message: result.reason });
};

const ping: Handler<"ping"> = (ctx) => {
  ctx.send({ t: "pong" });
};

export const HANDLERS: HandlerTable = {
  ...terminalHandlers,
  ...chatHandlers,
  ...modelHandlers,
  ...actionHandlers,
  push,
  pushTest,
  ping,
  lang,
  pair: noop,
  hello: noop,
};

export async function dispatch(ctx: SessionContext, raw: string): Promise<void> {
  const msg = parseClientMessage(raw);
  if (!msg) {
    // 形の合わない「新しいワークスペース」には、待たせないように返事をする
    const req = requestIdOf(raw);
    if (req) ctx.send({ t: "error", req, message: "フォルダは / か ~ から書いてください" });
    return;
  }
  // モデルを切り替えているペインには、そのあいだ何も打たない（一覧の検索や Enter に混ざらないように）
  if ((msg.t === "prompt" || msg.t === "keys" || msg.t === "answer" || msg.t === "attach") && ctx.services.modelSwitching.has(msg.pane)) {
    ctx.send({ t: "error", message: "モデルを切り替えているところです。少し待ってから送ってください" });
    return;
  }
  try {
    const handler = HANDLERS[msg.t] as Handler<MessageType> | undefined;
    await handler?.(ctx, msg as never);
  } catch (err) {
    ctx.send({ t: "error", message: describeError(err) });
  }
}

/** 形の合わないメッセージから、返事に使う req だけ取り出す */
function requestIdOf(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as { t?: unknown; req?: unknown };
    return value.t === "create" && typeof value.req === "string" && value.req.length <= 64 ? value.req : null;
  } catch {
    return null;
  }
}
