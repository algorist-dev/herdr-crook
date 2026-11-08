import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolveSocketPath } from "../../herdr/herdrClient.ts";
import * as launchd from "../launchd.ts";
import { herdrBin, relayIsUp, resolveCommand, sleep } from "../paths.ts";
import { execFile } from "node:child_process";
import { addKeybinding, install } from "./install.ts";

/** 中継が動いていなければ動かす（Herdr の起動フック） */
export async function run(_args: string[]): Promise<void> {
  if (await relayIsUp()) return;
  if (!existsSync(launchd.plistPath())) {
    // 自動で入れるのは、いつものセッションのときだけ（試しの名前付きセッションで上書きしないように）
    const defaultSocket = resolveSocketPath({}, homedir());
    if (resolveSocketPath(process.env, homedir()) !== defaultSocket) return;
    await install();
    // GitHub から入れた人は install コマンドを打たないので、はじめての起動で prefix+m も足し、Herdr に読み直させる
    if (addKeybinding()) {
      execFile(resolveCommand(herdrBin()), ["server", "reload-config"], { timeout: 10_000 }, () => {});
    }
  }
  else await launchd.kickstart().catch(() => install());
  for (let i = 0; i < 20 && !(await relayIsUp()); i++) await sleep(250);
}
