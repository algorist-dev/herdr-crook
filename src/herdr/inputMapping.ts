// スマホから来たキー入力（バイト列）を、Herdr の API で送れる形に分ける。
// 「Mac と同じ表示」ではペインの制御を取らないので、文字は pane.send_text、特別なキーは pane.send_keys で送る。

export type Step = { text: string } | { keys: string[] };

const ESCAPES: Record<string, string> = {
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[Z": "shift+tab",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
};

export function bytesToSteps(bytes: Buffer): Step[] {
  const input = bytes.toString("utf8");
  const steps: Step[] = [];
  const pushText = (t: string) => {
    const last = steps.at(-1);
    if (last && "text" in last) last.text += t;
    else steps.push({ text: t });
  };
  const pushKey = (k: string) => {
    const last = steps.at(-1);
    if (last && "keys" in last) last.keys.push(k);
    else steps.push({ keys: [k] });
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const code = ch.charCodeAt(0);
    if (ch === "\x1b") {
      const seq = input.slice(i, i + 3);
      if (ESCAPES[seq]) {
        pushKey(ESCAPES[seq]);
        i += 3;
        continue;
      }
      // 知らない並び（\x1b[99~ など）は終わりの文字まで読み飛ばす
      const csi = /^\x1b\[[0-9;]*[~A-Za-z]/.exec(input.slice(i));
      if (csi) {
        i += csi[0].length;
        continue;
      }
      pushKey("esc");
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      pushKey("enter");
      // \r\n は 1 回の Enter
      i += ch === "\r" && input[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\t") pushKey("tab");
    else if (code === 0x7f || code === 0x08) pushKey("backspace");
    else if (code >= 0x01 && code <= 0x1a) pushKey(`ctrl+${String.fromCharCode(code + 0x60)}`);
    else if (code >= 0x20) pushText(ch);
    // それ以外の制御文字は捨てる
    i += 1;
  }
  return steps;
}
