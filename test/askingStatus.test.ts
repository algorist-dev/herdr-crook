import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAskingOnScreen } from "../src/features/choices.ts";
import { markAskingAsBlocked } from "../src/herdr/askingStatus.ts";

// 監督のペインで捕まえた本物の画面（Herdr は done と言っていた）。試しの質問の部分だけ
const asking = readFileSync(join(import.meta.dirname, "fixtures", "claude-askuserquestion-supervisor.txt"), "utf8");
const listOnly = ["  私のおすすめは次の 2 つです", "  1. りんご", "  2. みかん", "", "✻ Brewed for 13s", "❯ ", "  Opus 5.5"].join("\n");

describe("isAskingOnScreen（画面がいま選択肢で待っているか）", () => {
  it("選択肢の下に「Enter to select」があれば待っている", () => {
    expect(isAskingOnScreen(asking)).toBe(true);
  });
  it("会話の中の番号付きの箇条書きだけなら待っていない", () => {
    expect(isAskingOnScreen(listOnly)).toBe(false);
  });
  it("「Esc to cancel」だけの一覧（/model など人が Mac で開いたもの）は待っていることにしない", () => {
    const menu = ["  Select model", "❯ 1. Default", "  2. Opus", "  3. Haiku", "", "  Enter to confirm · Esc to cancel"].join("\n");
    expect(isAskingOnScreen(menu)).toBe(false);
  });
  it("案内が選択肢より上にしかなければ待っていない", () => {
    expect(isAskingOnScreen("Enter to select\n" + listOnly)).toBe(false);
  });
});

describe("markAskingAsBlocked", () => {
  const snap = (status: string) => ({
    panes: [{ pane_id: "w1:p1", agent_status: status }],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: status }],
  });
  const reader = (text: string) => {
    const calls: string[] = [];
    return {
      calls,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push(`${method}:${String(params.pane_id)}`);
        return { read: { text } };
      },
    };
  };

  it("Herdr が done でも、画面が選択肢で待っていれば blocked にする", async () => {
    const r = reader(asking);
    const out = (await markAskingAsBlocked(snap("done"), r.request)) as ReturnType<typeof snap>;
    expect(out.agents[0]!.agent_status).toBe("blocked");
    expect(out.panes[0]!.agent_status).toBe("blocked");
  });

  it("idle も同じ", async () => {
    const out = (await markAskingAsBlocked(snap("idle"), reader(asking).request)) as ReturnType<typeof snap>;
    expect(out.agents[0]!.agent_status).toBe("blocked");
  });

  it("画面に箇条書きしかなければ done のまま", async () => {
    const out = (await markAskingAsBlocked(snap("done"), reader(listOnly).request)) as ReturnType<typeof snap>;
    expect(out.agents[0]!.agent_status).toBe("done");
  });

  it("作業中や blocked のペインは画面を読まない", async () => {
    for (const st of ["working", "blocked", "unknown"]) {
      const r = reader(asking);
      const s = snap(st);
      expect(await markAskingAsBlocked(s, r.request)).toBe(s);
      expect(r.calls).toEqual([]);
    }
  });

  it("画面が読めなければ Herdr の言うとおり", async () => {
    const s = snap("done");
    const out = await markAskingAsBlocked(s, async () => {
      throw new Error("gone");
    });
    expect(out).toBe(s);
  });
});
