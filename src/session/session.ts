// つながった 1 台の iPhone とのやりとり。transport が確かめたあとの welcome・一覧・
// メッセージの振り分け・切れたときの後片付けを、部品（terminal・chat・dispatch）につなぐ。
import { PROTOCOL_VERSION, type ServerMessage } from "../protocol/messages.ts";
import { PLUGIN_VERSION } from "../protocol/version.ts";
import { localizeServerMessage } from "../i18n/index.ts";
import type { WatchState } from "../herdr/paneWatcher.ts";
import type { AuthedLink } from "../transport/connection.ts";
import { bindLang, dispatch, type LangState } from "./dispatch.ts";
import { isAway } from "../notify/away.ts";
import { createChatController } from "./chat.ts";
import { createTerminalController } from "./terminal.ts";
import type { RelayServices, SessionBase, SessionContext } from "./types.ts";

export function createSession(services: RelayServices, link: AuthedLink): void {
  const deps = services.deps;

  /** この接続で「スマホから操作中」を Mac に知らせたペイン */
  const announced = new Set<string>();
  const announce = (pane: string, resized = false) => {
    if (announced.has(pane)) return;
    announced.add(pane);
    const found = base.pane(pane);
    const where = found?.workspace || "ワークスペース";
    const what = found?.kind === "agent" ? `エージェント（${found.agent ?? found.label}）` : "ターミナル";
    services.notify("スマホから操作中", `${where} の${what}${resized ? "（スマホの幅にしています。離れると元に戻ります）" : ""}`);
  };

  // このつながりの言語。hello の lang が無ければ日本語。あとから来る lang で替わる
  const lang: LangState = { lang: link.lang ?? "ja" };

  const base: SessionBase = {
    services,
    deviceId: link.deviceId,
    send: (msg: ServerMessage) => link.send(localizeServerMessage(lang.lang, msg)),
    pane: (paneId) => deps.watcher.current().panes.find((p) => p.paneId === paneId),
    kindOf: (paneId) => deps.watcher.kindOf(paneId),
    poke: () => deps.watcher.poke(),
    announce,
    async readScreen(paneId, lines = 80) {
      const result = (await deps.herdr.request("pane.read", { pane_id: paneId, source: "visible", lines })) as {
        read?: { text?: unknown };
      } | null;
      return typeof result?.read?.text === "string" ? result.read.text : "";
    },
  };

  const ctx: SessionContext = {
    ...base,
    terminal: createTerminalController(base),
    chat: createChatController(base),
  };
  bindLang(ctx, lang);
  // hello で言われた言語を端末に残す（通知はこれで書く。同じなら store が書かない）
  if (link.lang) deps.store.setLang?.(link.deviceId, link.lang);

  const onChange = (state: WatchState) => ctx.send({ t: "panes", panes: state.panes, herdr: state.herdr });
  const state = deps.watcher.current();
  const agents = deps.agents();
  const theme = deps.herdrTheme?.();
  const pushRoom = deps.pushRoom?.();
  ctx.send({
    t: "welcome",
    machine: deps.machine,
    protocol: PROTOCOL_VERSION,
    herdr: state.herdr,
    agents,
    push: deps.pushReady?.() ?? false,
    unattended: agents.filter((agent) => services.providers.unattendedArgs(agent) !== null),
    theme: theme?.theme,
    ...(pushRoom ? { pushRoom } : {}),
    plugin: PLUGIN_VERSION,
  });
  ctx.send({ t: "panes", panes: state.panes, herdr: state.herdr });
  deps.watcher.on("change", onChange);

  // Mac のテーマが変わったら、つながっている間だけ知らせる
  let themeMtime = theme?.mtimeMs ?? 0;
  const themeTimer = deps.herdrTheme
    ? setInterval(() => {
        const next = deps.herdrTheme?.();
        if (!next || next.mtimeMs === themeMtime) return;
        themeMtime = next.mtimeMs;
        ctx.send({ t: "theme", theme: next.theme });
      }, deps.herdrThemePollMs ?? 30_000)
    : null;
  themeTimer?.unref?.();

  // Mac から離れている（キーボードとマウスがさわられていない・ロックされている）：つないだとき・変わったときに知らせる
  let lastAway: boolean | null = null;
  const checkAway = async () => {
    try {
      const away = await isAway();
      if (away !== lastAway) {
        lastAway = away;
        ctx.send({ t: "away", away });
      }
    } catch {
      // 読めなければ黙る（iPhone は「分からなければ true」で扱う）
    }
  };
  void checkAway();
  const awayTimer = setInterval(() => void checkAway(), deps.awayPollMs ?? 30_000);
  awayTimer.unref?.();

  link.onMessage((raw) => void dispatch(ctx, raw));
  link.onClose(() => {
    if (themeTimer) clearInterval(themeTimer);
    clearInterval(awayTimer);
    deps.watcher.off("change", onChange);
    ctx.chat.stop();
    ctx.terminal.close("disconnect");
  });
}
