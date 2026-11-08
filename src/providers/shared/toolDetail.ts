// 会話のツールの行を押したときに見せる中身。エージェントごとの違い（記録の読み方）は providers が吸収し、
// 「どのツールをどんな見出しで出すか」はここ 1 か所に書く。
type Rec = Record<string, unknown>;

export interface ToolDetail {
  /** 実行中（結果がまだ無い）か */
  running: boolean;
  /** 失敗した（エージェントがエラーと記録した）か */
  error: boolean;
  /** 上から並べる中身 */
  sections: ToolSection[];
}

export interface ToolSection {
  /** 見出し（「コマンド」「ファイル」「出力」「変更」「渡したもの」など） */
  label: string;
  /** code：等幅／diff：行頭の + - で色を付ける／text：ふつうの文 */
  style: "code" | "diff" | "text";
  text: string;
  /** 長すぎて切った */
  truncated: boolean;
}

/** provider が取り出した、1 つのツールの呼び出しと結果 */
export interface ToolCall {
  name: string;
  /** tool_use の input・arguments・state.input など（オブジェクトか JSON の文字） */
  input: unknown;
  /** 返ってきたもの（文字にしたもの） */
  output?: string | null;
  running?: boolean;
  error?: boolean;
}

/** 1 つの section の上限（32 KB） */
export const TOOL_SECTION_BYTES = 32 * 1024;
/** 全部の section の上限（128 KB） */
export const TOOL_TOTAL_BYTES = 128 * 1024;

const BASH = new Set(["bash", "shell", "local_shell_call"]);
const READ = new Set(["read"]);
const WRITE = new Set(["write"]);
const EDIT = new Set(["edit", "multiedit"]);
const PATCH = new Set(["apply_patch"]);
const SEARCH = new Set(["grep", "glob"]);
const WEB = new Set(["webfetch", "websearch", "fetch", "web_search"]);

export function buildToolDetail(call: ToolCall): ToolDetail {
  const key = call.name.toLowerCase();
  const input = asRecord(call.input);
  const running = call.running === true;
  const output = call.output ?? "";
  const sections: ToolSection[] = [];
  const add = (label: string, style: ToolSection["style"], text: string) => {
    if (text) sections.push({ label, style, text, truncated: false });
  };

  if (BASH.has(key)) {
    const description = text(input.description);
    if (description) add("説明", "text", description);
    add("コマンド", "code", commandText(input));
    if (!running) add("出力", "code", output);
  } else if (READ.has(key)) {
    const path = filePath(input);
    add("ファイル", "code", withRange(path, input));
    if (!running) add("中身", "code", output || (isImagePath(path) ? "（画像）" : ""));
  } else if (WRITE.has(key)) {
    add("ファイル", "code", filePath(input));
    add("書いた中身", "code", contentText(input.content));
  } else if (EDIT.has(key)) {
    add("ファイル", "code", filePath(input));
    add("変更", "diff", editDiff(input));
    if (!running) add("結果", "text", output);
  } else if (PATCH.has(key)) {
    add("変更", "diff", patchText(call.input, input));
  } else if (SEARCH.has(key)) {
    add("探したもの", "code", searchText(input));
    if (!running) add("見つかったもの", "code", output);
  } else if (WEB.has(key)) {
    add("場所", "code", text(input.url) ?? text(input.query) ?? "");
    if (!running) add("結果", "text", output);
  } else {
    add("渡したもの", "code", jsonText(call.input));
    if (!running) add("結果", "code", output);
  }

  return { running, error: call.error === true, sections: limitToolSections(sections) };
}

/** 32 KB・128 KB で後ろを切る */
export function limitToolSections(sections: ToolSection[]): ToolSection[] {
  let budget = TOOL_TOTAL_BYTES;
  return sections.map((section) => {
    const capped = cutToBytes(section.text, TOOL_SECTION_BYTES);
    let truncated = capped.length !== section.text.length || section.truncated;
    let text = capped;
    if (byteLength(text) > budget) {
      text = cutToBytes(text, budget);
      truncated = true;
    }
    budget -= byteLength(text);
    return { ...section, text, truncated };
  });
}

function asRecord(value: unknown): Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function cutToBytes(value: string, max: number): string {
  if (max <= 0) return "";
  if (byteLength(value) <= max) return value;
  let used = 0;
  let out = "";
  for (const char of value) {
    const n = byteLength(char);
    if (used + n > max) break;
    out += char;
    used += n;
  }
  return out;
}

function commandText(input: Rec): string {
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) return command.map((v) => String(v)).join(" ");
  if (typeof command === "string") return command;
  return "";
}

function filePath(input: Rec): string {
  return text(input.file_path) ?? text(input.filePath) ?? text(input.path) ?? "";
}

function withRange(path: string, input: Rec): string {
  const extra: string[] = [];
  if (typeof input.offset === "number") extra.push(`offset: ${input.offset}`);
  if (typeof input.limit === "number") extra.push(`limit: ${input.limit}`);
  return [path, ...extra].filter(Boolean).join("\n");
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join("\n");
  return "";
}

function editDiff(input: Rec): string {
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  return edits
    .map((edit) => {
      if (!edit || typeof edit !== "object") return "";
      const e = edit as Rec;
      const oldLines = linesOf(e.old_string).map((line) => `-${line}`);
      const newLines = linesOf(e.new_string).map((line) => `+${line}`);
      return [...oldLines, ...newLines].join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

function linesOf(value: unknown): string[] {
  return typeof value === "string" ? value.split("\n") : [];
}

function patchText(raw: unknown, input: Rec): string {
  if (typeof raw === "string") return raw;
  return text(input.patch) ?? jsonText(raw);
}

function searchText(input: Rec): string {
  return ["pattern", "path", "glob"]
    .map((key) => text(input[key]))
    .filter((v): v is string => Boolean(v))
    .join("\n");
}

function jsonText(raw: unknown): string {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed !== null && typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : raw;
    } catch {
      return raw;
    }
  }
  if (raw === undefined || raw === null) return "";
  return JSON.stringify(raw, null, 2);
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i.test(path);
}
