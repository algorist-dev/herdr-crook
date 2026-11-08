// Herdr の設定（~/.config/herdr/config.toml）に「prefix+m で QR を出す」を足す。
export const PAIR_ACTION = "algorist.crook.pair";
const KEY = "prefix+m";

/** 足した後の設定を返す。もう入っている・prefix+m が使われているときは null（触らない）。 */
export function addPairKeybinding(config: string): string | null {
  if (config.includes(PAIR_ACTION)) return null;
  if (config.includes(`"${KEY}"`)) return null;
  const block = [
    "",
    "# Crook: pair iPhone or iPad (show QR code)",
    "[[keys.command]]",
    `key = "${KEY}"`,
    'type = "plugin_action"',
    `command = "${PAIR_ACTION}"`,
    'description = "Pair iPhone or iPad with Crook"',
    "",
  ].join("\n");
  const base = config.length === 0 || config.endsWith("\n") ? config : `${config}\n`;
  return base + block;
}
