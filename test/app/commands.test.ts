import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Mac の言語に左右されないよう、日本語のまま出す
vi.mock("../../src/i18n/mac.ts", () => ({ macText: (text: string) => text }));
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-commands-"));
  dirs.push(dir);
  return dir;
}

function device(id: string, name: string) {
  return { id, name, tokenHash: "00", createdAt: 1, lastSeenAt: 1_700_000_000_000 };
}

function logs(): string[] {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  return out;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("devices", () => {
  it("1 台もつないでいなければ「なし」と出す", async () => {
    const home = tempHome();
    vi.stubEnv("CROOK_HOME", home);
    vi.resetModules();
    const out = logs();

    const { run } = await import("../../src/app/commands/devices.ts");
    await run([]);
    expect(out).toEqual(["つないだ端末: なし"]);
  });

  it("つないだスマホの ID・名前・最後に使った日時を出す", async () => {
    const home = tempHome();
    writeFileSync(join(home, "devices.json"), JSON.stringify({ devices: [device("abc", "テストの iPhone")], pending: null }));
    vi.stubEnv("CROOK_HOME", home);
    vi.resetModules();
    const out = logs();

    const { run } = await import("../../src/app/commands/devices.ts");
    await run([]);
    expect(out[0]).toBe("つないだ端末:");
    expect(out[1]).toMatch(/^  abc {2}テストの iPhone {2}最後に使った日時 /);
  });
});

describe("revoke", () => {
  it("ID がなければ使い方を言って止める", async () => {
    const home = tempHome();
    vi.stubEnv("CROOK_HOME", home);
    vi.resetModules();

    const { run } = await import("../../src/app/commands/revoke.ts");
    await expect(run([])).rejects.toThrow("消すスマホの ID を指定してください（devices で見られます）");
  });

  it("ある ID は消し、ない ID はそのまま知らせる", async () => {
    const home = tempHome();
    writeFileSync(join(home, "devices.json"), JSON.stringify({ devices: [device("abc", "iPhone")], pending: null }));
    vi.stubEnv("CROOK_HOME", home);
    vi.resetModules();
    const out = logs();

    const { run } = await import("../../src/app/commands/revoke.ts");
    await run(["abc"]);
    await run(["abc"]);
    expect(out).toEqual(["消しました。", "その ID の端末はありません。"]);
  });
});
