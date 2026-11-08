// Mac の Herdr の設定（~/.config/herdr/config.toml）から [theme] だけを読む。
// Herdr の設定は TOML だが、テーマに要るところだけの小さな読み方にしてある。
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Herdr の 19 の色（custom に書けるキー） */
export const HERDR_COLORS = [
  "accent",
  "panel_bg",
  "sidebar_bg",
  "active_row_bg",
  "selection_bg",
  "surface0",
  "surface1",
  "surface_dim",
  "overlay0",
  "overlay1",
  "text",
  "subtext0",
  "mauve",
  "green",
  "yellow",
  "red",
  "blue",
  "teal",
  "peach",
] as const;

const colorKeys = new Set<string>(HERDR_COLORS);
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Mac の config.toml の [theme]。iPhone の HerdrThemeConfig と同じ形 */
export interface HerdrThemeConfig {
  name: string | null;
  autoSwitch: boolean;
  darkName: string | null;
  lightName: string | null;
  /** 19 の色 → #rrggbb */
  custom: Record<string, string>;
  customDark: Record<string, string>;
  customLight: Record<string, string>;
}

/** テーマと、変更に気づくためのファイルの時刻 */
export interface HerdrThemeSnapshot {
  theme: HerdrThemeConfig;
  mtimeMs: number;
}

export function emptyHerdrTheme(): HerdrThemeConfig {
  return { name: null, autoSwitch: false, darkName: null, lightName: null, custom: {}, customDark: {}, customLight: {} };
}

/** HERDR_CONFIG_PATH があればそこ、なければ ~/.config/herdr/config.toml */
export function herdrConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_CONFIG_PATH || join(homedir(), ".config", "herdr", "config.toml");
}

/** ファイルを読み、[theme]・[theme.custom]・[theme.custom.dark]・[theme.custom.light] だけを見る。
 * ファイルが無い・読めないときは空の設定。 */
export function readHerdrTheme(path: string): HerdrThemeConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyHerdrTheme();
  }
  return parseHerdrTheme(text);
}

/** テーマと変更時刻。ファイルが無ければ時刻は 0 */
export function readHerdrThemeSnapshot(path: string): HerdrThemeSnapshot {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  return { theme: readHerdrTheme(path), mtimeMs };
}

type Section = "theme" | "theme.custom" | "theme.custom.dark" | "theme.custom.light" | "other";

function parseHerdrTheme(text: string): HerdrThemeConfig {
  const theme = emptyHerdrTheme();
  let section: Section = "other";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = sectionOf(line.slice(1, -1).trim());
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = parseValue(line.slice(eq + 1).trim());
    if (value === null) continue;
    apply(theme, section, key, value);
  }
  return theme;
}

function sectionOf(name: string): Section {
  switch (name) {
    case "theme":
      return "theme";
    case "theme.custom":
      return "theme.custom";
    case "theme.custom.dark":
      return "theme.custom.dark";
    case "theme.custom.light":
      return "theme.custom.light";
    default:
      return "other";
  }
}

function apply(theme: HerdrThemeConfig, section: Section, key: string, value: string | boolean): void {
  if (section === "theme") {
    if (typeof value === "string") {
      if (key === "name") theme.name = value;
      else if (key === "dark_name") theme.darkName = value;
      else if (key === "light_name") theme.lightName = value;
    } else if (key === "auto_switch") {
      theme.autoSwitch = value;
    }
    return;
  }
  if (section === "other" || typeof value !== "string" || !HEX6.test(value) || !colorKeys.has(key)) return;
  if (section === "theme.custom") theme.custom[key] = value;
  else if (section === "theme.custom.dark") theme.customDark[key] = value;
  else if (section === "theme.custom.light") theme.customLight[key] = value;
}

/** 文字の外の # から後ろをコメントとして捨てる（"#ff0000" は残す） */
function stripComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseValue(raw: string): string | boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (!raw.startsWith('"')) return null;
  const end = raw.indexOf('"', 1);
  if (end < 0) return null;
  return raw.slice(1, end);
}
