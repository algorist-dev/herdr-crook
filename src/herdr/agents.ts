// Herdr の session.snapshot から、スマホの一覧に出す形を作る。
// 返事待ちのエージェントがいちばん上に来るように並べる。

import { defaultProviders } from "../providers/defaults.ts";
import type { HerdrAgentRecord } from "../providers/types.ts";

export type Status = "blocked" | "done" | "working" | "idle" | "unknown";

/** このペインでできること（iPhone が出し分けに使う） */
export interface PaneCaps {
  chat: boolean;
  models: boolean;
}

export interface PaneSummary {
  paneId: string;
  kind: "agent" | "terminal";
  /** 一覧で大きく出す名前（付けた名前・表示名・エージェントの種類・"ターミナル"） */
  label: string;
  /** エージェントの種類（claude・codex など）。ターミナルなら null */
  agent: string | null;
  status: Status;
  /** 何をしているか（エージェントが報告した題名やターミナルのタイトル） */
  title: string | null;
  workspace: string;
  /** Herdr のワークスペースの番号（画面の左に出す）。分からなければ null */
  workspaceNumber: number | null;
  tab: string;
  /** 作業フォルダの最後の名前 */
  folder: string | null;
  /** 作業フォルダの場所（新しいワークスペースを同じところに作るため） */
  cwd: string | null;
  focused: boolean;
  stateChangeSeq: number;
  workspaceId: string;
  /** Mac 側のペインの大きさ（スマホで「デスクトップ表示」にするとき使う）。分からなければ null */
  cols: number | null;
  rows: number | null;
  /** 状態がいまのものに変わった時刻（ミリ秒）。分からなければ null */
  since: number | null;
  /** Claude Code のセッション ID（会話をチャットで見られる）。なければ null */
  chatId: string | null;
  /** 会話の題名（Claude Code が付けたもの） */
  chatTitle: string | null;
  /** このペインでできること。summarize がいつも付ける */
  caps: PaneCaps;
  /** 確認なしの引数で立ち上げたエージェントのペイン（中継が覚えているあいだだけ） */
  unattended: boolean;
}

const ORDER: Record<Status, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

type Rec = Record<string, unknown>;

export function summarize(
  snapshot: object,
  sinceOf: (paneId: string) => number | null = () => null,
  chatTitleOf: (chatId: string, agent: string | null) => string | null = () => null,
  chatKeyOf: (record: HerdrAgentRecord, cwd: string | null) => string | null = (record, cwd) =>
    defaultProviders().chatKey(record, cwd),
  capsOf: (agent: string | null, chatId: string | null) => PaneCaps = (agent, chatId) => ({
    // 起動したばかりで記録（chatId）がまだなくても、会話を読めるエージェントなら会話で見せる（前の iPhone の決め方と同じ）
    chat: chatId !== null || defaultProviders().get(agent)?.chat !== undefined,
    models: defaultProviders().get(agent)?.models !== undefined,
  }),
): PaneSummary[] {
  const s = snapshot as Rec;
  const workspaces = records(s.workspaces);
  const tabs = records(s.tabs);
  const panes = records(s.panes);
  const agents = records(s.agents);

  const workspaceLabel = new Map(workspaces.map((w) => [str(w.workspace_id), str(w.label) ?? `#${w.number ?? "?"}`]));
  const workspaceNumber = new Map(workspaces.map((w) => [str(w.workspace_id), typeof w.number === "number" ? w.number : null]));
  const tabLabel = new Map(tabs.map((t) => [str(t.tab_id), str(t.label) ?? `${t.number ?? ""}`]));
  const agentByPane = new Map(agents.map((a) => [str(a.pane_id), a]));
  const recordOf = (agent: Rec | undefined): HerdrAgentRecord => {
    const session = agent?.agent_session as Rec | undefined;
    return {
      agent: str(agent?.agent),
      sessionSource: str(session?.source),
      sessionValue: str(session?.value),
    };
  };
  const chatIdOf = (agent: Rec | undefined, cwd: string | null = null): string | null => chatKeyOf(recordOf(agent), cwd);
  const sizeByPane = new Map<string, { cols: number; rows: number }>();
  for (const layout of records(s.layouts)) {
    for (const p of records(layout.panes)) {
      const rect = p.rect as Record<string, unknown> | undefined;
      const id = str(p.pane_id);
      if (id && rect && typeof rect.width === "number" && typeof rect.height === "number") {
        sizeByPane.set(id, { cols: rect.width, rows: rect.height });
      }
    }
  }

  const list: PaneSummary[] = [];
  for (const pane of panes) {
    const paneId = str(pane.pane_id);
    if (!paneId) continue;
    const agent = agentByPane.get(paneId);
    const source = agent ?? pane;
    const agentKind = agent ? str(agent.agent) : null;
    const status = toStatus(source.agent_status);
    const cwd = str(source.foreground_cwd) ?? str(source.cwd) ?? str(pane.cwd);
    const chatId = chatIdOf(agent, cwd);
    list.push({
      paneId,
      kind: agent ? "agent" : "terminal",
      label: (agent && (str(agent.name) ?? str(agent.display_agent) ?? agentKind)) ?? str(pane.label) ?? "ターミナル",
      agent: agentKind,
      status: agent ? status : "unknown",
      title: str(source.title) ?? str(source.terminal_title_stripped) ?? str(pane.terminal_title_stripped),
      workspace: workspaceLabel.get(str(pane.workspace_id)) ?? "",
      workspaceNumber: workspaceNumber.get(str(pane.workspace_id)) ?? null,
      tab: tabLabel.get(str(pane.tab_id)) ?? "",
      folder: cwd ? (cwd.split("/").filter(Boolean).pop() ?? "/") : null,
      cwd,
      focused: pane.focused === true,
      stateChangeSeq: typeof source.state_change_seq === "number" ? source.state_change_seq : 0,
      workspaceId: str(pane.workspace_id) ?? "",
      cols: sizeByPane.get(paneId)?.cols ?? null,
      rows: sizeByPane.get(paneId)?.rows ?? null,
      since: sinceOf(paneId),
      chatId,
      chatTitle: chatId ? chatTitleOf(chatId, agentKind) : null,
      caps: capsOf(agentKind, chatId),
      unattended: false,
    });
  }

  // エージェントが報告されているのに panes に無いもの（念のため）
  for (const agent of agents) {
    const paneId = str(agent.pane_id);
    if (!paneId || list.some((p) => p.paneId === paneId)) continue;
    const kind = str(agent.agent);
    const chatId = chatIdOf(agent);
    list.push({
      paneId,
      kind: "agent",
      label: str(agent.name) ?? str(agent.display_agent) ?? kind ?? "エージェント",
      agent: kind,
      status: toStatus(agent.agent_status),
      title: str(agent.title) ?? str(agent.terminal_title_stripped),
      workspace: workspaceLabel.get(str(agent.workspace_id)) ?? "",
      workspaceNumber: workspaceNumber.get(str(agent.workspace_id)) ?? null,
      tab: tabLabel.get(str(agent.tab_id)) ?? "",
      folder: null,
      cwd: null,
      focused: agent.focused === true,
      stateChangeSeq: typeof agent.state_change_seq === "number" ? agent.state_change_seq : 0,
      workspaceId: str(agent.workspace_id) ?? "",
      cols: sizeByPane.get(paneId)?.cols ?? null,
      rows: sizeByPane.get(paneId)?.rows ?? null,
      since: sinceOf(paneId),
      chatId,
      chatTitle: chatId ? chatTitleOf(chatId, kind) : null,
      caps: capsOf(kind, chatId),
      unattended: false,
    });
  }

  return list.sort((a, b) => {
    const kind = (a.kind === "agent" ? 0 : 1) - (b.kind === "agent" ? 0 : 1);
    if (kind !== 0) return kind;
    const order = ORDER[a.status] - ORDER[b.status];
    if (order !== 0) return order;
    return b.stateChangeSeq - a.stateChangeSeq;
  });
}

function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter((v): v is Rec => typeof v === "object" && v !== null) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toStatus(value: unknown): Status {
  return value === "blocked" || value === "done" || value === "working" || value === "idle" ? value : "unknown";
}
