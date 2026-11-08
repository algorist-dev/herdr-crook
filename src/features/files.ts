// 入力欄で「@」を打ったときのファイルの候補。Orca と同じように、いまの作業フォルダのファイルから選べる。
// git の管理しているファイルがあればそれを使い（.gitignore を尊重する）、なければフォルダを少しだけ歩く。
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface FileListSources {
  /** ペインの作業フォルダ。分からなければ null（候補は空） */
  cwd: string | null;
  /** 入力欄で「@」のあとに打った文字 */
  query: string;
  /** 返す数（既定 50） */
  limit?: number;
  /** git がないときに歩くファイルの上限 */
  scanLimit?: number;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_SCAN_LIMIT = 20_000;
const MAX_DEPTH = 8;
// 同じフォルダで打つたびに git を呼ばないように、少しのあいだ覚えておく
const GIT_CACHE_MS = 5_000;
const gitCache = new Map<string, { at: number; files: string[] }>();
// 中身を見ても意味がない・大きすぎるフォルダ
const SKIP_DIRS = new Set([
  ".git",
  ".build",
  ".next",
  ".nuxt",
  ".cache",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "Pods",
  "DerivedData",
  ".venv",
  "venv",
  "__pycache__",
]);

/** 作業フォルダのファイルから、打った文字に合うものを返す */
export function listFiles(sources: FileListSources): string[] {
  const { cwd } = sources;
  if (!cwd || !isDirectory(cwd)) return [];
  const files = gitFiles(cwd) ?? walkFiles(cwd, sources.scanLimit ?? DEFAULT_SCAN_LIMIT);
  return matchFiles(files, sources.query, sources.limit ?? DEFAULT_LIMIT);
}

/** 打った文字に合うものを、頭・ファイル名・どこかに含む の順に並べる */export function matchFiles(files: string[], query: string, limit = DEFAULT_LIMIT): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const head: string[] = [];
  const name: string[] = [];
  const rest: string[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    if (lower.startsWith(q)) head.push(path);
    else if (basename(lower).startsWith(q)) name.push(path);
    else if (lower.includes(q)) rest.push(path);
  }
  return [...head, ...name, ...rest].slice(0, limit);
}

function basename(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/** git が使えれば、管理しているファイル（未追跡で .gitignore されていないものも）を返す */
function gitFiles(cwd: string): string[] | null {
  const cached = gitCache.get(cwd);
  if (cached && Date.now() - cached.at < GIT_CACHE_MS) return cached.files;
  try {
    const out = execFileSync("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const text = out.toString("utf8");
    const files = text ? text.split("\0").filter((p) => p && !p.includes("\n")) : [];
    gitCache.set(cwd, { at: Date.now(), files });
    return files;
  } catch {
    return null;
  }
}

function walkFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (files.length >= limit || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (SKIP_DIRS.has(entry.name) && entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const path = relative(root, full).split(sep).join("/");
        if (!path.includes("\n")) files.push(path);
      }
    }
  };
  walk(root, 0);
  return files;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
