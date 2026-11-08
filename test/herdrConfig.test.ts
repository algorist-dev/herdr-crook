import { describe, expect, it } from "vitest";
import { addPairKeybinding, PAIR_ACTION } from "../src/herdr/herdrConfig.ts";

describe("addPairKeybinding", () => {
  it("空の設定に prefix+m を足す", () => {
    const out = addPairKeybinding("");
    expect(out).toContain('[[keys.command]]');
    expect(out).toContain('key = "prefix+m"');
    expect(out).toContain('type = "plugin_action"');
    expect(out).toContain(`command = "${PAIR_ACTION}"`);
  });

  it("前からある設定は残して、最後に足す", () => {
    const out = addPairKeybinding('[ui]\ntheme = "dark"\n');
    expect(out?.startsWith('[ui]\ntheme = "dark"\n')).toBe(true);
  });

  it("もう入っていれば何もしない（null）", () => {
    const once = addPairKeybinding("") ?? "";
    expect(addPairKeybinding(once)).toBeNull();
  });

  it("prefix+m を別のことに使っていれば足さない（null）", () => {
    expect(addPairKeybinding('[keys]\nnew_tab = "prefix+m"\n')).toBeNull();
  });
});
