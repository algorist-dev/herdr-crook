// 中継サーバー（Cloudflare）を通すときのメッセージの分け方。1 つのメッセージは 1 MB までなので、大きいもの（画像など）は分ける。
// 形：[印 1 バイト][中身]。印の 1 = まだ続きがある、2 = 文字（なければバイナリ）。iPhone 側も同じ（RelayConnection.swift）。

export const CHUNK_BYTES = 512 * 1024;

export function chunkFrames(data: Buffer, text: boolean): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  do {
    const end = Math.min(data.length, offset + CHUNK_BYTES);
    const more = end < data.length;
    out.push(Buffer.concat([Buffer.from([(more ? 1 : 0) | (text ? 2 : 0)]), data.subarray(offset, end)]));
    offset = end;
  } while (offset < data.length);
  return out;
}

export class Reassembler {
  private parts: Buffer[] = [];
  private size = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** 最後の一切れが来たら、つないだものを返す */
  push(frame: Buffer): { data: Buffer; text: boolean } | null {
    if (frame.length < 1) throw new Error("empty frame");
    const flags = frame[0]!;
    this.size += frame.length - 1;
    if (this.size > this.max) throw new Error("message too large");
    this.parts.push(frame.subarray(1));
    if (flags & 1) return null;
    const data = Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    return { data, text: (flags & 2) !== 0 };
  }
}
