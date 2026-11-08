// テスト用の偽の Herdr サーバー（改行区切り JSON の Unix ソケット）。
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Handler = (req: { id: string; method: string; params: Record<string, unknown> }, socket: Socket) => unknown;

export class FakeHerdr {
  readonly path: string;
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  readonly subscribers: Socket[] = [];
  private server: Server;

  private handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
    this.path = join(mkdtempSync(join(tmpdir(), "hm-sock-")), "herdr.sock");
    this.server = createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const req = JSON.parse(line);
          this.requests.push({ method: req.method, params: req.params });
          if (req.method === "events.subscribe") {
            this.subscribers.push(socket);
            socket.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
            continue;
          }
          const result = this.handler(req, socket);
          if (result instanceof Error) {
            socket.write(JSON.stringify({ id: req.id, error: { code: "not_found", message: result.message } }) + "\n");
          } else if (result !== undefined) {
            socket.write(JSON.stringify({ id: req.id, result }) + "\n");
          }
        }
      });
      socket.on("error", () => {});
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve));
  }

  emit(event: string, data: unknown): void {
    for (const s of this.subscribers) if (!s.destroyed) s.write(JSON.stringify({ event, data }) + "\n");
  }

  dropSubscribers(): void {
    for (const s of this.subscribers.splice(0)) s.destroy();
  }

  close(): Promise<void> {
    this.dropSubscribers();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
