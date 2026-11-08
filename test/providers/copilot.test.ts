import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotProvider } from "../../src/providers/copilot/index.ts";

const line = (o: object) => JSON.stringify(o) + "\n";
const user = (id: string, text: string) => line({ type: "user.message", data: { messageId: id, content: text } });
const assistant = (id: string, text: string) => line({ type: "assistant.message", data: { messageId: id, content: text } });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hm-cp-provider-"));
  const events = join(dir, "events.jsonl");
  writeFileSync(events, "");
  let session: { path: string; title: string | null } | null = { path: events, title: "認証を直す" };
  const provider = createCopilotProvider({ find: (cwd) => (cwd === "/repo" ? session : null) });
  return {
    provider,
    events,
    setSession: (next: { path: string; title: string | null } | null) => void (session = next),
  };
}

describe("Copilot のプロバイダ", () => {
  it("chatKey：作業フォルダがあれば copilot:<フォルダ>、なければ null", () => {
    const { provider } = setup();
    expect(provider.id).toBe("copilot");
    expect(provider.chatKey({ agent: "copilot", sessionSource: null, sessionValue: null }, "/repo")).toBe("copilot:/repo");
    expect(provider.chatKey({ agent: "copilot", sessionSource: null, sessionValue: null }, null)).toBeNull();
  });

  it("chat：記録を読めて、増えた分だけが届く", () => {
    const { provider, events } = setup();
    const stream = provider.chat!.open(() => "copilot:/repo");

    expect(stream.poll().chat).toEqual({ available: true, reset: true, title: null, items: [] });

    appendFileSync(events, user("u1", "直して"));
    expect(stream.poll().chat).toEqual({
      available: true,
      reset: false,
      title: null,
      items: [{ id: "u1", role: "user", kind: "text", text: "直して" }],
    });

    appendFileSync(events, assistant("a1", "直しました"));
    expect(stream.poll().chat).toEqual({
      available: true,
      reset: false,
      title: null,
      items: [{ id: "a1", role: "assistant", kind: "text", text: "直しました" }],
    });

    expect(stream.poll().chat).toBeNull();
    stream.close();
  });

  it("chat：copilot: でない chatId や、まだ記録がないフォルダは読まない", () => {
    const { provider } = setup();
    const other = provider.chat!.open(() => "codex:/repo");
    expect(other.poll().chat).toEqual({ available: false, reset: true, title: null, items: [] });

    const missing = provider.chat!.open(() => "copilot:/nowhere");
    expect(missing.poll().chat).toEqual({ available: false, reset: true, title: null, items: [] });
  });

  it("title：そのフォルダの会話の題名。copilot: でなければ null", () => {
    const { provider, setSession } = setup();
    expect(provider.chat!.title("copilot:/repo")).toBe("認証を直す");
    expect(provider.chat!.title("codex:/repo")).toBeNull();
    setSession(null);
    expect(provider.chat!.title("copilot:/repo")).toBeNull();
    setSession({ path: "/tmp/events.jsonl", title: null });
    expect(provider.chat!.title("copilot:/repo")).toBeNull();
  });

  it("chat.toolDetail：toolRequests の引数と、あとの tool.execution_complete の結果", () => {
    const { provider, events } = setup();
    appendFileSync(
      events,
      line({
        type: "assistant.message",
        data: { messageId: "a1", content: "見ます", toolRequests: [{ name: "bash", arguments: { command: "ls" }, toolCallId: "t1" }] },
      }),
    );
    expect(provider.chat!.toolDetail!("copilot:/repo", "a1:t0")).toEqual({
      running: true,
      error: false,
      sections: [{ label: "コマンド", style: "code", text: "ls", truncated: false }],
    });

    appendFileSync(events, line({ type: "tool.execution_complete", data: { toolCallId: "t1", result: { content: "file.txt" } } }));
    expect(provider.chat!.toolDetail!("copilot:/repo", "a1:t0")).toEqual({
      running: false,
      error: false,
      sections: [
        { label: "コマンド", style: "code", text: "ls", truncated: false },
        { label: "出力", style: "code", text: "file.txt", truncated: false },
      ],
    });
    expect(provider.chat!.toolDetail!("copilot:/repo", "a9:t0")).toBeNull();
  });

  it("models は無い（切り替えはまだできない）", () => {
    const { provider } = setup();
    expect(provider.models).toBeUndefined();
  });

  it("/ の組み込みコマンドと、Mac の prompts のコマンドを返す", () => {
    const { provider } = setup();
    expect(provider.builtinCommands!().map((c) => c.name)).toEqual(["clear", "help"]);

    const home = mkdtempSync(join(tmpdir(), "hm-cp-home-"));
    const prompts = join(home, ".copilot", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "review.md"), "変更を見直す\n");
    const found = provider.discoverCommands!("/repo", home, {});
    expect(found.map((c) => c.name)).toEqual(["review"]);
  });
});
