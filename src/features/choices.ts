import { charWidth, displayWidth } from "./textWidth.ts";

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
  /** 複数選択の質問の選択肢なら、いま印が付いているか（ラベルの「[ ]」「[✔]」はそのまま残す。古いアプリでも読めるように） */
  checked?: boolean;
}

/** 質問が 2 つ以上の AskUserQuestion の上の並び（← ☐ 果物  ☒ 飲み物  ✔ Submit →）の 1 つ */
export interface ChoiceTab {
  label: string;
  /** 答えたか（☒） */
  done: boolean;
  /** 最後の「Submit」（答えを確かめて送る） */
  submit?: true;
}

export interface Choices {
  question: string | null;
  options: Choice[];
  /** いまカーソルがある番号 */
  selected: string | null;
  /** 質問が 2 つ以上のときの上の並び。← → で行き来する */
  tabs?: ChoiceTab[];
  /** 複数選択の質問（番号で印を付け外しし、→ で次へ） */
  multi?: true;
}

// 選んでいる行の印：Claude は ❯、Codex は ›、Gemini CLI は ●
const OPTION = /^(\s*)(?:([❯›>●])\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const SEPARATOR = /^[\s─━—\-=]+$/;
// 複数選択の印（Claude は「[ ]」と「[✔]」）
const CHECKBOX = /^\[([ ✔✓xX×])\uFE0F?\]\s/;
// 質問が 2 つ以上のときの上の並び
const TAB_BAR = /^\s*←\s+(.+?)\s+→\s*$/;
// OpenCode の許可の選択肢（この並び順で、あるものだけ出す）
const PERMISSION_LABELS = ["Allow once", "Allow always", "Reject"];
// 枠の線（Claude は「│ 1. Yes │」、OpenCode は「  ┃  1. A」のように頭に空白が付く）
const BOX = /^\s*[│┃|]\s?|\s?[│┃|]$/g;

function clean(line: string): string {
  return line.replace(/\s+$/, "").replace(BOX, "").replace(/\s+$/, "");
}

/**
 * 折り返した行をつなぐ。前の行が画面の端まで埋まっていれば語の途中で折れた（日本語など）のでそのまま、
 * 端まで行かずに折れていれば空白のところで折れたので、空白を 1 つ入れる。スマホの幅（49 桁）で見ていると
 * AskUserQuestion の説明や質問が何行にも折れる（2026-11-17）
 */
function joinWrapped(text: string, prevRaw: string, next: string, width: number): string {
  const prev = prevRaw.replace(/\s+$/, "");
  // 語の途中で折れるのは全角の字で終わるときだけ（英語は空白で折れる。全角は端の 1 桁に入らないので -1 まで見る）
  const lastChar = [...prev].pop() ?? "";
  const midWord = charWidth(lastChar) === 2 && displayWidth(prev) >= width - 1;
  return midWord ? text + next : `${text} ${next}`;
}

export function parseChoices(screen: string): Choices | null {
  const raw = screen.split("\n");
  const lines = raw.map(clean);
  // 画面の幅は、いちばん長い行（区切り線は端まで届く）から見積もる
  const width = Math.max(0, ...raw.map((l) => displayWidth(l.replace(/\s+$/, ""))));
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
  // 説明のあとに空の行や区切り線があったか（そのあとの下げた行は説明の続きではない。下の案内など）
  let gap = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const m = OPTION.exec(line);
    if (m && Number(m[3]) === expected) {
      gap = false;
      optionIndent = m[1]!.length;
      const label = m[4]!.trim();
      const box = CHECKBOX.exec(label);
      options.push(box ? { key: m[3]!, label, detail: null, checked: box[1] !== " " } : { key: m[3]!, label, detail: null });
      if (m[2]) selected = m[3]!;
      expected++;
      continue;
    }
    if (!line.trim() || SEPARATOR.test(line)) {
      gap = true;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const last = options[options.length - 1];
    // 複数選択の「Type something」の下の「Next」「Submit」は、説明ではなく次へ進むボタン（→ と同じ）
    if (last?.checked !== undefined && /^(?:Next|Submit)$/.test(line.trim())) continue;
    // ずっと右にある文字は枠の飾り（OpenCode の「/~」など）。説明ではない
    if (indent > optionIndent + 12) continue;
    // 選択肢より深く下げてある行は、その説明。続く行は折り返し
    if (last && indent > optionIndent + 2 && !(gap && last.detail !== null)) {
      last.detail = last.detail === null ? line.trim() : joinWrapped(last.detail, raw[i - 1]!, line.trim(), width);
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
      // Claude の質問は左にだけ線（│）が付く。その中で折り返した質問は、上の行からつなぐ
      // （Gemini のように左右に線がある枠は、枠の中身ごと混ざるのでつながない）
      const quoted = (l: string) => /^\s*│/.test(l) && !/│\s*$/.test(l);
      let top = i;
      while (top > 0 && quoted(raw[top]!) && quoted(raw[top - 1]!) && lines[top - 1]!.trim()) top--;
      if (top < i) {
        question = lines[top]!.trim();
        for (let k = top + 1; k <= i; k++) question = joinWrapped(question, raw[k - 1]!, lines[k]!.trim(), width);
      }
      break;
    }
  }
  question ??= fallback;
  const result: Choices = { question, options, selected };
  const tabs = parseTabs(lines, start);
  if (tabs) result.tabs = tabs;
  if (options.some((o) => o.checked !== undefined)) result.multi = true;
  return result;
}

/** 選択肢より上にある「← ☐ 果物  ☒ 飲み物  ✔ Submit →」を読む（質問が 1 つなら出ない） */
function parseTabs(lines: string[], start: number): ChoiceTab[] | undefined {
  // 並びは区切り線のすぐ下にある。区切り線より上（前に流れた画面の残り）は見ない
  for (let i = start - 1; i >= 0 && i >= start - 20; i--) {
    if (SEPARATOR.test(lines[i]!) && lines[i]!.trim()) return undefined;
    const bar = TAB_BAR.exec(lines[i]!);
    if (!bar) continue;
    const items = bar[1]!.split(/\s{2,}/).map((part) => /^([☐☒✔✓])\s*(.+)$/.exec(part.trim()));
    if (items.length < 2 || items.some((m) => !m)) return undefined;
    return items.map((m, k) => {
      const [, mark, label] = m!;
      if (k === items.length - 1 && (mark === "✔" || mark === "✓")) return { label: label!, done: false, submit: true as const };
      return { label: label!, done: mark === "☒" };
    });
  }
  return undefined;
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

// 選択肢のすぐ下に出る、いま選ばせているときだけの案内（Claude Code の AskUserQuestion）。
// 「Enter to confirm」「Esc to cancel」だけだと、Mac で人が開いた /model などの一覧まで返事待ちにして
// iPhone に知らせてしまうので、AskUserQuestion の 2 つがそろったときだけにする
// 質問が 2 つ以上・複数選択のときは「Tab/Arrow keys to navigate」になる
const ASKING_FOOTER = [/Enter\s+to\s+select/, /(?:↑\/↓|Tab\/Arrow\s+keys)\s+to\s+navigate/];
// 質問が 2 つ以上のときの最後の確かめの画面（下の案内がない）
const REVIEW_HEADING = /Ready to submit your answers\?/;

/**
 * 画面がいま選択肢で答えを待っているか。選択肢が読めて、その下に「Enter to select」などの案内があるときだけ。
 * Herdr が返事待ち（blocked）と done を行き来することがあるので（2026-11-17、監督のペインで見た）、
 * done や idle のときに画面で確かめ直すのに使う。会話の中の番号付きの箇条書きだけでは待っていることにしない
 */
export function isAskingOnScreen(screen: string): boolean {
  if (!parseChoices(screen)) return false;
  const lines = screen.split("\n").map(clean);
  let first = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPTION.exec(lines[i]!);
    if (m && m[3] === "1") {
      first = i;
      break;
    }
  }
  if (first < 0) return false;
  const below = lines.slice(first + 1).join("\n");
  if (ASKING_FOOTER.every((re) => re.test(below))) return true;
  // 質問が 2 つ以上の最後の確かめの画面には下の案内がないので、上の並びと見出しの両方で見分ける
  return parseTabs(lines, first) !== undefined && lines.slice(0, first).some((l) => REVIEW_HEADING.test(l));
}
