import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../../src/protocol/messages.ts";
import type { RelayDeps } from "../../src/relay.ts";
import { createSession } from "../../src/session/session.ts";
import type { AuthedLink } from "../../src/transport/connection.ts";
import { fakeSession } from "../helpers/fakeSession.ts";

function connect(services: ReturnType<typeof fakeSession>["ctx"]["services"], lang?: string, deviceId = "device-1") {
  const sent: ServerMessage[] = [];
  let onMessage: ((raw: string) => void) | null = null;
  const link: AuthedLink = {
    deviceId,
    once: false,
    ...(lang ? { lang } : {}),
    send: (msg) => void sent.push(msg),
    onMessage: (fn) => void (onMessage = fn),
    onClose: () => {},
  };
  createSession(services, link);
  return {
    sent,
    send: (raw: string) => void onMessage?.(raw),
  };
}

function servicesWithLang() {
  const languages: { device: string; lang: string }[] = [];
  const f = fakeSession({
    deps: {
      store: {
        redeem: () => ({ ok: false, reason: "invalid_code" }),
        verify: () => null,
        isActive: () => true,
        markSeen: () => {},
        setLang: (device: string, lang: string) => void languages.push({ device, lang }),
      } as unknown as RelayDeps["store"],
    },
  });
  return { services: f.ctx.services, languages };
}

const badCreate = JSON.stringify({ t: "create", req: "r1", cwd: "src/api" });

describe("session の言語", () => {
  it("hello の lang が en なら、エラーの文が英語で届く", () => {
    const { services, languages } = servicesWithLang();
    const s = connect(services, "en");

    s.send(badCreate);

    expect(s.sent).toContainEqual({ t: "error", req: "r1", message: "Start the folder with / or ~" });
    expect(languages).toEqual([{ device: "device-1", lang: "en" }]);
  });

  it("hello に lang が無ければ日本語", () => {
    const { services, languages } = servicesWithLang();
    const s = connect(services);

    s.send(badCreate);

    expect(s.sent).toContainEqual({ t: "error", req: "r1", message: "フォルダは / か ~ から書いてください" });
    expect(languages).toEqual([]);
  });

  it("あとから lang を送ると、そのあとの文がその言語になる", () => {
    const { services, languages } = servicesWithLang();
    const s = connect(services);

    s.send(JSON.stringify({ t: "lang", lang: "en" }));
    s.send(badCreate);

    expect(s.sent).toContainEqual({ t: "error", req: "r1", message: "Start the folder with / or ~" });
    expect(languages).toEqual([{ device: "device-1", lang: "en" }]);
  });

  it("表の無い言語でも英語で届く", () => {
    const { services } = servicesWithLang();
    const s = connect(services, "it");

    s.send(badCreate);

    expect(s.sent).toContainEqual({ t: "error", req: "r1", message: "Start the folder with / or ~" });
  });
});
