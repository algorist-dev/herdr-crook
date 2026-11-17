import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAskingOnScreen, parseChoices } from "../src/features/choices.ts";

// 質問が 2 つ以上・複数選択の AskUserQuestion（2026-11-17 に 49 桁の本物の画面から取った）
const load = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", `claude-askuserquestion-multi-${name}.txt`), "utf8");

describe("質問が 2 つ以上の AskUserQuestion", () => {
  it("上の並び（← ☐ 果物 ☐ 飲み物 ✔ Submit →）を、答えたかどうかと一緒に読む", () => {
    const c = parseChoices(load("q1"))!;
    expect(c.tabs).toEqual([
      { label: "果物", done: false },
      { label: "飲み物", done: false },
      { label: "Submit", done: false, submit: true },
    ]);
    const answered = parseChoices(load("checked"))!;
    expect(answered.tabs?.[0]).toEqual({ label: "果物", done: true });
  });

  it("複数選択の印 [ ] と [✔] を読み、Next は説明にしない", () => {
    const c = parseChoices(load("checked"))!;
    expect(c.question).toBe("好きな果物は？");
    expect(c.multi).toBe(true);
    expect(c.options.map((o) => [o.key, o.label, o.detail, o.checked])).toEqual([
      ["1", "[✔] りんご", "りんごを選ぶ", true],
      ["2", "[ ] みかん", "みかんを選ぶ", false],
      ["3", "[✔] ぶどう", "ぶどうを選ぶ", true],
      ["4", "[ ] Type something", null, false],
      ["5", "Chat about this", null, undefined],
    ]);
  });

  it("1 つだけ選ぶ質問には複数選択の印を付けない", () => {
    const c = parseChoices(load("q2"))!;
    expect(c.question).toBe("飲み物は？");
    expect(c.multi).toBeUndefined();
    expect(c.options.every((o) => o.checked === undefined)).toBe(true);
    expect(c.tabs?.map((t) => t.done)).toEqual([true, false, false]);
  });

  it("最後の確かめ（Review your answers）も選択肢として読む", () => {
    const c = parseChoices(load("review"))!;
    expect(c.question).toBe("Ready to submit your answers?");
    expect(c.options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
    expect(c.tabs?.map((t) => t.done)).toEqual([true, true, false]);
  });

  it("どの画面も返事待ちと見る（案内が「Tab/Arrow keys to navigate」・案内のない確かめの画面でも）", () => {
    for (const name of ["q1", "checked", "q2", "review"]) expect(isAskingOnScreen(load(name)), name).toBe(true);
  });

  it("複数選択の質問が 1 つだけでも上の並びがあり、下のボタンは Submit になる", () => {
    const c = parseChoices(load("single"))!;
    expect(c.multi).toBe(true);
    expect(c.tabs).toEqual([{ label: "好きな果物", done: false }, { label: "Submit", done: false, submit: true }]);
    expect(c.options[3]).toEqual({ key: "4", label: "[ ] Type something", detail: null, checked: false });
    expect(isAskingOnScreen(load("single"))).toBe(true);
  });

  it("区切り線より上に残った古い並びは使わない（/model の一覧などを返事待ちにしない）", () => {
    const stale = [
      "←  ☒ 果物  ☒ 飲み物  ✔ Submit  →",
      "  → りんご",
      "─────────────────────────────────────────────────",
      " Select model",
      " ❯ 1. Default",
      "   2. Opus",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(parseChoices(stale)!.tabs).toBeUndefined();
    expect(isAskingOnScreen(stale)).toBe(false);
  });

  it("並びがあっても、確かめの見出しも下の案内もなければ返事待ちにしない", () => {
    const screen = load("review").replace("Ready to submit your answers?", "Pick one");
    expect(isAskingOnScreen(screen)).toBe(false);
  });

  it("狭い画面で案内が折り返しても見分ける", () => {
    const narrow = load("q2").replace(/Enter to select · Tab\/Arrow keys to navigate ·/, "Enter to select · Tab/Arrow keys to\nnavigate ·");
    expect(narrow).not.toBe(load("q2"));
    expect(isAskingOnScreen(narrow)).toBe(true);
  });

  it("印の後ろに字形の指定（U+FE0F）が付いても読む", () => {
    const c = parseChoices(load("checked").replace("[✔] りんご", "[✔\uFE0F] りんご"))!;
    expect(c.options[0]!.checked).toBe(true);
  });

  it("1 つだけの質問には上の並びがない", () => {
    const one = readFileSync(join(import.meta.dirname, "fixtures", "claude-askuserquestion-supervisor.txt"), "utf8");
    expect(parseChoices(one)!.tabs).toBeUndefined();
  });
});
