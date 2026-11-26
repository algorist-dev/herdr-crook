import { describe, expect, it } from "vitest";
import { findBgStandIn, type BgSessionDeps, type ClaudeSessionEntry } from "../src/providers/claude/bgSession.ts";

// 2026-11-26 にユーザーの iPhone で起きた形：Claude を bg（claude agents）で動かすと、
// 前もって立てておく「spare」も同じペインの環境を持っていて、その SessionStart が Herdr の記録を上書きする。
// spare は使われるまで会話の記録を作らないので、チャットが「まだ会話がありません」のままになる
const spare: ClaudeSessionEntry = { pid: 42239, sessionId: "spare-id", spare: true, updatedAt: 300 };
const worker: ClaudeSessionEntry = { pid: 42260, sessionId: "real-id", updatedAt: 200 };

function deps(over: Partial<BgSessionDeps> = {}): BgSessionDeps {
  const panes: Record<number, string> = { 42239: "sock|wE:p1", 42260: "sock|wE:p1", 50000: "sock|w1:p1" };
  return {
    sessions: () => [spare, worker],
    alive: () => true,
    paneOf: (pid) => panes[pid] ?? null,
    transcript: (id) => (id === "real-id" ? "/p/real-id.jsonl" : id === "other-id" ? "/p/other-id.jsonl" : null),
    ...over,
  };
}

describe("findBgStandIn", () => {
  it("記録のない spare なら、同じペインで動いている Claude の記録を使う", () => {
    expect(findBgStandIn("spare-id", deps())).toBe("/p/real-id.jsonl");
  });

  it("ほかのペインの Claude は使わない", () => {
    const other: ClaudeSessionEntry = { pid: 50000, sessionId: "other-id", updatedAt: 999 };
    expect(findBgStandIn("spare-id", deps({ sessions: () => [spare, other] }))).toBeNull();
    expect(findBgStandIn("spare-id", deps({ sessions: () => [spare, other, worker] }))).toBe("/p/real-id.jsonl");
  });

  it("同じペインに何人かいれば、いちばん最近動いたもの", () => {
    const newer: ClaudeSessionEntry = { pid: 42261, sessionId: "other-id", updatedAt: 250 };
    const d = deps({ sessions: () => [spare, worker, newer], paneOf: (pid) => (pid === 50000 ? null : "sock|wE:p1") });
    expect(findBgStandIn("spare-id", d)).toBe("/p/other-id.jsonl");
  });

  it("spare でなければ代わりを探さない（起動したばかりで、まだ送っていない Claude）", () => {
    const fresh: ClaudeSessionEntry = { pid: 42239, sessionId: "spare-id", updatedAt: 300 };
    expect(findBgStandIn("spare-id", deps({ sessions: () => [fresh, worker] }))).toBeNull();
  });

  it("終わったプロセス・ほかの spare・記録のないものは使わない", () => {
    expect(findBgStandIn("spare-id", deps({ alive: (pid) => pid !== 42260 }))).toBeNull();
    const spare2: ClaudeSessionEntry = { pid: 42262, sessionId: "other-id", spare: true, updatedAt: 999 };
    expect(findBgStandIn("spare-id", deps({ sessions: () => [spare, spare2], paneOf: () => "sock|wE:p1" }))).toBeNull();
    expect(findBgStandIn("spare-id", deps({ transcript: () => null }))).toBeNull();
  });

  it("spare のペインが分からない・spare が見つからないときは null", () => {
    expect(findBgStandIn("spare-id", deps({ paneOf: () => null }))).toBeNull();
    expect(findBgStandIn("nobody", deps())).toBeNull();
  });
});

describe("StandInCache", () => {
  it("しばらくは同じ答えを返し、時間がたてば聞き直す", async () => {
    const { StandInCache } = await import("../src/providers/claude/bgSession.ts");
    let t = 0;
    let calls = 0;
    const c = new StandInCache(() => `/p/${++calls}`, 5000, () => t);
    expect(c.get("a")).toBe("/p/1");
    t = 4999;
    expect(c.get("a")).toBe("/p/1");
    t = 5000;
    expect(c.get("a")).toBe("/p/2");
  });
});
