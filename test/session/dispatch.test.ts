import { describe, expect, it } from "vitest";
import { dispatch } from "../../src/session/dispatch.ts";
import type { AgentProvider } from "../../src/providers/types.ts";
import { fakeSession, paneFixture } from "../helpers/fakeSession.ts";

describe("dispatch", () => {
  it("形の合わない create には、待たせないように req 付きでわけを返す", async () => {
    const f = fakeSession();

    await dispatch(f.ctx, JSON.stringify({ t: "create", req: "r4", cwd: "src/api" }));

    expect(f.sent).toEqual([{ t: "error", req: "r4", message: "フォルダは / か ~ から書いてください" }]);
  });

  it("形の合わないものでも、req が無ければ何も送らない", async () => {
    const f = fakeSession();

    await dispatch(f.ctx, "{");
    await dispatch(f.ctx, JSON.stringify({ t: "create", cwd: "src/api" }));

    expect(f.sent).toEqual([]);
  });

  it("モデルを切り替えているペインへの入力は断る（何も Herdr に送らない）", async () => {
    const f = fakeSession();
    f.ctx.services.modelSwitching.add("w1:p1");

    for (const raw of [
      { t: "prompt", pane: "w1:p1", text: "hi" },
      { t: "keys", pane: "w1:p1", keys: ["esc"] },
      { t: "answer", pane: "w1:p1", key: "1", expect: "0000000000000000" },
      { t: "attach", pane: "w1:p1", images: ["aGk="] },
    ]) {
      await dispatch(f.ctx, JSON.stringify(raw));
    }

    expect(f.sent).toEqual(
      Array.from({ length: 4 }, () => ({ t: "error", message: "モデルを切り替えているところです。少し待ってから送ってください" })),
    );
    expect(f.herdrCalls).toEqual([]);
    expect(f.announced).toEqual([]);
  });

  it("切り替えていないペインへの入力は、そのままハンドラに渡す", async () => {
    const f = fakeSession();

    await dispatch(f.ctx, JSON.stringify({ t: "keys", pane: "w1:p1", keys: ["esc"] }));

    expect(f.herdrCalls).toEqual([{ method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["esc"] } }]);
  });

  it("ハンドラが投げたら、describeError の文を error にして送る", async () => {
    const provider: AgentProvider = {
      id: "p",
      chatKey: () => null,
      models: {
        async list() {
          return { current: null, variant: null, recent: [], models: [] };
        },
        async switch() {
          throw new Error("こわれた");
        },
      },
    };
    const f = fakeSession({ providers: [provider], panes: [paneFixture({ agent: "p" })] });

    await dispatch(f.ctx, JSON.stringify({ t: "setModel", pane: "w1:p1", provider: "p", model: "m", variant: null }));

    expect(f.sent).toEqual([{ t: "error", message: "こわれた" }]);
    // 切り替え中の印は、投げても残さない
    expect(f.ctx.services.modelSwitching.has("w1:p1")).toBe(false);
  });

  it("ping には pong を返す", async () => {
    const f = fakeSession();

    await dispatch(f.ctx, JSON.stringify({ t: "ping" }));

    expect(f.sent).toEqual([{ t: "pong" }]);
  });

  it("push は、つながっている端末の宛先として覚える", async () => {
    const calls: { device: string; token: string | null; env: string }[] = [];
    const f = fakeSession({
      deps: {
        store: {
          redeem: () => ({ ok: false, reason: "invalid_code" }),
          verify: () => null,
          isActive: () => true,
          markSeen: () => {},
          setPush: (device, token, env) => void calls.push({ device, token, env }),
        },
      },
    });
    const token = "ab".repeat(32);

    await dispatch(f.ctx, JSON.stringify({ t: "push", token, env: "sandbox" }));

    expect(calls).toEqual([{ device: "device-1", token, env: "sandbox" }]);
  });

  it("push に prefs があれば、端末の push に残す", async () => {
    const calls: { device: string; token: string; env: string; prefs?: unknown }[] = [];
    const f = fakeSession({
      deps: {
        store: {
          redeem: () => ({ ok: false, reason: "invalid_code" }),
          verify: () => null,
          isActive: () => true,
          markSeen: () => {},
          setPush: (device, token: string | null, env, prefs) => void calls.push({ device, token: token ?? "", env, prefs }),
        },
      },
    });
    const token = "ab".repeat(32);
    const prefs = { enabled: false, mutedWorkspaces: ["w1"] };
    await dispatch(
      f.ctx,
      JSON.stringify({ t: "push", token, env: "production", prefs }),
    );
    expect(calls).toEqual([
      {
        device: "device-1",
        token,
        env: "production",
        // 無いキーは既定（parseNotificationPrefs）
        prefs: { ...prefs, onlyWhenAway: true, onlyNeedsInput: false, sound: true, suppressFocused: true, quiet: null, remindAfterMinutes: null },
      },
    ]);
  });

  it("pushTest：試しを頼んで pushTested でこたえる", async () => {
    const f = fakeSession({
      deps: {
        store: {
          redeem: () => ({ ok: false, reason: "invalid_code" }),
          verify: () => null,
          isActive: () => true,
          markSeen: () => {},
        },
        pushTest: async () => ({ ok: true, reason: "試しの通知を送りました" }),
      },
    });
    await dispatch(f.ctx, JSON.stringify({ t: "pushTest" }));
    expect(f.sent).toEqual([{ t: "pushTested", ok: true, message: "試しの通知を送りました" }]);
  });

  it("pushTest：試しを頼めない側（礫のない Mac）は、送らなかった Boys とこたえる", async () => {
    const f = fakeSession();
    await dispatch(f.ctx, JSON.stringify({ t: "pushTest" }));
    expect(f.sent).toEqual([{ t: "pushTested", ok: false, message: "試しの通知を送れませんでした" }]);
  });
});
