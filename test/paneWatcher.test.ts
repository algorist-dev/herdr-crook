import { afterEach, describe, expect, it } from "vitest";
import { HerdrClient } from "../src/herdr/herdrClient.ts";
import { PaneWatcher, type WatchState } from "../src/herdr/paneWatcher.ts";
import { FakeHerdr } from "./fakeHerdr.ts";
import { waitFor } from "./herdrClient.test.ts";

let fake: FakeHerdr | null = null;
let watcher: PaneWatcher | null = null;
afterEach(async () => {
  watcher?.stop();
  await fake?.close();
  fake = null;
  watcher = null;
});

function snapshotWith(status: string) {
  return {
    type: "session_snapshot",
    snapshot: {
      workspaces: [{ workspace_id: "w1", label: "api" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: status }],
      agents: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: status }],
    },
  };
}

function snapshotOf(panes: "agent" | "terminal" | "none") {
  return {
    type: "session_snapshot",
    snapshot: {
      workspaces: [{ workspace_id: "w1", label: "api" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
      panes: panes === "none" ? [] : [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle" }],
      agents:
        panes === "agent"
          ? [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "idle" }]
          : [],
    },
  };
}

describe("PaneWatcher", () => {
  it("はじめに一覧を読み、ペインごとの状態の変化を購読する", async () => {
    fake = new FakeHerdr((req) => (req.method === "session.snapshot" ? snapshotWith("working") : undefined));
    await fake.listen();
    watcher = new PaneWatcher(new HerdrClient(fake.path), { pollMs: 10_000, debounceMs: 5 });
    const states: WatchState[] = [];
    watcher.on("change", (s: WatchState) => states.push(s));
    watcher.start();
    await waitFor(() => states.length > 0 && fake!.subscribers.length > 0);
    expect(states[0]?.herdr).toBe(true);
    expect(states[0]?.panes[0]?.status).toBe("working");
    const sub = fake.requests.find((r) => r.method === "events.subscribe");
    expect(sub?.params.subscriptions).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
    expect(sub?.params.subscriptions).toContainEqual({ type: "pane.created" });
  });

  it("イベントが来たら読み直し、変わったときだけ知らせる", async () => {
    let status = "working";
    fake = new FakeHerdr((req) => (req.method === "session.snapshot" ? snapshotWith(status) : undefined));
    await fake.listen();
    watcher = new PaneWatcher(new HerdrClient(fake.path), { pollMs: 10_000, debounceMs: 5 });
    const states: WatchState[] = [];
    watcher.on("change", (s: WatchState) => states.push(s));
    watcher.start();
    await waitFor(() => fake!.subscribers.length > 0);
    fake.emit("pane_updated", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(states.length).toBe(1);
    status = "blocked";
    fake.emit("pane_agent_status_changed", {});
    await waitFor(() => states.length === 2);
    expect(states[1]?.panes[0]?.status).toBe("blocked");
  });

  it("状態が変わった時刻を覚えて since に入れる。変わらなければ同じ時刻のまま", async () => {
    let status = "working";
    fake = new FakeHerdr((req) => (req.method === "session.snapshot" ? snapshotWith(status) : undefined));
    await fake.listen();
    let clock = 1000;
    watcher = new PaneWatcher(new HerdrClient(fake.path), { pollMs: 10_000, debounceMs: 5, now: () => clock });
    const states: WatchState[] = [];
    watcher.on("change", (s: WatchState) => states.push(s));
    watcher.start();
    await waitFor(() => fake!.subscribers.length > 0);
    expect(states[0]?.panes[0]?.since).toBe(1000);
    clock = 5000;
    status = "blocked";
    fake.emit("pane_agent_status_changed", {});
    await waitFor(() => states.length === 2);
    expect(states[1]?.panes[0]?.since).toBe(5000);
  });

  it("確認なしで立ち上げた印を覚え、一覧から消えたら忘れる", async () => {
    let mode: "agent" | "terminal" | "none" = "agent";
    fake = new FakeHerdr((req) => (req.method === "session.snapshot" ? snapshotOf(mode) : undefined));
    await fake.listen();
    watcher = new PaneWatcher(new HerdrClient(fake.path), { pollMs: 10_000, debounceMs: 5 });
    const states: WatchState[] = [];
    watcher.on("change", (s: WatchState) => states.push(s));
    watcher.start();
    await waitFor(() => states.length > 0 && states.at(-1)?.panes[0]?.unattended === false);

    watcher.markUnattended("w1:p1");
    await waitFor(() => states.at(-1)?.panes[0]?.unattended === true);

    mode = "none";
    fake.emit("pane_updated", {});
    await waitFor(() => states.at(-1)?.panes.length === 0);

    mode = "agent";
    fake.emit("pane_updated", {});
    await waitFor(() => states.at(-1)?.panes.length === 1);
    expect(states.at(-1)?.panes[0]?.unattended).toBe(false);
  });

  it("エージェントでなくなった（ターミナルになった）ら印を忘れる", async () => {
    let mode: "agent" | "terminal" = "agent";
    fake = new FakeHerdr((req) => (req.method === "session.snapshot" ? snapshotOf(mode) : undefined));
    await fake.listen();
    watcher = new PaneWatcher(new HerdrClient(fake.path), { pollMs: 10_000, debounceMs: 5 });
    const states: WatchState[] = [];
    watcher.on("change", (s: WatchState) => states.push(s));
    watcher.start();
    await waitFor(() => states.length > 0);
    watcher.markUnattended("w1:p1");
    await waitFor(() => states.at(-1)?.panes[0]?.unattended === true);

    mode = "terminal";
    fake.emit("pane_updated", {});
    await waitFor(() => states.at(-1)?.panes[0]?.kind === "terminal");
    expect(states.at(-1)?.panes[0]?.unattended).toBe(false);

    mode = "agent";
    fake.emit("pane_updated", {});
    await waitFor(() => states.at(-1)?.panes[0]?.kind === "agent");
    expect(states.at(-1)?.panes[0]?.unattended).toBe(false);
  });

  it("Herdr が一時的に止まっても、確認なしの印は残る", async () => {
    let down = false;
    fake = new FakeHerdr((req) => {
      if (req.method !== "session.snapshot") return undefined;
      if (down) return new Error("down");
      return snapshotOf("agent");
    });
    await fake.listen();
    watcher = new PaneWatcher(new HerdrClient(fake.path), { pollMs: 10_000, debounceMs: 5 });
    const states: WatchState[] = [];
    watcher.on("change", (s: WatchState) => states.push(s));
    watcher.start();
    await waitFor(() => states.length > 0);
    watcher.markUnattended("w1:p1");
    await waitFor(() => states.at(-1)?.panes[0]?.unattended === true);

    down = true;
    watcher.poke();
    await waitFor(() => states.at(-1)?.herdr === false);

    down = false;
    watcher.poke();
    await waitFor(() => states.at(-1)?.herdr === true);
    expect(states.at(-1)?.panes[0]?.unattended).toBe(true);
  });

  it("Herdr が止まったら herdr: false にし、また動いたら戻る", async () => {
    fake = new FakeHerdr((req) => (req.method === "session.snapshot" ? snapshotWith("idle") : undefined));
    await fake.listen();
    const path = fake.path;
    watcher = new PaneWatcher(new HerdrClient(path), { pollMs: 30, debounceMs: 5 });
    const states: WatchState[] = [];
    watcher.on("change", (s: WatchState) => states.push(s));
    watcher.start();
    await waitFor(() => states.length === 1);
    await fake.close();
    await waitFor(() => states.at(-1)?.herdr === false);
    expect(watcher.current().panes).toEqual([]);
  });
});
