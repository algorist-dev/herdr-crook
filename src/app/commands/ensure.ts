import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolveSocketPath } from "../../herdr/herdrClient.ts";
import * as launchd from "../launchd.ts";
import { CLI, herdrBin, relayIsUp, resolveCommand, sleep } from "../paths.ts";
import { execFile } from "node:child_process";
import { addKeybinding, install } from "./install.ts";

/** 中継が動いていなければ動かす（Herdr の起動フック） */
export async function run(_args: string[]): Promise<void> {
  // herdr plugin update は新しい場所へ入れ、次に Herdr が起動するときに古い場所を消す。
  // launchd が古い場所を指したままだと、中継は古いコードのままで、そのうち起動できなくなる。指している場所が
  // 今のコードと違えば入れ直す（local: でつないだプラグインは場所が変わらないので、ここには来ない）。
  // launchd の中継はいつものセッションのものなので、試しの名前付きセッションからは触らない
  if (isDefaultSession() && !process.env.CROOK_HOME && existsSync(launchd.plistPath()) && !launchd.plistRunsCli(readFileSync(launchd.plistPath(), "utf8"), CLI)) {
    try {
      await install();
      for (let i = 0; i < 20 && !(await relayIsUp()); i++) await sleep(250);
      return;
    } catch {
      // 入れ直せなければ、いつもの確かめへ
    }
  }
  if (await relayIsUp()) return;
  if (!existsSync(launchd.plistPath())) {
    // 自動で入れるのは、いつものセッションのときだけ（試しの名前付きセッションで上書きしないように）
    if (!isDefaultSession()) return;
    await install();
    // GitHub から入れた人は install コマンドを打たないので、はじめての起動で prefix+m も足し、Herdr に読み直させる
    if (addKeybinding()) {
      execFile(resolveCommand(herdrBin()), ["server", "reload-config"], { timeout: 10_000 }, () => {});
    }
  }
  else await launchd.kickstart().catch(() => install());
  for (let i = 0; i < 20 && !(await relayIsUp()); i++) await sleep(250);
}

/** いつものセッション（名前付きの試しのセッションではない）か */
function isDefaultSession(): boolean {
  return resolveSocketPath(process.env, homedir()) === resolveSocketPath({}, homedir());
}
