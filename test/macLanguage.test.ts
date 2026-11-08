import { describe, expect, it } from "vitest";
import { macLanguage, macText } from "../src/i18n/mac.ts";

describe("Mac の画面の言語", () => {
  it("LANG の言語を使う", () => {
    expect(macLanguage(null, { LANG: "ja_JP.UTF-8" }, "en-US")).toBe("ja");
    expect(macLanguage(null, { LANG: "de_DE.UTF-8" }, "en-US")).toBe("de");
    expect(macLanguage(null, { LANG: "pt_BR.UTF-8" }, "en-US")).toBe("pt-BR");
  });

  it("LC_ALL・LC_MESSAGES は LANG より強い", () => {
    expect(macLanguage(null, { LANG: "ja_JP.UTF-8", LC_ALL: "fr_FR.UTF-8" }, "en-US")).toBe("fr");
    expect(macLanguage(null, { LANG: "ja_JP.UTF-8", LC_MESSAGES: "ko_KR.UTF-8" }, "en-US")).toBe("ko");
  });

  it("C や空なら、システムの言語（Intl）を使う", () => {
    expect(macLanguage(null, { LANG: "C" }, "ja-JP")).toBe("ja");
    expect(macLanguage(null, {}, "ru-RU")).toBe("ru");
  });

  it("中国語は簡体と繁体を分ける", () => {
    expect(macLanguage(null, { LANG: "zh_CN.UTF-8" }, "en")).toBe("zh-Hans");
    expect(macLanguage(null, { LANG: "zh_TW.UTF-8" }, "en")).toBe("zh-Hant");
    expect(macLanguage(null, {}, "zh-Hant-TW")).toBe("zh-Hant");
    expect(macLanguage(null, {}, "zh-HK")).toBe("zh-Hant");
  });

  it("表のない言語は英語", () => {
    expect(macLanguage(null, { LANG: "it_IT.UTF-8" }, "ja-JP")).toBe("en");
  });

  it("macOS の優先する言語を、LANG より先に使う", () => {
    expect(macLanguage("ja-JP", { LANG: "en_US.UTF-8" }, "en-US")).toBe("ja");
    expect(macLanguage("zh-Hant-TW", { LANG: "en_US.UTF-8" }, "en-US")).toBe("zh-Hant");
  });

  it("文を訳す（日本語ならそのまま）", () => {
    expect(macText("つなぎ方:", "en")).toBe("Connect via:");
    expect(macText("つなぎ方:", "ja")).toBe("つなぎ方:");
  });
});
