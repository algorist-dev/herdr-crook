import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "../../src/herdr/agents.ts";
import { HerdrClient } from "../../src/herdr/herdrClient.ts";
import { PaneWatcher, type WatchState } from "../../src/herdr/paneWatcher.ts";
import { createDefaultProviders, defaultProviders } from "../../src/providers/defaults.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import type { AgentProvider, HerdrAgentRecord, ProviderPaneContext } from "../../src/providers/types.ts";
import type { AgentModel } from "../../src/providers/types.ts";
import { builtinSlashCommands } from "../../src/features/slashCommands.ts";
import { FakeHerdr } from "../fakeHerdr.ts";
import { waitFor } from "../herdrClient.test.ts";
import { paneFixture } from "../helpers/fakeSession.ts";

const model: AgentModel = {
  provider: "claude",
  id: "sonnet",
  name: "Sonnet",
  providerName: "Claude",
  variants: ["high"],
};

function ctxOf(agent = "claude", screen = ""): ProviderPaneContext {
  const pane = paneFixture({ agent });
  return {
    paneId: pane.paneId,
    pane,
    herdr: { request: async () => ({}) },
    readScreen: async () => screen,
    wait: async () => {},
    poke: () => {},
    log: () => {},
  };
}

let fake: FakeHerdr | null = null;
let watcher: PaneWatcher | null = null;
afterEach(async () => {
  watcher?.stop();
  await fake?.close();
  fake = null;
  watcher = null;
});

describe("createDefaultProviders", () => {
  it("4 つのエージェントを、いまの名前で入れる", () => {
    const registry = createDefaultProviders();

    expect(registry.all().map((p) => p.id)).toEqual(["claude", "codex", "opencode", "copilot"]);
  });

  it("渡したオプションを、そのエージェントのプロバイダに使わせる", async () => {
    const registry = createDefaultProviders({ claude: { models: async () => [model] } });

    const listing = await registry.get("claude")!.models!.list(ctxOf());

    expect(listing.models).toEqual([model]);
  });

  it("何も渡さないときのものは 1 つだけ（はじめて呼ばれたときに作る）", () => {
    expect(defaultProviders()).toBe(defaultProviders());
    expect(defaultProviders().all().map((p) => p.id)).toEqual(["claude", "codex", "opencode", "copilot"]);
  });

  it("既定のプロバイダが「/」のコマンドを持つ（slashCommands から呼べる）", () => {
    expect(defaultProviders().get("claude")!.builtinCommands!().map((c) => c.name)).toEqual([
      "clear",
      "compact",
      "init",
      "review",
      "help",
    ]);
    expect(builtinSlashCommands("claude").map((c) => c.name)).toEqual(["clear", "compact", "init", "review", "help"]);
  });

  it("Mac のファイルからコマンドを集める中身も、プロバイダ側にある", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-defaults-"));
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(join(home, ".claude", "commands", "deploy.md"), "---\ndescription: 本番に出す\n---\n");

    expect(defaultProviders().get("claude")!.discoverCommands!(null, home, {})).toEqual([
      { name: "deploy", summary: "本番に出す", kind: "command" },
    ]);
  });
});

describe("エージェントの分岐を共有ファイルから外したあとの入り口", () => {
  it("summarize は 4 つ目の chatKeyOf で chatId を作る", () => {
    const seen: { record: HerdrAgentRecord; cwd: string | null }[] = [];
    const list = summarize(
      {
        panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo/app" }],
        agents: [
          {
            pane_id: "w1:p1",
            agent: "gemini",
            agent_status: "idle",
            agent_session: { source: "herdr:claude", value: "sess-1" },
          },
        ],
      },
      () => null,
      () => null,
      (record, cwd) => {
        seen.push({ record, cwd });
        return `custom:${cwd}`;
      },
    );

    expect(list[0]?.chatId).toBe("custom:/repo/app");
    expect(seen[0]).toEqual({
      record: { agent: "gemini", sessionSource: "herdr:claude", sessionValue: "sess-1" },
      cwd: "/repo/app",
    });
  });

  it("chatTitleOf には chatId とエージェントの種類を渡す", () => {
    let got: [string, string | null] | null = null;
    summarize(
      {
        panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo/app" }],
        agents: [
          {
            pane_id: "w1:p1",
            agent: "gemini",
            agent_status: "idle",
            agent_session: { source: "herdr:claude", value: "sess-1" },
          },
        ],
      },
      () => null,
      (chatId, agent) => {
        got = [chatId, agent];
        return "題名";
      },
    );

    expect(got).toEqual(["sess-1", "gemini"]);
  });

  it("PaneWatcher は題名を providers.title に聞く", async () => {
    fake = new FakeHerdr((req) =>
      req.method === "session.snapshot"
        ? {
            snapshot: {
              panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo/app" }],
              agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }],
            },
          }
        : undefined,
    );
    await fake.listen();
    const asked: string[] = [];
    const provider: AgentProvider = {
      id: "claude",
      chatKey: () => "sess-1",
      chat: {
        open: () => ({ poll: () => ({ chat: null }), close: () => {} }),
        title: (chatId) => {
          asked.push(chatId);
          return "認証を直す";
        },
      },
    };
    watcher = new PaneWatcher(new HerdrClient(fake.path), {
      pollMs: 10_000,
      debounceMs: 5,
      providers: new ProviderRegistry([provider]),
    });
    const states: WatchState[] = [];
    watcher.on("change", (state: WatchState) => states.push(state));
    watcher.start();

    await waitFor(() => states.length > 0);
    expect(states[0]?.panes[0]).toMatchObject({ chatId: "sess-1", chatTitle: "認証を直す" });
    expect(asked).toContain("sess-1");
  });
});
