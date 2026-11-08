import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonlChatStream } from "../../src/providers/shared/jsonlChat.ts";
import type { TranscriptUsage } from "../../src/features/usage.ts";

const line = (o: object) => JSON.stringify(o) + "\n";
const user = (id: string, text: string) => line({ type: "user", uuid: id, message: { role: "user", content: text } });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hm-jsonl-"));
  const files = new Map<string, string>();
  let key: string | null = "s1";
  const stream = (more: Partial<Parameters<typeof jsonlChatStream>[0]> = {}) =>
    jsonlChatStream({ key: () => key, resolve: (k) => files.get(k) ?? null, ...more });
  const write = (k: string, text: string) => {
    const path = join(dir, `${k}.jsonl`);
    writeFileSync(path, text);
    files.set(k, path);
    return path;
  };
  return { stream, write, setKey: (k: string | null) => void (key = k) };
}

describe("jsonlChatStream", () => {
  it("記録がまだない：1 回目は available:false、2 回目は何も送らない", () => {
    const t = setup();
    const s = t.stream();
    expect(s.poll()).toEqual({ chat: { available: false, reset: true, title: null, items: [] } });
    expect(s.poll()).toEqual({ chat: null });
  });

  it("あとから記録ができたら、そのとき全部を reset で送る", () => {
    const t = setup();
    const s = t.stream();
    s.poll();
    s.poll();
    t.write("s1", user("u1", "こんにちは"));
    const got = s.poll();
    expect(got.chat).toMatchObject({ available: true, reset: true, items: [{ id: "u1", text: "こんにちは" }] });
    expect("usage" in got).toBe(true);
  });

  it("最初から記録がある：1 回目に reset で全部・usage のキーもある", () => {
    const t = setup();
    t.write("s1", line({ type: "ai-title", aiTitle: "題名" }) + user("u1", "a"));
    const got = t.stream().poll();
    expect(got.chat).toEqual({ available: true, reset: true, title: "題名", items: [{ id: "u1", role: "user", kind: "text", text: "a" }] });
    expect("usage" in got).toBe(true);
  });

  it("行が増えたら増えた分だけ reset:false で、増えていなければ chat:null", () => {
    const t = setup();
    const path = t.write("s1", user("u1", "a"));
    const s = t.stream();
    s.poll();
    expect(s.poll().chat).toBeNull();
    appendFileSync(path, user("u2", "b"));
    expect(s.poll().chat).toEqual({ available: true, reset: false, title: null, items: [{ id: "u2", role: "user", kind: "text", text: "b" }] });
  });

  it("会話が切り替わったら（/clear など）新しい記録を reset で送り直す", () => {
    const t = setup();
    t.write("s1", user("u1", "古い"));
    const s = t.stream();
    s.poll();
    t.write("s2", user("v1", "新しい"));
    t.setKey("s2");
    expect(s.poll().chat).toMatchObject({ reset: true, items: [{ id: "v1" }] });
  });

  it("切り替わった先の記録がまだなければ、前の会話を読み続ける", () => {
    const t = setup();
    const path = t.write("s1", user("u1", "古い"));
    const s = t.stream();
    s.poll();
    t.setKey("s2");
    appendFileSync(path, user("u2", "続き"));
    expect(s.poll().chat).toMatchObject({ reset: false, items: [{ id: "u2" }] });
  });

  it("長い会話は最初に最後の 150 件だけ", () => {
    const t = setup();
    t.write("s1", Array.from({ length: 200 }, (_, i) => user(`u${i}`, `m${i}`)).join(""));
    const items = t.stream().poll().chat?.items ?? [];
    expect(items).toHaveLength(150);
    expect(items[0]?.id).toBe("u50");
    expect(items.at(-1)?.id).toBe("u199");
  });

  it("mapUsage を渡すと、読んでいる会話の ID と一緒に呼ばれ、その結果を返す", () => {
    const t = setup();
    const path = t.write("s1", user("u1", "a"));
    const fixed = { source: "claude", model: "opus" } as unknown as TranscriptUsage;
    const keys: string[] = [];
    const s = t.stream({ mapUsage: (_u, k) => (keys.push(k), fixed) });
    expect(s.poll().usage).toBe(fixed);
    appendFileSync(path, user("u2", "b"));
    expect(s.poll().usage).toBe(fixed);
    expect(keys).toEqual(["s1", "s1"]);
  });

  it("close のあとは何も送らない", () => {
    const t = setup();
    t.write("s1", user("u1", "a"));
    const s = t.stream();
    s.poll();
    s.close();
    t.setKey(null);
    expect(s.poll()).toEqual({ chat: null });
  });
});
