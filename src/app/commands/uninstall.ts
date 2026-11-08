import * as launchd from "../launchd.ts";
import { macText as t } from "../../i18n/mac.ts";

/** ログインしたら中継が動くのをやめる */
export async function run(_args: string[]): Promise<void> {
  await launchd.uninstall();
  console.log(t("中継の自動起動をやめました。"));
}
