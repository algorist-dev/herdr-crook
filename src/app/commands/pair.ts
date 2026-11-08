import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { PAIRING_CODE_TTL_MS } from "../../pairing/pairing.ts";
import { buildPairingUrl } from "../../pairing/pairingUrl.ts";
import { Tailscale } from "../../net/tailscale.ts";
import { lanAddresses } from "../../net/lan.ts";
import { clientUrl } from "../../net/cloudRelay.ts";
import { HOME, PORT, RELAY_SERVER, cloudRoom, keyPair, localHostName, macName, relayIsUp, sleep, store } from "../paths.ts";
import { run as ensure } from "./ensure.ts";
import { macText as t } from "../../i18n/mac.ts";

/** QR を出してスマホとつなぐ（Herdr のポップアップから呼ばれる） */
async function pair(): Promise<void> {
  const out = process.stdout;
  const tailscale = new Tailscale();
  const self = await tailscale.self();
  const machine = self?.hostName ?? macName();
  const wifi = lanAddresses(networkInterfaces());
  if (!self && wifi.length === 0 && !cloudRoom) {
    out.write(`\n  ${t("Tailscale も Wi-Fi もつながっていません。")}\n  ${t("どちらかをオンにしてから、もう一度開いてください。")}\n\n  ${t("（q で閉じる）")}\n`);
    await waitForQuit();
    return;
  }
  await ensure([]);
  if (!(await relayIsUp())) {
    out.write(`\n  ${t("中継を動かせませんでした。")}\n  ${t("ログ:")} ${join(HOME, "relay.log")}\n\n  ${t("（q で閉じる）")}\n`);
    await waitForQuit();
    return;
  }

  const devicesBefore = store.listDevices().length;
  let expiresAt = 0;
  let qr = "";
  let url = "";
  const refresh = async () => {
    const code = store.createPairingCode();
    expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    // Tailscale を先に、そのあと同じ Wi-Fi（Bonjour の名前、IP）。
    // MagicDNS の名前は入れない（Tailscale の IP は変わらないので要らず、QR が大きくなって小窓からはみ出す）
    const bonjour = localHostName();
    const hosts = [
      ...(self ? [self.ipv4] : []),
      ...(bonjour ? [bonjour] : []),
      ...wifi,
    ];
    const relay = cloudRoom ? clientUrl(RELAY_SERVER, cloudRoom.room) : undefined;
    url = buildPairingUrl({ hosts, port: PORT, code, machine, key: keyPair.publicKey, relay });
    qr = await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  };
  // QR は出し直すときだけ描き、残り時間の行だけを毎回書き換える（ちらつかないように）
  let countdownRow = 0;
  let hintRow = 0;
  const hint = `  ${t("QR を読めないときは、このリンクを iPhone の「リンクを貼り付け」へ（c でコピー）")}`;
  const drawAll = () => {
    out.write("\x1b[2J\x1b[H\x1b[?25l");
    out.write(`  ${t("iPhone か iPad の Crook で読んでください")} — ${machine}\n`);
    out.write(`  ${t("つなぎ方:")} ${[self ? "Tailscale" : null, wifi.length ? t("同じ Wi-Fi") : null, cloudRoom ? t("中継サーバー") : null].filter(Boolean).join(" · ")}\n\n`);
    const body = qr.replace(/^/gm, "  ");
    out.write(body);
    countdownRow = 3 + body.split("\n").length;
    hintRow = countdownRow + 2;
    // 残り時間の行のあとに、リンク（長いので折り返す。行の数を数えなくてよいように、いちばん下に置く）
    out.write(`\x1b[${hintRow};1H${hint}\n\x1b[2m  ${url}\x1b[0m`);
    draw();
  };
  const copied = async () => {
    const ok = await copyToClipboard(url);
    out.write(`\x1b[${hintRow};1H\x1b[2K  ${ok ? `✓ ${t("コピーしました。iPhone の「リンクを貼り付け」で貼れます")}` : t("コピーできませんでした。リンクを選んでコピーしてください")}`);
  };
  const draw = () => {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    out.write(`\x1b[${countdownRow};1H\x1b[2K  ${t("新しい QR まで")} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} · ${t("q で閉じる")}`);
  };
  await refresh();
  drawAll();

  let quit = false;
  void waitForQuit((key) => {
    if (key === "c" || key === "C") void copied();
  }).then(() => (quit = true));
  while (!quit) {
    await sleep(500);
    if (store.listDevices().length > devicesBefore && !store.hasPendingCode()) {
      const device = store.listDevices().at(-1);
      out.write("\x1b[2J\x1b[H");
      out.write(`\n  ${t("つながりました:")} ${device?.name ?? "iPhone"}\n\n  ${t("この画面は自動で閉じます。")}\n`);
      await sleep(1500);
      break;
    }
    if (Date.now() >= expiresAt) {
      await refresh();
      drawAll();
    } else {
      draw();
    }
  }
  out.write("\x1b[?25h");
  process.stdin.setRawMode?.(false);
  process.exit(0);
}

/** Mac のクリップボードに入れる（ユニバーサルクリップボードで iPhone でも貼れる） */
function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolveCopy) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolveCopy(false));
    child.on("close", (code) => resolveCopy(code === 0));
    child.stdin.end(text);
  });
}

/** q・Esc・ctrl+c で閉じる。ほかのキーは onKey に渡す */
function waitForQuit(onKey?: (key: string) => void): Promise<void> {
  return new Promise((resolveQuit) => {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d: Buffer) => {
      const k = d.toString();
      if (k === "q" || k === "Q" || k === "\x1b" || k === "\x03") resolveQuit();
      else onKey?.(k);
    });
  });
}

/** pair コマンド */
export async function run(_args: string[]): Promise<void> {
  await pair();
}
