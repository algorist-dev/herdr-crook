import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { PairingStore } from "../src/pairing/pairing.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { startRelay } from "../src/relay.ts";
import type { WatchState } from "../src/herdr/paneWatcher.ts";
import {
  herdrConfigPath,
  readHerdrTheme,
  readHerdrThemeSnapshot,
  type HerdrThemeConfig,
  type HerdrThemeSnapshot,
} from "../src/features/herdrTheme.ts";

const emptyTheme: HerdrThemeConfig = {
  name: null,
  autoSwitch: false,
  darkName: null,
  lightName: null,
  custom: {},
  customDark: {},
  customLight: {},
};

const sample = `# Mac の Herdr の設定
[ui]
theme = "dark"

[theme]
name = "tokyo-night" # 夜はこれ
auto_switch = true
dark_name = "dracula"
light_name = "one-light"
unknown = "読まない"

[theme.custom]
accent = "#ff0000"
text = "#00ff00"
red = "rgb(255,0,0)"
blue = "reset"
unknown_color = "#0000ff"
green = "#ABCDEF"
short = "#123"

[theme.custom.dark]
red = "#aa0000"
overlay0 = "#123"

[theme.custom.light]
red = "#bb0000"

[keys]
new_tab = "prefix+m"
`;

function fileWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-theme-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, text);
  return path;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
}

describe("readHerdrTheme", () => {
  it("[theme] と custom だけを読み、コメント・rgb()・知らないキーは捨てる", () => {
    expect(readHerdrTheme(fileWith(sample))).toEqual({
      name: "tokyo-night",
      autoSwitch: true,
      darkName: "dracula",
      lightName: "one-light",
      custom: { accent: "#ff0000", text: "#00ff00", green: "#ABCDEF" },
      customDark: { red: "#aa0000" },
      customLight: { red: "#bb0000" },
    });
  });

  it("ファイルが無ければ、空の設定を返す", () => {
    expect(readHerdrTheme(join(tmpdir(), "crook-no-such-theme.toml"))).toEqual(emptyTheme);
  });

  it("変更を見るための時刻も返す（ファイルが無ければ 0）", () => {
    const path = fileWith(sample);
    const snapshot = readHerdrThemeSnapshot(path);
    expect(snapshot.theme.name).toBe("tokyo-night");
    expect(snapshot.mtimeMs).toBeGreaterThan(0);
    expect(readHerdrThemeSnapshot(join(tmpdir(), "crook-no-such-theme.toml")).mtimeMs).toBe(0);
  });

  it("場所は HERDR_CONFIG_PATH、無ければ ~/.config/herdr/config.toml", () => {
    expect(herdrConfigPath({ HERDR_CONFIG_PATH: "/tmp/herdr.toml" })).toBe("/tmp/herdr.toml");
    expect(herdrConfigPath({})).toMatch(/\.config\/herdr\/config\.toml$/);
  });
});

class FakeWatcher {
  current(): WatchState {
    return { herdr: true, panes: [] };
  }
  kindOf() {
    return null;
  }
  poke() {}
  markUnattended() {}
  on() {}
  off() {}
}

describe("中継の welcome とテーマの変更", () => {
  it("welcome にテーマを入れ、変更時刻が変わったときだけ theme を送る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-relay-theme-"));
    const store = new PairingStore(join(dir, "devices.json"));
    let snapshot: HerdrThemeSnapshot = { theme: { ...emptyTheme, name: "tokyo-night" }, mtimeMs: 1 };
    const relay = await startRelay(
      {
        store,
        watcher: new FakeWatcher(),
        herdr: { request: async () => ({}) },
        openTerminal: () => ({ input() {}, resize() {}, scroll() {}, close() {} }),
        isAllowedPeer: async () => true,
        machine: "Mac mini",
        agents: () => [],
        providers: new ProviderRegistry([]),
        herdrTheme: () => snapshot,
        herdrThemePollMs: 20,
      },
      [{ host: "127.0.0.1", port: 0 }],
    );
    const ws = new WebSocket(`ws://127.0.0.1:${relay.ports[0]}/`);
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    try {
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ t: "pair", code: store.createPairingCode(), device: "iPhone" }));

      await waitFor(() => messages.some((m) => m.t === "welcome"));
      expect(messages.find((m) => m.t === "welcome")?.theme).toMatchObject({ name: "tokyo-night" });
      // プラグインの版（package.json）も伝える。アプリが古いプラグインを見分けるため
      const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
      expect(messages.find((m) => m.t === "welcome")?.plugin).toBe(pkg.version);

      await sleep(70);
      expect(messages.filter((m) => m.t === "theme")).toHaveLength(0);

      snapshot = { theme: { ...emptyTheme, name: "nord" }, mtimeMs: 2 };
      await waitFor(() => messages.some((m) => m.t === "theme"));
      expect(messages.find((m) => m.t === "theme")?.theme).toMatchObject({ name: "nord" });
    } finally {
      ws.close();
      await relay.close();
    }
  });
});
