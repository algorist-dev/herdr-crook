import { describe, expect, it } from "vitest";
import { chunkFrames, Reassembler, CHUNK_BYTES } from "../src/net/tunnel.ts";

describe("中継サーバーを通すときの分け方（1 MB の上限があるので）", () => {
  it("小さいものは 1 つ。先頭の 1 バイトが印（1=続きあり 2=文字）", () => {
    const [only, ...rest] = chunkFrames(Buffer.from("hi"), true);
    expect(rest).toEqual([]);
    expect([...only!]).toEqual([2, 0x68, 0x69]);
  });

  it("大きいものは分けて、つなぎ直すと元に戻る", () => {
    const big = Buffer.alloc(CHUNK_BYTES * 2 + 10, 7);
    const parts = chunkFrames(big, false);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= CHUNK_BYTES + 1)).toBe(true);
    const r = new Reassembler(10 * 1024 * 1024);
    expect(r.push(parts[0]!)).toBeNull();
    expect(r.push(parts[1]!)).toBeNull();
    const done = r.push(parts[2]!)!;
    expect(done.text).toBe(false);
    expect(done.data.equals(big)).toBe(true);
  });

  it("上限を超えたら捨てる（throw）", () => {
    const r = new Reassembler(10);
    expect(() => r.push(Buffer.concat([Buffer.from([1]), Buffer.alloc(20)]))).toThrow();
  });
});
