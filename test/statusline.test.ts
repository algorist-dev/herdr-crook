import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findStatuslineScript, installStatuslineHook, readStatusline, saveStatusline, sessionIdFrom } from "../src/providers/claude/statusline.ts";

describe("Claude の statusline", () => {
  it("session_id か transcript のファイル名から会話の ID を読む", () => {
    expect(sessionIdFrom({ session_id: "abc-123" })).toBe("abc-123");
    expect(sessionIdFrom({ sessionId: "def-456" })).toBe("def-456");
    expect(sessionIdFrom({ transcript_path: "/Users/me/.claude/projects/x/abc-123.jsonl" })).toBe("abc-123");
    expect(sessionIdFrom({ transcript_path: "/tmp/../x y.jsonl" })).toBeNull();
    expect(sessionIdFrom({})).toBeNull();
    expect(sessionIdFrom("not json")).toBeNull();
  });

  it("0600 で残して、中継から読める。古いものは消す", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-statusline-"));
    const payload = { session_id: "abc-123", context_window: { used_percentage: 42 } };
    const saved = saveStatusline(dir, payload);
    expect(saved.sessionId).toBe("abc-123");
    expect(readStatusline(dir, "abc-123")).toEqual(payload);
    expect(statSync(saved.path!).mode & 0o777).toBe(0o600);
    expect(readStatusline(dir, "../abc")).toBeNull();

    const old = join(dir, "old-1.json");
    writeFileSync(old, "{}");
    const past = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, past, past);
    saveStatusline(dir, { session_id: "new-1" });
    expect(() => statSync(old)).toThrow();
    expect(readStatusline(dir, "new-1")).toEqual({ session_id: "new-1" });
  });

  it("settings.json の statusLine.command からスクリプトを探す", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-home-"));
    const dir = join(home, ".claude");
    const script = join(dir, "statusline.sh");
    const settings = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, "#!/bin/sh\n");
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "sh ~/.claude/statusline.sh" } }));
    expect(findStatuslineScript(settings, home)).toBe(script);
    writeFileSync(settings, JSON.stringify({ statusLine: { command: "python3 ~/.claude/line.py" } }));
    expect(findStatuslineScript(settings, home)).toBeNull();
    expect(findStatuslineScript("/no/settings.json", home)).toBeNull();
  });

  it("statusline のスクリプトに入力のすぐあとの 1 行を足す（元は残す・二度は足さない）", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-hook-"));
    const script = join(dir, "statusline.sh");
    const original = '#!/bin/sh\ninput=$(cat)\nprintf "%s" "$input" | python3 "$HOME/.claude/statusline.py"\n';
    writeFileSync(script, original);
    const options = { node: "/usr/local/bin/node", cli: "/repo/plugin/src/cli.ts", home: "/Users/me/.config/crook" };
    const first = installStatuslineHook(script, options);
    expect(first.ok).toBe(true);
    const text = readFileSync(script, "utf8");
    expect(text).toContain("crook statusline");
    expect(text.indexOf("crook statusline")).toBeGreaterThan(text.indexOf("input=$(cat)"));
    expect(text).toContain('"$input"');
    expect(text).toContain("CROOK_HOME='/Users/me/.config/crook'");
    expect(text).toContain("'/repo/plugin/src/cli.ts' statusline");
    expect(readFileSync(`${script}.bak-crook`, "utf8")).toBe(original);
    expect(installStatuslineHook(script, options).ok).toBe(true);
    expect(readFileSync(script, "utf8").match(/crook statusline/g)).toHaveLength(1);
  });

  it("入力を読む行がないスクリプトには足さない", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-hook-"));
    const script = join(dir, "statusline.sh");
    writeFileSync(script, "#!/bin/sh\necho hi\n");
    expect(installStatuslineHook(script, { node: "n", cli: "c", home: "h" }).ok).toBe(false);
  });
});
