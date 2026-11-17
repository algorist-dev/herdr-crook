// 端末の画面での文字の幅（日本語などの全角は 2 桁）

/** 画面の 1 文字の幅（日本語などの全角は 2） */
export function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
    ? 2
    : 1;
}

/** 行の表示の幅（桁） */
export function displayWidth(line: string): number {
  let w = 0;
  for (const ch of line) w += charWidth(ch);
  return w;
}
