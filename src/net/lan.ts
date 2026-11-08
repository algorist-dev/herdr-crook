// 同じ Wi-Fi（家や職場の LAN）で受けるための住所を選ぶ。
// ここで受ける接続は Tailscale の確認ができないので、中継は必ず暗号化（Mac の鍵）を求める。
import type { NetworkInterfaceInfo } from "node:os";

const SKIP_INTERFACE = /^(lo|utun|bridge|vmnet|vnic|awdl|llw|anpi|ap\d|gif|stf|docker|veth)/;

export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (SKIP_INTERFACE.test(name)) continue;
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const [a, b] = info.address.split(".").map(Number);
      if (a === 127 || (a === 169 && b === 254)) continue;
      // Tailscale（100.64.0.0/10）は別に受けている
      if (a === 100 && b !== undefined && b >= 64 && b <= 127) continue;
      if (!out.includes(info.address)) out.push(info.address);
    }
  }
  return out;
}
