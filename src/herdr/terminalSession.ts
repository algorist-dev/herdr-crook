// 1 つのペインの画面をスマホにつなぐ。
// `herdr terminal session control` を子プロセスで動かし、画面の差分（ANSI のバイト列）を受け取り、
// スマホからのキー入力・大きさの変更・スクロールを渡す。
import type { Readable, Writable } from "node:stream";
import type { EventEmitter } from "node:events";

export interface ChildLike extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => ChildLike;

export interface Frame {
  seq: number;
  full: boolean;
  cols: number;
  rows: number;
  b64: string;
}

export interface TerminalHandlers {
  onFrame(frame: Frame): void;
  onClosed(reason: string): void;
}

export interface TerminalOptions {
  herdrBin: string;
  socketPath: string;
  pane: string;
  cols: number;
  rows: number;
  spawn: SpawnLike;
  /** 見るだけ（ペインの大きさを変えず、入力も受け付けない） */
  observe?: boolean;
}

export interface Terminal {
  input(b64: string): void;
  resize(cols: number, rows: number): void;
  scroll(dir: "up" | "down", lines: number): void;
  close(): void;
}

export function openTerminal(opts: TerminalOptions, handlers: TerminalHandlers): Terminal {
  // control はペインの大きさ（PTY）をこの大きさに変え、閉じても戻らない。observe は大きさに触らない
  const args = opts.observe
    ? ["terminal", "session", "observe", opts.pane, "--cols", String(opts.cols), "--rows", String(opts.rows)]
    : ["terminal", "session", "control", opts.pane, "--takeover", "--cols", String(opts.cols), "--rows", String(opts.rows)];
  const child = opts.spawn(opts.herdrBin, args, {
    env: { ...process.env, HERDR_SOCKET_PATH: opts.socketPath },
  });

  let closed = false;
  let stderr = "";
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClosed(reason);
  };

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-500);
  });
  child.on("exit", () => finish(stderr.trim() || "exited"));
  child.on("error", (err: Error) => finish(err.message));
  child.stdin.on("error", () => {});

  function handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "terminal.frame" && typeof msg.bytes === "string") {
      handlers.onFrame({
        seq: Number(msg.seq) || 0,
        full: msg.full === true,
        cols: Number(msg.width) || opts.cols,
        rows: Number(msg.height) || opts.rows,
        b64: msg.bytes,
      });
    } else if (msg.type === "terminal.closed") {
      finish(typeof msg.reason === "string" ? msg.reason : "closed");
    }
  }

  function send(command: Record<string, unknown>): void {
    if (opts.observe || closed || child.stdin.destroyed) return;
    child.stdin.write(JSON.stringify(command) + "\n");
  }

  return {
    input: (b64) => send({ type: "terminal.input", bytes: b64 }),
    resize: (cols, rows) => send({ type: "terminal.resize", cols, rows }),
    scroll: (direction, lines) => send({ type: "terminal.scroll", direction, lines }),
    close() {
      if (closed) return;
      if (opts.observe) {
        closed = true;
        child.kill("SIGTERM");
        return;
      }
      send({ type: "terminal.release" });
      closed = true;
      child.stdin.end();
      // release で自分から終わるはず。終わらなければ止める
      setTimeout(() => child.kill("SIGTERM"), 1000).unref();
    },
  };
}
