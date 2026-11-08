import { describe, expect, it } from "vitest";
import { buildPairingUrl } from "../src/pairing/pairingUrl.ts";
import { DEFAULT_RELAY_SERVER } from "../src/net/cloudRelay.ts";

describe("buildPairingUrl", () => {
  it("アプリで開けるリンクに、つなぎ先と合言葉を入れる", () => {
    const url = new URL(
      buildPairingUrl({ hosts: ["100.101.102.103", "mac-mini.tail1234ab.ts.net"], port: 47821, code: "c0de", machine: "Mac mini" }),
    );
    expect(url.protocol).toBe("crook:");
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.getAll("h")).toEqual(["100.101.102.103", "mac-mini.tail1234ab.ts.net"]);
    expect(url.searchParams.get("p")).toBe("47821");
    expect(url.searchParams.get("c")).toBe("c0de");
    expect(url.searchParams.get("n")).toBe("Mac mini");
  });

  it("Mac の公開鍵を k に入れる（base64url）。なければ入れない", () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => 250 - i));
    const url = new URL(buildPairingUrl({ hosts: ["192.168.1.20"], port: 1, code: "c", machine: "m", key }));
    expect(url.searchParams.get("k")).toBe(key.toString("base64url"));
    expect(new URL(buildPairingUrl({ hosts: ["x"], port: 1, code: "c", machine: "m" })).searchParams.has("k")).toBe(false);
  });

  it("いつもの中継サーバーなら、部屋の名前だけを r に入れる（QR を小さくして、Herdr の小窓に収める）", () => {
    const room = "A".repeat(22);
    const url = new URL(buildPairingUrl({ hosts: ["x"], port: 1, code: "c", machine: "m", relay: `${DEFAULT_RELAY_SERVER}/c/${room}` }));
    expect(url.searchParams.get("r")).toBe(room);
  });

  it("中継サーバーの入口を r に入れる", () => {
    const url = new URL(buildPairingUrl({ hosts: ["x"], port: 1, code: "c", machine: "m", relay: "wss://r.dev/c/AAAA" }));
    expect(url.searchParams.get("r")).toBe("wss://r.dev/c/AAAA");
  });
});
