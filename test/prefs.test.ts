import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, parseNotificationPrefs, shouldNotify, shouldSound } from "../src/notify/prefs.ts";

// iPhone（ios/CrookKit/Tests/CrookKitTests/NotificationPrefsTests.swift）と同じ表のテスト。同じ入力で同じ答えになる。
const base = DEFAULT_PREFS;

describe("shouldNotify", () => {
  const cases: { name: string; prefs: Partial<typeof base>; kind: "needs-input" | "finished"; workspaceId: string; away: boolean; focused: string | null; want: boolean }[] = [
    { name: "既定では返事待ち・終わったとも出す", prefs: {}, kind: "finished", workspaceId: "w1", away: true, focused: null, want: true },
    { name: "切ったら出さない", prefs: { enabled: false }, kind: "needs-input", workspaceId: "w1", away: true, focused: null, want: false },
    { name: "エージェントに呼ばれたときだけ：終わったは出さない", prefs: { onlyNeedsInput: true }, kind: "finished", workspaceId: "w1", away: true, focused: null, want: false },
    { name: "エージェントに呼ばれたときだけ：返事待ちは出す", prefs: { onlyNeedsInput: true }, kind: "needs-input", workspaceId: "w1", away: true, focused: null, want: true },
    { name: "Mac から離れているときだけ：さわっていると出さない", prefs: { onlyWhenAway: true }, kind: "needs-input", workspaceId: "w1", away: false, focused: null, want: false },
    { name: "Mac から離れているときだけ：離れていれば出す", prefs: { onlyWhenAway: true }, kind: "needs-input", workspaceId: "w1", away: true, focused: null, want: true },
    { name: "見ているワークスペースは出さない（別のワークスペースなら出す）", prefs: { suppressFocused: true }, kind: "needs-input", workspaceId: "w1", away: false, focused: "w1", want: false },
    { name: "見ているワークスペースは出さない：オフなら、さわっていても出す", prefs: { suppressFocused: false, onlyWhenAway: false }, kind: "needs-input", workspaceId: "w1", away: false, focused: "w1", want: true },
    { name: "黙らせたワークスペースは出さない", prefs: { mutedWorkspaces: ["w1"] }, kind: "needs-input", workspaceId: "w1", away: true, focused: null, want: false },
    { name: "黙らせたワークスペースと別なら出す", prefs: { mutedWorkspaces: ["w1"] }, kind: "needs-input", workspaceId: "w2", away: true, focused: null, want: true },
    { name: "きつい設定は重ねて効く", prefs: { enabled: false, onlyWhenAway: false }, kind: "needs-input", workspaceId: "w1", away: true, focused: null, want: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const prefs = { ...base, ...c.prefs };
      expect(shouldNotify(prefs, c.kind, c.workspaceId, c.away, c.focused)).toBe(c.want);
    });
  }
});

describe("shouldSound", () => {
  const quiet = (start: number, end: number, timeZone = "Asia/Tokyo") => ({ start, end, timeZone });
  const at = (clock: string, timeZone = "Asia/Tokyo") => new Date(`2026-11-08T${clock}:00${timeZone === "Asia/Tokyo" ? "+09:00" : ""}`);

  it(" sound が切れたら、時間の外でも鳴らさない", () => {
    expect(shouldSound({ ...base, sound: false }, at("12:00"))).toBe(false);
  });

  it("鳴らさない時間の外は（既定の）音を鳴らす", () => {
    expect(shouldSound({ ...base, quiet: quiet(1380, 420) }, at("12:00"))).toBe(true);
  });

  it("鳴らさない時間の中は（日をまたぐ 23:00〜7:00）", () => {
    expect(shouldSound({ ...base, quiet: quiet(1380, 420) }, at("23:00"))).toBe(false);
    expect(shouldSound({ ...base, quiet: quiet(1380, 420) }, at("02:30"))).toBe(false);
  });

  it("鳴らさない時間（同じ日の中 7:00〜9:00）", () => {
    expect(shouldSound({ ...base, quiet: quiet(420, 540) }, at("08:00"))).toBe(false);
  });

  it("境目ちょうど：start ちょうどは中、end ちょうどは外", () => {
    expect(shouldSound({ ...base, quiet: quiet(1380, 420) }, at("07:00"))).toBe(true);
  });

  it("start == end は無いことにする", () => {
    expect(shouldSound({ ...base, quiet: quiet(60, 60) }, at("01:00"))).toBe(true);
  });

  it("別の時刻のそろえ方（timeZone）で決める", () => {
    // Tokyo の 18:50 は Los Angeles の 01:50（23:00〜7:00 の中）
    expect(shouldSound({ ...base, quiet: quiet(1380, 420, "America/Los_Angeles") }, at("18:50"))).toBe(false);
    expect(shouldSound({ ...base, quiet: quiet(1380, 420) }, at("18:50"))).toBe(true);
  });

  it("時刻の名前が読めなければ鳴らさない時間を無いことにする", () => {
    expect(shouldSound({ ...base, quiet: quiet(1380, 420, "Mars/Olympus") }, at("23:30"))).toBe(true);
  });
});

describe("parseNotificationPrefs", () => {
  it("prefs が無ければ undefined（push に乗らなかったと分かる）", () => {
    expect(parseNotificationPrefs(undefined)).toBeUndefined();
    expect(parseNotificationPrefs(null)).toBeUndefined();
  });

  it("無いキーは既定", () => {
    expect(parseNotificationPrefs({})).toEqual(base);
    expect(parseNotificationPrefs({ enabled: false })).toEqual({ ...base, enabled: false });
  });

  it("もう一度の通知（remindAfterMinutes）：既定は無し。1〜240 分の整数だけ受ける", () => {
    expect(parseNotificationPrefs({})?.remindAfterMinutes).toBeNull();
    expect(parseNotificationPrefs({ remindAfterMinutes: null })?.remindAfterMinutes).toBeNull();
    expect(parseNotificationPrefs({ remindAfterMinutes: 10 })?.remindAfterMinutes).toBe(10);
    expect(parseNotificationPrefs({ remindAfterMinutes: 30 })?.remindAfterMinutes).toBe(30);
    expect(parseNotificationPrefs({ remindAfterMinutes: 0 })).toBeUndefined();
    expect(parseNotificationPrefs({ remindAfterMinutes: 241 })).toBeUndefined();
    expect(parseNotificationPrefs({ remindAfterMinutes: 1.5 })).toBeUndefined();
    expect(parseNotificationPrefs({ remindAfterMinutes: "10" })).toBeUndefined();
  });

  it("quiet の中身を確かめる（端が出ている・日をまたいでよい）", () => {
    expect(parseNotificationPrefs({ quiet: { start: 1380, end: 420, timeZone: "Asia/Tokyo" } })?.quiet).toEqual({ start: 1380, end: 420, timeZone: "Asia/Tokyo" });
    expect(parseNotificationPrefs({ quiet: { start: 1440, end: 420, timeZone: "Asia/Tokyo" } })).toBeUndefined();
    expect(parseNotificationPrefs({ quiet: { start: -1, end: 420, timeZone: "Asia/Tokyo" } })).toBeUndefined();
    expect(parseNotificationPrefs({ quiet: { start: 1.5, end: 420, timeZone: "Asia/Tokyo" } })).toBeUndefined();
    expect(parseNotificationPrefs({ quiet: { start: 1380, end: 420, timeZone: "" } })).toBeUndefined();
    expect(parseNotificationPrefs({ quiet: { start: 1380, end: 420, timeZone: "x".repeat(65) } })).toBeUndefined();
    expect(parseNotificationPrefs({ quiet: { start: 1380, end: 420 } })).toBeUndefined();
  });

  it("時刻の名前が読めなければ（鳴らさない時間を無いことにする）", () => {
    expect(parseNotificationPrefs({ quiet: { start: 1380, end: 420, timeZone: "Mars/Olympus" } })).toEqual(base);
  });

  it("start == end は無いことにする", () => {
    expect(parseNotificationPrefs({ quiet: { start: 60, end: 60, timeZone: "Asia/Tokyo" } })).toEqual(base);
  });

  it("黙らせたワークスペースは 200 個まで、名前の形", () => {
    expect(parseNotificationPrefs({ mutedWorkspaces: ["w1", "abc_123"] })?.mutedWorkspaces).toEqual(["w1", "abc_123"]);
    expect(parseNotificationPrefs({ mutedWorkspaces: ["悪い"] })).toBeUndefined();
    expect(parseNotificationPrefs({ mutedWorkspaces: ["x".repeat(64)] })?.mutedWorkspaces).toEqual(["x".repeat(64)]);
    expect(parseNotificationPrefs({ mutedWorkspaces: ["x".repeat(65)] })).toBeUndefined();
    expect(parseNotificationPrefs({ mutedWorkspaces: Array.from({ length: 200 }, (_, i) => `w${i}`) })?.mutedWorkspaces).toHaveLength(200);
    expect(parseNotificationPrefs({ mutedWorkspaces: Array.from({ length: 201 }, (_, i) => `w${i}`) })).toBeUndefined();
  });

  it("boolean でない・配列でないものは断る（push の受けを丸ごと断るので undefined）", () => {
    expect(parseNotificationPrefs({ enabled: "yes" })).toBeUndefined();
    expect(parseNotificationPrefs({ mutedWorkspaces: "w1" })).toBeUndefined();
    expect(parseNotificationPrefs({ quiet: 3 })).toBeUndefined();
  });
});
