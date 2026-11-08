import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveStatusline } from "../../providers/claude/statusline.ts";
import { HOME } from "../paths.ts";

/** Claude の statusline から渡された JSON を残す（標準入力から読む。画面には何も出さない） */
export async function run(_args: string[]): Promise<void> {
  const raw = readFileSync(0, "utf8");
  if (!raw.trim()) return;
  const payload = JSON.parse(raw);
  saveStatusline(join(HOME, "statusline"), payload);
}
