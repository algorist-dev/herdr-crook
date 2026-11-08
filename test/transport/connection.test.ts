// 受け口・確認・暗号化（transport/connection.ts）を、本物の WebSocket で試す。
// onAuthed は「届いた文字をためる・link を覚えておく」だけの偽物にして、中身の扱いは見ない。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PairingStore } from "../../src/pairing/pairing.ts";
import { clientChannelForTest, keyPairFromSecret } from "../../src/net/e2ee.ts";
import type { ListenOptions } from "../../src/relay.ts";
import type { ServerMessage } from "../../src/protocol/messages.ts";
import { startTransport, type AuthedLink, type Transport, type TransportDeps } from "../../src/transport/connection.ts";

const macKey = keyPairFromSecret(Buffer.alloc(32, 7));

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error("待ちきれませんでした");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let transport: Transport | null = null;
let deps: TransportDeps;
let store: PairingStore;
let allowPeer: boolean;
let links: AuthedLink[];
let received: string[];
let present: Set<string>;
let presentAdded: string[];

const onAuthed = (link: AuthedLink) => {
  links.push(link);
  link.onMessage((raw) => received.push(raw));
};

/** ふつう（暗号化なし）でつなぐ */
async function connect(headers: Record<string, string> = {}): Promise<{ ws: WebSocket; messages: Record<string, unknown>[] }> {
  const t = transport ?? (await start());
  const ws = new WebSocket(`ws://127.0.0.1:${t.ports[0]}/`, { headers });
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, messages };
}

/** Mac の鍵で暗号化してつなぐ */
async function connectSealed(key = macKey.publicKey): Promise<{ ws: WebSocket; messages: Record<string, unknown>[]; sendSealed(m: unknown): void }> {
  const t = transport ?? (await start());
  const ws = new WebSocket(`ws://127.0.0.1:${t.ports[0]}/`);
  const { clientPub, client } = clientChannelForTest(key, Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)));
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      messages.push({ plaintext: JSON.parse(data.toString()) });
      return;
    }
    const text = client.open(Buffer.from(data as Buffer));
    if (text !== null) messages.push(JSON.parse(text));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ t: "seal", pk: clientPub.toString("base64") }));
  return { ws, messages, sendSealed: (m) => ws.send(client.seal(JSON.stringify(m))) };
}

async function start(listen: ListenOptions[] = [{ host: "127.0.0.1", port: 0 }]): Promise<Transport> {
  transport = await startTransport(deps, listen, onAuthed);
  return transport;
}

/** 使える端末を 1 台作って、その鍵を返す */
function newDevice(): { token: string; deviceId: string } {
  const result = store.redeem(store.createPairingCode(), "iPhone");
  if (!result.ok) throw new Error("合言葉を使えませんでした");
  return { token: result.token, deviceId: result.deviceId };
}

beforeEach(() => {
  store = new PairingStore(join(mkdtempSync(join(tmpdir(), "hm-transport-")), "devices.json"));
  allowPeer = true;
  links = [];
  received = [];
  present = new Set();
  presentAdded = [];
  deps = {
    store,
    presence: {
      add: (id) => {
        presentAdded.push(id);
        present.add(id);
      },
      remove: (id) => present.delete(id),
    },
    isAllowedPeer: async () => allowPeer,
    machine: () => "Mac mini",
    checkDevicesMs: 30,
    log: () => {},
  };
});

afterEach(async () => {
  await transport?.close();
  transport = null;
});

describe("つなぐところ（受け口・確認・暗号化）", () => {
  it("正しい合言葉なら paired を送って onAuthed を呼ぶ", async () => {
    const c = await connect();
    c.ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" }));
    await waitFor(() => c.messages.some((m) => m.t === "paired"));
    expect(c.messages.find((m) => m.t === "paired")).toMatchObject({ machine: "Mac mini" });
    await waitFor(() => links.length === 1);
    expect(links[0]!.deviceId).toBe(store.listDevices()[0]!.id);
    expect(links[0]!.once).toBe(false);
    c.ws.close();
  });

  it("違う合言葉なら denied invalid_code で切る", async () => {
    const c = await connect();
    const closed = new Promise<void>((resolve) => c.ws.once("close", () => resolve()));
    c.ws.send(JSON.stringify({ t: "pair", code: "wrong", device: "x" }));
    await closed;
    expect(c.messages).toEqual([{ t: "denied", reason: "invalid_code" }]);
    expect(links).toHaveLength(0);
  });

  it("正しい鍵（hello）なら通り、開いている端末として数える", async () => {
    const device = newDevice();
    const c = await connect();
    c.ws.send(JSON.stringify({ t: "hello", token: device.token }));
    await waitFor(() => links.length === 1);
    expect(links[0]!.deviceId).toBe(device.deviceId);
    expect(links[0]!.once).toBe(false);
    expect(present.has(device.deviceId)).toBe(true);
    expect(presentAdded).toEqual([device.deviceId]);
    c.ws.close();
  });

  it("hello の lang はそのつながりに付く（2 台が続けてつないでも入れ替わらない）", async () => {
    const a = newDevice();
    const b = newDevice();
    const ca = await connect();
    const cb = await connect();
    ca.ws.send(JSON.stringify({ t: "hello", token: a.token, lang: "en" }));
    cb.ws.send(JSON.stringify({ t: "hello", token: b.token }));
    await waitFor(() => links.length === 2);
    expect(links.find((l) => l.deviceId === a.deviceId)!.lang).toBe("en");
    expect(links.find((l) => l.deviceId === b.deviceId)!.lang).toBeUndefined();
    ca.ws.close();
    cb.ws.close();
  });

  it("once の鍵（通知から）は開いている端末に数えない", async () => {
    const device = newDevice();
    const c = await connect();
    c.ws.send(JSON.stringify({ t: "hello", token: device.token, once: true }));
    await waitFor(() => links.length === 1);
    expect(links[0]!.once).toBe(true);
    expect(presentAdded).toEqual([]);
    expect(present.size).toBe(0);
    c.ws.close();
  });

  it("違う鍵なら invalid_token で切る", async () => {
    const c = await connect();
    const closed = new Promise<void>((resolve) => c.ws.once("close", () => resolve()));
    c.ws.send(JSON.stringify({ t: "hello", token: "nope" }));
    await closed;
    expect(c.messages).toEqual([{ t: "denied", reason: "invalid_token" }]);
    expect(links).toHaveLength(0);
  });

  it("Tailscale で別のアカウントの端末なら断る", async () => {
    allowPeer = false;
    const c = await connect();
    const closed = new Promise<void>((resolve) => c.ws.once("close", () => resolve()));
    await closed;
    expect(c.messages).toEqual([{ t: "denied", reason: "not_same_tailnet_user" }]);
    expect(links).toHaveLength(0);
  });

  it("何度も間違えたら、しばらく断る", async () => {
    for (let i = 0; i < 10; i++) {
      const c = await connect();
      c.ws.send(JSON.stringify({ t: "pair", code: "wrong", device: "x" }));
      await new Promise<void>((resolve) => c.ws.once("close", () => resolve()));
    }
    const c = await connect();
    const closed = new Promise<void>((resolve) => c.ws.once("close", () => resolve()));
    c.ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "x" }));
    await closed;
    expect(c.messages).toEqual([{ t: "denied", reason: "too_many_attempts" }]);
    expect(links).toHaveLength(0);
  });

  it("確かめる前の大きなメッセージは断る", async () => {
    const c = await connect();
    c.ws.send(JSON.stringify({ t: "hello", token: "x".repeat(5000) }));
    await waitFor(() => c.messages.some((m) => m.t === "denied"));
    expect(c.messages.find((m) => m.t === "denied")).toEqual({ t: "denied", reason: "invalid_token" });
    expect(links).toHaveLength(0);
  });

  it("暗号化が要る受け口では、平文を断る", async () => {
    deps.keyPair = macKey;
    await start([{ host: "127.0.0.1", port: 0, requireSeal: true, checkPeer: false }]);
    const c = await connect();
    const closed = new Promise<number>((resolve) => c.ws.once("close", (code) => resolve(code)));
    c.ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" }));
    expect(await closed).toBe(4002);
    expect(c.messages.some((m) => m.t === "paired")).toBe(false);
  });

  it("暗号化してから鍵でつなぐと通り、そのあとの send は暗号化されて届く", async () => {
    deps.keyPair = macKey;
    await start([{ host: "127.0.0.1", port: 0, requireSeal: true, checkPeer: false }]);
    const device = newDevice();
    const c = await connectSealed();
    c.sendSealed({ t: "hello", token: device.token });
    await waitFor(() => links.length === 1);
    links[0]!.send({ t: "pong" } satisfies ServerMessage);
    await waitFor(() => c.messages.some((m) => m.t === "pong"));
    expect(c.messages.some((m) => "plaintext" in m)).toBe(false);
    c.ws.close();
  });

  it("暗号化したあとに平文が来たら切る", async () => {
    deps.keyPair = macKey;
    await start([{ host: "127.0.0.1", port: 0, checkPeer: false }]);
    const c = await connectSealed();
    const closed = new Promise<number>((resolve) => c.ws.once("close", (code) => resolve(code)));
    c.ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" }));
    expect(await closed).toBe(4002);
    expect(c.messages.some((m) => m.t === "paired")).toBe(false);
  });

  it("ブラウザのページから（Origin 付きで）はつながらない", async () => {
    const t = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${t.ports[0]}/`, { headers: { Origin: "https://evil.example" } });
    const err = await new Promise((resolve) => ws.once("error", resolve));
    expect(err).toBeTruthy();
  });

  it("つながっている最中に端末を消したら、その接続を切る", async () => {
    const device = newDevice();
    const c = await connect();
    c.ws.send(JSON.stringify({ t: "hello", token: device.token }));
    await waitFor(() => links.length === 1);
    store.revoke(device.deviceId);
    await new Promise<void>((resolve) => c.ws.once("close", () => resolve()));
    expect(c.messages.at(-1)).toEqual({ t: "denied", reason: "invalid_token" });
  });

  it("認証のあとに来た文字は、そのまま順番どおり onMessage に届く", async () => {
    const device = newDevice();
    const c = await connect();
    c.ws.send(JSON.stringify({ t: "hello", token: device.token }));
    await waitFor(() => links.length === 1);
    const raws = [
      JSON.stringify({ t: "ping", n: 1 }),
      JSON.stringify({ t: "commands", pane: "w1:p1" }),
      JSON.stringify({ t: "files", pane: "w1:p1", query: "" }),
    ];
    for (const raw of raws) c.ws.send(raw);
    await waitFor(() => received.length === 3);
    expect(received).toEqual(raws);
  });
});
