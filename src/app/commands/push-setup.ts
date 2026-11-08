import { saveApnsConfig } from "../../notify/apns.ts";
import { DEFAULT_TEAM, HOME } from "../paths.ts";

/** iPhone に通知を送るための Apple の鍵を入れる */
export async function run(args: string[]): Promise<void> {
  const [keyPath, team] = args;
  if (!keyPath) {
    console.error("使い方: crook push-setup <AuthKey_XXXXXXXXXX.p8> [チーム ID]");
    process.exit(1);
  }
  saveApnsConfig(HOME, { keyPath, teamId: team ?? DEFAULT_TEAM, topic: "jp.algorist.crook" });
  console.log("入れました。1 分ほどで中継が通知を送り始めます。試すには: node src/cli.ts push-test");
}
