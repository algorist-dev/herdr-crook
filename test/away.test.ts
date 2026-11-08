import { describe, expect, it } from "vitest";
import { idleSecondsFromIoreg, isAway, isAwayFromSamples, isScreenLocked, resetAwayCache } from "../src/notify/away.ts";

/** さわっていない 200 秒（この Mac の ioreg の出力の書き方） */
const idle200 = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000472, registered, matched, active, busy 0 (0 ms), retain 7>
{
  "HIDIdleTime" = 200000000000
}`;
const idle10 = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000472>
{ "HIDIdleTime" = 10000000000 }`;
/** ioreg -n Root -d 1 -a は XML の plist（2026-11-08 にこの Mac がロック中に見た形） */
const locked = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>IOConsoleUsers</key>
	<array>
		<dict>
			<key>CGSSessionScreenIsLocked</key>
			<true/>
			<key>kCGSSessionOnConsoleKey</key>
			<true/>
		</dict>
	</array>
</dict>
</plist>`;
const unlocked = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>IOConsoleUsers</key>
	<array>
		<dict>
			<key>kCGSSessionOnConsoleKey</key>
			<true/>
		</dict>
	</array>
</dict>
</plist>`;

describe("ioreg の出力を見る", () => {
  it("HIDIdleTime はナノ秒から秒", () => {
    expect(idleSecondsFromIoreg(idle200)).toBe(200);
    expect(idleSecondsFromIoreg(idle10)).toBe(10);
    expect(idleSecondsFromIoreg("no key")).toBeNull();
  });

  it("ロックの印（触っていないときはキーごと無い）", () => {
    expect(isScreenLocked(locked)).toBe(true);
    expect(isScreenLocked(unlocked)).toBe(false);
    expect(isScreenLocked(locked.replace("<true/>", "<false/>"))).toBe(false);
  });

  it("3 分さわっていなければ離れている", () => {
    expect(isAwayFromSamples(idle200, unlocked)).toBe(true);
  });

  it("さわっていれば、離れていない", () => {
    expect(isAwayFromSamples(idle10, unlocked)).toBe(false);
  });

  it("ロック中なら、さわっていても離れている", () => {
    expect(isAwayFromSamples(idle10, locked)).toBe(true);
  });

  it("コマンドが失敗したら（読めなければ）離れている扱い（知らせない方に倒さない）", () => {
    expect(isAwayFromSamples(null, null)).toBe(true);
    expect(isAwayFromSamples(null, locked)).toBe(true);
    expect(isAwayFromSamples("キーが無い出力", unlocked)).toBe(true);
  });
});

describe("isAway", () => {
  it("ioreg を決まった引数で動かし、失敗（例外）しても離れている扱いで、次はまた読み直す", async () => {
    resetAwayCache();
    const calls: string[][] = [];
    const broken = { run: async (args: string[]) => { calls.push(args); throw new Error("boom"); } };
    expect(await isAway(broken)).toBe(true);
    expect(calls).toContainEqual(["-c", "IOHIDSystem", "-d", "4", "-k", "HIDIdleTime"]);
    expect(calls).toContainEqual(["-n", "Root", "-d", "1", "-a"]);
    resetAwayCache();
    const ok = { run: async (args: string[]) => (args[0] === "-c" ? idle10 : unlocked) };
    expect(await isAway(ok)).toBe(false);
  });
});
