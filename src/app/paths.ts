// いくつものコマンドが使う決まった値と、小さな関数。
// 入口（cli.ts）とコマンド（app/commands/）は、ここから読む。
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PairingStore } from "../pairing/pairing.ts";
import { loadOrCreateKeyPair } from "../net/e2ee.ts";
import { DEFAULT_RELAY_SERVER, loadOrCreateRoom } from "../net/cloudRelay.ts";

export const HOME = process.env.CROOK_HOME ?? join(homedir(), ".config", "crook");
export const PORT = Number(process.env.CROOK_PORT ?? 47821);
export const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
export const store = new PairingStore(join(HOME, "devices.json"));
/** Mac の鍵（QR に公開鍵を入れ、アプリはこれで暗号化してつなぐ） */
export const keyPair = loadOrCreateKeyPair(join(HOME, "e2ee.json"));

/** 中継サーバー（Tailscale も Wi-Fi も使えないとき）。CROOK_RELAY_SERVER=off で使わない */
export const RELAY_SERVER = process.env.CROOK_RELAY_SERVER ?? DEFAULT_RELAY_SERVER;
export const relayServerOn = RELAY_SERVER !== "off";
export const cloudRoom = relayServerOn ? loadOrCreateRoom(join(HOME, "cloud.json")) : null;

/** 通知を送る Apple のチーム（実機に入れるときのチームと同じ） */
export const DEFAULT_TEAM = "5HW9M2226X";

/** Mac の名前（Tailscale がなければコンピュータ名） */
export function macName(): string {
  try {
    return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim() || hostname();
  } catch {
    return hostname().replace(/\.local$/, "");
  }
}

/** 同じ Wi-Fi で使う名前（Bonjour。IP が変わってもつながる） */
export function localHostName(): string | null {
  try {
    const name = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim();
    return name ? `${name}.local` : null;
  } catch {
    return null;
  }
}

export function herdrBin(): string {
  return process.env.HERDR_BIN ?? process.env.HERDR_BIN_PATH ?? "herdr";
}

export function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

export function relayIsUp(): Promise<boolean> {
  return new Promise((resolveUp) => {
    const s = connect({ host: "127.0.0.1", port: PORT });
    s.once("connect", () => {
      s.destroy();
      resolveUp(true);
    });
    s.once("error", () => resolveUp(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolveUp(false);
    });
  });
}

export function resolveCommand(cmd: string): string {
  if (cmd.startsWith("/")) return cmd;
  try {
    return execFileSync("/usr/bin/which", [cmd], { encoding: "utf8" }).trim() || cmd;
  } catch {
    return cmd;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
