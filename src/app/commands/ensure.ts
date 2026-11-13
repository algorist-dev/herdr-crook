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
  // launchd が古い場所を指したままだと、中継は古いコードのままで、そのうち起動できなくなる。
  const plistExists = existsSync(launchd.plistPath());
  const facts = {
    defaultSession: isDefaultSession(),
    customHome: Boolean(process.env.CROOK_HOME),
    plistExists,
    plistCurrent: plistExists && launchd.plistRunsCli(readFileSync(launchd.plistPath(), "utf8"), CLI),
  };
  let action = launchd.decideEnsure({ ...facts, relayUp: await relayIsUp() });
  if (action === "relocate") {
    try {
      await install();
      await waitForRelay();
      return;
    } catch {
      // 入れ直せなければ、いつもの確かめへ
      action = launchd.decideEnsure({ ...facts, plistCurrent: true, relayUp: await relayIsUp() });
    }
  }
  if (action === "none") return;
  if (action === "firstInstall") {
    await install();
    // GitHub から入れた人は install コマンドを打たないので、はじめての起動で prefix+m も足し、Herdr に読み直させる
    if (addKeybinding()) {
      execFile(resolveCommand(herdrBin()), ["server", "reload-config"], { timeout: 10_000 }, () => {});
    }
  } else {
    await launchd.kickstart().catch(() => install());
  }
  await waitForRelay();
}

async function waitForRelay(): Promise<void> {
  for (let i = 0; i < 20 && !(await relayIsUp()); i++) await sleep(250);
}

/** いつものセッション（名前付きの試しのセッションではない）か */
function isDefaultSession(): boolean {
  return resolveSocketPath(process.env, homedir()) === resolveSocketPath({}, homedir());
}
