// 中継サーバーに「この端末に通知を送って」と頼む（docs/architecture/relay-push.md）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { httpBase, RelayPushClient } from "../src/notify/relayPush.ts";
import { createPushSender } from "../src/notify/pushSender.ts";
import type { PushPayload } from "../src/notify/apns.ts";

const ROOM = { room: "Rm0123456789abcdefghij", secret: "s".repeat(43) };
const payload: PushPayload = { aps: { alert: { title: "t", body: "b" }, "thread-id": "p", category: "hm.reply" }, pane: "p", kind: "finished" };

let server: Server;
let base = "";
let reply: (body: { pushes: { sealed: string }[] }) => { status: number; body: object } = (b) => ({
  status: 200,
  body: { results: b.pushes.map(() => ({ ok: true })) },
});
const requests: { path: string; headers: IncomingHttpHeaders; body: { pushes: { sealed: string; payload: object }[] } }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text);
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const r = reply(body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `ws://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => server.close());

beforeEach(() => {
  requests.length = 0;
  reply = (b) => ({ status: 200, body: { results: b.pushes.map(() => ({ ok: true })) } });
});

describe("httpBase", () => {
  it("wss は https、ws は http にする", () => {
    expect(httpBase("wss://crook-relay.algorist.jp/")).toBe("https://crook-relay.algorist.jp");
    expect(httpBase("ws://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });
});

describe("RelayPushClient", () => {
  it("部屋の合言葉を付けて /p/<部屋> に頼む。同じときに頼まれたものは 1 回にまとめる", async () => {
    const client = new RelayPushClient({ server: base, room: ROOM });
    const [a, b] = await Promise.all([client.send({ sealed: "S1" }, payload), client.send({ sealed: "S2" }, payload)]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe(`/p/${ROOM.room}`);
    expect(requests[0]!.headers["x-herdr-host-secret"]).toBe(ROOM.secret);
    expect(requests[0]!.body.pushes).toEqual([
      { sealed: "S1", payload },
      { sealed: "S2", payload },
    ]);
  });

  it("消えた宛先は invalidToken、開けない封は失敗", async () => {
    reply = () => ({ status: 200, body: { results: [{ ok: false, gone: true }, { ok: false, reason: "bad seal" }] } });
    const client = new RelayPushClient({ server: base, room: ROOM });
    const [a, b] = await Promise.all([client.send({ sealed: "S1" }, payload), client.send({ sealed: "S2" }, payload)]);
    expect(a).toEqual({ ok: false, invalidToken: true, reason: "gone" });
    expect(b).toEqual({ ok: false, reason: "bad seal" });
  });

  it("9 台以上は 8 台ずつに分ける", async () => {
    const client = new RelayPushClient({ server: base, room: ROOM });
    await Promise.all(Array.from({ length: 9 }, (_, i) => client.send({ sealed: `S${i}` }, payload)));
    expect(requests.map((r) => r.body.pushes.length)).toEqual([8, 1]);
  });

  it("1 日の上限なら、次の 00:00 UTC まで頼まない", async () => {
    let now = Date.UTC(2026, 10, 8, 23, 0);
    reply = () => ({ status: 429, body: { error: "daily limit" } });
    const client = new RelayPushClient({ server: base, room: ROOM, now: () => now });
    expect(await client.send({ sealed: "S" }, payload)).toEqual({ ok: false, status: 429, reason: "daily limit" });
    reply = (b) => ({ status: 200, body: { results: b.pushes.map(() => ({ ok: true })) } });
    expect(await client.send({ sealed: "S" }, payload)).toEqual({ ok: false, reason: "paused" });
    expect(requests).toHaveLength(1);
    now = Date.UTC(2026, 10, 9, 0, 0, 1);
    expect(await client.send({ sealed: "S" }, payload)).toEqual({ ok: true });
  });

  it("部屋がまだ無い（403）なら 1 分だけ休む", async () => {
    let now = 1_000_000;
    reply = () => ({ status: 403, body: { error: "wrong secret" } });
    const client = new RelayPushClient({ server: base, room: ROOM, now: () => now });
    expect((await client.send({ sealed: "S" }, payload)).ok).toBe(false);
    expect(await client.send({ sealed: "S" }, payload)).toEqual({ ok: false, reason: "paused" });
    now += 60 * 1000 + 1;
    reply = (b) => ({ status: 200, body: { results: b.pushes.map(() => ({ ok: true })) } });
    expect(await client.send({ sealed: "S" }, payload)).toEqual({ ok: true });
  });

  it("全体の上限でも、次の 00:00 UTC まで頼まない", async () => {
    const now = Date.UTC(2026, 10, 8, 12, 0);
    reply = () => ({ status: 429, body: { error: "global limit" } });
    const client = new RelayPushClient({ server: base, room: ROOM, now: () => now });
    await client.send({ sealed: "S" }, payload);
    expect(await client.send({ sealed: "S" }, payload)).toEqual({ ok: false, reason: "paused" });
  });

  it("中継サーバーに鍵がない（503）なら 10 分休む", async () => {
    let now = 1_000_000;
    reply = () => ({ status: 503, body: { error: "push unavailable" } });
    const client = new RelayPushClient({ server: base, room: ROOM, now: () => now });
    expect((await client.send({ sealed: "S" }, payload)).ok).toBe(false);
    expect(await client.send({ sealed: "S" }, payload)).toEqual({ ok: false, reason: "paused" });
    now += 10 * 60 * 1000 + 1;
    reply = (b) => ({ status: 200, body: { results: b.pushes.map(() => ({ ok: true })) } });
    expect(await client.send({ sealed: "S" }, payload)).toEqual({ ok: true });
  });

  it("つながらなくても投げない", async () => {
    const client = new RelayPushClient({ server: "ws://127.0.0.1:1", room: ROOM });
    expect((await client.send({ sealed: "S" }, payload)).ok).toBe(false);
  });
});

describe("createPushSender（直接か中継サーバーか）", () => {
  const target = { deviceId: "d", token: "aa", env: "production" as const };
  const fake = (name: string, log: string[]) => ({
    send: async (t: { token?: string; sealed?: string }) => {
      log.push(`${name}:${name === "direct" ? t.token : t.sealed}`);
      return { ok: true };
    },
  });

  it("Mac に自分の鍵があれば直接送る", async () => {
    const log: string[] = [];
    const sender = createPushSender({ direct: () => fake("direct", log), relay: fake("relay", log) });
    expect(sender.ready()).toBe(true);
    await sender.send({ ...target, sealed: "S" }, payload);
    expect(log).toEqual(["direct:aa"]);
  });

  it("鍵がなければ、封のある宛先は中継サーバーから", async () => {
    const log: string[] = [];
    const sender = createPushSender({ direct: () => null, relay: fake("relay", log) });
    expect(sender.ready()).toBe(true);
    await sender.send({ ...target, sealed: "S" }, payload);
    expect(log).toEqual(["relay:S"]);
  });

  it("封の無い宛先・中継サーバーを使わない設定では送らない", async () => {
    const log: string[] = [];
    const sender = createPushSender({ direct: () => null, relay: fake("relay", log) });
    expect(await sender.send(target, payload)).toEqual({ ok: false, reason: "no sealed destination" });
    const off = createPushSender({ direct: () => null, relay: null });
    expect(off.ready()).toBe(false);
    expect(await off.send({ ...target, sealed: "S" }, payload)).toEqual({ ok: false, reason: "no push route" });
    expect(log).toEqual([]);
  });
});
