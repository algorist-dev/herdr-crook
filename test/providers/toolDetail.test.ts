import { describe, expect, it } from "vitest";
import { buildToolDetail, limitToolSections, type ToolSection } from "../../src/providers/shared/toolDetail.ts";

const section = (text: string, label = "中身"): ToolSection => ({ label, style: "code", text, truncated: false });

describe("ツールの中身の見出しと形", () => {
  it("Bash：説明があれば先に文で、コマンドと出力を code で出す", () => {
    expect(
      buildToolDetail({
        name: "Bash",
        input: { command: "npm test", description: "テストを動かす" },
        output: "ok\n",
      }),
    ).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "説明", style: "text", text: "テストを動かす", truncated: false },
        { label: "コマンド", style: "code", text: "npm test", truncated: false },
        { label: "出力", style: "code", text: "ok\n", truncated: false },
      ],
    });
  });

  it("Read：ファイルと中身。画像は base64 を出さず「（画像）」", () => {
    expect(buildToolDetail({ name: "Read", input: { file_path: "/tmp/a.png" }, output: "（画像）" })).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "ファイル", style: "code", text: "/tmp/a.png", truncated: false },
        { label: "中身", style: "code", text: "（画像）", truncated: false },
      ],
    });

    expect(buildToolDetail({ name: "Read", input: { file_path: "/tmp/a.ts", offset: 10, limit: 20 }, output: "const a = 1" }).sections[0]).toEqual({
      label: "ファイル",
      style: "code",
      text: "/tmp/a.ts\noffset: 10\nlimit: 20",
      truncated: false,
    });
  });

  it("Write：ファイルと書いた中身", () => {
    expect(buildToolDetail({ name: "Write", input: { file_path: "/tmp/a.ts", content: "const a = 1" }, output: "書きました" })).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "ファイル", style: "code", text: "/tmp/a.ts", truncated: false },
        { label: "書いた中身", style: "code", text: "const a = 1", truncated: false },
      ],
    });
  });

  it("Edit：古い行を -、新しい行を + にした diff と結果", () => {
    expect(
      buildToolDetail({
        name: "Edit",
        input: { file_path: "/tmp/a.ts", old_string: "a\nb", new_string: "a\nc" },
        output: "直しました",
      }),
    ).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "ファイル", style: "code", text: "/tmp/a.ts", truncated: false },
        { label: "変更", style: "diff", text: "-a\n-b\n+a\n+c", truncated: false },
        { label: "結果", style: "text", text: "直しました", truncated: false },
      ],
    });
  });

  it("MultiEdit：edits を順に diff にする", () => {
    expect(
      buildToolDetail({
        name: "MultiEdit",
        input: {
          file_path: "/tmp/a.ts",
          edits: [
            { old_string: "x", new_string: "y" },
            { old_string: "p", new_string: "q" },
          ],
        },
        output: "ok",
      }).sections[1],
    ).toEqual({ label: "変更", style: "diff", text: "-x\n+y\n-p\n+q", truncated: false });
  });

  it("apply_patch：パッチの文字をそのまま diff にする", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
    expect(buildToolDetail({ name: "apply_patch", input: patch, output: "Done" })).toEqual({
      running: false,
      error: false,
      sections: [{ label: "変更", style: "diff", text: patch, truncated: false }],
    });
  });

  it("Grep：探したものと、見つかったもの", () => {
    expect(
      buildToolDetail({ name: "Grep", input: { pattern: "TODO", path: "src", glob: "*.ts" }, output: "src/a.ts:1" }),
    ).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "探したもの", style: "code", text: "TODO\nsrc\n*.ts", truncated: false },
        { label: "見つかったもの", style: "code", text: "src/a.ts:1", truncated: false },
      ],
    });
  });

  it("WebFetch：場所と結果", () => {
    expect(buildToolDetail({ name: "WebFetch", input: { url: "https://example.com" }, output: "こんにちは" })).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "場所", style: "code", text: "https://example.com", truncated: false },
        { label: "結果", style: "text", text: "こんにちは", truncated: false },
      ],
    });
  });

  it("知らないツール：渡したものの JSON と、結果", () => {
    expect(buildToolDetail({ name: "mcp__foo__bar", input: { foo: "bar", n: 1 }, output: "done" })).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "渡したもの", style: "code", text: '{\n  "foo": "bar",\n  "n": 1\n}', truncated: false },
        { label: "結果", style: "code", text: "done", truncated: false },
      ],
    });
  });

  it("実行中は、返ってきたものの section を付けない", () => {
    expect(buildToolDetail({ name: "Bash", input: { command: "sleep 10" }, running: true }).sections).toEqual([
      { label: "コマンド", style: "code", text: "sleep 10", truncated: false },
    ]);
    expect(buildToolDetail({ name: "Read", input: { file_path: "/tmp/a.ts" }, running: true }).sections).toEqual([
      { label: "ファイル", style: "code", text: "/tmp/a.ts", truncated: false },
    ]);
  });

  it("失敗した印をそのまま返す", () => {
    expect(buildToolDetail({ name: "Bash", input: { command: "false" }, output: "だめ", error: true })).toMatchObject({
      running: false,
      error: true,
    });
  });
});

describe("長い中身の切り方", () => {
  it("1 つの section は 32 KB まで", () => {
    const [only] = limitToolSections([section("a".repeat(40 * 1024))]);
    expect(only?.text.length).toBe(32 * 1024);
    expect(only?.truncated).toBe(true);
  });

  it("全部で 128 KB まで。超えた後ろは空にして truncated にする", () => {
    const limited = limitToolSections(Array.from({ length: 5 }, (_, i) => section("a".repeat(40 * 1024), `s${i}`)));
    expect(limited.map((s) => s.text.length)).toEqual([32 * 1024, 32 * 1024, 32 * 1024, 32 * 1024, 0]);
    expect(limited.every((s) => s.truncated)).toBe(true);
    expect(limited.reduce((sum, s) => sum + Buffer.byteLength(s.text, "utf8"), 0)).toBeLessThanOrEqual(128 * 1024);
  });

  it("短いものは切らない", () => {
    expect(limitToolSections([section("a")])).toEqual([section("a")]);
  });
});
