import { ApnsClient, loadApnsConfig } from "../../notify/apns.ts";
import { HOME, store } from "../paths.ts";

/** つないだ iPhone に試しの通知を送る */
export async function run(_args: string[]): Promise<void> {
  const cfg = loadApnsConfig(HOME);
  if (!cfg) {
    console.error("まだ Apple の鍵が入っていません（push-setup）");
    process.exit(1);
  }
  const targets = store.pushTargets();
  if (targets.length === 0) {
    console.error("通知を受け取る iPhone がありません。アプリを開いて、通知を許してください");
    process.exit(1);
  }
  const client = new ApnsClient(cfg, { keepAlive: false });
  for (const t of targets) {
    const r = await client.send(t, {
      aps: { alert: { title: "Crook", body: "通知のためしです" }, sound: "default", "thread-id": "test", category: "hm.reply" },
      pane: "",
      kind: "finished",
    });
    console.log(`${t.deviceId}: ${r.ok ? "送りました" : `だめでした（${r.status} ${r.reason ?? ""}）`}`);
  }
  client.close();
}
