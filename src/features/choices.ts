// 返事待ちのエージェントの画面から、いま聞かれている選択肢を読む（Orca のように、番号だけでなく中身を見せるため）。
// Claude Code の許可の確認（1. Yes / 2. … / 3. No）と AskUserQuestion の両方。いちばん下にある選択肢のまとまりを使う。

export interface Choice {
  /** 画面に出す番号 */
  key: string;
  label: string;
  /** 選択肢の下の説明（あれば） */
  detail: string | null;
  /** 押すキーの並び（横並びの許可のように、選ぶまで移動が要るとき） */
  keys?: string[];
}

export interface Choices {
  question: string | null;
  options: Choice[];
  /** いまカーソルがある番号 */
  selected: string | null;
}

// 選んでいる行の印：Claude は ❯、Codex は ›、Gemini CLI は ●
const OPTION = /^(\s*)(?:([❯›>●])\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const SEPARATOR = /^[\s─━—\-=]+$/;
// OpenCode の許可の選択肢（この並び順で、あるものだけ出す）
const PERMISSION_LABELS = ["Allow once", "Allow always", "Reject"];
// 枠の線（Claude は「│ 1. Yes │」、OpenCode は「  ┃  1. A」のように頭に空白が付く）
const BOX = /^\s*[│┃|]\s?|\s?[│┃|]$/g;

function clean(line: string): string {
  return line.replace(/\s+$/, "").replace(BOX, "").replace(/\s+$/, "");
}

export function parseChoices(screen: string): Choices | null {
  const lines = screen.split("\n").map(clean);
  // OpenCode の「Always allow」の確認（Confirm / Cancel）は、許可のあとにもう 1 回出る
  const confirm = parseAlwaysAllow(lines);
  if (confirm) return confirm;
  // OpenCode の許可の確認は番号がなく、横に並ぶ
  const permission = parsePermission(lines);
  if (permission) return permission;
  // いちばん下の「1.」から始まるまとまり
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPTION.exec(lines[i]!);
    if (m && m[3] === "1") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const options: Choice[] = [];
  let selected: string | null = null;
  let optionIndent = -1;
  let expected = 1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const m = OPTION.exec(line);
    if (m && Number(m[3]) === expected) {
      optionIndent = m[1]!.length;
      options.push({ key: m[3]!, label: m[4]!.trim(), detail: null });
      if (m[2]) selected = m[3]!;
      expected++;
      continue;
    }
    if (!line.trim() || SEPARATOR.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const last = options[options.length - 1];
    // ずっと右にある文字は枠の飾り（OpenCode の「/~」など）。説明ではない
    if (indent > optionIndent + 12) continue;
    // 選択肢より深く下げてある行は、その説明
    if (last && indent > optionIndent + 2 && last.detail === null) {
      last.detail = line.trim();
      continue;
    }
    break;
  }
  if (options.length < 2) return null;

  let question: string | null = null;
  let fallback: string | null = null;
  // 質問は選択肢のすぐ上。コマンドや前置きが挟まっていても、? の付いた行を優先する
  for (let i = start - 1; i >= 0 && i >= start - 10; i--) {
    const line = lines[i]!.trim();
    if (!line || SEPARATOR.test(line) || /^[╭╰┌└]/.test(line)) continue;
    fallback ??= line;
    if (line.includes("?") || line.includes("？")) {
      question = line;
      break;
    }
  }
  question ??= fallback;
  return { question, options, selected };
}

/**
 * OpenCode で「Allow always」を選んだあとの確認（Confirm / Cancel）。
 * 「Always allow」の見出しのあとに、許可するパターンと 2 つのボタンが並ぶ。
 * 右の Cancel を選ぶには右矢印を送ってから Enter（esc でもやめられる）。
 */
function parseAlwaysAllow(lines: string[]): Choices | null {
  let header = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(?:[△⚠]\s*)?Always allow\s*$/i.test(lines[i]!)) {
      header = i;
      break;
    }
  }
  if (header < 0) return null;
  const chunk = lines.slice(header, Math.min(lines.length, header + 12));
  const hasConfirm = chunk.some((line) => /\bConfirm\b/.test(line));
  const hasCancel = chunk.some((line) => /\bCancel\b/.test(line));
  if (!hasConfirm || !hasCancel) return null;
  const options: Choice[] = [
    { key: "1", label: "Confirm", detail: null, keys: ["enter"] },
    { key: "2", label: "Cancel", detail: null, keys: ["right", "enter"] },
  ];
  // 見出しの下の説明（折り返していることがある）を質問にする。ボタンやパターンの行は飛ばす
  const question = chunk
    .slice(1)
    .map((line) => line.trim())
    .find(
      (line) =>
        line &&
        !/\bConfirm\b|\bCancel\b/.test(line) &&
        !/^[-•]/.test(line) &&
        !/select|enter confirm/i.test(line),
    );
  return { question: question ?? "Always allow", options, selected: "1" };
}

/**
 * OpenCode の「Permission required」。Allow once / Allow always / Reject が横に並ぶ。
 * 番号キーは効かないので、選ぶところまで矢印を送ってから Enter を押す。
 * 許可の種類によっては 2 つだけ（Allow once / Reject）のこともある。
 */
function parsePermission(lines: string[]): Choices | null {
  let header = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/Permission required/i.test(lines[i]!)) {
      header = i;
      break;
    }
  }
  // ずっと前の許可を拾わないように、いま見えている範囲の下のほうだけ見る
  if (header < 0 || lines.length - header > 30) return null;
  // 許可の選択肢は、ヘッダーのあとの数行のどこかにある（狭いと折り返すので、まとめて探す）
  const chunk = lines.slice(header, Math.min(lines.length, header + 12));
  const labels = PERMISSION_LABELS.filter((label) => chunk.some((line) => line.includes(label)));
  if (labels.length < 2) return null;
  const options: Choice[] = labels.map((label, index) => ({
    key: String(index + 1),
    label,
    detail: null,
    // いま選ばれているのが 1 番目という前提（ふつうはそう）。右に動かしてから Enter
    keys: [...Array.from({ length: index }, () => "right"), "enter"],
  }));
  const questionLine = chunk.slice(1).find((line) => line.trim() && !labels.some((label) => line.includes(label)));
  return { question: questionLine?.trim() || "許可しますか？", options, selected: "1" };
}
