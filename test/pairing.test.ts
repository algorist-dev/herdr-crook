import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingStore, PAIRING_CODE_TTL_MS } from "../src/pairing/pairing.ts";
import { DEFAULT_PREFS } from "../src/notify/prefs.ts";

describe("PairingStore", () => {
  let dir: string;
  let now: number;
  let store: PairingStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hm-pair-"));
    now = 1_000_000;
    store = new PairingStore(join(dir, "devices.json"), () => now);
  });

  it("合言葉を1回だけ使える", () => {
    const code = store.createPairingCode();
    const first = store.redeem(code, "iPhone");
    expect(first.ok).toBe(true);
    const second = store.redeem(code, "iPhone");
    expect(second).toEqual({ ok: false, reason: "invalid_code" });
  });

  it("5分を過ぎた合言葉は使えない", () => {
    const code = store.createPairingCode();
    now += PAIRING_CODE_TTL_MS + 1;
    expect(store.redeem(code, "iPhone")).toEqual({ ok: false, reason: "invalid_code" });
  });

  it("新しい合言葉を出すと前の合言葉は使えなくなる", () => {
    const old = store.createPairingCode();
    const fresh = store.createPairingCode();
    expect(store.redeem(old, "iPhone").ok).toBe(false);
    expect(store.redeem(fresh, "iPhone").ok).toBe(true);
  });

  it("もらった鍵でつなげる。違う鍵や消した端末の鍵ではつなげない", () => {
    const result = store.redeem(store.createPairingCode(), "iPhone 15");
    if (!result.ok) throw new Error("redeem failed");
    expect(store.verify(result.token)?.name).toBe("iPhone 15");
    expect(store.verify(result.token + "x")).toBeNull();
    expect(store.verify("")).toBeNull();
    store.revoke(result.deviceId);
    expect(store.verify(result.token)).toBeNull();
  });

  it("鍵そのものはファイルに残さず、ファイルは本人だけが読める", () => {
    const result = store.redeem(store.createPairingCode(), "iPhone");
    if (!result.ok) throw new Error("redeem failed");
    const raw = readFileSync(join(dir, "devices.json"), "utf8");
    expect(raw).not.toContain(result.token);
    expect(statSync(join(dir, "devices.json")).mode & 0o777).toBe(0o600);
  });

  it("別のプロセスが出した合言葉もファイル経由で使える", () => {
    const code = store.createPairingCode();
    const other = new PairingStore(join(dir, "devices.json"), () => now);
    expect(other.redeem(code, "iPhone").ok).toBe(true);
  });

  it("端末の名前は短く、制御文字なしで残す", () => {
    const result = store.redeem(store.createPairingCode(), "a\u0000b\n" + "x".repeat(200));
    if (!result.ok) throw new Error("redeem failed");
    const device = store.listDevices()[0];
    expect(device?.name.startsWith("ab")).toBe(true);
    expect(device?.name.length).toBeLessThanOrEqual(64);
  });

  it("鍵の確認ではファイルを書かない（ほかのプロセスの書き込みを消さないため）", () => {
    const result = store.redeem(store.createPairingCode(), "iPhone");
    if (!result.ok) throw new Error("redeem failed");
    const before = readFileSync(join(dir, "devices.json"), "utf8");
    now += 5000;
    store.verify(result.token);
    expect(readFileSync(join(dir, "devices.json"), "utf8")).toBe(before);
  });

  it("最後につないだ時刻は markSeen で残す", () => {
    const result = store.redeem(store.createPairingCode(), "iPhone");
    if (!result.ok) throw new Error("redeem failed");
    now += 5000;
    store.markSeen(result.deviceId);
    expect(store.listDevices()[0]?.lastSeenAt).toBe(now);
  });

  it("端末の言語を残す（同じなら書かない）", () => {
    const result = store.redeem(store.createPairingCode(), "iPhone");
    if (!result.ok) throw new Error("redeem failed");
    expect(store.listDevices()[0]?.lang).toBeUndefined();

    store.setLang(result.deviceId, "en");
    expect(store.listDevices()[0]?.lang).toBe("en");

    const before = readFileSync(join(dir, "devices.json"), "utf8");
    store.setLang(result.deviceId, "en");
    expect(readFileSync(join(dir, "devices.json"), "utf8")).toBe(before);

    store.setLang(result.deviceId, "ja");
    expect(store.listDevices()[0]?.lang).toBe("ja");
  });

  it("通知の宛先には端末の言語も付ける", () => {
    const result = store.redeem(store.createPairingCode(), "iPhone");
    if (!result.ok) throw new Error("redeem failed");
    store.setPush(result.deviceId, "aa11", "sandbox");
    store.setLang(result.deviceId, "en");
    expect(store.pushTargets()).toEqual([{ deviceId: result.deviceId, token: "aa11", env: "sandbox", lang: "en" }]);
  });

  it("消した端末は isActive が false になる", () => {
    const result = store.redeem(store.createPairingCode(), "iPhone");
    if (!result.ok) throw new Error("redeem failed");
    expect(store.isActive(result.deviceId)).toBe(true);
    store.revoke(result.deviceId);
    expect(store.isActive(result.deviceId)).toBe(false);
  });
});

describe("PairingStore の通知の宛先", () => {
  it("端末ごとに通知の宛先をしまい、消した端末・消した宛先は出さない", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-pair-"));
    const store = new PairingStore(join(dir, "devices.json"));
    const one = store.redeem(store.createPairingCode(), "iPhone");
    const two = store.redeem(store.createPairingCode(), "iPad");
    if (!one.ok || !two.ok) throw new Error("redeem failed");
    store.setPush(one.deviceId, "aa11", "sandbox");
    store.setPush(two.deviceId, "bb22", "production");
    expect(store.pushTargets()).toEqual([
      { deviceId: one.deviceId, token: "aa11", env: "sandbox" },
      { deviceId: two.deviceId, token: "bb22", env: "production" },
    ]);
    store.clearPushToken("aa11");
    store.revoke(two.deviceId);
    expect(store.pushTargets()).toEqual([]);
    store.setPush(one.deviceId, "cc33", "sandbox");
    store.setPush(one.deviceId, null, "sandbox");
    expect(store.pushTargets()).toEqual([]);
  });
});

describe("PairingStore の通知の宛先（つなぎ直し）", () => {
  it("同じ宛先を別の登録に入れたら、前の登録からは外す（2 回鳴らない）", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-pair-"));
    const store = new PairingStore(join(dir, "devices.json"));
    const old = store.redeem(store.createPairingCode(), "iPhone");
    const fresh = store.redeem(store.createPairingCode(), "iPhone");
    if (!old.ok || !fresh.ok) throw new Error("redeem failed");
    store.setPush(old.deviceId, "aa11", "sandbox");
    store.setPush(fresh.deviceId, "aa11", "sandbox");
    expect(store.pushTargets()).toEqual([{ deviceId: fresh.deviceId, token: "aa11", env: "sandbox" }]);
  });
});

describe("PairingStore の通知の設定（prefs）", () => {
  it("prefs を宛先に残し、pushTargets でも返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-pair-"));
    const store = new PairingStore(join(dir, "devices.json"));
    const one = store.redeem(store.createPairingCode(), "iPhone");
    if (!one.ok) throw new Error("redeem failed");
    store.setPush(one.deviceId, "aa11", "sandbox");
    expect(store.pushTargets()[0]?.prefs).toBeUndefined();
    store.setPush(one.deviceId, "aa11", "sandbox", DEFAULT_PREFS);
    expect(store.pushTargets()[0]?.prefs).toEqual(DEFAULT_PREFS);
    // 宛先が変わっても prefs は残る（iPhone が送り直すまで）
    store.setPush(one.deviceId, "bb22", "sandbox", DEFAULT_PREFS);
    expect(store.pushTargets()[0]?.prefs).toEqual(DEFAULT_PREFS);
  });

  it("prefs が変わらない・宛先が同じならファイルを書かない", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-pair-"));
    const store = new PairingStore(join(dir, "devices.json"));
    const one = store.redeem(store.createPairingCode(), "iPhone");
    if (!one.ok) throw new Error("redeem failed");
    store.setPush(one.deviceId, "aa11", "sandbox", DEFAULT_PREFS);
    const before = readFileSync(join(dir, "devices.json"), "utf8");
    store.setPush(one.deviceId, "aa11", "sandbox", DEFAULT_PREFS);
    expect(readFileSync(join(dir, "devices.json"), "utf8")).toBe(before);
    // 設定が替わったら書く
    store.setPush(one.deviceId, "aa11", "sandbox", { ...DEFAULT_PREFS, enabled: false });
    expect(store.pushTargets()[0]?.prefs?.enabled).toBe(false);
  });
});
