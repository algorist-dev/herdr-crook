// QR に入れるリンク。iPhone のカメラで読んでもアプリが開く（crook://）。
// Herdr の小窓（幅 64）に QR が収まるよう、短く書く（長いと折り返されて読めない）。
import { DEFAULT_RELAY_SERVER } from "../net/cloudRelay.ts";
export interface PairingTarget {
  /** つなぎ先の候補（Tailscale の IP と MagicDNS の名前） */
  hosts: string[];
  port: number;
  code: string;
  machine: string;
  /** Mac の公開鍵（X25519・32 バイト）。アプリはこれで暗号化してつなぐ */
  key?: Buffer;
  /** 中継サーバーの入口（wss://…/c/部屋）。Tailscale も Wi-Fi も使えないときに使う */
  relay?: string;
}

export function buildPairingUrl(target: PairingTarget): string {
  const params = new URLSearchParams();
  params.set("v", "1");
  for (const host of target.hosts) params.append("h", host);
  params.set("p", String(target.port));
  params.set("c", target.code);
  params.set("n", target.machine);
  if (target.key) params.set("k", target.key.toString("base64url"));
  if (target.relay) {
    // いつもの中継サーバーなら部屋の名前だけ（アプリが入口を知っている）
    const prefix = `${DEFAULT_RELAY_SERVER}/c/`;
    params.set("r", target.relay.startsWith(prefix) ? target.relay.slice(prefix.length) : target.relay);
  }
  return `crook://pair?${params.toString()}`;
}
