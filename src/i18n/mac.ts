// Mac の画面（QR の小窓・コマンドの出力）の文言を、Mac の言語で出す。訳は iPhone 向けと同じ表から引く。
import { execFileSync } from "node:child_process";
import { localize, TABLES } from "./index.ts";

/** 言語の名前（ja-JP・en_US.UTF-8・zh-Hant-TW など）を、表のある言語にする。無ければ英語 */
export function languageFromTag(raw: string): string {
  const tag = raw.split(".")[0]!.replace(/_/g, "-");
  const [base = "", ...rest] = tag.split("-");
  const lower = base.toLowerCase();
  if (lower === "ja") return "ja";
  if (lower === "zh") {
    const traditional = rest.some((p) => ["Hant", "TW", "HK", "MO"].includes(p));
    return traditional ? "zh-Hant" : "zh-Hans";
  }
  if (lower === "pt") return "pt-BR";
  return lower in TABLES ? lower : "en";
}

/**
 * Mac の言語。macOS の「優先する言語」の 1 番目 → 環境変数（LC_ALL → LC_MESSAGES → LANG）→ Intl の順。
 * ターミナルは LANG が en_US のままのことが多いので、macOS の設定を先に見る（2026-11-08 にこの Mac で見た）
 */
export function macLanguage(
  appleLanguage: string | null = readAppleLanguage(),
  env: Record<string, string | undefined> = process.env,
  systemLocale: string = Intl.DateTimeFormat().resolvedOptions().locale,
): string {
  const fromEnv = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v && v !== "C" && v !== "POSIX");
  return languageFromTag(appleLanguage ?? fromEnv ?? systemLocale);
}

/** `defaults read -g AppleLanguages` の 1 番目（読めなければ null） */
function readAppleLanguage(): string | null {
  try {
    const out = execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 2000 });
    return /"?([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)"?/.exec(out.replace(/^\(\s*/, ""))?.[1] ?? null;
  } catch {
    return null;
  }
}

let cached: string | null = null;

/** 日本語の文を、Mac の言語にする */
export function macText(text: string, lang: string = (cached ??= macLanguage())): string {
  return localize(lang, text);
}
