import { describe, expect, it } from "vitest";
import { summarize } from "../src/herdr/agents.ts";

const snapshot = {
  focused_pane_id: "w1:p1",
  layouts: [
    { tab_id: "w1:t1", panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }, { pane_id: "w1:p2", rect: { width: 80, height: 30 } }] },
  ],
  workspaces: [
    { workspace_id: "w1", label: "api", number: 1 },
    { workspace_id: "w2", label: "web", number: 2 },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "main", number: 1 },
    { tab_id: "w2:t1", workspace_id: "w2", label: "1", number: 1 },
  ],
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "unknown", cwd: "/repo/api", focused: true, terminal_title_stripped: "zsh" },
    { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", agent_status: "working", cwd: "/repo/api" },
    { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", agent_status: "blocked", cwd: "/repo/web" },
    { pane_id: "w2:p2", workspace_id: "w2", tab_id: "w2:t1", agent_status: "done", cwd: "/repo/web" },
  ],
  agents: [
    { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "working", state_change_seq: 5, title: "Refactor auth", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-1" } },
    { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", agent: "codex", display_agent: "Codex: web", agent_status: "blocked", state_change_seq: 3 },
    { pane_id: "w2:p2", workspace_id: "w2", tab_id: "w2:t1", agent: "claude", name: "reviewer", agent_status: "done", state_change_seq: 9 },
  ],
};

describe("summarize", () => {
  it("返事待ち → 完了 → 作業中 → それ以外 の順に並べる", () => {
    const list = summarize(snapshot);
    expect(list.map((p) => p.paneId)).toEqual(["w2:p1", "w2:p2", "w1:p2", "w1:p1"]);
  });

  it("エージェントとただのターミナルを分ける", () => {
    const list = summarize(snapshot);
    expect(list.find((p) => p.paneId === "w1:p2")?.kind).toBe("agent");
    expect(list.find((p) => p.paneId === "w1:p1")?.kind).toBe("terminal");
  });

  it("名前は 付けた名前 → 表示名 → エージェントの種類 の順に使う", () => {
    const list = summarize(snapshot);
    expect(list.find((p) => p.paneId === "w2:p2")?.label).toBe("reviewer");
    expect(list.find((p) => p.paneId === "w2:p1")?.label).toBe("Codex: web");
    expect(list.find((p) => p.paneId === "w1:p2")?.label).toBe("claude");
  });

  it("ワークスペースとタブの名前、題名、フォルダ名を付ける", () => {
    const pane = summarize(snapshot).find((p) => p.paneId === "w1:p2");
    expect(pane).toMatchObject({ workspace: "api", tab: "main", title: "Refactor auth", folder: "api", status: "working" });
  });

  it("ワークスペースの番号を付ける（なければ null）", () => {
    const list = summarize(snapshot);
    expect(list.find((p) => p.paneId === "w1:p2")?.workspaceNumber).toBe(1);
    expect(summarize({ panes: [{ pane_id: "x:p1", workspace_id: "x" }] })[0]?.workspaceNumber).toBeNull();
  });

  it("作業フォルダの場所もそのまま付ける（スマホで同じフォルダに新しいワークスペースを作るため）", () => {
    const pane = summarize(snapshot).find((p) => p.paneId === "w1:p2");
    expect(pane?.cwd).toMatch(/\/api$/);
    expect(pane?.cwd?.startsWith("/")).toBe(true);
  });

  it("ターミナルの題名はターミナルのタイトルを使う", () => {
    const pane = summarize(snapshot).find((p) => p.paneId === "w1:p1");
    expect(pane?.title).toBe("zsh");
  });

  it("同じ状態の中では、最近変わったものを上にする", () => {
    const list = summarize({
      ...snapshot,
      agents: [
        { pane_id: "a", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "working", state_change_seq: 1 },
        { pane_id: "b", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "working", state_change_seq: 7 },
      ],
      panes: [
        { pane_id: "a", workspace_id: "w1", tab_id: "w1:t1", agent_status: "working" },
        { pane_id: "b", workspace_id: "w1", tab_id: "w1:t1", agent_status: "working" },
      ],
    });
    expect(list.map((p) => p.paneId)).toEqual(["b", "a"]);
  });

  it("ワークスペースの ID とペインの大きさ（列と行）を付ける。分からなければ null", () => {
    const list = summarize(snapshot);
    expect(list.find((p) => p.paneId === "w1:p1")).toMatchObject({ workspaceId: "w1", cols: 120, rows: 40 });
    expect(list.find((p) => p.paneId === "w2:p1")).toMatchObject({ workspaceId: "w2", cols: null, rows: null });
  });

  it("状態が変わった時刻は since で渡したものを使う", () => {
    const list = summarize(snapshot, (paneId) => (paneId === "w2:p1" ? 1234 : null));
    expect(list.find((p) => p.paneId === "w2:p1")?.since).toBe(1234);
    expect(list.find((p) => p.paneId === "w1:p2")?.since).toBeNull();
  });

  it("OpenCode のペインは、作業フォルダで会話を探す（opencode:フォルダ）", () => {
    const list = summarize({
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo/app" }],
      agents: [{ pane_id: "w1:p1", agent: "opencode", agent_status: "idle" }],
    });
    expect(list[0]).toMatchObject({ kind: "agent", chatId: "opencode:/repo/app" });
  });

  it("Claude のセッションがあれば chatId に入れ、会話の題名を chatTitle に入れる", () => {
    const list = summarize(snapshot, () => null, (id) => (id === "sess-1" ? "認証を直す" : null));
    expect(list.find((p) => p.paneId === "w1:p2")).toMatchObject({ chatId: "sess-1", chatTitle: "認証を直す" });
    expect(list.find((p) => p.paneId === "w2:p1")).toMatchObject({ chatId: "codex:/repo/web", chatTitle: null });
  });

  it("壊れた形でも落ちずに空にする", () => {
    expect(summarize({})).toEqual([]);
    expect(summarize({ panes: "x" } as unknown as object)).toEqual([]);
  });
});
