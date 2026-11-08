// ターミナル中継（open・input・resize・scroll・close）と、スマホ表示で変えた大きさを戻すところ。
import { describe, expect, it } from "vitest";
import type { Terminal, TerminalHandlers } from "../../src/herdr/terminalSession.ts";
import type { RelayDeps } from "../../src/relay.ts";
import { createRestoreManager, createTerminalController } from "../../src/session/terminal.ts";
import { fakeSession, paneFixture } from "../helpers/fakeSession.ts";

/** 条件が成り立つまで少し待つ */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("待っても条件が成り立ちません");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Opened {
  pane: string;
  observe: boolean;
  cols: number;
  rows: number;
  handlers: TerminalHandlers;
  inputs: string[];
  resizes: [number, number][];
  scrolls: ["up" | "down", number][];
  closed: boolean;
}

function fakeOpener() {
  const opened: Opened[] = [];
  const openTerminal: RelayDeps["openTerminal"] = (pane, cols, rows, handlers, observe): Terminal => {
    const o: Opened = { pane, observe, cols, rows, handlers, inputs: [], resizes: [], scrolls: [], closed: false };
    opened.push(o);
    return {
      input: (b64) => o.inputs.push(b64),
      resize: (c, r) => o.resizes.push([c, r]),
      scroll: (dir, lines) => o.scrolls.push([dir, lines]),
      close: () => (o.closed = true),
    };
  };
  return { opened, openTerminal };
}

function setup(graceMs = 40) {
  const { opened, openTerminal } = fakeOpener();
  const logs: string[] = [];
  const restores = createRestoreManager({ openTerminal, graceMs, log: (m) => void logs.push(m) });
  const f = fakeSession({
    panes: [paneFixture({ paneId: "w1:p1", cols: 120, rows: 40 }), paneFixture({ paneId: "w1:p2", cols: 100, rows: 30 })],
    deps: { openTerminal },
    services: { restores },
  });
  return { opened, restores, logs, f, terminal: createTerminalController(f.ctx) };
}

const fit = (pane = "w1:p1", cols = 44, rows = 30) => ({ t: "open" as const, pane, cols, rows, mode: "fit" as const });
const mirror = (pane = "w1:p1", cols = 120, rows = 40) => ({ t: "open" as const, pane, cols, rows, mode: "mirror" as const });

describe("スマホ表示で変えた大きさを戻す", () => {
  it("スマホ表示で開いて閉じたら、前の大きさですぐ戻す", async () => {
    const { opened, f, terminal, logs } = setup();

    terminal.open(fit());
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ pane: "w1:p1", observe: false, cols: 44, rows: 30 });
    expect(f.announced).toEqual([{ pane: "w1:p1", resized: true }]);
    expect(terminal.currentPane()).toBe("w1:p1");

    terminal.close("explicit");
    expect(opened).toHaveLength(2);
    expect(opened[1]).toMatchObject({ pane: "w1:p1", observe: false, cols: 120, rows: 40 });
    await waitFor(() => opened[1]!.closed);
    expect(logs).toContain("restored w1:p1 to 120x40");
    expect(terminal.currentPane()).toBeNull();
  });

  it("切れたときは少し待ってから戻す", async () => {
    const { opened, terminal } = setup();
    terminal.open(fit());
    terminal.close("disconnect");
    expect(opened).toHaveLength(1);
    await waitFor(() => opened.length === 2);
    expect(opened[1]).toMatchObject({ pane: "w1:p1", observe: false, cols: 120, rows: 40 });
  });

  it("待っている間に同じペインをスマホ表示で開き直したら戻さず、次に閉じたとき最初の大きさに戻す", async () => {
    const { opened, terminal } = setup(60);
    terminal.open(fit());
    terminal.close("disconnect");
    await new Promise((r) => setTimeout(r, 10));
    expect(opened).toHaveLength(1);

    terminal.open(fit());
    expect(opened).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 90));
    // 開き直したので、待っていた戻す予定は取り消されている
    expect(opened).toHaveLength(2);

    terminal.close("explicit");
    expect(opened).toHaveLength(3);
    expect(opened[2]).toMatchObject({ pane: "w1:p1", observe: false, cols: 120, rows: 40 });
  });

  it("デスクトップ表示で開き直すと、待っていたものはすぐ戻す", async () => {
    const { opened, terminal } = setup(200);
    terminal.open(fit());
    terminal.close("disconnect");
    terminal.open(mirror());

    expect(opened).toHaveLength(3);
    expect(opened[1]).toMatchObject({ pane: "w1:p1", observe: false, cols: 120, rows: 40 });
    expect(opened[2]).toMatchObject({ pane: "w1:p1", observe: true, cols: 120, rows: 40 });
  });

  it("中継を止めるときは、待っているものを全部すぐ戻す", () => {
    const { opened, restores, terminal } = setup(10_000);
    terminal.open(fit("w1:p1"));
    terminal.close("disconnect");
    restores.schedule("w1:p2", { cols: 100, rows: 30 });

    restores.shutdown();
    expect(opened).toHaveLength(3);
    expect(opened[1]).toMatchObject({ pane: "w1:p1", cols: 120, rows: 40 });
    expect(opened[2]).toMatchObject({ pane: "w1:p2", cols: 100, rows: 30 });

    // 止めたあとの予定は、待たずにすぐ戻す
    restores.schedule("w1:p1", { cols: 120, rows: 40 });
    expect(opened).toHaveLength(4);
  });
});

describe("ターミナルの中継", () => {
  it("スマホ表示では、キー・大きさ・スクロールをそのまま渡す", () => {
    const { opened, terminal } = setup();
    terminal.open(fit());
    terminal.input("DQ==");
    terminal.resize(50, 20);
    terminal.scroll("up", 5);

    expect(opened[0]!.inputs).toEqual(["DQ=="]);
    expect(opened[0]!.resizes).toEqual([[50, 20]]);
    expect(opened[0]!.scrolls).toEqual([["up", 5]]);
  });

  it("デスクトップ表示のキーは、Herdr の API で順番どおりに送る", async () => {
    const { opened, f, terminal } = setup();
    terminal.open(mirror("w1:p1", 120, 40));
    terminal.input(Buffer.from("ls\r").toString("base64"));

    await waitFor(() => f.herdrCalls.length === 2);
    expect(f.herdrCalls).toEqual([
      { method: "pane.send_text", params: { pane_id: "w1:p1", text: "ls" } },
      { method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["enter"] } },
    ]);
    expect(opened[0]!.inputs).toEqual([]);
    expect(f.announced).toEqual([{ pane: "w1:p1", resized: false }]);
  });

  it("古いターミナルの画面は送らない", () => {
    const { opened, f, terminal } = setup();
    terminal.open(mirror("w1:p1"));
    terminal.open(mirror("w1:p2"));
    expect(opened).toHaveLength(2);
    expect(opened[0]!.closed).toBe(true);

    const frame = { seq: 1, full: true, cols: 120, rows: 40, b64: "aGk=" };
    opened[0]!.handlers.onFrame(frame);
    expect(f.sent).toEqual([]);

    opened[1]!.handlers.onFrame(frame);
    expect(f.sent).toEqual([{ t: "frame", ...frame }]);
  });

  it("Herdr 側でペインが閉じたら知らせる", () => {
    const { opened, f, terminal } = setup();
    terminal.open(mirror("w1:p1"));
    opened[0]!.handlers.onClosed("pane_closed");

    expect(f.sent).toEqual([{ t: "closed", reason: "pane_closed" }]);
    // いまのペインはそのまま（閉じたのは Herdr 側。次に開き直すか切れるまで覚えておく）
    expect(terminal.currentPane()).toBe("w1:p1");
  });

  it("mirror で送れなかったら、iPhone にエラーの文を返す", async () => {
    const { f, terminal } = setup();
    f.ctx.services.deps.herdr = {
      request: async () => {
        throw new Error("Herdr が混んでいます");
      },
    };
    terminal.open(mirror("w1:p1"));
    terminal.input(Buffer.from("a").toString("base64"));

    await waitFor(() => f.sent.some((m) => m.t === "error"));
    expect(f.sent.find((m) => m.t === "error")).toEqual({ t: "error", message: "Herdr が混んでいます" });
  });
});
