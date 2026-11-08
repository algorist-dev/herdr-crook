#!/usr/bin/env node
// crook のコマンド。
//   serve      中継を動かす（ふつうは launchd が動かす）
//   pair       QR を出してスマホとつなぐ（Herdr のポップアップから呼ばれる）
//   install    ログインしたら中継が動くようにする
//   uninstall  それをやめる
//   ensure     中継が動いていなければ動かす（Herdr の起動フック）
//   devices    つないだスマホの一覧
//   revoke ID  スマホのつながりを消す
//   status     いまの様子
//   push-setup AuthKey_XXXX.p8 [チーム ID]   iPhone に通知を送るための Apple の鍵を入れる
//   push-test  つないだ iPhone に試しの通知を送る
import { serve } from "./app/serve.ts";
import { run as pair } from "./app/commands/pair.ts";
import { run as install } from "./app/commands/install.ts";
import { run as uninstall } from "./app/commands/uninstall.ts";
import { run as ensure } from "./app/commands/ensure.ts";
import { run as devices } from "./app/commands/devices.ts";
import { run as revoke } from "./app/commands/revoke.ts";
import { run as status } from "./app/commands/status.ts";
import { run as pushSetup } from "./app/commands/push-setup.ts";
import { run as pushTest } from "./app/commands/push-test.ts";
import { run as statusline } from "./app/commands/statusline.ts";
import { run as statuslineInstall } from "./app/commands/statusline-install.ts";

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const args = process.argv.slice(3);
  switch (command) {
    case "serve":
      return serve();
    case "pair":
      return pair(args);
    case "install":
      return install(args);
    case "uninstall":
      return uninstall(args);
    case "ensure":
      return ensure(args);
    case "devices":
      return devices(args);
    case "revoke":
      return revoke(args);
    case "status":
      return status(args);
    case "push-setup":
      return pushSetup(args);
    case "push-test":
      return pushTest(args);
    case "statusline":
      return statusline(args);
    case "statusline-install":
      return statuslineInstall(args);
    default:
      console.log("使い方: crook <serve|pair|install|uninstall|ensure|devices|revoke ID|status|push-setup KEY.p8|push-test|statusline-install>");
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
