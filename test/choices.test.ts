import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChoices } from "../src/features/choices.ts";

describe("parseChoices（返事待ちの画面から選択肢を読む）", () => {
  it("Claude の許可の確認（枠あり）", () => {
    const screen = [
      "╭──────────────────────────────────────────╮",
      "│ Bash command                             │",
      "│                                          │",
      "│   npm test                               │",
      "│                                          │",
      "│ Do you want to proceed?                  │",
      "│ ❯ 1. Yes                                 │",
      "│   2. Yes, and don't ask again for npm    │",
      "│   3. No, and tell Claude what to do (esc)│",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(parseChoices(screen)).toEqual({
      question: "Do you want to proceed?",
      options: [
        { key: "1", label: "Yes", detail: null },
        { key: "2", label: "Yes, and don't ask again for npm", detail: null },
        { key: "3", label: "No, and tell Claude what to do (esc)", detail: null },
      ],
      selected: "1",
    });
  });

  it("AskUserQuestion（説明つき・区切り線のあとの選択肢も）", () => {
    const screen = [
      "⏺ どちらにしますか",
      "",
      " ☐ 認証",
      "",
      " どの方法でログインしますか？",
      "",
      " ❯ 1. OAuth",
      "      プロバイダーでログイン",
      "   2. API キー",
      "      かんたんなトークン",
      "   3. Type something.",
      " ────────────────",
      "   4. Chat about this",
      "",
      " Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(parseChoices(screen)).toEqual({
      question: "どの方法でログインしますか？",
      options: [
        { key: "1", label: "OAuth", detail: "プロバイダーでログイン" },
        { key: "2", label: "API キー", detail: "かんたんなトークン" },
        { key: "3", label: "Type something.", detail: null },
        { key: "4", label: "Chat about this", detail: null },
      ],
      selected: "1",
    });
  });

  it("前の会話にある番号付きの箇条書きではなく、いちばん下の選択肢を読む", () => {
    const screen = ["手順:", "1. ビルド", "2. テスト", "", "続けますか？", "› 1. はい", "  2. いいえ"].join("\n");
    expect(parseChoices(screen)?.options.map((o) => o.label)).toEqual(["はい", "いいえ"]);
    expect(parseChoices(screen)?.question).toBe("続けますか？");
  });

  it("Codex の許可（番号で選ぶ）も読む", () => {
    const screen = [
      "  Would you like to run the following command?",
      "  $ rm -rf build",
      "",
      "  ❯ 1. Yes, proceed (y)",
      "    2. Yes, and don't ask again for this command in this session",
      "    3. No, and tell Codex what to do differently (esc)",
      "",
      "  Press a number to choose · esc to dismiss · type to continue",
    ].join("\n");
    expect(parseChoices(screen)).toEqual({
      question: "Would you like to run the following command?",
      options: [
        { key: "1", label: "Yes, proceed (y)", detail: null },
        { key: "2", label: "Yes, and don't ask again for this command in this session", detail: null },
        { key: "3", label: "No, and tell Codex what to do differently (esc)", detail: null },
      ],
      selected: "1",
    });
  });

  it("OpenCode の許可（横に並ぶ Allow once / Always allow / Reject）も読む", () => {
    const screen = [
      "  ┃  △ Permission required",
      "  ┃  # Shell command",
      "  ┃  $ npm test",
      "  ┃",
      "  ┃    Allow once     Allow always     Reject",
      "  ┃  ←/→ select  enter confirm  esc dismiss",
    ].join("\n");
    expect(parseChoices(screen)).toEqual({
      question: "# Shell command",
      options: [
        { key: "1", label: "Allow once", detail: null, keys: ["enter"] },
        { key: "2", label: "Allow always", detail: null, keys: ["right", "enter"] },
        { key: "3", label: "Reject", detail: null, keys: ["right", "right", "enter"] },
      ],
      selected: "1",
    });
  });

  it("OpenCode の外部フォルダの許可（実際の画面）も読む", () => {
    const screen = [
      "  ┃  △ Permission required",
      "  ┃    ← Access external directory /tmp",
      "  ┃",
      "  ┃  Patterns",
      "  ┃",
      "  ┃  - /tmp/*",
      "  ┃",
      "  ┃    Allow once     Allow always     Reject",
    ].join("\n");
    expect(parseChoices(screen)?.options.map((o) => o.label)).toEqual(["Allow once", "Allow always", "Reject"]);
    expect(parseChoices(screen)?.question).toBe("← Access external directory /tmp");
  });

  it("OpenCode の許可が 2 択（Allow once / Reject）でも読む", () => {
    const screen = [
      "  ┃  △ Permission required",
      "  ┃    ← Access external directory /tmp",
      "  ┃",
      "  ┃  Patterns",
      "  ┃",
      "  ┃  - /tmp/*",
      "  ┃",
      "  ┃    Allow once     Reject",
    ].join("\n");
    expect(parseChoices(screen)).toEqual({
      question: "← Access external directory /tmp",
      options: [
        { key: "1", label: "Allow once", detail: null, keys: ["enter"] },
        { key: "2", label: "Reject", detail: null, keys: ["right", "enter"] },
      ],
      selected: "1",
    });
  });

  it("OpenCode の「Always allow」の確認（Confirm / Cancel）も読む", () => {
    const screen = [
      "  ┃  △ Always allow",
      "  ┃",
      "  ┃  This will allow the following patterns",
      "  ┃  until OpenCode is restarted",
      "  ┃",
      "  ┃  - /Users/me/.claude/*",
      "  ┃",
      "  ┃    Confirm     Cancel",
      "  ┃  ⇄ select  enter confirm",
    ].join("\n");
    expect(parseChoices(screen)).toEqual({
      question: "This will allow the following patterns",
      options: [
        { key: "1", label: "Confirm", detail: null, keys: ["enter"] },
        { key: "2", label: "Cancel", detail: null, keys: ["right", "enter"] },
      ],
      selected: "1",
    });
  });

  it("選択肢がなければ null", () => {
    expect(parseChoices("me@mac % ls\nREADME.md\n")).toBeNull();
    expect(parseChoices("")).toBeNull();
  });

  it("OpenCode の質問（行の頭に空白と ┃ が付く）も読む", () => {
    const screen = [
      "     → Asked 1 question",
      "",
      "  ┃",
      "  ┃  今日は何をする？",
      "  ┃",
      "  ┃  1. コードを書く",
      "  ┃     新しい機能や修正を実装する",
      "  ┃  2. コードを読む",
      "  ┃     既存のコードを調査・説明する",
      "  ┃  3. 雑談",
      "  ┃     特に目的なしで話す",
      "  ┃  4. Type your own answer",
      "  ┃                                                     /~",
      "  ┃  ↑↓ select  enter submit  esc dismiss",
    ].join("\n");
    expect(parseChoices(screen)).toEqual({
      question: "今日は何をする？",
      options: [
        { key: "1", label: "コードを書く", detail: "新しい機能や修正を実装する" },
        { key: "2", label: "コードを読む", detail: "既存のコードを調査・説明する" },
        { key: "3", label: "雑談", detail: "特に目的なしで話す" },
        { key: "4", label: "Type your own answer", detail: null },
      ],
      selected: null,
    });
  });
});

describe("Gemini CLI 0.67（実物の画面。選んでいる行の印が ●）", () => {
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

  it("フォルダの信頼の確認：上の「Tips」の番号付きの行と取り違えない", () => {
    expect(parseChoices(fixture("gemini-0.67-trust.txt"))).toEqual({
      question: "Do you trust the files in this folder?",
      options: [
        { key: "1", label: "Trust folder (proj)", detail: null },
        { key: "2", label: "Trust parent folder (agents)", detail: null },
        { key: "3", label: "Don't trust", detail: null },
      ],
      selected: "1",
    });
  });

  it("ログインの方法の選択", () => {
    expect(parseChoices(fixture("gemini-0.67-auth.txt"))).toEqual({
      question: "How would you like to authenticate for this project?",
      options: [
        { key: "1", label: "Sign in with Google", detail: null },
        { key: "2", label: "Use Gemini API Key", detail: null },
        { key: "3", label: "Vertex AI", detail: null },
      ],
      selected: "1",
    });
  });
});

describe("承認の画面（実物）", () => {
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

  it("Gemini CLI 0.67 のシェルの承認（● 1. Allow once）", () => {
    expect(parseChoices(fixture("gemini-0.67-approval.txt"))).toEqual({
      question: "Allow execution of [Shell]?",
      options: [
        { key: "1", label: "Allow once", detail: null },
        { key: "2", label: "Allow for this session", detail: null },
        { key: "3", label: "No, suggest changes (esc)", detail: null },
      ],
      selected: "1",
    });
  });

  it("Hermes Agent 0.23 の危ないコマンドの承認（❯ 1. Allow once）", () => {
    expect(parseChoices(fixture("hermes-0.23-approval.txt"))).toEqual({
      question: "rm -rf ./scratch-dir",
      options: [
        { key: "1", label: "Allow once", detail: null },
        { key: "2", label: "Allow for this session", detail: null },
        { key: "3", label: "Add to permanent allowlist", detail: null },
        { key: "4", label: "Deny", detail: null },
      ],
      selected: "1",
    });
  });
});
