import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { openTerminal, type SpawnLike } from "../src/herdr/terminalSession.ts";

function fakeSpawn() {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill() {
      this.killed = true;
      child.emit("exit", null, "SIGTERM");
      return true;
    },
  });
  const written: string[] = [];
  stdin.on("data", (c: Buffer) => written.push(...c.toString("utf8").split("\n").filter(Boolean)));
  const spawn: SpawnLike = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    return child;
  };
  return { spawn, calls, child, written };
}

describe("openTerminal", () => {
  it("herdr terminal session control を、スマホの大きさで、制御を引き取って開く", () => {
    const f = fakeSpawn();
    openTerminal({ herdrBin: "/opt/homebrew/bin/herdr", socketPath: "/s.sock", pane: "w1:p2", cols: 44, rows: 30, spawn: f.spawn }, {
      onFrame: () => {},
      onClosed: () => {},
    });
    expect(f.calls[0]?.cmd).toBe("/opt/homebrew/bin/herdr");
    expect(f.calls[0]?.args).toEqual(["terminal", "session", "control", "w1:p2", "--takeover", "--cols", "44", "--rows", "30"]);
    expect(f.calls[0]?.env?.HERDR_SOCKET_PATH).toBe("/s.sock");
  });

  it("見るだけ（observe）なら、制御を取らず大きさも変えない", () => {
    const f = fakeSpawn();
    const t = openTerminal({ herdrBin: "herdr", socketPath: "/s", pane: "w1:p2", cols: 120, rows: 40, spawn: f.spawn, observe: true }, {
      onFrame: () => {},
      onClosed: () => {},
    });
    expect(f.calls[0]?.args).toEqual(["terminal", "session", "observe", "w1:p2", "--cols", "120", "--rows", "40"]);
    t.input("YQ==");
    t.resize(10, 10);
    expect(f.written).toEqual([]);
  });

  it("画面の差分を受け取って渡す（行が途中で切れても）", async () => {
    const f = fakeSpawn();
    const frames: unknown[] = [];
    openTerminal({ herdrBin: "herdr", socketPath: "/s", pane: "w1:p1", cols: 40, rows: 20, spawn: f.spawn }, {
      onFrame: (fr) => frames.push(fr),
      onClosed: () => {},
    });
    const line = JSON.stringify({ type: "terminal.frame", seq: 1, encoding: "ansi", width: 40, height: 20, full: true, bytes: "aGk=" });
    f.child.stdout.write(line.slice(0, 10));
    f.child.stdout.write(line.slice(10) + "\n");
    await new Promise((r) => setImmediate(r));
    expect(frames).toEqual([{ seq: 1, full: true, cols: 40, rows: 20, b64: "aGk=" }]);
  });

  it("入力・大きさ・スクロールを Herdr の形にして送る", async () => {
    const f = fakeSpawn();
    const t = openTerminal({ herdrBin: "herdr", socketPath: "/s", pane: "w1:p1", cols: 40, rows: 20, spawn: f.spawn }, {
      onFrame: () => {},
      onClosed: () => {},
    });
    t.input("G1tB");
    t.resize(50, 25);
    t.scroll("up", 3);
    await new Promise((r) => setImmediate(r));
    expect(f.written.map((l) => JSON.parse(l))).toEqual([
      { type: "terminal.input", bytes: "G1tB" },
      { type: "terminal.resize", cols: 50, rows: 25 },
      { type: "terminal.scroll", direction: "up", lines: 3 },
    ]);
  });

  it("Herdr 側で閉じたら理由を知らせる。1回だけ", async () => {
    const f = fakeSpawn();
    const reasons: string[] = [];
    openTerminal({ herdrBin: "herdr", socketPath: "/s", pane: "w1:p1", cols: 40, rows: 20, spawn: f.spawn }, {
      onFrame: () => {},
      onClosed: (r) => reasons.push(r),
    });
    f.child.stdout.write(JSON.stringify({ type: "terminal.closed", reason: "pane_closed" }) + "\n");
    await new Promise((r) => setImmediate(r));
    f.child.emit("exit", 0, null);
    expect(reasons).toEqual(["pane_closed"]);
  });

  it("閉じるときは制御を返してから終わらせる", async () => {
    const f = fakeSpawn();
    const t = openTerminal({ herdrBin: "herdr", socketPath: "/s", pane: "w1:p1", cols: 40, rows: 20, spawn: f.spawn }, {
      onFrame: () => {},
      onClosed: () => {},
    });
    t.close();
    await new Promise((r) => setImmediate(r));
    expect(f.written.map((l) => JSON.parse(l))).toEqual([{ type: "terminal.release" }]);
  });
});
