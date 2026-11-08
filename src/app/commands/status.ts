import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { HerdrClient, resolveSocketPath } from "../../herdr/herdrClient.ts";
import * as launchd from "../launchd.ts";
import { Tailscale } from "../../net/tailscale.ts";
import { PORT, relayIsUp } from "../paths.ts";
import { run as runDevices } from "./devices.ts";
import { macText as t } from "../../i18n/mac.ts";

/** いまの様子（中継・Tailscale・Herdr・自動起動・つないだスマホ） */
export async function run(_args: string[]): Promise<void> {
  const self = await new Tailscale().self();
  const up = await relayIsUp();
  const herdrOk = await new HerdrClient(resolveSocketPath(process.env, homedir()))
    .request("ping", {}, 2000)
    .then(() => true)
    .catch(() => false);
  console.log(`${t("中継:")} ${up ? t("動いています") : t("止まっています")} (${t("ポート")} ${PORT})`);
  console.log(`Tailscale: ${self ? `${self.ipv4}  ${self.dnsName ?? ""}` : t("動いていません")}`);
  console.log(`Herdr: ${herdrOk ? t("動いています") : t("止まっています")}`);
  console.log(`${t("自動で起動:")} ${existsSync(launchd.plistPath()) ? t("する") : t("しない（install で有効）")}`);
  await runDevices([]);
}
