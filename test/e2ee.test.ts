import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptChannel, clientChannelForTest, keyPairFromSecret, loadOrCreateKeyPair } from "../src/net/e2ee.ts";

describe("e2ee（Mac の鍵で暗号化）", () => {
  it("鍵は一度作ったら同じものを使い、ファイルは本人だけ読める", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hm-key-")), "e2ee.json");
    const a = loadOrCreateKeyPair(path);
    const b = loadOrCreateKeyPair(path);
    expect(a.publicKey.length).toBe(32);
    expect(b.publicKey.equals(a.publicKey)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("スマホと Mac で同じ鍵ができ、行き来の中身が読める", () => {
    const server = keyPairFromSecret(Buffer.alloc(32, 7));
    const { clientPub, client } = clientChannelForTest(server.publicKey, Buffer.alloc(32, 9));
    const mac = acceptChannel(server, clientPub)!;
    expect(mac.open(client.seal('{"t":"hello"}'))).toBe('{"t":"hello"}');
    expect(client.open(mac.seal('{"t":"welcome"}'))).toBe('{"t":"welcome"}');
    expect(mac.open(client.seal("2つめ"))).toBe("2つめ");
  });

  it("同じものをもう一度送られたり、書き換えられたりしたら読めない", () => {
    const server = keyPairFromSecret(Buffer.alloc(32, 7));
    const { clientPub, client } = clientChannelForTest(server.publicKey, Buffer.alloc(32, 9));
    const mac = acceptChannel(server, clientPub)!;
    const frame = client.seal("a");
    expect(mac.open(frame)).toBe("a");
    expect(mac.open(frame)).toBeNull();
    const second = client.seal("b");
    second[0] = second[0]! ^ 1;
    expect(mac.open(second)).toBeNull();
  });

  it("違う Mac の鍵で作ったものは読めない", () => {
    const server = keyPairFromSecret(Buffer.alloc(32, 7));
    const other = keyPairFromSecret(Buffer.alloc(32, 8));
    const { clientPub, client } = clientChannelForTest(other.publicKey, Buffer.alloc(32, 9));
    const mac = acceptChannel(server, clientPub)!;
    expect(mac.open(client.seal("x"))).toBeNull();
  });

  it("おかしな公開鍵は断る", () => {
    const server = keyPairFromSecret(Buffer.alloc(32, 7));
    expect(acceptChannel(server, Buffer.alloc(31))).toBeNull();
    expect(acceptChannel(server, Buffer.alloc(32, 0))).toBeNull();
  });

  it("iPhone（CryptoKit）と同じ答えになる（決まった鍵での見本）", () => {
    const server = keyPairFromSecret(Buffer.alloc(32, 7));
    const { clientPub, client } = clientChannelForTest(server.publicKey, Buffer.alloc(32, 9));
    expect(server.publicKey.toString("base64")).toBe(VECTOR.serverPub);
    expect(clientPub.toString("base64")).toBe(VECTOR.clientPub);
    expect(client.seal("hi").toString("base64")).toBe(VECTOR.firstClientFrame);
    const mac = acceptChannel(server, clientPub)!;
    expect(mac.seal("ok").toString("base64")).toBe(VECTOR.firstServerFrame);
  });
});

// ios/CrookKit/Tests/CrookKitTests/SealedChannelTests.swift と同じ値
const VECTOR = {
  serverPub: "E75P6uryBMf9M1j8nAByGIHRdCeBKCJ+xnTzf3/pe20=",
  clientPub: "V9tLNZ8jrl4Ubk4lEgVnBHIlBjSMFQwUdT0Mkz0E1CE=",
  firstClientFrame: "ZWGMpqn5YRl/N/v88sdwWmwC",
  firstServerFrame: "Pvw8I6JT42EAmFRenCAI5Rr/",
};
