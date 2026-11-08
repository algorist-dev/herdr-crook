import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexProvider } from "../../src/providers/codex/index.ts";
import type { ProviderPaneContext } from "../../src/providers/types.ts";
import type { AgentModel } from "../../src/providers/types.ts";

const line = (o: object) => JSON.stringify(o) + "\n";
const user = (text: string) => line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

const idle = (status: string) =>
  `  >_ OpenAI Codex (v0.167.0)\n\n› Ask Codex to do anything\n\n  ${status} · /private/tmp\n  ← for agents · ? for shortcuts      ⚠ 1 warning · f2 to view`;
const modelScreen = [
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

const target: AgentModel = {
  provider: "codex",
  id: "gpt-5.6-luna",
  name: "GPT-5.6-Luna",
  providerName: "Codex",
  variants: ["low", "medium", "high"],
};

function ctx(over: Partial<ProviderPaneContext> & { screen?: string } = {}): ProviderPaneContext {
  return {
    paneId: "w1:p1",
    pane: { paneId: "w1:p1", agent: "codex", chatId: "codex:/repo" } as ProviderPaneContext["pane"],
    herdr: { request: async () => ({}) },
    readScreen: async () => over.screen ?? "",
    wait: async () => {},
    poke: () => {},
    log: () => {},
    ...over,
  };
}

function rollout(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-codex-prov-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-a.jsonl");
  writeFileSync(path, line({ type: "session_meta", payload: { cwd: "/repo" } }) + user(text));
  return path;
}

describe("Codex のプロバイダ", () => {
  it("chatKey は作業フォルダから codex:<フォルダ> を作る", () => {
    const p = createCodexProvider();
    expect(p.chatKey({ agent: "codex", sessionSource: null, sessionValue: null }, "/repo")).toBe("codex:/repo");
    expect(p.chatKey({ agent: "codex", sessionSource: null, sessionValue: null }, null)).toBeNull();
  });

  it("chat は作業フォルダの rollout を読み、増えた分を返す", () => {
    const path = rollout("直して");
    const p = createCodexProvider({ findRollout: (cwd) => (cwd === "/repo" ? path : null) });
    const stream = p.chat!.open(() => "codex:/repo");
    const first = stream.poll();
    expect(first.chat).toMatchObject({ available: true, reset: true, title: "直して", items: [{ text: "直して" }] });
    expect(stream.poll().chat).toBeNull();
  });

  it("title は題名を返し、rollout がまだなら null", () => {
    const path = rollout("題名になる");
    const p = createCodexProvider({ findRollout: () => path });
    expect(p.chat!.title("codex:/repo")).toBe("題名になる");
    const none = createCodexProvider({ findRollout: () => null });
    expect(none.chat!.title("codex:/repo")).toBeNull();
  });

  it("models.list は画面の状態行から current と variant を出す", async () => {
    const models = [target];
    const p = createCodexProvider({ models: () => models });
    const got = await p.models!.list(ctx({ screen: idle("GPT-5.6-Luna low") }));
    expect(got).toEqual({ current: { provider: "codex", id: "gpt-5.6-luna" }, variant: "low", recent: [], models });
  });

  it("models.switch は一覧に無いモデルを文言で断る", async () => {
    const p = createCodexProvider({ models: () => [target] });
    const got = await p.models!.switch(ctx(), { provider: "codex", model: "nope", variant: null });
    expect(got).toEqual({ ok: false, current: null, variant: null, message: "そのモデルは Mac の Codex にありません" });
  });

  it("models.switch は成功すると、切り替えたモデルと考える量を返す", async () => {
    const state = { screen: idle("GPT-5.6-Luna low"), cursor: 0 };
    const herdr = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "pane.read") return { read: { text: state.screen } };
        const k = params.keys as string[] | undefined;
        if (k?.[0] === "enter") state.screen = modelScreen;
        else if (k?.[0] === "3") state.screen = levels(0);
        else if (k?.[0] === "down") {
          state.cursor += k.length;
          state.screen = levels(state.cursor);
        } else if (k?.[0] === "s") state.screen = idle("GPT-5.6-Luna high");
        return {};
      },
    };
    const p = createCodexProvider({ models: () => [target], defaultEffort: () => null });
    const got = await p.models!.switch(ctx({ herdr }), { provider: "codex", model: "gpt-5.6-luna", variant: "high" });
    expect(got).toEqual({ ok: true, current: { provider: "codex", id: "gpt-5.6-luna" }, variant: "high", message: null });
  });

  it("chat.toolDetail：cx の行から引数と結果を返す（結果がまだなら running）", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-cx-tool-"));
    const path = join(dir, "rollout-tool.jsonl");
    writeFileSync(path, line({ type: "session_meta", payload: { cwd: "/repo" } }));
    appendFileSync(path, line({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls", "-la"] }), call_id: "call1" } }));
    const p = createCodexProvider({ findRollout: () => path });
    expect(p.chat!.toolDetail!("codex:/repo", "cx1")).toEqual({
      running: true,
      error: false,
      sections: [{ label: "コマンド", style: "code", text: "ls -la", truncated: false }],
    });

    appendFileSync(path, line({ type: "response_item", payload: { type: "function_call_output", call_id: "call1", output: "file.txt" } }));
    expect(p.chat!.toolDetail!("codex:/repo", "cx1")).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "コマンド", style: "code", text: "ls -la", truncated: false },
        { label: "出力", style: "code", text: "file.txt", truncated: false },
      ],
    });
    expect(p.chat!.toolDetail!("codex:/repo", "cx99")).toBeNull();
  });

  it("chat.toolDetail：apply_patch はパッチの文字を diff にする", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-cx-patch-"));
    const path = join(dir, "rollout-patch.jsonl");
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
    writeFileSync(path, line({ type: "session_meta", payload: { cwd: "/repo" } }));
    appendFileSync(path, line({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: "call2" } }));
    const p = createCodexProvider({ findRollout: () => path });
    expect(p.chat!.toolDetail!("codex:/repo", "cx1")).toEqual({
      running: true,
      error: false,
      sections: [{ label: "変更", style: "diff", text: patch, truncated: false }],
    });
  });

  it("組み込みコマンドとファイルから集めるコマンドは Codex のもの", () => {
    const p = createCodexProvider();
    expect(p.builtinCommands!().map((c) => c.name)).toContain("model");
    expect(p.discoverCommands!("/nowhere", "/nowhere-home", {})).toEqual([]);
  });
});
