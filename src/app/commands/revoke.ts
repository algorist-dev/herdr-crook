import { store } from "../paths.ts";
import { macText as t } from "../../i18n/mac.ts";

/** つないだスマホのつながりを消す */
export async function run(args: string[]): Promise<void> {
  const [arg] = args;
  if (!arg) throw new Error("消すスマホの ID を指定してください（devices で見られます）");
  console.log(store.revoke(arg) ? t("消しました。") : t("その ID の端末はありません。"));
}
