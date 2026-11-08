// つなぐところ（中身は知らない）。WebSocket の受け口・Origin を断る・心拍・Tailscale で同じアカウントか・
// 暗号化（seal）・合言葉（pair）と鍵（hello）・失敗が多い相手を断る・消された端末を切る・遅い相手を切る。
// ここを通ったあとのメッセージの扱い（welcome・panes・中身）は onAuthed の側（session）がする。
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { acceptChannel, type Channel } from "../net/e2ee.ts";
import { MAX_MESSAGE_BYTES, type ServerMessage } from "../protocol/messages.ts";
import { parseClientMessage } from "../protocol/parse.ts";
import type { ListenOptions, RelayDeps } from "../relay.ts";

export type TransportDeps = Pick<RelayDeps, "store" | "presence" | "isAllowedPeer" | "keyPair" | "log" | "checkDevicesMs"> & {
  /** paired で返す Mac の名前（あとから変わるので関数） */
  machine(): string;
};

/** 確かめが終わった 1 本のつながり */
export interface AuthedLink {
  deviceId: string;
  /** 通知のボタンからの短いつながり（開いている端末に数えない） */
  once: boolean;
  /** hello で言われたアプリの言語（BCP 47、形は parse で確かめ済み）。合言葉でつないだときは無い */
  lang?: string;
  /** 暗号化していれば暗号化して送る。遅い相手は切る */
  send(msg: ServerMessage): void;
  /** 確かめたあとに来た文字（形はまだ確かめていない）。onAuthed の中で同期で登録すること */
  onMessage(fn: (raw: string) => void): void;
  onClose(fn: () => void): void;
}

export interface Transport {
  ports: number[];
  attach(ws: WebSocket, ip: string, opts: { requireSeal: boolean; checkPeer: boolean }): void;
  close(): Promise<void>;
}

const AUTH_TIMEOUT_MS = 10_000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_BUFFERED = 8 * 1024 * 1024;
const MAX_QUEUED = 5;
/** 確かめる前は、小さなメッセージしか受けない（大きな画像などはつながってから） */
const MAX_PREAUTH_TEXT = 4096;
const MAX_PREAUTH_SEALED = 8192;

export async function startTransport(
  deps: TransportDeps,
  listen: ListenOptions[],
  onAuthed: (link: AuthedLink) => void,
): Promise<Transport> {
  const log = deps.log ?? (() => {});
  const failures = new Map<string, number[]>();
  const servers: WebSocketServer[] = [];

  const tooMany = (ip: string) => {
    const now = Date.now();
    const recent = (failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
    if (recent.length === 0) failures.delete(ip);
    else failures.set(ip, recent);
    return recent.length >= MAX_FAILURES;
  };
  const fail = (ip: string) => failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);

  for (const { host, port, requireSeal = false, checkPeer = true } of listen) {
    const wss = new WebSocketServer({
      host,
      port,
      maxPayload: MAX_MESSAGE_BYTES + 1024,
      perMessageDeflate: false,
      // ブラウザのページからは来ないはず（アプリは Origin を付けない）。付いていたら断る
      verifyClient: (info: { req: IncomingMessage }) => info.req.headers.origin === undefined,
    });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    wss.on("error", (err) => log(`websocket error: ${err.message}`));
    wss.on("connection", (ws, req: IncomingMessage) => handleConnection(ws, req.socket.remoteAddress ?? "", { requireSeal, checkPeer }));
    servers.push(wss);
  }

  // 返事のない接続を見つけて切る
  const heartbeat = setInterval(() => {
    for (const wss of servers) {
      for (const ws of wss.clients) {
        const alive = ws as WebSocket & { isAlive?: boolean };
        if (alive.isAlive === false) {
          ws.terminate();
          continue;
        }
        alive.isAlive = false;
        ws.ping();
      }
    }
  }, 20_000);
  heartbeat.unref();

  // 消された端末の接続を切る
  const sessions = new Map<WebSocket, string>();
  const deviceCheck = setInterval(() => {
    for (const [ws, deviceId] of sessions) {
      if (!deps.store.isActive(deviceId)) {
        log(`device ${deviceId} was removed; closing`);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "denied", reason: "invalid_token" }));
        ws.close(4001, "revoked");
        sessions.delete(ws);
      }
    }
  }, deps.checkDevicesMs ?? 5000);
  deviceCheck.unref();

  function handleConnection(ws: WebSocket, ip: string, opts: { requireSeal: boolean; checkPeer: boolean }): void {
    const alive = ws as WebSocket & { isAlive?: boolean };
    alive.isAlive = true;
    ws.on("pong", () => (alive.isAlive = true));

    /** 暗号化しているときの鍵（{"t":"seal"} のあと） */
    let channel: Channel | null = null;

    const sendRaw = (text: string) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) {
        log(`slow client ${ip}, closing`);
        ws.terminate();
        return;
      }
      if (channel) ws.send(channel.seal(text), { binary: true });
      else ws.send(text);
    };
    const send = (msg: ServerMessage) => sendRaw(JSON.stringify(msg));
    const deny = (reason: Extract<ServerMessage, { t: "denied" }>["reason"]) => {
      send({ t: "denied", reason });
      ws.close(4001, reason);
    };

    let authed = false;
    /** つながっている端末として数えた ID（切れたら数から外す） */
    let presentAs: string | null = null;
    let onMessageFn: ((raw: string) => void) | null = null;
    let onCloseFn: (() => void) | null = null;
    let closed = false;

    const authTimer = setTimeout(() => {
      if (!authed) ws.close(4000, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    // 確かめ終わるまでに来たメッセージはためておく
    const queue: string[] = [];
    let peerChecked = false;

    /** 確かめたあとに来た文字を onAuthed に渡す。まだなら断る */
    const receive = (raw: string) => {
      if (closed) return;
      if (!authed) {
        if (raw.length > MAX_PREAUTH_TEXT) {
          fail(ip);
          deny("invalid_token");
          return;
        }
        authenticate(raw);
        return;
      }
      onMessageFn?.(raw);
    };

    ws.on("message", (data, isBinary) => {
      if (closed) return;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      let raw: string;
      if (isBinary) {
        // 確かめる前は小さなものしか受けない
        if (!channel || (!authed && bytes.length > MAX_PREAUTH_SEALED)) {
          ws.close(4002, "not sealed");
          return;
        }
        const opened = channel.open(bytes);
        if (opened === null) {
          log(`unreadable sealed message from ${ip}; closing`);
          ws.terminate();
          return;
        }
        raw = opened;
      } else {
        raw = bytes.toString("utf8");
        if (channel) {
          ws.close(4002, "plaintext after seal");
          return;
        }
        const pk = sealKeyOf(raw);
        if (pk !== null) {
          channel = deps.keyPair ? acceptChannel(deps.keyPair, pk) : null;
          if (!channel) ws.close(4002, "cannot seal");
          else log(`sealed connection from ${ip}`);
          return;
        }
        if (opts.requireSeal) {
          ws.close(4002, "seal required");
          return;
        }
      }
      if (peerChecked) receive(raw);
      else if (queue.length < MAX_QUEUED) queue.push(raw);
    });

    void (opts.checkPeer ? deps.isAllowedPeer(ip) : Promise.resolve(true)).then((ok) => {
      // 確かめている間に切れていたら何もしない（合言葉を無駄に使わない）
      if (closed) return;
      if (!ok) {
        log(`denied peer ${ip}`);
        deny("not_same_tailnet_user");
        return;
      }
      peerChecked = true;
      for (const raw of queue.splice(0)) receive(raw);
    });

    ws.on("close", () => {
      closed = true;
      sessions.delete(ws);
      if (presentAs) deps.presence?.remove(presentAs);
      presentAs = null;
      clearTimeout(authTimer);
      onCloseFn?.();
    });

    function authenticate(raw: string): void {
      if (tooMany(ip)) {
        deny("too_many_attempts");
        return;
      }
      const msg = parseClientMessage(raw);
      if (msg?.t === "pair") {
        const result = deps.store.redeem(msg.code, msg.device);
        if (!result.ok) {
          fail(ip);
          deny("invalid_code");
          return;
        }
        log(`paired new device "${msg.device}" from ${ip}`);
        send({ t: "paired", token: result.token, machine: deps.machine() });
        welcome(result.deviceId);
        return;
      }
      const device = msg?.t === "hello" ? deps.store.verify(msg.token) : null;
      if (device) {
        deps.store.markSeen(device.id);
        welcome(device.id, msg?.t === "hello" && msg.once === true, msg?.t === "hello" ? msg.lang : undefined);
        return;
      }
      fail(ip);
      deny("invalid_token");
    }

    /** once：通知のボタンから、送るだけの短いつながり（開いている端末には数えない） */
    function welcome(deviceId: string, once = false, lang?: string): void {
      if (closed) return;
      authed = true;
      sessions.set(ws, deviceId);
      if (!once) {
        deps.presence?.add(deviceId);
        presentAs = deviceId;
      }
      clearTimeout(authTimer);
      onAuthed({
        deviceId,
        once,
        ...(lang ? { lang } : {}),
        send,
        onMessage(fn) {
          onMessageFn = fn;
        },
        onClose(fn) {
          onCloseFn = fn;
        },
      });
    }
  }

  return {
    attach: handleConnection,
    ports: servers.map((s) => {
      const addr = s.address();
      return typeof addr === "object" && addr ? addr.port : 0;
    }),
    async close() {
      clearInterval(heartbeat);
      clearInterval(deviceCheck);
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              for (const c of s.clients) c.terminate();
              s.close(() => resolve());
            }),
        ),
      );
    },
  };
}

/** {"t":"seal","pk":<base64 32 バイト>} なら公開鍵を返す */
function sealKeyOf(raw: string): Buffer | null {
  if (raw.length > 200 || !raw.includes('"seal"')) return null;
  try {
    const v = JSON.parse(raw) as { t?: unknown; pk?: unknown };
    if (v.t !== "seal" || typeof v.pk !== "string") return null;
    const pk = Buffer.from(v.pk, "base64");
    return pk.length === 32 ? pk : Buffer.alloc(0);
  } catch {
    return null;
  }
}
