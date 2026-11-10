import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeminiProvider } from "../../src/providers/gemini/index.ts";
import { createGeminiParser, findGeminiSession, geminiHome, geminiToolDetail } from "../../src/providers/gemini/transcript.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "gemini-0.67-session.jsonl");
const fixtureLines = () => readFileSync(fixture, "utf8").split("\n").filter((l) => l.trim());

const SHELL1 = "run_shell_command__call_5619069895261638373";
const SHELL2 = "run_shell_command__call_15855174917022835603";

describe("Gemini CLI の会話の記録（実物の見本、0.67）", () => {
  it("同じ id で何度も書かれたメッセージを 1 つにまとめ、前置き・ツールの結果・考えは出さない", () => {
    const parsed = createGeminiParser()(fixtureLines(), 0);
    expect(parsed.items).toEqual([
      { id: "e2be5b6c-f321-4040-b37f-44a81583c571", role: "user", kind: "text", text: "Run `ls -1` with the shell tool, then reply in one short line." },
      { id: `8aadef7f-58a7-4e8b-8798-18f6ff2fdd43:${SHELL1}`, role: "assistant", kind: "tool", tool: "Shell", text: "ls -1" },
      { id: "8f9e304b-4287-42e5-b6b7-7e9003cf1615", role: "assistant", kind: "text", text: "note.txt" },
      { id: "9ca8eddf-9b26-4a3d-a3ab-eb716d851e07", role: "user", kind: "text", text: "Run `touch hi.txt` with the shell tool, then reply in one short line." },
      { id: `3e1015da-94b1-4c2d-a779-765efec538f6:${SHELL2}`, role: "assistant", kind: "tool", tool: "Shell", text: "touch hi.txt" },
      { id: "ecd9486e-959c-47c5-9e28-2bd2ec633b74", role: "assistant", kind: "text", text: "Created `hi.txt`." },
    ]);
    expect(parsed.title).toBe("Run `ls -1` with the shell tool, then reply in one short line.");
  });

  it("使用量：メッセージごとに 1 回だけ数える（書き直しで重ねない）", () => {
    const usage = createGeminiParser()(fixtureLines(), 0).usage!;
    expect(usage.source).toBe("gemini");
    expect(usage.model).toBe("gemini-3.5-flash-lite");
    expect(usage.tokensDelta).toEqual({ input: 47166 - 24332, output: 83, cacheRead: 24332, cacheWrite: 0, reasoning: 482 });
    expect(usage.contextUsed).toBe(12128);
  });

  it("続きを読むとき：もう出したものは出さず、新しく付いたツールだけ出す", () => {
    const lines = fixtureLines();
    const parse = createGeminiParser();
    // 2 回目の 8aadef7f（toolCalls が付く前）で区切る
    const cut = lines.findIndex((l, i) => i > 0 && l.includes("8aadef7f") && !l.includes("toolCalls"));
    const first = parse(lines.slice(0, cut + 1), 0);
    const rest = parse(lines.slice(cut + 1), cut + 1);
    const all = [...first.items, ...rest.items];
    expect(all.map((i) => i.id)).toEqual(createGeminiParser()(lines, 0).items.map((i) => i.id));
    expect(rest.title).toBeNull();
    const tokens = [first.usage, rest.usage].reduce((n, u) => n + (u?.tokensDelta?.output ?? 0), 0);
    expect(tokens).toBe(83);
  });

  it("$rewindTo のあとは読み直す（消えたものを出したままにしない）", () => {
    const parse = createGeminiParser();
    parse(fixtureLines(), 0);
    const rewind = parse([JSON.stringify({ $rewindTo: "9ca8eddf-9b26-4a3d-a3ab-eb716d851e07" })], 30);
    expect(rewind.restart).toBe(true);
  });

  it("最初から読むときは、巻き戻したところから後ろを出さない（読み直しをくり返さない）", () => {
    const lines = [...fixtureLines(), JSON.stringify({ $rewindTo: "9ca8eddf-9b26-4a3d-a3ab-eb716d851e07" })];
    const parsed = createGeminiParser()(lines, 0);
    expect(parsed.restart).toBeUndefined();
    expect(parsed.items.map((i) => i.text)).toEqual(["Run `ls -1` with the shell tool, then reply in one short line.", "ls -1", "note.txt"]);
  });

  it("ツールの中身：呼び出し・結果（untrusted_context の囲みは外す）", () => {
    const detail = geminiToolDetail(fixture, `8aadef7f-58a7-4e8b-8798-18f6ff2fdd43:${SHELL1}`)!;
    expect(detail.running).toBe(false);
    expect(detail.error).toBe(false);
    const texts = detail.sections.map((s) => s.text).join("\n");
    expect(texts).toContain("ls -1");
    expect(texts).toContain("Output: note.txt");
    expect(texts).not.toContain("untrusted_context");
    expect(geminiToolDetail(fixture, "nope")).toBeNull();
  });
});

describe("Gemini CLI の記録の場所", () => {
  it("GEMINI_CLI_HOME があればその下、なければ ~ の下の .gemini", () => {
    expect(geminiHome({ GEMINI_CLI_HOME: "/h" }, "/home/me")).toBe("/h/.gemini");
    expect(geminiHome({}, "/home/me")).toBe("/home/me/.gemini");
  });

  it("projects.json の短い名前 → tmp/<名前>/chats のいちばん新しい session-*.jsonl", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-home-"));
    writeFileSync(join(home, "projects.json"), JSON.stringify({ projects: { "/private/tmp/proj": "proj" } }));
    const chats = join(home, "tmp", "proj", "chats");
    mkdirSync(join(chats, "parent-id"), { recursive: true });
    const old = join(chats, "session-2026-11-01T00-00-aaaaaaaa.jsonl");
    const neu = join(chats, "session-2026-11-08T00-00-bbbbbbbb.jsonl");
    writeFileSync(old, "{}\n");
    writeFileSync(neu, "{}\n");
    // サブエージェントの記録（chats/<親>/）は見ない
    writeFileSync(join(chats, "parent-id", "sub.jsonl"), "{}\n");
    utimesSync(old, new Date(1000), new Date(1000));
    expect(findGeminiSession("/private/tmp/proj", home)).toBe(neu);
    expect(findGeminiSession("/tmp/proj", home)).toBe(neu);
    expect(findGeminiSession("/tmp/other", home)).toBeNull();
  });
});

describe("Gemini CLI のプロバイダ", () => {
  it("作業フォルダのいちばん新しい記録（gemini:<フォルダ>）", () => {
    const p = createGeminiProvider();
    expect(p.chatKey({ agent: "gemini", sessionSource: null, sessionValue: null }, "/a")).toBe("gemini:/a");
    expect(p.chatKey({ agent: "gemini", sessionSource: null, sessionValue: null }, null)).toBeNull();
  });

  it("確認なしは --yolo", () => {
    expect(createGeminiProvider().unattendedArgs).toEqual(["--yolo"]);
  });

  it("会話を開くと、見本の記録を読める", () => {
    const p = createGeminiProvider({ find: () => fixture });
    const stream = p.chat!.open(() => "gemini:/repo/demo");
    const first = stream.poll();
    expect(first.chat?.available).toBe(true);
    expect(first.chat?.items).toHaveLength(6);
    expect(first.usage?.tokens?.output).toBe(83);
    stream.close();
    expect(p.chat!.title("gemini:/repo/demo")).toBe("Run `ls -1` with the shell tool, then reply in one short line.");
    expect(p.chat!.title("other")).toBeNull();
  });
});

describe("Gemini CLI：巻き戻しの見張り", () => {
  it("記録に巻き戻しが足されたら、最初から読み直して入れ替える（1 回だけ）", () => {
    const dir = mkdtempSync(join(tmpdir(), "gemini-rewind-"));
    const path = join(dir, "session-x.jsonl");
    writeFileSync(path, fixtureLines().join("\n") + "\n");
    const p = createGeminiProvider({ find: () => path });
    const stream = p.chat!.open(() => "gemini:/repo/demo");
    expect(stream.poll().chat?.items).toHaveLength(6);
    writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify({ $rewindTo: "9ca8eddf-9b26-4a3d-a3ab-eb716d851e07" }) + "\n");
    const after = stream.poll();
    expect(after.chat?.reset).toBe(true);
    expect(after.chat?.items).toHaveLength(3);
    expect(stream.poll().chat).toBeNull();
    stream.close();
  });
});

describe("Gemini CLI：$patch・$set.messages（レビューの指摘）", () => {
  const user = (id: string, text: string) => JSON.stringify({ id, timestamp: "t", type: "user", content: [{ text }] });
  const reply = (id: string, text: string) => JSON.stringify({ id, timestamp: "t", type: "gemini", content: text });

  it("最初から読むとき：removeIds で消し、content の差し替えを反映する", () => {
    const parsed = createGeminiParser()(
      [user("u1", "やって"), reply("g1", "古い"), reply("g2", "消える"), JSON.stringify({ $patch: { id: "g1", content: "新しい", removeIds: ["g2"] } })],
      0,
    );
    expect(parsed.items.map((i) => i.text)).toEqual(["やって", "新しい"]);
  });

  it("最初から読むとき：$set.messages でまるごと入れ替える", () => {
    const parsed = createGeminiParser()(
      [user("u1", "古い発言"), JSON.stringify({ $set: { messages: [JSON.parse(user("u9", "新しい発言"))] } })],
      0,
    );
    expect(parsed.items.map((i) => i.id)).toEqual(["u9"]);
  });

  it("続きを読むときの $patch・$set.messages は読み直してもらう", () => {
    const parse = createGeminiParser();
    parse([user("u1", "やって")], 0);
    expect(parse([JSON.stringify({ $patch: { id: "u1", content: "x" } })], 1).restart).toBe(true);
    expect(parse([JSON.stringify({ $set: { messages: [] } })], 2).restart).toBe(true);
    expect(parse([JSON.stringify({ $set: { lastUpdated: "t" } })], 3).restart).toBeUndefined();
  });

  it("題名：最初の読み取りがメタデータだけでも、あとで来た最初の発言を題名にする（その後は変えない）", () => {
    const parse = createGeminiParser();
    expect(parse([JSON.stringify({ sessionId: "s", kind: "main" })], 0).title).toBeNull();
    expect(parse([user("u1", "最初")], 1).title).toBe("最初");
    expect(parse([user("u2", "次")], 2).title).toBeNull();
  });

  it("ツールの結果が $patch だけで届いても、中身に出す", () => {
    const dir = mkdtempSync(join(tmpdir(), "gemini-patch-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ id: "g1", type: "gemini", content: "", toolCalls: [{ id: "c1", name: "run_shell_command", args: { command: "ls" }, status: "success" }] }),
        JSON.stringify({ $patch: { id: "g1", toolCalls: [{ id: "c1", result: [{ functionResponse: { id: "c1", name: "run_shell_command", response: { output: "a.txt" } } }] }] } }),
      ].join("\n") + "\n",
    );
    const detail = geminiToolDetail(path, "g1:c1")!;
    expect(detail.running).toBe(false);
    expect(detail.sections.map((s) => s.text).join("\n")).toContain("a.txt");
  });
});
