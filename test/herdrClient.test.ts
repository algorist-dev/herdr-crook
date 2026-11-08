import { afterEach, describe, expect, it } from "vitest";
import { HerdrClient, HerdrError, resolveSocketPath } from "../src/herdr/herdrClient.ts";
import { FakeHerdr } from "./fakeHerdr.ts";

let fake: FakeHerdr | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe("resolveSocketPath", () => {
  it("HERDR_SOCKET_PATH → HERDR_SESSION → いつものセッション の順", () => {
    expect(resolveSocketPath({ HERDR_SOCKET_PATH: "/x.sock" }, "/home/u")).toBe("/x.sock");
    expect(resolveSocketPath({ HERDR_SESSION: "work" }, "/home/u")).toBe("/home/u/.config/herdr/sessions/work/herdr.sock");
    expect(resolveSocketPath({}, "/home/u")).toBe("/home/u/.config/herdr/herdr.sock");
  });

  it("セッション名にパスの区切りは使わせない", () => {
    expect(resolveSocketPath({ HERDR_SESSION: "../../etc" }, "/home/u")).toBe("/home/u/.config/herdr/herdr.sock");
  });
});

describe("HerdrClient", () => {
  it("リクエストを送って結果を受け取る", async () => {
    fake = new FakeHerdr((req) => (req.method === "ping" ? { type: "pong" } : undefined));
    await fake.listen();
    const client = new HerdrClient(fake.path);
    await expect(client.request("ping", {})).resolves.toEqual({ type: "pong" });
  });

  it("エラーは HerdrError にする", async () => {
    fake = new FakeHerdr(() => new Error("pane not found"));
    await fake.listen();
    const client = new HerdrClient(fake.path);
    await expect(client.request("pane.get", { pane_id: "w9:p9" })).rejects.toBeInstanceOf(HerdrError);
  });

  it("Herdr が動いていなければすぐ失敗する", async () => {
    const client = new HerdrClient("/nonexistent/herdr.sock");
    await expect(client.request("ping", {})).rejects.toThrow();
  });

  it("返事が来なければ時間切れにする", async () => {
    fake = new FakeHerdr(() => undefined);
    await fake.listen();
    const client = new HerdrClient(fake.path);
    await expect(client.request("ping", {}, 100)).rejects.toThrow(/timeout/);
  });

  it("イベントを購読して受け取る。切れたら知らせる", async () => {
    fake = new FakeHerdr(() => undefined);
    await fake.listen();
    const client = new HerdrClient(fake.path);
    const events: string[] = [];
    let closed = false;
    const sub = await client.subscribe([{ type: "pane.created" }], (e) => events.push(e.event), () => (closed = true));
    fake.emit("pane_created", { pane: { pane_id: "w1:p2" } });
    await waitFor(() => events.length === 1);
    expect(events).toEqual(["pane_created"]);
    fake.dropSubscribers();
    await waitFor(() => closed);
    sub.close();
  });
});

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
