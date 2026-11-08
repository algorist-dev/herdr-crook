import { afterEach, describe, expect, it, vi } from "vitest";
// Mac の言語に左右されないよう、日本語のまま出す
vi.mock("../../src/i18n/mac.ts", () => ({ macText: (text: string) => text }));
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USAGE =
  "使い方: crook <serve|pair|install|uninstall|ensure|devices|revoke ID|status|push-setup KEY.p8|push-test|statusline-install>";

const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-cli-"));
  dirs.push(dir);
  return dir;
}

async function runCli(argv: string[]): Promise<{ logs: string[]; code: number | string | null | undefined }> {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  const home = tempHome();
  vi.stubEnv("CROOK_HOME", home);
  vi.stubEnv("CROOK_RELAY_SERVER", "off");
  const beforeArgv = process.argv;
  const beforeExit = process.exitCode;
  process.argv = ["node", "cli.ts", ...argv];
  vi.resetModules();
  try {
    await import("../../src/cli.ts");
    await new Promise((r) => setTimeout(r, 0));
    return { logs, code: process.exitCode };
  } finally {
    process.argv = beforeArgv;
    process.exitCode = beforeExit;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cli", () => {
  it("引数なしは使い方を出して 0 で終わる", async () => {
    const { logs, code } = await runCli([]);
    expect(logs).toEqual([USAGE]);
    expect(code).toBe(0);
  });

  it("知らないコマンドは使い方を出して 1 で終わる", async () => {
    const { logs, code } = await runCli(["nope"]);
    expect(logs).toEqual([USAGE]);
    expect(code).toBe(1);
  });

  it("devices は 1 台もつないでいなければ「なし」と出す", async () => {
    const { logs } = await runCli(["devices"]);
    expect(logs).toEqual(["つないだ端末: なし"]);
  });
});
