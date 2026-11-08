import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localize, localizeServerMessage, TABLES, TRANSLATION_LANGUAGES } from "../src/i18n/index.ts";
import { attentionText } from "../src/notify/notifier.ts";
import type { ServerMessage } from "../src/protocol/messages.ts";

describe("localize", () => {
  it("日本語はそのまま、英語は表のとおり、表に無い文はそのまま", () => {
    expect(localize("ja", "そのモデルは選べません")).toBe("そのモデルは選べません");
    expect(localize("en", "そのモデルは選べません")).toBe("That model isn't available");
    expect(localize("en", "これは表に無い文です")).toBe("これは表に無い文です");
  });

  it("場所や名前が入る文は、正規表現の表で引く", () => {
    expect(localize("en", "Mac にそのフォルダがありません: /Users/me/nope")).toBe("The folder isn't on the Mac: /Users/me/nope");
  });

  it("表の無い言語は英語で送る", () => {
    expect(localize("it", "そのモデルは選べません")).toBe("That model isn't available");
  });
});

describe("localizeServerMessage", () => {
  const localizeMessage = (lang: string, message: ServerMessage) => localizeServerMessage(lang, message);

  it("error と modelSet の message を訳す", () => {
    expect(localizeMessage("en", { t: "error", message: "Herdr がワークスペースを作れませんでした" })).toEqual({
      t: "error",
      message: "Herdr couldn't create the workspace",
    });
    expect(
      localizeMessage("en", {
        t: "modelSet",
        pane: "w1:p1",
        ok: false,
        current: null,
        variant: null,
        message: "作業中は切り替えられません。終わってから切り替えてください",
      }),
    ).toMatchObject({ message: "Can't switch while working. Wait until it finishes" });
  });

  it("使用量の上限の行の名前を訳す（5h・7d はそのまま）", () => {
    const usage = {
      pane: "w1:p1",
      agent: "codex",
      updatedAt: 0,
      source: "codex",
      tokens: null,
      context: null,
      cost: null,
      model: null,
      limits: [
        { label: "5h", usedPercent: 10, resetsAt: null },
        { label: "使用量", usedPercent: 20, resetsAt: null },
      ],
    } as unknown as Extract<ServerMessage, { t: "usage" }>["usage"];
    const out = localizeMessage("en", { t: "usage", pane: "w1:p1", usage }) as Extract<ServerMessage, { t: "usage" }>;
    expect(out.usage?.limits.map((l) => l.label)).toEqual(["5h", "Usage"]);
  });

  it("ツールの中身の見出しを訳す（出力そのものは訳さない）", () => {
    const msg: ServerMessage = {
      t: "toolDetail",
      pane: "w1:p1",
      item: "a1:0",
      detail: {
        running: false,
        error: false,
        sections: [{ label: "出力", style: "code", text: "そのモデルは選べません", truncated: false }],
      },
    };
    expect(localizeMessage("en", msg)).toEqual({
      t: "toolDetail",
      pane: "w1:p1",
      item: "a1:0",
      detail: {
        running: false,
        error: false,
        sections: [{ label: "Output", style: "code", text: "そのモデルは選べません", truncated: false }],
      },
    });
  });

  it("コマンドの説明・おすすめ（既定）・許可しますか？・（画像）・ツールを訳す", () => {
    expect(
      localizeMessage("en", {
        t: "commands",
        pane: "w1:p1",
        agent: "claude",
        commands: [
          { name: "clear", summary: "会話を消して、最初からにする", kind: "command" },
          { name: "mine", summary: "ユーザーが書いた説明", kind: "command" },
        ],
      }),
    ).toMatchObject({ commands: [{ summary: "Clear the chat and start over" }, { summary: "ユーザーが書いた説明" }] });

    expect(
      localizeMessage("en", {
        t: "models",
        pane: "w1:p1",
        agent: "claude",
        current: null,
        variant: null,
        recent: [],
        models: [{ provider: "claude", id: "default", name: "おすすめ（既定）", providerName: "Claude", variants: ["low"] }],
      }),
    ).toMatchObject({ models: [{ name: "Recommended (default)" }] });

    expect(
      localizeMessage("en", { t: "choices", pane: "w1:p1", question: "許可しますか？", options: [], selected: null }),
    ).toMatchObject({ question: "Allow?" });

    expect(
      localizeMessage("en", {
        t: "chat",
        pane: "w1:p1",
        available: true,
        reset: true,
        title: null,
        items: [
          { id: "u1", role: "user", kind: "text", text: "見て（画像 2 枚）" },
          { id: "u2", role: "user", kind: "text", text: "見て（画像）" },
          { id: "a1:0", role: "assistant", kind: "tool", text: "そのモデルは選べません", tool: "ツール" },
        ],
      }),
    ).toMatchObject({
      items: [
        { text: "見て(2 images)" },
        { text: "見て(image)" },
        { text: "そのモデルは選べません", tool: "Tool" },
      ],
    });
  });
});

describe("取りこぼしの見張り", () => {
  /** 表にその文があるか（中国語の「結果」のように、訳が日本語と同じ字になることもあるので、訳の結果ではなく表を見る） */
  const hasTranslation = (lang: string, text: string) => {
    const table = TABLES[lang]!;
    return text in table.exact || table.patterns.some(([pattern]) => pattern.test(text));
  };
  const src = fileURLToPath(new URL("../src/", import.meta.url));

  function filesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...filesUnder(path));
      else if (entry.name.endsWith(".ts")) found.push(path);
    }
    return found;
  }

  /**
   * 日本語でも iPhone に届かないもの（Mac の画面・設定ファイル・ログ・中の誤り）。足すときは理由も書く。
   * herdr/agents.ts のペインの名前（ターミナル・エージェント）は iPhone に届くが、iPhone がその名前かどうかを見て使うので、iPhone 側で訳す（F5a）
   */
  const MAC_ONLY: [file: string, text: string][] = [
    ["session/session.ts", "ワークスペース"], // Mac の知らせ（スマホから操作中）
    ["session/session.ts", "エージェント（${found.agent ?? found.label}）"],
    ["session/session.ts", "ターミナル"],
    ["session/session.ts", "スマホから操作中"],
    ["session/session.ts", "${where} の"],
    ["providers/registry.ts", "プロバイダ ${p.id} が 2 つあります"], // 中の誤り（起動のとき）
    ["herdr/agents.ts", "ターミナル"],
    ["herdr/agents.ts", "エージェント"],
  ];
  const macOnly = (file: string, text: string) =>
    MAC_ONLY.some(([f, t]) => file.endsWith(f) && (text === t || text.startsWith(t)));

  it("iPhone に届きうる日本語の文字列は、message: の形でなくても全部の言語の表にある", () => {
    const files = ["providers", "session", "features", "herdr"].flatMap((dir) => filesUnder(join(src, dir)));
    const literal = /"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g;
    const missing: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (line.includes("${marker}")) return; // statusline のスクリプトに書くコメント（Mac のファイル）
        for (const match of line.matchAll(literal)) {
          const value = match[1] ?? match[2] ?? "";
          if (!/[ぁ-んァ-ン一-龥]/.test(value) || macOnly(file, value)) continue;
          // 中に入る名前や数は「1」にして引く（「（画像 1 枚）」のように数でしか合わない形もあるため）
          const key = value.replace(/\$\{[^}]*\}/g, "1");
          for (const lang of TRANSLATION_LANGUAGES) {
            if (!hasTranslation(lang, key)) missing.push(`${lang}: ${file.slice(src.length)}:${i + 1}: ${value}`);
          }
        }
      });
    }
    expect(missing).toEqual([]);
  });

  it("iPhone に届く message の日本語は、全部の言語の表にある", () => {
    const files = ["providers", "session", "features", "herdr"].flatMap((dir) => filesUnder(join(src, dir)));
    const found = /message:\s*("(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g;
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(found)) {
        const raw = match[1]!;
        const value = raw.slice(1, -1);
        if (!/[ぁ-んァ-ン一-龥]/.test(value)) continue;
        for (const lang of TRANSLATION_LANGUAGES) {
          const key = value.includes("${") ? value.replace(/\$\{[^}]*\}/g, "X") : value;
          if (!hasTranslation(lang, key)) missing.push(`${lang}: ${file}: ${value}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("言語の一覧", () => {
  const shared = (name: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../../shared/i18n/${name}`, import.meta.url)), "utf8"));

  it("アプリと同じ 10 の言語（日本語のほか）に表がある", () => {
    expect([...TRANSLATION_LANGUAGES].sort()).toEqual(["de", "en", "es", "fr", "ko", "pt-BR", "ru", "tr", "zh-Hans", "zh-Hant"].sort());
  });

  it("どの言語の表も、英語の表と同じ文と同じ数の正規表現を持つ", () => {
    const en = TABLES.en!;
    for (const lang of TRANSLATION_LANGUAGES) {
      const table = TABLES[lang]!;
      expect(Object.keys(table.exact).sort(), lang).toEqual(Object.keys(en.exact).sort());
      expect(table.patterns.map(([re]) => re.source), lang).toEqual(en.patterns.map(([re]) => re.source));
      for (const [text, translated] of Object.entries(table.exact)) {
        expect(translated, `${lang}: ${text}`).not.toBe("");
      }
    }
  });

  // shared/ はアプリと同じリポジトリにだけある（公開しているプラグインだけのリポジトリでは見ない）
  const hasShared = existsSync(fileURLToPath(new URL("../../shared/i18n", import.meta.url)));

  it.skipIf(!hasShared)("通知の書き出しはアプリと同じ文（shared/i18n/attention.json）", () => {
    const table = shared("attention.json") as Record<string, Record<string, string>>;
    for (const lang of ["ja", ...TRANSLATION_LANGUAGES]) {
      expect(attentionText({ paneId: "p", kind: "needs-input", title: "t", what: null, workspaceId: "w" }, lang).body, lang).toBe(table.needsInput![lang]);
      expect(attentionText({ paneId: "p", kind: "finished", title: "t", what: "直す", workspaceId: "w" }, lang).body, lang).toBe(`${table.finished![lang]} — 直す`);
    }
  });
});
