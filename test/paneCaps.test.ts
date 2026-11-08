// 一覧の 1 件に「このペインでできること」（caps）が付くことを見張る。
// iPhone はこれを見て、会話を出せるか・モデルを選べるかを決める。
import { describe, expect, it } from "vitest";
import { summarize } from "../src/herdr/agents.ts";

const snapshot = {
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo/app" },
    { pane_id: "w1:p2", workspace_id: "w1", cwd: "/repo/app" },
    { pane_id: "w1:p3", workspace_id: "w1", cwd: "/repo/app" },
  ],
  agents: [
    {
      pane_id: "w1:p1",
      agent: "claude",
      agent_status: "idle",
      agent_session: { source: "herdr:claude", value: "sess-1" },
    },
    { pane_id: "w1:p2", agent: "copilot", agent_status: "idle" },
  ],
};

describe("PaneSummary の caps", () => {
  it("Claude は会話もモデルもできる", () => {
    const pane = summarize(snapshot).find((p) => p.paneId === "w1:p1");
    expect(pane?.caps).toEqual({ chat: true, models: true });
  });

  it("Copilot は会話はできるが、モデルは選べない", () => {
    const pane = summarize(snapshot).find((p) => p.paneId === "w1:p2");
    expect(pane?.caps).toEqual({ chat: true, models: false });
  });

  it("ただのターミナルはどちらもできない", () => {
    const pane = summarize(snapshot).find((p) => p.paneId === "w1:p3");
    expect(pane).toMatchObject({ kind: "terminal", chatId: null });
    expect(pane?.caps).toEqual({ chat: false, models: false });
  });

  it("起動したばかりで会話の記録がまだ無い Claude も会話で見せる（前の iPhone と同じ）", () => {
    const list = summarize({
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo/app" }],
      agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }],
    });
    expect(list[0]?.caps).toEqual({ chat: true, models: true });
  });

  it("知らないエージェントは chat:false・models:false", () => {
    const list = summarize({
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo/app" }],
      agents: [{ pane_id: "w1:p1", agent: "gemini", agent_status: "idle" }],
    });
    expect(list[0]?.caps).toEqual({ chat: false, models: false });
  });
});
