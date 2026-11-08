// 入力欄の「/」に出すコマンドを、Mac のファイルから集める共通の部品。
// どのエージェントがどのフォルダを見るかは providers/<名前>/commands.ts に書く。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { SlashCommandInfo, SlashCommandKind } from "../../features/slashCommands.ts";

export const MAX_DEPTH = 3;

export function command(name: string, summary: string): SlashCommandInfo {
  return { name, summary, kind: "command" };
}

export function skill(name: string, summary: string): SlashCommandInfo {
  return { name, summary, kind: "skill" };
}

/** どのエージェントにも出す、いちばん少ないコマンド */
export const COMMON: SlashCommandInfo[] = [
  command("clear", "会話を消して、最初からにする"),
  command("help", "使えるコマンドを見る"),
];

export function readCommands(dirs: string[], kind: SlashCommandKind): SlashCommandInfo[] {
  const result: SlashCommandInfo[] = [];
  for (const dir of dirs) {
    for (const path of markdownFiles(dir, MAX_DEPTH)) {
      const name = relative(dir, path).replace(/\.md$/, "").split(sep).join("/");
      if (!isCommandName(name)) continue;
      result.push({ name, summary: describeMarkdown(path), kind });
    }
  }
  return result;
}

export function readSkills(dirs: string[]): SlashCommandInfo[] {
  const result: SlashCommandInfo[] = [];
  for (const dir of dirs) {
    for (const entry of entries(dir)) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name, "SKILL.md");
      if (!isFile(path) || !isCommandName(entry.name)) continue;
      result.push(skill(entry.name, describeMarkdown(path)));
    }
  }
  return result;
}

function markdownFiles(dir: string, depth: number): string[] {
  if (depth < 0) return [];
  const result: string[] = [];
  for (const entry of entries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...markdownFiles(path, depth - 1));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      result.push(path);
    }
  }
  return result;
}

function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** ファイルの中身から説明を読む。frontmatter の description がなければ最初の見出しや行 */
function describeMarkdown(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const front = frontmatter(text);
  const described = front === null ? null : frontmatterDescription(front);
  if (described) return oneLine(described).slice(0, 160);
  const body = front === null ? text : text.slice(text.indexOf("\n---", 3) + 4);
  const line = body.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
  return oneLine(line ?? "").slice(0, 160);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** frontmatter の description。`>` や `|` で書いた複数行にも対応する */
function frontmatterDescription(front: string): string | null {
  const lines = front.split(/\r?\n/);
  const index = lines.findIndex((line) => /^description\s*:/.test(line));
  if (index < 0) return null;
  const inline = (lines[index] ?? "").replace(/^description\s*:\s*/, "").trim();
  if (inline && !/^[>|][+-]?$/.test(inline)) return unquote(inline);
  if (!/^[>|][+-]?$/.test(inline)) return null;
  const block: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim()) block.push(line.trim());
  }
  if (block.length === 0) return null;
  return inline.startsWith("|") ? block.join("\n") : block.join(" ");
}

function frontmatter(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  return end > 0 ? text.slice(3, end) : null;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function isCommandName(name: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(name) && name.length <= 100;
}
