// スマホと Mac のあいだのやりとりを暗号化する（Orca と同じ考え方：QR に Mac の公開鍵を入れる）。
// 同じ Wi-Fi や中継サーバーを通るときも、中身は Mac とスマホにしか読めない。
//
// 1. スマホはつなぐたびに使い捨ての鍵を作り、公開鍵を {"t":"seal","pk":…} で送る
// 2. 両方で X25519 → HKDF-SHA256（salt = スマホの公開鍵 + Mac の公開鍵）で、行きと帰りの 2 つの鍵を作る
// 3. あとはバイナリのメッセージで ChaCha20-Poly1305。nonce は向きごとの通し番号（送り直し・入れ替えは読めない）
// QR で受け取った Mac の公開鍵で計算するので、Mac の秘密鍵を持たない相手は返事を作れない。
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const INFO = Buffer.from("crook e2ee v1");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const TAG = 16;
/** 1 つのメッセージの上限（中身の大きさの上限は protocol.ts） */
export const MAX_SEALED_BYTES = 20 * 1024 * 1024;

export interface KeyPair {
  publicKey: Buffer;
  privateKey: KeyObject;
}

export function keyPairFromSecret(secret: Buffer): KeyPair {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, secret]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: Buffer.from(publicKey), privateKey };
}

/** Mac の鍵。なければ作って、本人だけ読めるファイルに置く */
export function loadOrCreateKeyPair(path: string): KeyPair {
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { v?: number; secret?: string };
    const secret = Buffer.from(saved.secret ?? "", "base64");
    if (saved.v === 1 && secret.length === 32) {
      chmodSync(path, 0o600);
      return keyPairFromSecret(secret);
    }
  }
  const { privateKey } = generateKeyPairSync("x25519");
  const secret = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ v: 1, secret: Buffer.from(secret).toString("base64") }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return keyPairFromSecret(Buffer.from(secret));
}

export interface Channel {
  seal(text: string): Buffer;
  /** 読めなければ null（そのときは接続を切る） */
  open(frame: Buffer): string | null;
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function deriveKeys(shared: Buffer, clientPub: Buffer, serverPub: Buffer): { c2s: Buffer; s2c: Buffer } {
  const okm = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([clientPub, serverPub]), INFO, 64));
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) };
}

function nonce(counter: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(counter, 4);
  return n;
}

function channel(sendKey: Buffer, recvKey: Buffer): Channel {
  let sent = 0n;
  let received = 0n;
  return {
    seal(text) {
      const cipher = createCipheriv("chacha20-poly1305", sendKey, nonce(sent++), { authTagLength: TAG });
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([body, cipher.getAuthTag()]);
    },
    open(frame) {
      if (frame.length < TAG || frame.length > MAX_SEALED_BYTES) return null;
      try {
        const decipher = createDecipheriv("chacha20-poly1305", recvKey, nonce(received), { authTagLength: TAG });
        decipher.setAuthTag(frame.subarray(frame.length - TAG));
        const text = Buffer.concat([decipher.update(frame.subarray(0, frame.length - TAG)), decipher.final()]).toString("utf8");
        received++;
        return text;
      } catch {
        return null;
      }
    },
  };
}

/** Mac 側：スマホの使い捨ての公開鍵を受けて、やりとりの鍵を作る。おかしな鍵なら null */
export function acceptChannel(server: KeyPair, clientPub: Buffer): Channel | null {
  if (clientPub.length !== 32) return null;
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: server.privateKey, publicKey: publicKeyObject(clientPub) });
  } catch {
    return null;
  }
  if (shared.every((b) => b === 0)) return null;
  const { c2s, s2c } = deriveKeys(shared, clientPub, server.publicKey);
  return channel(s2c, c2s);
}

/** スマホ側の計算（テストと確かめ用。アプリは CryptoKit で同じことをする） */
export function clientChannelForTest(serverPub: Buffer, clientSecret: Buffer): { clientPub: Buffer; client: Channel } {
  const me = keyPairFromSecret(clientSecret);
  const shared = diffieHellman({ privateKey: me.privateKey, publicKey: publicKeyObject(serverPub) });
  const { c2s, s2c } = deriveKeys(shared, me.publicKey, serverPub);
  return { clientPub: me.publicKey, client: channel(c2s, s2c) };
}
