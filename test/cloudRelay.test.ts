// 中継サーバーのふりをする小さな WebSocket サーバーを立て、Mac 側（CloudTunnel → relay）とつなぐ
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { CloudTunnel, clientUrl, loadOrCreateRoom } from "../src/net/cloudRelay.ts";
import { clientChannelForTest, keyPairFromSecret } from "../src/net/e2ee.ts";
import { PairingStore } from "../src/pairing/pairing.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { chunkFrames, Reassembler } from "../src/net/tunnel.ts";
import { waitFor } from "./herdrClient.test.ts";
import { createDefaultProviders } from "../src/providers/defaults.ts";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** 部屋のふり：host とつなぎ、iPhone のメッセージに番号を付けて渡す */
async function fakeRoom() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  let host: WebSocket | null = null;
  let hostSecret = "";
  const phones = new Map<number, WebSocket>();
  wss.on("connection", (ws, req) => {
    if (req.url?.startsWith("/h/")) {
      host = ws;
      hostSecret = String(req.headers["x-herdr-host-secret"] ?? "");
      ws.on("message", (data, isBinary) => {
        const b = data as Buffer;
        if (!isBinary) return;
        phones.get(b.readUInt32BE(0))?.send(b.subarray(4));
      });
      return;
    }
    const ch = phones.size + 1;
    phones.set(ch, ws);
    host?.send(JSON.stringify({ t: "open", ch, ip: "203.0.113.5" }));
    ws.on("message", (data) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(ch);
      host?.send(Buffer.concat([header, data as Buffer]));
    });
    ws.on("close", () => host?.send(JSON.stringify({ t: "close", ch })));
  });
  cleanup.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
  const port = (wss.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}`, secret: () => hostSecret, hostReady: () => host !== null };
}

describe("中継サーバー（CloudTunnel）", () => {
  it("部屋の名前と合言葉は一度作ったら同じ。iPhone の入口は /c/部屋", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hm-room-")), "cloud.json");
    const a = loadOrCreateRoom(path);
    expect(loadOrCreateRoom(path)).toEqual(a);
    expect(a.room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(clientUrl("wss://x.dev/", a.room)).toBe(`wss://x.dev/c/${a.room}`);
  });

  it("部屋を通った iPhone が、暗号化してペアリングでき、大きな返事も分けて届く", async () => {
    const room = await fakeRoom();
    const store = new PairingStore(join(mkdtempSync(join(tmpdir(), "hm-cr-")), "devices.json"));
    const macKey = keyPairFromSecret(Buffer.alloc(32, 7));
    const watcher = Object.assign(new EventEmitter(), {
      current: () => ({ herdr: true, panes: [] }),
      kindOf: () => null,
      poke() {},
      markUnattended() {},
    });
    const relay: Relay = await startRelay(
      {
        store,
        watcher,
        herdr: { request: async () => ({}) },
        openTerminal: () => ({ input() {}, resize() {}, scroll() {}, close() {} }),
        isAllowedPeer: async () => false,
        machine: "Mac",
        keyPair: macKey,
        agents: () => [],
        providers: createDefaultProviders({
          claude: { findTranscript: () => null, defaultEffort: () => null, statusline: () => null },
          codex: { findRollout: () => null, models: () => [], defaultEffort: () => null },
          opencode: {
            store: { read: () => null, title: () => null },
            models: { list: async () => [], recent: () => [] },
            modelInfo: () => null,
          },
          copilot: { find: () => null },
        }),
      },
      [],
    );
    cleanup.push(() => relay.close());
    const tunnel = new CloudTunnel({ server: room.url, room: { room: "r".repeat(22), secret: "s".repeat(43) }, relay, retryMs: 50 });
    tunnel.start();
    cleanup.push(() => tunnel.stop());
    await waitFor(() => room.hostReady());
    expect(room.secret()).toBe("s".repeat(43));

    // iPhone のふり：[印][中身] で送る
    const phone = new WebSocket(`${room.url}/c/x`);
    await new Promise((r) => phone.once("open", r));
    cleanup.push(() => phone.close());
    const { clientPub, client } = clientChannelForTest(macKey.publicKey, Buffer.alloc(32, 9));
    const got: Record<string, unknown>[] = [];
    const reassembler = new Reassembler(20 * 1024 * 1024);
    phone.on("message", (data) => {
      const whole = reassembler.push(data as Buffer);
      if (whole) got.push(JSON.parse(client.open(whole.data)!));
    });
    const sendRaw = (data: Buffer, text: boolean) => chunkFrames(data, text).forEach((p) => phone.send(p));
    sendRaw(Buffer.from(JSON.stringify({ t: "seal", pk: clientPub.toString("base64") })), true);
    sendRaw(client.seal(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" })), false);
    await waitFor(() => got.some((m) => m.t === "paired"));
    expect(got.some((m) => m.t === "welcome")).toBe(true);
  });

  it("暗号化しない iPhone は断る", async () => {
    const room = await fakeRoom();
    const relay: Relay = await startRelay(
      {
        store: new PairingStore(join(mkdtempSync(join(tmpdir(), "hm-cr-")), "devices.json")),
        watcher: Object.assign(new EventEmitter(), { current: () => ({ herdr: true, panes: [] }), kindOf: () => null, poke() {}, markUnattended() {} }),
        herdr: { request: async () => ({}) },
        openTerminal: () => ({ input() {}, resize() {}, scroll() {}, close() {} }),
        isAllowedPeer: async () => true,
        machine: "Mac",
        keyPair: keyPairFromSecret(Buffer.alloc(32, 7)),
        agents: () => [],
        providers: createDefaultProviders({
          claude: { findTranscript: () => null, defaultEffort: () => null, statusline: () => null },
          codex: { findRollout: () => null, models: () => [], defaultEffort: () => null },
          opencode: {
            store: { read: () => null, title: () => null },
            models: { list: async () => [], recent: () => [] },
            modelInfo: () => null,
          },
          copilot: { find: () => null },
        }),
      },
      [],
    );
    cleanup.push(() => relay.close());
    const tunnel = new CloudTunnel({ server: room.url, room: { room: "r".repeat(22), secret: "s".repeat(43) }, relay, retryMs: 50 });
    tunnel.start();
    cleanup.push(() => tunnel.stop());
    await waitFor(() => room.hostReady());
    const phone = new WebSocket(`${room.url}/c/x`);
    await new Promise((r) => phone.once("open", r));
    const closed = new Promise<void>((r) => phone.once("close", () => r()));
    chunkFrames(Buffer.from(JSON.stringify({ t: "hello", token: "x" })), true).forEach((p) => phone.send(p));
    // 中継がその iPhone を閉じたら、部屋のふりは Mac からの close を知らないので、ここでは閉じない。代わりに返事が来ないことを見る
    const replies: unknown[] = [];
    phone.on("message", (d) => replies.push(d));
    await new Promise((r) => setTimeout(r, 200));
    expect(replies).toEqual([]);
    phone.close();
    await closed;
  });
});

describe("中継サーバーの今日の上限（4029）", () => {
  it("次の 00:00 UTC までの時間を返す", async () => {
    const { untilNextUtcDay } = await import("../src/net/cloudRelay.ts");
    expect(untilNextUtcDay(Date.UTC(2026, 10, 7, 23, 59, 0))).toBe(60_000);
    expect(untilNextUtcDay(Date.UTC(2026, 10, 7, 0, 0, 0))).toBe(24 * 3600_000);
  });

  it("4029 で閉じられたら、次の 00:00 UTC まではつなぎ直さない", async () => {
    const server = new WebSocketServer({ port: 0 });
    let connects = 0;
    server.on("connection", (ws) => {
      connects++;
      ws.close(4029, "daily limit");
    });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    const logs: string[] = [];
    const tunnel = new CloudTunnel({
      server: `ws://127.0.0.1:${port}`,
      room: { room: "A".repeat(22), secret: "s".repeat(43) },
      relay: {} as never,
      retryMs: 10,
      log: (m) => logs.push(m),
    });
    tunnel.start();
    await waitFor(() => connects >= 1);
    await new Promise((r) => setTimeout(r, 200));
    tunnel.stop();
    server.close();
    expect(connects).toBe(1);
    expect(logs.some((l) => l.includes("daily limit"))).toBe(true);
  });
});

describe("中継サーバーの相手が思いどおりに返事をしないとき", () => {
  const room = { room: "r".repeat(22), secret: "s".repeat(40) };
  const relay = { attach() {} };

  it("101 以外を返されても、つなぎ直しを続ける", async () => {
    let hits = 0;
    const http = createServer((_req, res) => {
      hits++;
      res.writeHead(503).end("busy");
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => http.close(() => r())));
    const port = (http.address() as { port: number }).port;
    const tunnel = new CloudTunnel({ server: `ws://127.0.0.1:${port}`, room, relay, retryMs: 10 });
    cleanup.push(() => tunnel.stop());
    tunnel.start();
    await waitFor(() => hits >= 3);
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it("つなぐときに返事がないサーバーは、時間切れにしてやり直す", async () => {
    const sockets: Socket[] = [];
    const silent = createNetServer((s) => sockets.push(s));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      silent.close(() => r());
    }));
    const port = (silent.address() as { port: number }).port;
    const tunnel = new CloudTunnel({ server: `ws://127.0.0.1:${port}`, room, relay, retryMs: 10, handshakeTimeoutMs: 30 });
    cleanup.push(() => tunnel.stop());
    tunnel.start();
    await waitFor(() => sockets.length >= 2);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it("pong が返らなくなったら切って、つなぎ直す", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.once("listening", r));
    cleanup.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
    let connections = 0;
    wss.on("connection", () => connections++);
    const port = (wss.address() as { port: number }).port;
    const tunnel = new CloudTunnel({ server: `ws://127.0.0.1:${port}`, room, relay, retryMs: 10, heartbeatMs: 20, deadAfterMs: 50 });
    cleanup.push(() => tunnel.stop());
    tunnel.start();
    await waitFor(() => connections >= 2);
    expect(connections).toBeGreaterThanOrEqual(2);
  });

  it("pong が返っているあいだは切らない", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.once("listening", r));
    cleanup.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.on("message", (d) => ws.send(d.toString() === "ping" ? "pong" : ""));
    });
    const port = (wss.address() as { port: number }).port;
    const tunnel = new CloudTunnel({ server: `ws://127.0.0.1:${port}`, room, relay, retryMs: 10, heartbeatMs: 10, deadAfterMs: 60 });
    cleanup.push(() => tunnel.stop());
    tunnel.start();
    await waitFor(() => tunnel.connected);
    await new Promise((r) => setTimeout(r, 200));
    expect(connections).toBe(1);
    expect(tunnel.connected).toBe(true);
  });

  it("止めたあとはつなぎ直さない", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.once("listening", r));
    cleanup.push(() => new Promise<void>((r) => wss.close(() => r())));
    let connections = 0;
    wss.on("connection", () => connections++);
    const port = (wss.address() as { port: number }).port;
    const tunnel = new CloudTunnel({ server: `ws://127.0.0.1:${port}`, room, relay, retryMs: 5 });
    tunnel.start();
    await waitFor(() => tunnel.connected);
    tunnel.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(connections).toBe(1);
  });
});
