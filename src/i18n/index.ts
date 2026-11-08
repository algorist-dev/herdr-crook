// 中継が iPhone に送る文言の訳。日本語の文を、その言語の表で引く。
// 言語を足すときは i18n/<言語>.ts を作って、下の TABLES に 1 行足す。
// 表に無い文は、英語 → 元の日本語（表に無ければそのまま）の順に使う。
import type { ServerMessage } from "../protocol/messages.ts";
import { en } from "./en.ts";
import { tr } from "./tr.ts";
import { fr } from "./fr.ts";
import { de } from "./de.ts";
import { es } from "./es.ts";
import { ptBR } from "./pt-BR.ts";
import { ru } from "./ru.ts";
import { ko } from "./ko.ts";
import { zhHant } from "./zh-Hant.ts";
import { zhHans } from "./zh-Hans.ts";

export interface TranslationTable {
  exact: Record<string, string>;
  patterns: [RegExp, string][];
}

export const TABLES: Record<string, TranslationTable> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  "ko": ko,
  "ru": ru,
  "pt-BR": ptBR,
  "es": es,
  "de": de,
  "fr": fr,
  "tr": tr,
};

/** 表のある言語（取りこぼしのテストが見る） */
export const TRANSLATION_LANGUAGES = Object.keys(TABLES);

/** lang の表。無ければ英語。英語も無ければ null */
function tableFor(lang: string): TranslationTable | null {
  return TABLES[lang] ?? TABLES.en ?? null;
}

export function localize(lang: string, text: string): string {
  if (lang === "ja") return text;
  const table = tableFor(lang);
  if (!table) return text;
  const exact = table.exact[text];
  if (exact !== undefined) return exact;
  for (const [pattern, replacement] of table.patterns) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

/** iPhone に送る直前に、届く文言だけを訳す（会話の本文やツールの出力そのものには触らない） */
export function localizeServerMessage(lang: string, msg: ServerMessage): ServerMessage {
  if (lang === "ja") return msg;
  switch (msg.t) {
    case "error":
      return { ...msg, message: localize(lang, msg.message) };
    case "pushTested":
      return msg.message === null ? msg : { ...msg, message: localize(lang, msg.message) };
    case "modelSet":
      return msg.message === null ? msg : { ...msg, message: localize(lang, msg.message) };
    case "choices":
      return msg.question === null ? msg : { ...msg, question: localize(lang, msg.question) };
    case "commands":
      return { ...msg, commands: msg.commands.map((command) => ({ ...command, summary: localize(lang, command.summary) })) };
    case "usage":
      if (msg.usage === null) return msg;
      return { ...msg, usage: { ...msg.usage, limits: msg.usage.limits.map((limit) => ({ ...limit, label: localize(lang, limit.label) })) } };
    case "models":
      return { ...msg, models: msg.models.map((model) => ({ ...model, name: localize(lang, model.name) })) };
    case "toolDetail":
      if (msg.detail === null) return msg;
      return {
        ...msg,
        detail: {
          ...msg.detail,
          sections: msg.detail.sections.map((section) => ({ ...section, label: localize(lang, section.label) })),
        },
      };
    case "chat":
      return {
        ...msg,
        items: msg.items.map((item) => ({
          ...item,
          ...(item.tool !== undefined ? { tool: localize(lang, item.tool) } : {}),
          ...(item.kind === "text" ? { text: localizeImageMark(lang, item.text) } : {}),
        })),
      };
    default:
      return msg;
  }
}

/** 会話の本文のうしろに付いた「（画像）」「（画像 N 枚）」だけを訳す */
function localizeImageMark(lang: string, text: string): string {
  return text.replace(/（画像 (\d+) 枚）$/, (_, count: string) => localize(lang, `（画像 ${count} 枚）`)).replace(/（画像）$/, () => localize(lang, "（画像）"));
}
