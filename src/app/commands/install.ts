import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSocketPath } from "../../herdr/herdrClient.ts";
import { addPairKeybinding } from "../../herdr/herdrConfig.ts";
import * as launchd from "../launchd.ts";
import { CLI, HOME, herdrBin, resolveCommand } from "../paths.ts";
import { installStatusline } from "./statusline-install.ts";
import { macText as t } from "../../i18n/mac.ts";

/** prefix+m で QR を出せるよう、Herdr の設定に足す。足したら true */
export function addKeybinding(): boolean {
  const dir = join(homedir(), ".config", "herdr");
  const path = join(dir, "config.toml");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = addPairKeybinding(current);
  if (next === null) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, next);
  return true;
}

/** ログインしたら中継が動くようにする（ensure からも呼ぶ。画面には何も出さない。Claude の statusline には触らない） */
export async function install(): Promise<void> {
  const bin = resolveCommand(herdrBin());
  await launchd.install({
    node: process.execPath,
    cli: CLI,
    home: HOME,
    env: {
      HERDR_BIN: bin,
      HERDR_SOCKET_PATH: resolveSocketPath(process.env, homedir()),
      TAILSCALE_BIN: resolveCommand(process.env.TAILSCALE_BIN ?? "tailscale"),
    },
  });
}

/** install コマンド（自動起動と、prefix+m の設定） */
export async function run(_args: string[]): Promise<void> {
  await install();
  console.log(t("ログインしたら中継が動くようにしました。"));
  // 人が install を打ったときだけ、Claude の statusline に 1 行足す（Herdr の起動で勝手に書き換えない）
  const hook = installStatusline();
  if (hook.ok) console.log(`${t("使用量:")} ${hook.message}`);
  if (addKeybinding()) console.log(t("Herdr で prefix+m を押すと QR が出るようにしました（設定の再読み込みか Herdr の再起動で効きます）。"));
}
