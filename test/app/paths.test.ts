import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-paths-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("app/paths", () => {
  it("環境変数から HOME・ポート・中継サーバーの設定を読む", async () => {
    const home = tempHome();
    vi.stubEnv("CROOK_HOME", home);
    vi.stubEnv("CROOK_PORT", "49999");
    vi.stubEnv("CROOK_RELAY_SERVER", "off");
    vi.resetModules();

    const paths = await import("../../src/app/paths.ts");
    expect(paths.HOME).toBe(home);
    expect(paths.PORT).toBe(49999);
    expect(paths.RELAY_SERVER).toBe("off");
    expect(paths.relayServerOn).toBe(false);
    expect(paths.cloudRoom).toBeNull();
  });

  it("cli.ts の場所はこのファイルから見た src/cli.ts（statusline と launchd が使う）", async () => {
    const home = tempHome();
    vi.stubEnv("CROOK_HOME", home);
    vi.resetModules();

    const paths = await import("../../src/app/paths.ts");
    expect(paths.CLI.endsWith(join("src", "cli.ts"))).toBe(true);
    expect(paths.CLI).not.toContain(join("app", "paths.ts"));
  });

  it("log は ISO の時刻を頭に付けて標準出力へ書く", async () => {
    const home = tempHome();
    vi.stubEnv("CROOK_HOME", home);
    vi.resetModules();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const paths = await import("../../src/app/paths.ts");
    paths.log("こんにちは");
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[^ ]+ こんにちは\n$/));
  });
});
