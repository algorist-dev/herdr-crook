import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import { lanAddresses } from "../src/net/lan.ts";

const v4 = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }) as NetworkInterfaceInfo;

describe("lanAddresses（同じ Wi-Fi で受けるところ）", () => {
  it("Wi-Fi や有線の IPv4 だけ。Tailscale・ループバック・リンクローカル・IPv6 は入れない", () => {
    const list = lanAddresses({
      lo0: [v4("127.0.0.1", true)],
      en0: [v4("192.168.1.20"), { ...v4("fe80::1"), family: "IPv6" } as NetworkInterfaceInfo],
      en1: [v4("10.0.0.5")],
      utun4: [v4("100.101.102.103")],
      bridge0: [v4("169.254.10.2")],
    });
    expect(list).toEqual(["192.168.1.20", "10.0.0.5"]);
  });

  it("仮想マシンやコンテナの橋（bridge・vmnet など）は入れない", () => {
    expect(lanAddresses({ vmnet8: [v4("172.16.5.1")], bridge100: [v4("192.168.64.1")], en0: [v4("192.168.0.3")] })).toEqual(["192.168.0.3"]);
  });
});
