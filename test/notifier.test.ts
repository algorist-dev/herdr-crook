import { describe, expect, it } from "vitest";
import type { PaneSummary } from "../src/herdr/agents.ts";
import { attentionEvents, attentionText, choicesFingerprint, machineHint, Notifier, Presence, replyCategory, type PushTarget } from "../src/notify/notifier.ts";
import { DEFAULT_PREFS } from "../src/notify/prefs.ts";

function pane(over: Partial<PaneSummary>): PaneSummary {
  return {
    paneId: "w1:p1",
    kind: "agent",
    label: "claude",
    agent: "claude",
    status: "working",
    title: null,
    workspace: "web",
    workspaceNumber: 1,
    tab: "1",
    folder: "web",
    cwd: "/Users/me/web",
    focused: false,
    stateChangeSeq: 1,
    workspaceId: "w1",
    cols: 80,
    rows: 24,
    since: null,
    chatId: null,
    chatTitle: null,
    caps: { chat: false, models: false },
    unattended: false,
    ...over,
  };
}

describe("attentionEvents", () => {
  it("最初の一覧では知らせない（起動したときに古い状態で鳴らない）", () => {
    expect(attentionEvents(null, [pane({ status: "blocked" })])).toEqual([]);
  });

  it("返事待ちになったら needs-input、作業中から終わったら finished", () => {
    const before = [pane({ paneId: "w1:a", status: "working" }), pane({ paneId: "w1:b", status: "working" })];
    const after = [pane({ paneId: "w1:a", status: "blocked" }), pane({ paneId: "w1:b", status: "done" })];
    const events = attentionEvents(before, after);
    expect(events.map((e) => [e.paneId, e.kind])).toEqual([
      ["w1:a", "needs-input"],
      ["w1:b", "finished"],
    ]);
  });

  it("ターミナル・新しく出てきたペイン・変わらないペインでは知らせない", () => {
    const before = [pane({ paneId: "w1:a", status: "blocked" }), pane({ paneId: "w1:t", kind: "terminal", agent: null, status: "working" })];
    const after = [
      pane({ paneId: "w1:a", status: "blocked" }),
      pane({ paneId: "w1:t", kind: "terminal", agent: null, status: "done" }),
      pane({ paneId: "w1:new", status: "blocked" }),
    ];
    expect(attentionEvents(before, after)).toEqual([]);
  });

  it("題名は Herdr の書き方（1:claude）とワークスペース、本文は会話の題名", () => {
    const [event] = attentionEvents([pane({ status: "working" })], [pane({ status: "blocked", chatTitle: "ログインを直す" })]);
    expect(attentionText(event!, "ja")).toEqual({ title: "1:claude · web", body: "返事を待っています — ログインを直す" });
    const [done] = attentionEvents([pane({ status: "working" })], [pane({ status: "done", tab: "2", agent: "codex", label: "codex" })]);
    expect(attentionText(done!, "ja")).toEqual({ title: "2:codex · web", body: "終わりました" });
  });

  it("通知の文は宛先の言語にする（会話の題名は訳さない）", () => {
    const [event] = attentionEvents([pane({ status: "working" })], [pane({ status: "blocked", chatTitle: "Fix login" })]);
    expect(attentionText(event!, "en")).toEqual({ title: "1:claude · web", body: "Waiting for your reply — Fix login" });
    const [done] = attentionEvents([pane({ status: "working" })], [pane({ status: "done" })]);
    expect(attentionText(done!, "en")).toEqual({ title: "1:claude · web", body: "Finished" });
  });
});

describe("Notifier", () => {
  function setup(targets: PushTarget[]) {
    const sent: { token: string; title: string; body: string; pane: string; sound?: boolean; passive?: boolean }[] = [];
    const cleared: string[] = [];
    const presence = new Presence();
    let now = 0;
    let away = true;
    let result: { ok: boolean; invalidToken?: boolean } = { ok: true };
    const notifier = new Notifier({
      targets: () => targets,
      clearToken: (token) => cleared.push(token),
      presence,
      send: async (target, payload) => {
        sent.push({ token: target.token, title: payload.aps.alert.title, body: payload.aps.alert.body, pane: payload.pane, sound: payload.aps.sound !== undefined, passive: payload.aps["interruption-level"] === "passive" });
        return result;
      },
      isAway: async () => away,
      now: () => now,
    });
    return {
      notifier,
      presence,
      sent,
      cleared,
      tick: (ms: number) => (now += ms),
      setAway: (v: boolean) => (away = v),
      failWith: (r: typeof result) => (result = r),
    };
  }
  const a = { deviceId: "d1", token: "aa", env: "sandbox" as const };
  const b = { deviceId: "d2", token: "bb", env: "sandbox" as const };

  it("つながっていない（裏にいる）端末にだけ送る", async () => {
    const t = setup([a, b]);
    t.presence.add("d1");
    await t.notifier.update([pane({ status: "working" })]);
    await t.notifier.update([pane({ status: "blocked" })]);
    expect(t.sent.map((s) => s.token)).toEqual(["bb"]);
    expect(t.sent[0]!.pane).toBe("w1:p1");
  });

  it("宛先の端末の言語で通知を送る（英語の端末には英語、日本語の端末には日本語）", async () => {
    const t = setup([a, { ...b, lang: "en" }]);
    await t.notifier.update([pane({ status: "working" })]);
    await t.notifier.update([pane({ status: "blocked" })]);

    expect(t.sent.map((s) => [s.token, s.body])).toEqual([
      ["aa", "返事を待っています"],
      ["bb", "Waiting for your reply"],
    ]);
  });

  it("2 本つないでいて 1 本切れても、まだつながっている扱い", () => {
    const p = new Presence();
    p.add("d1");
    p.add("d1");
    p.remove("d1");
    expect(p.has("d1")).toBe(true);
    p.remove("d1");
    expect(p.has("d1")).toBe(false);
  });

  it("同じペインの同じ知らせは 5 秒のうちは 1 回だけ（状態がゆれても鳴り続けない）", async () => {
    const t = setup([b]);
    await t.notifier.update([pane({ status: "working" })]);
    await t.notifier.update([pane({ status: "blocked" })]);
    await t.notifier.update([pane({ status: "working" })]);
    await t.notifier.update([pane({ status: "blocked" })]);
    expect(t.sent).toHaveLength(1);
    t.tick(6000);
    await t.notifier.update([pane({ status: "working" })]);
    await t.notifier.update([pane({ status: "blocked" })]);
    expect(t.sent).toHaveLength(2);
  });

  describe("もう一度の通知（返事待ちのまま時間がたったら 1 回だけ）", () => {
    const min = 60_000;
    const remindIn = (m: number | null) => ({ ...DEFAULT_PREFS, remindAfterMinutes: m });

    it("決めた時間がたっても返事待ちなら、もう 1 回だけ同じ知らせを送る", async () => {
      const t = setup([{ ...b, prefs: remindIn(10) }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked", chatTitle: "ログインを直す" })]);
      expect(t.sent).toHaveLength(1);
      t.tick(9 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(1);
      t.tick(1 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(2);
      expect(t.sent[1]!.body).toBe("返事を待っています — ログインを直す");
      t.tick(60 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(2);
    });

    it("一覧が変わったとき（update）でも、時間がたっていれば送る", async () => {
      const t = setup([{ ...b, prefs: remindIn(10) }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      t.tick(11 * min);
      await t.notifier.update([pane({ status: "blocked" }), pane({ paneId: "w1:p2", status: "working" })]);
      expect(t.sent).toHaveLength(2);
    });

    it("時間の前に返事をしたら送らない。また返事待ちになったら数え直す", async () => {
      const t = setup([{ ...b, prefs: remindIn(10) }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      t.tick(5 * min);
      await t.notifier.update([pane({ status: "working" })]);
      t.tick(1 * min);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent).toHaveLength(2);
      t.tick(9 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(2);
      t.tick(1 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(3);
    });

    it("設定が無い（既定）端末には送らない。端末ごとの時間で送る", async () => {
      const t = setup([{ ...a, prefs: remindIn(30) }, b]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent.map((s) => s.token)).toEqual(["aa", "bb"]);
      t.tick(29 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(2);
      t.tick(1 * min);
      await t.notifier.remind();
      expect(t.sent.map((s) => s.token)).toEqual(["aa", "bb", "aa"]);
    });

    it("そのときアプリを開いている端末には送らない（見ているので、あとからも送らない）", async () => {
      const t = setup([{ ...b, prefs: remindIn(10) }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      t.tick(10 * min);
      t.presence.add("d2");
      await t.notifier.remind();
      t.presence.remove("d2");
      t.tick(1 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(1);
    });

    it("黙らせたワークスペースには、もう一度も送らない", async () => {
      const t = setup([{ ...b, prefs: { ...remindIn(10), mutedWorkspaces: ["w1"] } }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      t.tick(10 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(0);
    });

    it("時間になったとき Mac の前にいたら（離れているときだけ）、離れてから送る", async () => {
      const t = setup([{ ...b, prefs: remindIn(10) }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent).toHaveLength(1);
      t.setAway(false);
      t.tick(10 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(1);
      t.setAway(true);
      t.tick(1 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(2);
    });

    it("最初の一覧ですでに返事待ちだったペインは、そこから数える", async () => {
      const t = setup([{ ...b, prefs: remindIn(10) }]);
      await t.notifier.update([pane({ status: "blocked" })]);
      t.tick(10 * min);
      await t.notifier.remind();
      expect(t.sent).toHaveLength(1);
    });
  });

  it("Apple に「もう使えない」と言われた宛先は消す", async () => {
    const t = setup([b]);
    t.failWith({ ok: false, invalidToken: true });
    await t.notifier.update([pane({ status: "working" })]);
    await t.notifier.update([pane({ status: "blocked" })]);
    expect(t.cleared).toEqual(["bb"]);
  });

  describe("端末の設定（prefs）", () => {
    const a2 = { deviceId: "d1", token: "aa", env: "sandbox" as const };

    it("切った端末には届かない（ほかの端末には届く）", async () => {
      const t = setup([{ ...a2, prefs: { ...DEFAULT_PREFS, enabled: false } }, b]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent.map((s) => s.token)).toEqual(["bb"]);
    });

    it("エージェントに呼ばれたときだけ：終わったは届かない", async () => {
      const prefs = { ...DEFAULT_PREFS, onlyNeedsInput: true };
      const t = setup([{ ...a2, prefs }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "done", since: 2 })]);
      expect(t.sent).toHaveLength(0);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent).toHaveLength(1);
    });

    it("黙らせたワークスペースは届かない", async () => {
      const prefs = { ...DEFAULT_PREFS, mutedWorkspaces: ["w1"] };
      const t = setup([{ ...a2, prefs }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent).toHaveLength(0);
    });

    it("音を鳴らさない：payload に sound を書かない（静けさの割り込みにはしない）", async () => {
      const prefs = { ...DEFAULT_PREFS, sound: false };
      const t = setup([{ ...a2, prefs }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent[0]).toMatchObject({ sound: false, passive: false });
    });

    it("鳴らさない時間の中：sound を書かず、aps の interruption-level を passive にする", async () => {
      // now は 0（1970-01-01 00:00 UTC）。UTC の 23:00〜7:00 の中
      const prefs = { ...DEFAULT_PREFS, quiet: { start: 1380, end: 420, timeZone: "UTC" } };
      const t = setup([{ ...a2, prefs }]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent[0]).toMatchObject({ sound: false, passive: true });
    });

    it("音を鳴らす端末は sound が入る", async () => {
      const t = setup([a2]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent[0]).toMatchObject({ sound: true, passive: false });
    });

    it("prefs が無い古い宛先は既定（鳴らす・送る）", async () => {
      const t = setup([a2]);
      await t.notifier.update([pane({ status: "working" })]);
      await t.notifier.update([pane({ status: "blocked" })]);
      expect(t.sent).toHaveLength(1);
    });
  });
});

describe("通知から返事する（カテゴリ）", () => {
  const opt = (key: string, label: string) => ({ key, label, detail: null });

  it("Claude の許可の確認（Yes / … / No）は「はい・今後も・いいえ」", () => {
    const c = replyCategory("needs-input", { question: "Do you want to make this edit?", options: [opt("1", "Yes"), opt("2", "Yes, allow all edits during this session"), opt("3", "No, and tell Claude what to do differently")], selected: "1" });
    expect(c).toBe("hm.permission");
  });

  it("ほかの選択肢は数で分ける（4 つ以上は 3 つまで出す）", () => {
    expect(replyCategory("needs-input", { question: null, options: [opt("1", "A"), opt("2", "B")], selected: null })).toBe("hm.choices2");
    expect(replyCategory("needs-input", { question: null, options: [opt("1", "A"), opt("2", "B"), opt("3", "C"), opt("4", "D")], selected: null })).toBe("hm.choices3");
  });

  it("選択肢が読めない・終わったときは「返事を書く」だけ", () => {
    expect(replyCategory("needs-input", null)).toBe("hm.reply");
    expect(replyCategory("finished", null)).toBe("hm.reply");
  });

  it("選択肢があれば本文にも中身を書き、通知に種類と Mac の印を付ける", async () => {
    const sent: { payload: import("../src/notify/apns.ts").PushPayload }[] = [];
    const notifier = new Notifier({
      targets: () => [{ deviceId: "d", token: "aa", env: "sandbox" }],
      clearToken: () => {},
      presence: new Presence(),
      choicesOf: async () => ({ question: "Do you want to proceed?", options: [opt("1", "Yes"), opt("2", "Yes, and don't ask again"), opt("3", "No")], selected: "1" }),
      machine: "abcd1234",
      isAway: async () => true,
      send: async (_t, payload) => {
        sent.push({ payload });
        return { ok: true };
      },
    });
    await notifier.update([pane({ status: "working" })]);
    await notifier.update([pane({ status: "blocked" })]);
    const p = sent[0]!.payload;
    expect(p.aps.category).toBe("hm.permission");
    expect(p.aps.alert.body).toBe("Do you want to proceed?\n1 Yes ／ 2 Yes, and don't ask again ／ 3 No");
    expect(p.m).toBe("abcd1234");
    expect(p.q).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("質問の印", () => {
  it("同じ質問なら同じ、選択肢が変われば違う（いま居る番号は関係ない）", () => {
    const a = { question: "Q", options: [{ key: "1", label: "Yes", detail: null }, { key: "2", label: "No", detail: null }], selected: "1" };
    expect(choicesFingerprint(a)).toBe(choicesFingerprint({ ...a, selected: "2" }));
    expect(choicesFingerprint(a)).not.toBe(choicesFingerprint({ ...a, question: "Q2" }));
  });
});

describe("Mac の印", () => {
  it("公開鍵の SHA-256 の先頭 8 バイト（16 進）", () => {
    expect(machineHint(Buffer.alloc(32, 1))).toMatch(/^[0-9a-f]{16}$/);
    expect(machineHint(Buffer.alloc(32, 1))).not.toBe(machineHint(Buffer.alloc(32, 2)));
  });
});
