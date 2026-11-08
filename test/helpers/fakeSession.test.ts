import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fakeSession, paneFixture } from "./fakeSession.ts";

describe("fakeSession", () => {
  it("send したものが sent に入る", () => {
    const f = fakeSession();
    f.ctx.send({ t: "pong" });
    expect(f.sent).toEqual([{ t: "pong" }]);
  });

  it("readScreen は setScreen の文字を返し、pane.read を herdrCalls に残す", async () => {
    const f = fakeSession({ screen: "前" });
    f.setScreen("> 入力");
    expect(await f.ctx.readScreen("w1:p1")).toBe("> 入力");
    expect(f.herdrCalls).toEqual([{ method: "pane.read", params: { pane_id: "w1:p1", source: "visible", lines: 80 } }]);
  });

  it("opts.herdr の返事を使う（pane.read で何も返さなければ画面の文字）", async () => {
    const f = fakeSession({ screen: "画面", herdr: (m) => (m === "tab.create" ? { root_pane: { pane_id: "w1:p9" } } : undefined) });
    expect(await f.ctx.services.deps.herdr.request("tab.create", {})).toEqual({ root_pane: { pane_id: "w1:p9" } });
    expect(await f.ctx.readScreen("w1:p1")).toBe("画面");
  });

  it("pane・kindOf は一覧から探し、setPanes で変えられる", () => {
    const f = fakeSession({ panes: [paneFixture(), paneFixture({ paneId: "w1:p2", kind: "terminal", agent: null })] });
    expect(f.ctx.pane("w1:p2")?.kind).toBe("terminal");
    expect(f.ctx.kindOf("w1:p1")).toBe("agent");
    expect(f.ctx.pane("w9:p9")).toBeUndefined();
    f.setPanes([]);
    expect(f.ctx.pane("w1:p1")).toBeUndefined();
    expect(f.ctx.kindOf("w1:p1")).toBeNull();
  });

  it("announce・poke・terminal・chat の呼ばれ方を覚える", () => {
    const f = fakeSession();
    f.ctx.announce("w1:p1", true);
    f.ctx.poke();
    f.ctx.terminal.close("explicit");
    f.ctx.chat.start("w1:p1");
    expect(f.announced).toEqual([{ pane: "w1:p1", resized: true }]);
    expect(f.pokes).toBe(1);
    expect(f.terminalCalls).toEqual(["close:explicit"]);
    expect(f.chatCalls).toEqual(["start"]);
  });

  it("deps の uploadDir・dirExists・slashCommands・listFiles・notify が services にも効く", () => {
    const f = fakeSession({
      deps: {
        uploadDir: () => "/x",
        dirExists: () => false,
        slashCommands: () => [{ name: "clear", summary: "", kind: "command" }],
        listFiles: () => ["a.ts"],
        notify: () => {},
      },
    });
    expect(f.ctx.services.uploadDir()).toBe("/x");
    expect(f.ctx.services.dirExists("/repo")).toBe(false);
    expect(f.ctx.services.slashCommands("claude", null)).toHaveLength(1);
    expect(f.ctx.services.listFiles(null, "")).toEqual(["a.ts"]);
    f.ctx.services.notify("t", "b");
    expect(f.notices).toEqual([]);
  });

  it("services を差しかえられ、既定の uploadDir はテストごとの一時フォルダ", () => {
    const f = fakeSession({ services: { dirExists: () => false } });
    expect(f.ctx.services.dirExists("/")).toBe(false);
    expect(existsSync(f.uploadDir)).toBe(true);
    expect(f.ctx.services.uploadDir()).toBe(f.uploadDir);
    expect(fakeSession().uploadDir).not.toBe(f.uploadDir);
  });

  it("restores の呼ばれ方を restoreCalls に残す（take は null）", () => {
    const f = fakeSession();
    const r = f.ctx.services.restores;
    r.schedule("w1:p1", { cols: 120, rows: 40 });
    expect(r.take("w1:p1")).toBeNull();
    r.restoreNow("w1:p1", { cols: 80, rows: 24 });
    r.shutdown();
    expect(f.restoreCalls).toEqual([
      { op: "schedule", pane: "w1:p1", size: { cols: 120, rows: 40 } },
      { op: "take", pane: "w1:p1" },
      { op: "restoreNow", pane: "w1:p1", size: { cols: 80, rows: 24 } },
      { op: "shutdown" },
    ]);
  });

  it("emitChange で watcher に登録した関数が呼ばれ、off したら呼ばれない", () => {
    const f = fakeSession();
    const seen: number[] = [];
    const fn = (s: { panes: unknown[] }) => void seen.push(s.panes.length);
    f.ctx.services.deps.watcher.on("change", fn);
    f.emitChange();
    f.ctx.services.deps.watcher.off("change", fn);
    f.emitChange();
    expect(seen).toEqual([1]);
  });

  it("watcher を差しかえたら ctx.pane もそれを見る", () => {
    const other = paneFixture({ paneId: "w2:p1" });
    const f = fakeSession({
      deps: { watcher: { current: () => ({ herdr: true, panes: [other] }), kindOf: () => "agent", poke() {}, markUnattended() {}, on() {}, off() {} } },
    });
    expect(f.ctx.pane("w2:p1")).toBe(other);
    expect(f.ctx.pane("w1:p1")).toBeUndefined();
  });
});
