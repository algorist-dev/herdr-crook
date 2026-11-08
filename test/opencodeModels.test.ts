import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentModelOnScreen, parseModelList, parseRecent, pickerRows, pickerState, rowIndexFor, switchOpenCodeModel, switchOpenCodeVariant, variantOnScreen } from "../src/providers/opencode/models.ts";

describe("OpenCode のモデル", () => {
  it("opencode models --verbose の出力を読む（提供元の表示名も付ける）", () => {
    const out = [
      "opencode-go/kimi-k3",
      JSON.stringify({ id: "kimi-k3", providerID: "opencode-go", name: "Kimi K3", status: "active" }, null, 2),
      "opencode/gpt-5",
      JSON.stringify({ id: "gpt-5", providerID: "opencode", name: "GPT-5", status: "active", limit: { context: 400000 } }, null, 2),
      "opencode/old",
      JSON.stringify({ id: "old", providerID: "opencode", name: "Old", status: "deprecated" }, null, 2),
    ].join("\n");
    expect(parseModelList(out)).toEqual([
      { provider: "opencode-go", id: "kimi-k3", name: "Kimi K3", providerName: "OpenCode Go", variants: [] },
      { provider: "opencode", id: "gpt-5", name: "GPT-5", providerName: "OpenCode", variants: [], contextLimit: 400000 },
    ]);
  });

  it("最近使ったモデル（model.json）", () => {
    const json = JSON.stringify({ recent: [{ providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }, { providerID: "x" }] });
    expect(parseRecent(json)).toEqual([{ provider: "opencode-go", id: "deepseek-v4.1-flash" }]);
    expect(parseRecent("not json")).toEqual([]);
  });

  it("広い画面で右端に「/~」が出ても、モデルと考える量を読める", () => {
    const wide = "  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · high                                                            /~\n";
    expect(currentModelOnScreen(wide)).toBe("DeepSeek V4.1 Flash OpenCode Go");
    expect(variantOnScreen(wide)).toBe("high");
    const noVariant = "  ┃  Build · Kimi K3 OpenCode Go                                                       /~\n";
    expect(currentModelOnScreen(noVariant)).toBe("Kimi K3 OpenCode Go");
    expect(variantOnScreen(noVariant)).toBeNull();
    expect(pickerRows("Select model   esc\n\n  kimi\n\n  Kimi K3      OpenCode Go          /~\n  Connect provider")).toEqual([{ name: "Kimi K3", provider: "OpenCode Go" }]);
  });

  it("会話の中の似た行は、いまのモデルと読まない", () => {
    expect(currentModelOnScreen("Step · do this thing\n")).toBeNull();
  });

  it("右端の「Free」の印は提供元と読まない", () => {
    expect(pickerRows("Select model   esc\n\n  beam\n\n  Beam Free      Free      OpenCode Go\n  Connect provider")).toEqual([{ name: "Beam Free", provider: "OpenCode Go" }]);
  });

  it("画面の下の「Build · モデル 提供元 · 考える量」から、いまのモデルを読む", () => {
    expect(currentModelOnScreen("  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · high\n")).toBe("DeepSeek V4.1 Flash OpenCode Go");
    expect(currentModelOnScreen("  ┃  Plan · Kimi K3 OpenCode Go\n")).toBe("Kimi K3 OpenCode Go");
    expect(currentModelOnScreen("nothing")).toBeNull();
  });

  const screen = [
    "                                  Select model                                     esc",
    "",
    "                                  Kimi K3",
    "",
    "                                  Kimi K3.1 Pro                            OpenCode Go",
    "                                  Kimi K3                                  OpenCode Go",
    "                                  Kimi K3                                     OpenCode",
    "",
    "                      ┃           Connect provider ctrl+a  Favorite ctrl+f",
  ].join("\n");

  it("絞り込んだ一覧の行（名前と提供元）を読む", () => {
    expect(pickerRows(screen)).toEqual([
      { name: "Kimi K3.1 Pro", provider: "OpenCode Go" },
      { name: "Kimi K3", provider: "OpenCode Go" },
      { name: "Kimi K3", provider: "OpenCode" },
    ]);
  });

  it("選びたいモデルが何行目か（名前と提供元の両方が合う行）", () => {
    expect(rowIndexFor(screen, { name: "Kimi K3", providerName: "OpenCode Go" })).toBe(1);
    expect(rowIndexFor(screen, { name: "Kimi K3", providerName: "OpenCode" })).toBe(2);
    expect(rowIndexFor(screen, { name: "GPT-5", providerName: "OpenCode" })).toBe(-1);
    expect(rowIndexFor("Select model\nno rows", { name: "Kimi K3", providerName: "OpenCode" })).toBe(-1);
  });
});

describe("switchOpenCodeModel", () => {
  const status = (m: string) => `  ┃  Ask anything\n  ┃  Build · ${m} · high\n`;
  const picker = (query: string, rows: string) => `Select model   esc\n\n  ${query || "Search"}\n\n${rows}\n  Connect provider ctrl+a`;
  function fake(screens: string[]) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let i = 0;
    return {
      calls,
      sent: () => calls.filter((c) => c.method !== "pane.read").map((c) => c.params.keys ?? c.params.text),
      herdr: {
        request: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          if (method === "pane.read") return { read: { text: screens[Math.min(i++, screens.length - 1)] } };
          return {};
        },
      },
    };
  }
  const now = async () => {};
  const rows = "  Kimi K3.1 Pro      OpenCode Go\n  Kimi K3      OpenCode Go";
  const target = { name: "Kimi K3", providerName: "OpenCode Go" };

  it("一覧を開き、名前で絞り、同じ一覧が続けて読めてから合う行まで下げて決め、下の表示で確かめる", async () => {
    const f = fake([status("DeepSeek OpenCode Go"), picker("", ""), picker("Kimi K3", rows), picker("Kimi K3", rows), picker("Kimi K3", rows), status("Kimi K3 OpenCode Go")]);
    const r = await switchOpenCodeModel(f.herdr, "w1:p1", target, now);
    expect(r).toEqual({ ok: true, current: "Kimi K3 OpenCode Go" });
    expect(f.sent()).toEqual([["ctrl+x", "m"], "Kimi K3", ["down"], ["enter"]]);
  });

  it("絞り込む前の一覧では数えない（検索の文字が出るまで待つ）", async () => {
    const unfiltered = "  Beam Free      OpenCode Go\n  X      OpenCode Go\n  Kimi K3      OpenCode Go";
    const f = fake([status("A OpenCode"), picker("", unfiltered), picker("", unfiltered), picker("Kimi K3", rows), picker("Kimi K3", rows), picker("Kimi K3", rows), status("Kimi K3 OpenCode Go")]);
    await switchOpenCodeModel(f.herdr, "w1:p1", target, now);
    expect(f.sent()).toEqual([["ctrl+x", "m"], "Kimi K3", ["down"], ["enter"]]);
  });

  it("一覧が開かなければ、名前も Enter も送らない", async () => {
    const f = fake([status("A OpenCode")]);
    const r = await switchOpenCodeModel(f.herdr, "w1:p1", target, now);
    expect(r.ok).toBe(false);
    expect(f.sent()).toEqual([["ctrl+x", "m"]]);
  });

  it("ほかのダイアログが開いていたら何も押さない", async () => {
    const f = fake(["Permission required\n  Allow once"]);
    const r = await switchOpenCodeModel(f.herdr, "w1:p1", target, now);
    expect(r.ok).toBe(false);
    expect(f.sent()).toEqual([]);
  });

  it("一覧になければ閉じて、Enter は押さない", async () => {
    const other = "  Other      OpenCode";
    const f = fake([status("A OpenCode"), picker("", ""), picker("Kimi K3", other), picker("Kimi K3", other), picker("Kimi K3", other), status("A OpenCode")]);
    const r = await switchOpenCodeModel(f.herdr, "w1:p1", target, now);
    expect(r.ok).toBe(false);
    expect(f.sent()).toEqual([["ctrl+x", "m"], "Kimi K3", ["esc"]]);
  });

  it("途中で一覧が閉じられたら Enter を押さない（名前が入力欄に入って送られないように）", async () => {
    const f = fake([status("A OpenCode"), picker("", ""), picker("Kimi K3", rows), picker("Kimi K3", rows), status("A OpenCode")]);
    const r = await switchOpenCodeModel(f.herdr, "w1:p1", target, now);
    expect(r.ok).toBe(false);
    expect(f.sent().some((k) => Array.isArray(k) && k.includes("enter"))).toBe(false);
  });
});

describe("考える量", () => {
  const line = (v: string | null) => `  ┃  Build · Kimi K3 OpenCode Go${v ? ` · ${v}` : ""}\n`;
  it("入力欄の下から読む。印がなければ既定（null）", () => {
    expect(variantOnScreen(line("xhigh"))).toBe("xhigh");
    expect(variantOnScreen(line(null))).toBeNull();
  });

  it("ctrl+t で目当ての段階になるまで回す（既定は印なし）", async () => {
    const screens = [line("high"), line("max"), line(null), line("low")];
    let i = 0;
    const keys: unknown[] = [];
    const herdr = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "pane.read") return { read: { text: screens[Math.min(i, screens.length - 1)] } };
        keys.push(params.keys);
        i++;
        return {};
      },
    };
    expect(await switchOpenCodeVariant(herdr, "p", ["low", "high", "max"], "default", async () => {})).toEqual({ ok: true, variant: null });
    expect(keys).toEqual([["ctrl+t"], ["ctrl+t"]]);
  });

  it("そのモデルにない段階は押さない", async () => {
    const herdr = { request: async () => ({ read: { text: line("high") } }) };
    expect((await switchOpenCodeVariant(herdr, "p", ["low", "high"], "max", async () => {})).ok).toBe(false);
  });
});

describe("広い画面のモデルの一覧（会話の上に重なって出る）", () => {
  it("左に残っている会話の文字（日本語も）を読まない", () => {
    const pad = (left: string, col: number, right: string) => {
      let w = 0;
      for (const ch of left) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
      return left + " ".repeat(Math.max(1, col - w)) + right;
    };
    const screen = [
      pad("  ┃", 80, "Select model                                     esc"),
      "  ┃",
      pad("", 81, "Kimi K2.7 Code"),
      "     + Thought: 1.8s",
      pad("  ┃  これは会話の日本語です", 81, "Kimi K2.7 Code                           OpenCode Go"),
      pad("                         (                            )", 81, "Kimi K2.7 Code                              OpenCode"),
      "",
      pad("     ▣  Build · DeepSeek V4.1 Flash · 4.1s", 81, "Connect provider ctrl+a  Favorite ctrl+f"),
    ].join("\n");
    expect(pickerState(screen)).toEqual({ open: true, query: "Kimi K2.7 Code" });
    expect(pickerRows(screen)).toEqual([
      { name: "Kimi K2.7 Code", provider: "OpenCode Go" },
      { name: "Kimi K2.7 Code", provider: "OpenCode" },
    ]);
    expect(rowIndexFor(screen, { name: "Kimi K2.7 Code", providerName: "OpenCode Go" })).toBe(0);
  });

  it("本物の画面（さっき読んだもの）でも読める", () => {
    const real = readFileSync(join(import.meta.dirname, "fixtures", "opencode-picker-wide.txt"), "utf8");
    expect(pickerState(real)).toEqual({ open: true, query: "Kimi K2.7 Code" });
    expect(rowIndexFor(real, { name: "Kimi K2.7 Code", providerName: "OpenCode Go" })).toBe(0);
  });
});
