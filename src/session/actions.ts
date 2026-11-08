// スマホからの「送る・作る・タブの操作・画像」のハンドラ。
// relay.ts の各 case をそのまま移し、Herdr への頼みごとを ctx から使う形にしたもの。
import { homedir } from "node:os";
import { join } from "node:path";
import { parseChoices, type Choices } from "../features/choices.ts";
import { choicesFingerprint } from "../notify/notifier.ts";
import { describeError, type HandlerTable, type SessionBase } from "./types.ts";
import { saveImages } from "./uploads.ts";

/** 画面から、いま聞かれている選択肢を読む。見えていなければ少し前まで広げて探す */
async function readChoices(ctx: SessionBase, paneId: string): Promise<Choices | null> {
  for (const [source, lines] of [["visible", 60], ["recent", 160]] as const) {
    const r = (await ctx.services.deps.herdr.request("pane.read", { pane_id: paneId, source, lines })) as {
      read?: { text?: unknown };
    } | null;
    const text = r?.read?.text;
    const found = typeof text === "string" ? parseChoices(text) : null;
    if (found) return found;
  }
  return null;
}

/** できたばかりのペインでエージェントを起動する（起動しきれなくてもペインは使える） */
async function startAgent(ctx: SessionBase, agent: string, pane: string, unattended: boolean): Promise<boolean> {
  const args = unattended ? ctx.services.providers.unattendedArgs(agent) : null;
  const params: Record<string, unknown> = { name: agent, kind: agent, pane_id: pane, timeout_ms: 60_000 };
  // 引数が無いときは args のキーごと書かない（いまと同じ形）
  if (args) params.args = [...args];
  try {
    await ctx.services.deps.herdr.request("agent.start", params, 65_000);
    return true;
  } catch (err) {
    ctx.services.log(`agent start failed in ${pane}: ${describeError(err)}`);
    return false;
  }
}

/** 確認なしで立ち上げられないエージェントなら、作る前に断る */
function refuseUnattended(ctx: SessionBase, req: string, agent: string | null, unattended: boolean): boolean {
  if (!unattended || !agent) return false;
  if (ctx.services.providers.unattendedArgs(agent) !== null) return false;
  ctx.send({ t: "error", req, message: "このエージェントは YOLO モードで起動できません" });
  return true;
}

export const actionHandlers: HandlerTable = {
  async prompt(ctx, msg) {
    const paths = msg.images ? saveImages(ctx.services.uploadDir(), msg.images) : [];
    // 場所に空白があっても読み違えないように、`` で囲む
    const text = [msg.text.trim(), paths.map((p) => `\`${p}\``).join("\n")].filter(Boolean).join("\n\n");
    ctx.announce(msg.pane);
    if (ctx.kindOf(msg.pane) === "agent") {
      await ctx.services.deps.herdr.request("agent.prompt", { target: msg.pane, text });
    } else {
      await ctx.services.deps.herdr.request("pane.send_text", { pane_id: msg.pane, text });
      await ctx.services.deps.herdr.request("pane.send_keys", { pane_id: msg.pane, keys: ["enter"] });
    }
    ctx.poke();
  },

  async create(ctx, msg) {
    if (refuseUnattended(ctx, msg.req, msg.agent, msg.unattended)) return;
    const cwd = msg.cwd === "~" ? homedir() : msg.cwd.startsWith("~/") ? join(homedir(), msg.cwd.slice(2)) : msg.cwd;
    if (!ctx.services.dirExists(cwd)) {
      ctx.send({ t: "error", req: msg.req, message: `Mac にそのフォルダがありません: ${msg.cwd}` });
      return;
    }
    let created: unknown;
    try {
      created = await ctx.services.deps.herdr.request("workspace.create", { cwd, ...(msg.label ? { label: msg.label } : {}), focus: false });
    } catch (err) {
      ctx.send({ t: "error", req: msg.req, message: describeError(err) });
      return;
    }
    const result = created as { workspace?: { workspace_id?: unknown }; root_pane?: { pane_id?: unknown } } | null;
    const workspaceId = String(result?.workspace?.workspace_id ?? "");
    const pane = String(result?.root_pane?.pane_id ?? "");
    if (!workspaceId || !pane) {
      ctx.send({ t: "error", req: msg.req, message: "Herdr がワークスペースを作れませんでした" });
      return;
    }
    const agentStarted = msg.agent ? await startAgent(ctx, msg.agent, pane, msg.unattended) : false;
    if (agentStarted && msg.unattended) ctx.services.deps.watcher.markUnattended(pane);
    ctx.services.log(
      `created workspace ${workspaceId} at ${cwd}${msg.agent ? ` with ${msg.agent}${msg.unattended ? " (unattended)" : ""}` : ""}`,
    );
    ctx.poke();
    ctx.send({ t: "created", req: msg.req, workspaceId, pane, agentStarted });
  },

  async newTab(ctx, msg) {
    if (refuseUnattended(ctx, msg.req, msg.agent, msg.unattended)) return;
    let created: unknown;
    try {
      created = await ctx.services.deps.herdr.request("tab.create", { workspace_id: msg.workspace, focus: false });
    } catch (err) {
      ctx.send({ t: "error", req: msg.req, message: describeError(err) });
      return;
    }
    const pane = String((created as { root_pane?: { pane_id?: unknown } } | null)?.root_pane?.pane_id ?? "");
    if (!pane) {
      ctx.send({ t: "error", req: msg.req, message: "Herdr がタブを作れませんでした" });
      return;
    }
    const agentStarted = msg.agent ? await startAgent(ctx, msg.agent, pane, msg.unattended) : false;
    if (agentStarted && msg.unattended) ctx.services.deps.watcher.markUnattended(pane);
    ctx.services.log(
      `created tab ${pane} in ${msg.workspace}${msg.agent ? ` with ${msg.agent}${msg.unattended ? " (unattended)" : ""}` : ""}`,
    );
    ctx.poke();
    ctx.send({ t: "created", req: msg.req, workspaceId: msg.workspace, pane, agentStarted });
  },

  async paneAction(ctx, msg) {
    // タブ（ペイン）の長押しの操作。閉じるのはアプリが確かめてから送ってくる
    if (msg.action === "rename") {
      if (ctx.kindOf(msg.pane) === "agent") await ctx.services.deps.herdr.request("agent.rename", { target: msg.pane, name: msg.label });
      else await ctx.services.deps.herdr.request("pane.rename", { pane_id: msg.pane, label: msg.label });
    } else if (msg.action === "clear") {
      await ctx.services.deps.herdr.request("pane.clear", { pane_id: msg.pane });
    } else {
      if (ctx.terminal.currentPane() === msg.pane) ctx.terminal.close("explicit");
      await ctx.services.deps.herdr.request("pane.close", { pane_id: msg.pane });
      ctx.services.log(`closed pane ${msg.pane}`);
    }
    ctx.poke();
  },

  async attach(ctx, msg) {
    // ターミナルに画像の場所を貼る（Orca と同じ）。Enter は押さないので、続けて書ける
    const paths = saveImages(ctx.services.uploadDir(), msg.images);
    ctx.announce(msg.pane);
    const quoted = paths.map((p) => (/\s/.test(p) ? `'${p}'` : p));
    await ctx.services.deps.herdr.request("pane.send_text", { pane_id: msg.pane, text: quoted.join(" ") + " " });
  },

  async keys(ctx, msg) {
    ctx.announce(msg.pane);
    await ctx.services.deps.herdr.request("pane.send_keys", { pane_id: msg.pane, keys: msg.keys });
    ctx.poke();
  },

  async answer(ctx, msg) {
    // 通知のときと同じ質問がまだ出ているときだけ押す（答え終わった・次の質問に変わったなら押さない）
    const now = await readChoices(ctx, msg.pane);
    if (!now || choicesFingerprint(now) !== msg.expect) {
      ctx.send({ t: "error", message: "Mac の画面がもう変わっていたので、選びませんでした。画面を見て選び直してください" });
      return;
    }
    ctx.announce(msg.pane);
    const option = now.options.find((o) => o.key === msg.key);
    await ctx.services.deps.herdr.request("pane.send_keys", { pane_id: msg.pane, keys: option?.keys ?? [msg.key] });
    ctx.poke();
  },
};
