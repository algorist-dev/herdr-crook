import { describe, expect, it } from "vitest";
import { createDefaultProviders } from "../../src/providers/defaults.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import type { AgentProvider, ChatSource } from "../../src/providers/types.ts";

const chat = (name: string, title: (key: string) => string | null = () => name): ChatSource => ({
  open: () => ({ poll: () => ({ chat: null }), close() {} }),
  title,
});

const claude: AgentProvider = { id: "claude", chatKey: (r) => r.sessionValue, chat: chat("claude") };
const codex: AgentProvider = { id: "codex", chatKey: (_, cwd) => (cwd ? `codex:${cwd}` : null), chat: chat("codex") };
const plain: AgentProvider = { id: "plain", chatKey: () => null };

describe("ProviderRegistry", () => {
  const registry = new ProviderRegistry([claude, codex, plain]);

  it("登録した名前でプロバイダを返し、null や知らない名前には null", () => {
    expect(registry.get("codex")).toBe(codex);
    expect(registry.get(null)).toBeNull();
    expect(registry.get(undefined)).toBeNull();
    expect(registry.get("gemini")).toBeNull();
    expect(registry.all().map((p) => p.id)).toEqual(["claude", "codex", "plain"]);
  });

  it("chatKey は登録したプロバイダに任せる", () => {
    expect(registry.chatKey({ agent: "codex", sessionSource: null, sessionValue: null }, "/repo")).toBe("codex:/repo");
    expect(registry.chatKey({ agent: "claude", sessionSource: null, sessionValue: "sess-1" }, null)).toBe("sess-1");
  });

  it("知らないエージェントでも、Herdr が Claude のセッションだと言っていればその ID", () => {
    expect(registry.chatKey({ agent: "gemini", sessionSource: "herdr:claude", sessionValue: "sess-9" }, "/repo")).toBe("sess-9");
    expect(registry.chatKey({ agent: "gemini", sessionSource: "herdr:gemini", sessionValue: "sess-9" }, "/repo")).toBeNull();
    expect(registry.chatKey({ agent: null, sessionSource: "herdr:claude", sessionValue: null }, "/repo")).toBeNull();
  });

  it("会話の部品：自分のもの → なければ chatId があるときだけ Claude のもの", () => {
    expect(registry.chatSourceFor({ agent: "codex", chatId: "codex:/repo" })).toBe(codex.chat);
    expect(registry.chatSourceFor({ agent: "plain", chatId: "sess-1" })).toBe(claude.chat);
    expect(registry.chatSourceFor({ agent: null, chatId: "sess-1" })).toBe(claude.chat);
    expect(registry.chatSourceFor({ agent: "plain", chatId: null })).toBeNull();
    expect(registry.chatSourceFor({ agent: null, chatId: null })).toBeNull();
  });

  it("題名：会話の部品の title。投げたら null", () => {
    expect(registry.title("codex", "codex:/repo")).toBe("codex");
    const broken = new ProviderRegistry([{ id: "x", chatKey: () => null, chat: chat("x", () => { throw new Error("読めない"); }) }]);
    expect(broken.title("x", "k")).toBeNull();
    expect(new ProviderRegistry([]).title("x", "k")).toBeNull();
  });

  it("同じ名前のプロバイダを 2 つ入れると止まる", () => {
    expect(() => new ProviderRegistry([plain, { ...plain }])).toThrow();
  });

  it("確認なしの引数：プロバイダごとの引数。知らない名前や null は null", () => {
    const registry = createDefaultProviders();
    expect(registry.unattendedArgs("claude")).toEqual(["--dangerously-skip-permissions"]);
    expect(registry.unattendedArgs("codex")).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(registry.unattendedArgs("opencode")).toEqual(["--auto"]);
    expect(registry.unattendedArgs("copilot")).toEqual(["--allow-all"]);
    expect(registry.unattendedArgs("gemini")).toBeNull();
    expect(registry.unattendedArgs(null)).toBeNull();
    expect(registry.unattendedArgs(undefined)).toBeNull();
  });
});
