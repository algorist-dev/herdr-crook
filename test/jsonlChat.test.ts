import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as transcript from "../src/providers/shared/transcript.ts";
import { ChatCache, jsonlChatStream } from "../src/providers/shared/jsonlChat.ts";

const user = (id: string, text: string) => JSON.stringify({ type: "user", uuid: id, message: { role: "user", content: text } }) + "\n";
const tokens = (id: string, n: number) =>
  JSON.stringify({
    type: "assistant",
    uuid: id,
    message: { model: "claude-x", content: [{ type: "text", text: id }], usage: { input_tokens: n, output_tokens: 1 } },
  }) + "\n";

function file(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "crook-jsonl-")), "t.jsonl");
  writeFileSync(path, content);
  return path;
}

describe("jsonlChatStream と ChatCache", () => {
  it("開き直しても最初から読まない（増えた分だけ）", () => {
    const path = file(user("u1", "a") + user("u2", "b"));
    const cache = new ChatCache();
    const open = () => jsonlChatStream({ key: () => "k", resolve: () => path, cache });
    const reads: number[] = [];
    const real = transcript.TranscriptReader.prototype.read;
    transcript.TranscriptReader.prototype.read = function (this: transcript.TranscriptReader) {
      const before = (this as unknown as { offset: number }).offset;
      reads.push(before);
      return real.call(this);
    };
    try {
      const a = open().poll();
      expect(a.chat?.items.map((i) => i.id)).toEqual(["u1", "u2"]);
      appendFileSync(path, user("u3", "c"));
      const b = open().poll();
      expect(b.chat?.reset).toBe(true);
      expect(b.chat?.items.map((i) => i.id)).toEqual(["u1", "u2", "u3"]);
    } finally {
      transcript.TranscriptReader.prototype.read = real;
    }
    // 2 回目は前回の続きから読んだ（0 から読み直していない）
    expect(reads[0]).toBe(0);
    expect(reads[1]).toBeGreaterThan(0);
  });

  it("使用量の累計は開き直しても正しい", () => {
    const path = file(tokens("a1", 100) + tokens("a2", 50));
    const cache = new ChatCache();
    const first = jsonlChatStream({ key: () => "k", resolve: () => path, cache }).poll();
    appendFileSync(path, tokens("a3", 25));
    const again = jsonlChatStream({ key: () => "k", resolve: () => path, cache }).poll();
    const total = (u: typeof first.usage) => u?.tokens?.input ?? null;
    expect(total(again.usage)).toBe((total(first.usage) ?? 0) + 25);
  });

  it("同じ会話を 2 つの画面で見ても、どちらにも新しい発言が届く", () => {
    const path = file(user("u1", "a"));
    const cache = new ChatCache();
    const a = jsonlChatStream({ key: () => "k", resolve: () => path, cache });
    const b = jsonlChatStream({ key: () => "k", resolve: () => path, cache });
    a.poll();
    b.poll();
    appendFileSync(path, user("u2", "b"));
    expect(a.poll().chat?.items.map((i) => i.id)).toEqual(["u2"]);
    expect(b.poll().chat?.items.map((i) => i.id)).toEqual(["u2"]);
    expect(a.poll().chat).toBeNull();
  });

  it("最初は最後のほうだけを送る", () => {
    const path = file(Array.from({ length: 10 }, (_, i) => user(`u${i}`, "x")).join(""));
    const poll = jsonlChatStream({ key: () => "k", resolve: () => path, cache: new ChatCache(), initialLimit: 3 }).poll();
    expect(poll.chat?.items.map((i) => i.id)).toEqual(["u7", "u8", "u9"]);
  });

  it("覚える会話の数には上限がある（古いものから忘れる）", () => {
    const cache = new ChatCache(2);
    const paths: [string, string, string] = [file(user("a", "1")), file(user("b", "1")), file(user("c", "1"))];
    const entries = paths.map((p) => cache.get(p, undefined, 10));
    expect(cache.get(paths[2], undefined, 10)).toBe(entries[2]);
    expect(cache.get(paths[0], undefined, 10)).not.toBe(entries[0]);
  });

  it("とても長い記録でも最初の読み取りで落ちない（最後のほうだけ残す）", () => {
    const n = 200_000;
    const path = file(Array.from({ length: n }, (_, i) => user(`u${i}`, "x")).join(""));
    const poll = jsonlChatStream({ key: () => "k", resolve: () => path, cache: new ChatCache() }).poll();
    expect(poll.chat?.items.length).toBe(150);
    expect(poll.chat?.items.at(-1)?.id).toBe(`u${n - 1}`);
  });

  it("記録が書き直されて小さくなったら、古い発言を捨てて送り直す", () => {
    const path = file(user("u1", "a") + user("u2", "b") + user("u3", "c"));
    const cache = new ChatCache();
    const stream = jsonlChatStream({ key: () => "k", resolve: () => path, cache });
    stream.poll();
    writeFileSync(path, user("n1", "new"));
    const next = stream.poll();
    expect(next.chat?.reset).toBe(true);
    expect(next.chat?.items.map((i) => i.id)).toEqual(["n1"]);
    const reopened = jsonlChatStream({ key: () => "k", resolve: () => path, cache }).poll();
    expect(reopened.chat?.items.map((i) => i.id)).toEqual(["n1"]);
  });

  it("題名を読んでも、覚えている会話の並びは変わらない", () => {
    const cache = new ChatCache(2);
    const [a, b, c] = [file(user("a", "1")), file(user("b", "1")), file(user("c", "1"))];
    const ea = cache.get(a, undefined, 10);
    cache.get(b, undefined, 10);
    // a を題名のために読んでも前に出さない → 次に c を足すと a が押し出される
    expect(cache.peekOrAdd(a, undefined, 10)).toBe(ea);
    cache.get(c, undefined, 10);
    expect(cache.get(a, undefined, 10)).not.toBe(ea);
  });
});
