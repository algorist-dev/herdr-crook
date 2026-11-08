import { store } from "../paths.ts";
import { macText as t } from "../../i18n/mac.ts";

/** つないだスマホの一覧を出す */
export async function run(_args: string[]): Promise<void> {
  const list = store.listDevices();
  if (list.length === 0) {
    console.log(t("つないだ端末: なし"));
    return;
  }
  console.log(t("つないだ端末:"));
  for (const d of list) {
    console.log(`  ${d.id}  ${d.name}  ${t("最後に使った日時")} ${new Date(d.lastSeenAt).toLocaleString()}`);
  }
}
