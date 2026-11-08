import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAlias, effortOnScreen, isSwitchConfirmation, lastModelInTranscript, matchClaudeModel, modelApplied, parseClaudeModelList, switchClaudeModel } from "../src/providers/claude/models.ts";

describe("Claude のモデル", () => {
  it("会話の記録のモデルの名前から /model の別名", () => {
    expect(claudeAlias("claude-opus-5-5")).toBe("opus");
    expect(claudeAlias("claude-sonnet-5-5")).toBe("sonnet");
    expect(claudeAlias("claude-fable-5-1")).toBe("fable");
    expect(claudeAlias(null)).toBeNull();
  });

  it("会話の記録から、いちばん新しい返事のモデルを読む（<synthetic> は飛ばす）", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hm-cm-")), "s.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } }),
      JSON.stringify({ type: "user", message: { content: "x" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5" } }),
      JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }),
    ].join("\n"));
    expect(lastModelInTranscript(path)).toBe("claude-sonnet-5-5");
    expect(lastModelInTranscript("/no/such")).toBeNull();
  });
});

describe("Claude のモデル（一覧と切り替え）", () => {
  const line = JSON.stringify({ type: "control_response", response: { subtype: "success", response: { models: [
    { value: "default", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "opus", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
    { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
    { value: "claude-opus-5-5", displayName: "Opus 5.5 (full)" },
  ] } } });

  it("claude 本体が答えた一覧を読む（考える量が選べないモデルは空）", () => {
    const list = parseClaudeModelList(`{"type":"system"}\n${line}\n`);
    expect(list.map((m) => [m.id, m.name, m.variants])).toEqual([
      ["default", "おすすめ（既定）", ["low", "high"]],
      ["opus", "Opus 5.5", ["low", "high", "max"]],
      ["claude-haiku-4-5-20251001", "Haiku 4.5", []],
      ["claude-opus-5-5", "Opus 5.5 (full)", []],
    ]);
  });

  it("会話の記録のモデルを一覧に合わせる（別名を先に。日付つきの名前も）", () => {
    const list = parseClaudeModelList(line);
    expect(matchClaudeModel(list, "claude-opus-5-5")?.id).toBe("opus");
    expect(matchClaudeModel(list, "claude-haiku-4-5-20251001")?.id).toBe("claude-haiku-4-5-20251001");
    expect(matchClaudeModel(list, null)).toBeNull();
  });

  it("画面の右の「◐ medium · /effort」から考える量を読む", () => {
    expect(effortOnScreen("   text\n                     ◐ medium · /effort\n───")).toBe("medium");
    expect(effortOnScreen("                     ● high · /effort")).toBe("high");
    expect(effortOnScreen("nothing")).toBeNull();
  });

  it("切り替えの確認を見分ける", () => {
    expect(isSwitchConfirmation("Switch model?\n This conversation is cached for the current model.")).toBe(true);
    expect(modelApplied("⎿  Set model to Sonnet 5.5 (default)", "Sonnet 5.5")).toBe(true);
    expect(modelApplied("Kept model as Opus", "Sonnet 5.5")).toBe(false);
  });

  const box = "\n" + "─".repeat(40) + "\n❯ \n" + "─".repeat(40) + "\n  Opus 5.5 · status";
  function fake(after: string[]) {
    const sent: unknown[] = [];
    let screen = "old text" + box;
    let i = 0;
    return {
      sent,
      herdr: {
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === "pane.read") return { read: { text: screen } };
          sent.push(params.text ?? params.keys);
          if (method === "agent.prompt" && String(params.text).startsWith("/model")) screen = after[i++] ?? screen;
          if (method === "pane.send_keys") screen = after[i++] ?? screen;
          return {};
        },
      },
    };
  }
  const opus = { provider: "claude", id: "opus", name: "Opus 5.5", providerName: "Claude", variants: ["high", "max"] };

  it("確認が出たら Enter で進め、「Set model to」を見てから /effort を送る", async () => {
    const f = fake(["Switch model?\nThis conversation is cached for the current model", "⎿ Set model to Opus 5.5" + box]);
    expect(await switchClaudeModel(f.herdr, "p", opus, "max", async () => {})).toEqual({ ok: true });
    expect(f.sent).toEqual(["/model opus", ["enter"], "/effort max"]);
  });

  it("書きかけの文章や、いつもの入力の画面でないときは何も送らない", async () => {
    const draft = fake([]);
    const sentDraft = draft.sent;
    (draft.herdr as { request: (m: string, p: Record<string, unknown>) => Promise<unknown> }).request = async (m, p) => {
      if (m === "pane.read") return { read: { text: "─".repeat(40) + "\n❯ 書きかけ\n" + "─".repeat(40) } };
      sentDraft.push(p.text ?? p.keys);
      return {};
    };
    expect((await switchClaudeModel(draft.herdr, "p", opus, "max", async () => {})).ok).toBe(false);
    expect(sentDraft).toEqual([]);
    const dialog = { request: async () => ({ read: { text: "Resume a conversation\n  ❯ session 1" } }) };
    expect((await switchClaudeModel(dialog, "p", opus, null, async () => {})).ok).toBe(false);
  });

  it("前から画面に残っている「Switch model?」には反応しない", async () => {
    const sent: unknown[] = [];
    let screen = "Switch model?\nThis conversation is cached for the current model" + box;
    const herdr = {
      request: async (m: string, p: Record<string, unknown>) => {
        if (m === "pane.read") return { read: { text: screen } };
        sent.push(p.text ?? p.keys);
        return {};
      },
    };
    expect((await switchClaudeModel(herdr, "p", opus, null, async () => {})).ok).toBe(false);
    expect(sent).toEqual([]);
    void screen;
    screen = "";
  });

  it("「Kept model as」なら断られたとして、/effort は送らない", async () => {
    const f = fake(["⎿ Kept model as Sonnet" + box]);
    expect((await switchClaudeModel(f.herdr, "p", opus, "max", async () => {})).ok).toBe(false);
    expect(f.sent).toEqual(["/model opus"]);
  });
});
