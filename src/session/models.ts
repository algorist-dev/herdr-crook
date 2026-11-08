// モデルの一覧と切り替え。エージェントごとの中身はプロバイダに任せ、
// ここでは「ペインがあるか・返事待ちや作業中は断る・同時に切り替えない・Mac に知らせる」を見る。
import { providerContext, type HandlerTable } from "./types.ts";

export const modelHandlers: HandlerTable = {
  async models(ctx, msg) {
    // 切り替えているあいだは、古い一覧を送らない
    if (ctx.services.modelSwitching.has(msg.pane)) return;
    const pane = ctx.pane(msg.pane);
    if (!pane) return;
    const provider = ctx.services.providers.get(pane.agent);
    const models = provider?.models;
    if (!provider || !models) return;

    const listing = await models.list(providerContext(ctx, pane));
    ctx.send({
      t: "models",
      pane: msg.pane,
      agent: provider.id,
      current: listing.current,
      variant: listing.variant,
      recent: listing.recent,
      models: listing.models,
    });
  },

  async setModel(ctx, msg) {
    const fail = (message: string) => ctx.send({ t: "modelSet", pane: msg.pane, ok: false, current: null, variant: null, message });

    const pane = ctx.pane(msg.pane);
    const models = pane ? ctx.services.providers.get(pane.agent)?.models : undefined;
    if (!pane || !models) return fail("このタブのモデルは切り替えられません");
    if (pane.status === "blocked") return fail("返事待ちのあいだは切り替えられません。先に返事をしてください");
    if (pane.status === "working") return fail("作業中は切り替えられません。終わってから切り替えてください");
    if (ctx.services.modelSwitching.has(msg.pane)) return fail("いま切り替えています");

    ctx.services.modelSwitching.add(msg.pane);
    try {
      ctx.announce(msg.pane);
      const r = await models.switch(providerContext(ctx, pane), { provider: msg.provider, model: msg.model, variant: msg.variant });
      ctx.send({ t: "modelSet", pane: msg.pane, ok: r.ok, current: r.current, variant: r.variant, message: r.message });
    } finally {
      ctx.services.modelSwitching.delete(msg.pane);
    }
  },
};
