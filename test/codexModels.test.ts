import { describe, expect, it } from "vitest";
import { codexInput, codexStatus, parseCodexModels, pickerRows, switchCodexModel } from "../src/providers/codex/models.ts";

const idle = (status: string, input = "Ask Codex to do anything") =>
  `  >_ OpenAI Codex (v0.167.0)\n\n› ${input}\n\n  ${status} · /private/tmp\n  ← for agents · ? for shortcuts      ⚠ 1 warning · f2 to view`;
const models = [
  "  Select Model and Effort",
  "  1. GPT-6-Luna              Fast and affordable model for easier tasks.",
  "  2. GPT-5.6-Terra           Older balanced model for straightforward work.",
  "› 3. GPT-5.6-Luna (current)  Older fast and efficient model.",
  "  enter select · esc back",
].join("\n");
const levels = (cursor: number) =>
  [
    "  Select Reasoning Level for GPT-5.6-Luna",
    "",
    "  1. Low (current)     Fast responses with lighter reasoning",
    "  2. Medium (default)  Balances speed and reasoning depth for everyday tasks",
    "  3. High              Greater reasoning depth for complex problems",
    "  4. Extra high        Extra high reasoning depth for complex problems",
    "  5. More reasoning…   Max consumes usage limits faster",
    "  enter default · s session · esc back",
  ]
    .map((l, i) => (i === cursor + 2 ? l.replace(/^ {2}/, "› ") : l))
    .join("\n");

describe("Codex のモデル", () => {
  it("models_cache.json から、一覧に出すモデルと選べる考える量", () => {
    const json = JSON.stringify({ models: [
      { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] },
      { slug: "hidden", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [] },
    ] });
    expect(parseCodexModels(json)).toEqual([{ provider: "codex", id: "gpt-6-luna", name: "GPT-6-Luna", providerName: "Codex", variants: ["low", "max"] }]);
  });

  it("入力欄の下から、いまのモデルと考える量を読む", () => {
    expect(codexStatus(idle("GPT-5.6-Luna low"))).toEqual({ name: "GPT-5.6-Luna", effort: "low" });
  });

  it("例の文字は書きかけではない。ほかの文字は書きかけ", () => {
    expect(codexInput(idle("GPT-5.6-Luna low"))).toEqual({ ready: true, draft: null });
    expect(codexInput(idle("GPT-5.6-Luna low", "これを直して"))).toEqual({ ready: true, draft: "これを直して" });
    expect(codexInput(models).ready).toBe(false);
  });

  it("/model の画面の行（(current) などは外す）", () => {
    expect(pickerRows(models, /Select Model/)).toEqual([
      { key: "1", label: "GPT-6-Luna", cursor: false },
      { key: "2", label: "GPT-5.6-Terra", cursor: false },
      { key: "3", label: "GPT-5.6-Luna", cursor: true },
    ]);
  });

  it("モデルは番号、考える量はカーソルを動かして s（この会話だけ）。Enter や番号では決めない", async () => {
    const sent: unknown[] = [];
    let screen = idle("GPT-5.6-Luna low");
    let cursor = 0;
    const herdr = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "pane.read") return { read: { text: screen } };
        sent.push(params.text ?? params.keys);
        const k = params.keys as string[] | undefined;
        if (k?.[0] === "enter") screen = models;
        else if (k?.[0] === "3") screen = levels(cursor);
        else if (k?.[0] === "down") {
          cursor += k.length;
          screen = levels(cursor);
        } else if (k?.[0] === "s") screen = idle("GPT-5.6-Luna high");
        return {};
      },
    };
    const target = { provider: "codex", id: "gpt-5.6-luna", name: "GPT-5.6-Luna", providerName: "Codex", variants: ["low", "medium", "high"] };
    expect(await switchCodexModel(herdr, "p", target, "high", null, async () => {})).toEqual({ ok: true, effort: "high" });
    expect(sent).toEqual(["/model", ["enter"], ["3"], ["down", "down"], ["s"]]);
  });

  it("書きかけがあれば何も押さない", async () => {
    const sent: unknown[] = [];
    const herdr = { request: async (m: string, p: Record<string, unknown>) => (m === "pane.read" ? { read: { text: idle("GPT-5.6-Luna low", "書きかけ") } } : sent.push(p)) };
    const target = { provider: "codex", id: "gpt-5.6-luna", name: "GPT-5.6-Luna", providerName: "Codex", variants: ["low"] };
    expect((await switchCodexModel(herdr, "p", target, "low", null, async () => {})).ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
