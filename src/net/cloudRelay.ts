// 中継サーバー（Cloudflare の Worker、relay-server/）に Mac から出ていってつなぐ。
// 部屋に来た iPhone 1 台ずつを、ふつうの WebSocket と同じように中継（relay.ts）へ渡す。
// 中身は Mac の鍵で暗号化されていないと受け付けない（requireSeal）。中継サーバーには中身が読めない。
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import { chunkFrames, Reassembler } from "./tunnel.ts";
import type { Relay } from "../relay.ts";

export const DEFAULT_RELAY_SERVER = "wss://crook-relay.algorist.jp";
const MAX_MESSAGE = 20 * 1024 * 1024;

export interface CloudRoom {
  room: string;
  secret: string;
}

/** この Mac の部屋の名前と合言葉。なければ作って、本人だけ読めるファイルに置く */
export function loadOrCreateRoom(path: string): CloudRoom {
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<CloudRoom>;
    if (typeof saved.room === "string" && /^[A-Za-z0-9_-]{22}$/.test(saved.room) && typeof saved.secret === "string" && saved.secret.length >= 32) {
      chmodSync(path, 0o600);
      return { room: saved.room, secret: saved.secret };
    }
  }
  const room = { room: randomBytes(16).toString("base64url"), secret: randomBytes(32).toString("base64url") };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(room), { mode: 0o600 });
  return room;
}

/** iPhone が QR で受け取る、部屋への入口 */
export function clientUrl(server: string, room: string): string {
  return `${server.replace(/\/+$/, "")}/c/${room}`;
}

/** 部屋の中の iPhone 1 台。relay.ts からは WebSocket に見える */
class TunnelSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  private readonly reassembler = new Reassembler(MAX_MESSAGE);
  private readonly tunnel: CloudTunnel;
  readonly ch: number;

  constructor(tunnel: CloudTunnel, ch: number) {
    super();
    this.tunnel = tunnel;
    this.ch = ch;
  }

  get bufferedAmount(): number {
    return this.tunnel.bufferedAmount;
  }

  /** 部屋から届いた一切れ */
  receive(frame: Buffer): void {
    let whole: { data: Buffer; text: boolean } | null;
    try {
      whole = this.reassembler.push(frame);
    } catch {
      this.close(4003, "too large");
      return;
    }
    if (whole) this.emit("message", whole.data, !whole.text);
  }

  send(data: string | Buffer, opts?: { binary?: boolean }): void {
    if (this.readyState !== 1) return;
    const text = typeof data === "string" && !opts?.binary;
    for (const part of chunkFrames(typeof data === "string" ? Buffer.from(data) : data, text)) this.tunnel.sendTo(this.ch, part);
  }

  ping(): void {}

  close(_code?: number, _reason?: string): void {
    if (this.readyState !== 1) return;
    this.tunnel.closeClient(this.ch);
    this.gone();
  }

  terminate(): void {
    this.close();
  }

  /** 閉じたことを relay.ts に知らせる */
  gone(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }
}

/** 中継サーバーが「今日の上限を超えた」で閉じるときの番号（relay-server/src/room.ts） */
export const CLOSE_DAILY_LIMIT = 4029;

/** 次の 00:00 UTC（中継サーバーの 1 日の量が戻るとき）までのミリ秒 */
export function untilNextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

export interface CloudTunnelOptions {
  server: string;
  room: CloudRoom;
  relay: Pick<Relay, "attach">;
  log?: (message: string) => void;
  /** つなぎ直すまでの最初の待ち時間（テストでは短く） */
  retryMs?: number;
}

export class CloudTunnel {
  private ws: WebSocket | null = null;
  private readonly clients = new Map<number, TunnelSocket>();
  private retry: number;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly opts: CloudTunnelOptions;
  /** 部屋に入れているか（画面や QR に出すため） */
  connected = false;

  constructor(opts: CloudTunnelOptions) {
    this.opts = opts;
    this.retry = opts.retryMs ?? 1000;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
    this.dropClients();
  }

  sendTo(ch: number, part: Buffer): void {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(ch);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(Buffer.concat([header, part]), { binary: true });
  }

  closeClient(ch: number): void {
    this.clients.delete(ch);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "close", ch }));
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.opts.server.replace(/\/+$/, "")}/h/${this.opts.room.room}`;
    const ws = new WebSocket(url, { headers: { "x-herdr-host-secret": this.opts.room.secret }, maxPayload: 2 * 1024 * 1024 });
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.retry = this.opts.retryMs ?? 1000;
      this.log(`relay server: connected (${this.opts.server})`);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
      this.heartbeat.unref?.();
    });
    ws.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (!isBinary) {
        this.control(bytes.toString("utf8"));
        return;
      }
      if (bytes.length < 5) return;
      this.clients.get(bytes.readUInt32BE(0))?.receive(bytes.subarray(4));
    });
    ws.on("unexpected-response", (_req, res) => {
      this.log(`relay server: refused (${res.statusCode})`);
    });
    ws.on("error", (err) => this.log(`relay server: ${err.message}`));
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      this.dropClients();
      if (this.stopped) return;
      let wait = this.retry;
      this.retry = Math.min(this.retry * 2, 60_000);
      if (code === CLOSE_DAILY_LIMIT) {
        // 今日の分を使い切った。つなぎ直しても断られるだけなので、量が戻るまで待つ（みんな同時に来ないよう少しずらす）
        wait = untilNextUtcDay(Date.now()) + Math.floor(Math.random() * 60_000);
        this.log(`relay server: daily limit reached, waiting ${Math.round(wait / 60_000)} min`);
      }
      setTimeout(() => this.connect(), wait).unref?.();
    });
  }

  private control(text: string): void {
    if (text === "pong") return;
    let msg: { t?: unknown; ch?: unknown; ip?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.ch !== "number") return;
    if (msg.t === "open") {
      const socket = new TunnelSocket(this, msg.ch);
      this.clients.set(msg.ch, socket);
      // 失敗の数え方（何度も間違えたら断る）は、iPhone の本当の IP ごとに
      const ip = typeof msg.ip === "string" && msg.ip ? `relay:${msg.ip}` : `relay:${msg.ch}`;
      this.opts.relay.attach(socket as unknown as WebSocket, ip, { requireSeal: true, checkPeer: false });
    } else if (msg.t === "close") {
      const socket = this.clients.get(msg.ch);
      this.clients.delete(msg.ch);
      socket?.gone();
    }
  }

  private dropClients(): void {
    for (const socket of this.clients.values()) socket.gone();
    this.clients.clear();
  }
}
