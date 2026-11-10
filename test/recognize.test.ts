import { describe, expect, it } from "vitest";
import { addRecognizedAgents } from "../src/herdr/recognize.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import type { AgentProvider } from "../src/providers/types.ts";

const thing: AgentProvider = {
  id: "thing",
  chatKey: () => null,
  recognize: {
    sessionSource: "herdr:thing",
    isRunning: (ps) => ps.some((p) => p.argv.some((a) => a.includes("thing_main"))),
  },
};
const registry = new ProviderRegistry([thing]);
const withScreen = new ProviderRegistry([
  { ...thing, recognize: { ...thing.recognize!, statusFromScreen: (screen: string) => (screen.includes("ASK") ? "blocked" : null) } },
]);

const pane = (id: string, session: object | null) => ({
  pane_id: id,
  workspace_id: "w1",
  cwd: "/repo",
  ...(session ? { agent_session: session } : {}),
});
const running = { process_info: { foreground_processes: [{ name: "python3.14", argv: ["python3", "-I", "-c", "from thing_main import main"] }] } };
const shell = { process_info: { foreground_processes: [{ name: "zsh", argv: ["-zsh"] }] } };

describe("Herdr が見分けないエージェントを足す", () => {
  it("報告があり、前のプロセスがそのエージェントなら agents に足す（状態は unknown）", async () => {
    const asked: string[] = [];
    const snap = {
      panes: [pane("w1:p1", { source: "herdr:thing", value: "s1" }), pane("w1:p2", null)],
      agents: [],
    };
    const out = (await addRecognizedAgents(snap, registry, async (_m, p) => (asked.push(p.pane_id as string), running), new Map(), 0)) as {
      agents: Record<string, unknown>[];
    };
    expect(out.agents).toEqual([expect.objectContaining({ pane_id: "w1:p1", agent: "thing", agent_status: "unknown", cwd: "/repo" })]);
    expect(asked).toEqual(["w1:p1"]);
    expect(snap.agents).toEqual([]);
  });

  it("報告が残っていても、終わったあと（前がシェル）なら足さない", async () => {
    const snap = { panes: [pane("w1:p1", { source: "herdr:thing", value: "s1" })], agents: [] };
    const out = (await addRecognizedAgents(snap, registry, async () => shell, new Map(), 0)) as { agents: unknown[] };
    expect(out.agents).toEqual([]);
  });

  it("Herdr がもう見分けているペイン・知らない報告は聞かない", async () => {
    const asked: string[] = [];
    const snap = {
      panes: [pane("w1:p1", { source: "herdr:thing", value: "s1" }), pane("w1:p2", { source: "herdr:other", value: "x" })],
      agents: [{ pane_id: "w1:p1", agent: "thing", agent_status: "working" }],
    };
    const out = await addRecognizedAgents(snap, registry, async (_m, p) => (asked.push(p.pane_id as string), running), new Map(), 0);
    expect(asked).toEqual([]);
    expect(out).toBe(snap);
  });

  it("プロセスは 5 秒は聞き直さない。会話が替わったら聞き直す。聞けなければ足さない", async () => {
    let calls = 0;
    const cache = new Map();
    const req = async () => (calls++, running);
    const snap = (value: string) => ({ panes: [pane("w1:p1", { source: "herdr:thing", value })], agents: [] });
    await addRecognizedAgents(snap("s1"), registry, req, cache, 0);
    await addRecognizedAgents(snap("s1"), registry, req, cache, 4_000);
    expect(calls).toBe(1);
    await addRecognizedAgents(snap("s2"), registry, req, cache, 4_500);
    expect(calls).toBe(2);
    await addRecognizedAgents(snap("s2"), registry, req, cache, 10_000);
    expect(calls).toBe(3);
    const failed = (await addRecognizedAgents(snap("s3"), registry, async () => {
      throw new Error("no");
    }, cache, 20_000)) as { agents: unknown[] };
    expect(failed.agents).toEqual([]);
  });

  it("聞けなかったときは前の答えのまま（一覧で行ったり来たりしない）", async () => {
    const cache = new Map();
    const snap = { panes: [pane("w1:p1", { source: "herdr:thing", value: "s1" })], agents: [] };
    await addRecognizedAgents(snap, registry, async () => running, cache, 0);
    const out = (await addRecognizedAgents(snap, registry, async () => {
      throw new Error("timeout");
    }, cache, 6_000)) as { agents: unknown[] };
    expect(out.agents).toHaveLength(1);
  });

  it("動いていないペインは 20 秒は聞き直さない", async () => {
    let calls = 0;
    const cache = new Map();
    const snap = { panes: [pane("w1:p1", { source: "herdr:thing", value: "s1" })], agents: [] };
    await addRecognizedAgents(snap, registry, async () => (calls++, shell), cache, 0);
    await addRecognizedAgents(snap, registry, async () => (calls++, shell), cache, 10_000);
    expect(calls).toBe(1);
    await addRecognizedAgents(snap, registry, async () => (calls++, shell), cache, 21_000);
    expect(calls).toBe(2);
  });

  it("画面から承認待ちが分かれば blocked にする", async () => {
    const snap = { panes: [pane("w1:p1", { source: "herdr:thing", value: "s1" })], agents: [] };
    const ask = async (m: string) => (m === "pane.read" ? { read: { text: "... ASK ..." } } : running);
    const calm = async (m: string) => (m === "pane.read" ? { read: { text: "prompt" } } : running);
    const a = (await addRecognizedAgents(snap, withScreen, ask, new Map(), 0)) as { agents: Record<string, unknown>[] };
    const b = (await addRecognizedAgents(snap, withScreen, calm, new Map(), 0)) as { agents: Record<string, unknown>[] };
    expect(a.agents[0]?.agent_status).toBe("blocked");
    expect(b.agents[0]?.agent_status).toBe("unknown");
  });
});
