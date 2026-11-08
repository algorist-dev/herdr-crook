// Herdr のソケット API（改行区切り JSON）とやりとりする。
// 1 リクエストごとに接続する（Herdr の CLI と同じやり方で、つなぎっぱなしの状態を持たない）。
import { connect, type Socket } from "node:net";
import { join } from "node:path";

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HerdrEvent {
  event: string;
  data: unknown;
}

export function resolveSocketPath(env: Record<string, string | undefined>, home: string): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const session = env.HERDR_SESSION;
  if (session && /^[A-Za-z0-9._-]+$/.test(session) && !session.startsWith(".")) {
    return join(home, ".config", "herdr", "sessions", session, "herdr.sock");
  }
  return join(home, ".config", "herdr", "herdr.sock");
}

export class HerdrClient {
  private seq = 0;
  readonly socketPath: string;
  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
    const id = `hm_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`herdr ${method} timeout`));
      }, timeoutMs);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      readLines(socket, (line) => {
        const msg = parse(line);
        if (!msg || msg.id !== id) return;
        if (msg.error) {
          const err = msg.error as { code?: string; message?: string };
          done(() => reject(new HerdrError(err.code ?? "error", err.message ?? "herdr error")));
        } else {
          done(() => resolve(msg.result));
        }
      });
      socket.on("error", (err) => done(() => reject(err)));
      socket.on("close", () => done(() => reject(new Error(`herdr ${method}: connection closed`))));
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /** イベントを購読する。接続が切れたら onClose を呼ぶ（呼び出し側でつなぎ直す）。 */
  subscribe(
    subscriptions: Record<string, unknown>[],
    onEvent: (event: HerdrEvent) => void,
    onClose: (reason: string) => void,
  ): Promise<{ close(): void }> {
    const id = `hm_sub_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(this.socketPath);
      let started = false;
      let closedByUs = false;
      const handle = {
        close() {
          closedByUs = true;
          socket.destroy();
        },
      };
      readLines(socket, (line) => {
        const msg = parse(line);
        if (!msg) return;
        if (!started && msg.id === id) {
          if (msg.error) {
            const err = msg.error as { code?: string; message?: string };
            socket.destroy();
            reject(new HerdrError(err.code ?? "error", err.message ?? "subscribe failed"));
            return;
          }
          started = true;
          resolve(handle);
          return;
        }
        if (msg.id === id && msg.error) {
          // events_lost など。購読は切れるので onClose で知らせる
          socket.destroy();
          return;
        }
        if (typeof msg.event === "string") onEvent({ event: msg.event, data: msg.data });
      });
      socket.on("error", (err) => {
        if (!started) reject(err);
      });
      socket.on("close", () => {
        if (started && !closedByUs) onClose("disconnected");
      });
      socket.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
    });
  }
}

function readLines(socket: Socket, onLine: (line: string) => void): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
