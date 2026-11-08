import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { HerdrClient, resolveSocketPath } from "../herdr/herdrClient.ts";
import { PaneWatcher } from "../herdr/paneWatcher.ts";
import { startRelay, type Relay } from "../relay.ts";
import { Tailscale } from "../net/tailscale.ts";
import { openTerminal, type SpawnLike } from "../herdr/terminalSession.ts";
import { lanAddresses } from "../net/lan.ts";
import { detectAgents } from "../herdr/installedAgents.ts";
import { OpenCodeStore } from "../providers/opencode/store.ts";
import { ApnsClient, loadApnsConfig, pushPayload } from "../notify/apns.ts";
import { localize } from "../i18n/index.ts";
import { machineHint, Notifier, Presence, type PushTarget } from "../notify/notifier.ts";
import { parseChoices } from "../features/choices.ts";
import { CLAUDE_MODELS, defaultClaudeEffort, loadClaudeModels } from "../providers/claude/models.ts";
import { codexHome, loadCodexModels } from "../providers/codex/models.ts";
import { loadOpenCodeModels, loadRecentModels, type OpenCodeModel } from "../providers/opencode/models.ts";
import { createDefaultProviders } from "../providers/defaults.ts";
import { CloudTunnel } from "../net/cloudRelay.ts";
import { readStatusline } from "../providers/claude/statusline.ts";
import { HOME, PORT, RELAY_SERVER, cloudRoom, herdrBin, keyPair, log, macName, sleep, store } from "./paths.ts";

/** 中継を動かす（ふつうは launchd が動かす） */
export async function serve(): Promise<void> {
  const socketPath = resolveSocketPath(process.env, homedir());
  const herdr = new HerdrClient(socketPath);
  // OpenCode の会話（データベースを読むだけ）
  const openCode = new OpenCodeStore();

  // OpenCode のモデルの一覧（読むのに数秒かかるので、起動時と 10 分ごとに読んでおく）
  let openCodeModels: OpenCodeModel[] = [];
  let loadingOpenCode: Promise<OpenCodeModel[]> | null = null;
  // 読んでいる途中にまた頼まれても、opencode を何個も動かさない
  const refreshOpenCode = () =>
    (loadingOpenCode ??= loadOpenCodeModels()
      .then((list) => {
        if (list.length) openCodeModels = list;
        else log("opencode: no models (is opencode installed?)");
        return openCodeModels;
      })
      .finally(() => (loadingOpenCode = null)));
  void refreshOpenCode();
  // Claude のモデルは claude 本体に聞く（メッセージは送らない。Orca と同じ聞き方）
  let claudeModels: OpenCodeModel[] = [];
  let loadingClaude: Promise<OpenCodeModel[]> | null = null;
  const refreshClaude = () =>
    (loadingClaude ??= loadClaudeModels()
      .then((list) => {
        if (list.length) claudeModels = list;
        return claudeModels.length ? claudeModels : CLAUDE_MODELS;
      })
      .finally(() => (loadingClaude = null)));
  void refreshClaude();
  setInterval(() => void refreshClaude(), 30 * 60 * 1000).unref();
  setInterval(() => void refreshOpenCode(), 10 * 60 * 1000).unref();

  // エージェントごとの違いはプロバイダにまとめる。ファイルを読む部品は、呼ばれたときに読むよう関数で渡す
  const providers = createDefaultProviders({
    claude: {
      models: () => (claudeModels.length ? Promise.resolve(claudeModels) : refreshClaude()),
      defaultEffort: () => defaultClaudeEffort(),
      // statusline が残した JSON（セッション ID から）。正確なコンテキスト%・5h/7d を出す
      statusline: (sessionId) => readStatusline(join(HOME, "statusline"), sessionId),
    },
    codex: {
      models: () => loadCodexModels(codexHome()),
      defaultEffort: () => {
        try {
          return /^model_reasoning_effort\s*=\s*"([a-z]+)"/m.exec(readFileSync(join(codexHome(), "config.toml"), "utf8"))?.[1] ?? null;
        } catch {
          return null;
        }
      },
    },
    opencode: {
      store: openCode,
      models: {
        list: () => (openCodeModels.length ? Promise.resolve(openCodeModels) : refreshOpenCode()),
        recent: () => loadRecentModels(),
      },
      modelInfo: (provider: string, id: string) => {
        const found = openCodeModels.find((m) => m.provider === provider && m.id === id);
        return found ? { name: found.name, contextLimit: found.contextLimit ?? null } : null;
      },
    },
  });

  const watcher = new PaneWatcher(herdr, { pollMs: 5000, debounceMs: 120, providers });
  const tailscale = new Tailscale();
  watcher.start();

  // 入っているエージェントは起動時と 10 分ごとに調べる
  let installedAgents: string[] = ["claude"];
  const refreshAgents = () => detectAgents().then((list) => (installedAgents = list));
  await refreshAgents();
  setInterval(() => void refreshAgents(), 10 * 60 * 1000).unref();

  // 通知：返事待ち・終わったを、裏にいる iPhone に Apple の通知で知らせる（鍵は push-setup で入れる）
  const presence = new Presence();
  const push = pushSender();
  const notifier = new Notifier({
    targets: () => (push.ready() ? store.pushTargets() : []),
    clearToken: (token) => store.clearPushToken(token),
    presence,
    send: (target, payload) => push.send(target, payload),
    machine: machineHint(keyPair.publicKey),
    // 返事待ちになったばかりだと画面がまだ描き終わっていないことがあるので、少し待ってから読む
    choicesOf: async (pane) => {
      await sleep(400);
      const r = (await herdr.request("pane.read", { pane_id: pane, source: "visible", lines: 60 })) as { read?: { text?: unknown } } | null;
      const text = r?.read?.text;
      return typeof text === "string" ? parseChoices(text) : null;
    },
    log,
  });
  watcher.on("change", (state) => {
    if (!state.herdr) notifier.reset();
    else void notifier.update(state.panes);
  });

  const deps = {
    store,
    watcher,
    presence,
    // エージェントごとの違いは、watcher と同じプロバイダを使う
    providers,
    pushReady: () => push.ready(),
    herdr,
    isAllowedPeer: (ip: string) => tailscale.isSameUser(ip),
    machine: macName(),
    keyPair,
    agents: () => installedAgents,
    log,
    // 試しの通知（iPhone の設定画面の「通知を試す」と pushTest）
    pushTest: async (deviceId: string) => {
      if (!push.ready()) return { ok: false, reason: "Mac に Apple 通知の鍵がありません" };
      const target = store.pushTargets().find((t) => t.deviceId === deviceId);
      if (!target) return { ok: false, reason: "Mac にこの端末の通知の宛先がありません" };
      const result = await push.send(
        target,
        pushPayload({ paneId: "", kind: "needs-input", title: "Crook", body: localize(target.lang ?? "ja", "通知を試しています") }),
      );
      return result.ok
        ? { ok: true, reason: "試しの通知を送りました" }
        : { ok: false, reason: `Apple の通知に送れませんでした（${result.status ?? result.reason ?? "error"}）` };
    },
    // スマホから送った画像の置き場（1 週間で消す）
    uploadDir: () => join(HOME, "uploads"),
    openTerminal: (pane: string, cols: number, rows: number, handlers: Parameters<typeof openTerminal>[1], observe: boolean) =>
      openTerminal({ herdrBin: herdrBin(), socketPath, pane, cols, rows, spawn: spawn as unknown as SpawnLike, observe }, handlers),
  };

  // Mac の中から（シミュレータや確認用）は 127.0.0.1、スマホからは Tailscale の IP と同じ Wi-Fi の IP で受ける。
  // 同じ Wi-Fi では Tailscale の確認ができないので、Mac の鍵での暗号化を必ず求める（合言葉と鍵も中に入れて確かめる）。
  const local = await startRelay(deps, [{ host: "127.0.0.1", port: PORT }]);
  log(`listening on 127.0.0.1:${local.ports[0]} (herdr socket ${socketPath})`);

  let tailnet: Relay | null = null;
  let tailnetIp: string | null = null;
  const bindTailnet = async () => {
    const self = await tailscale.self();
    if (self) deps.machine = self.hostName;
    const ip = self?.ipv4 ?? null;
    if (ip === tailnetIp) return;
    await tailnet?.close();
    tailnet = null;
    tailnetIp = null;
    if (!ip) {
      log("tailscale is not running; waiting");
      return;
    }
    try {
      tailnet = await startRelay(deps, [{ host: ip, port: PORT }]);
      tailnetIp = ip;
      log(`listening on ${ip}:${PORT} (${self?.dnsName ?? "no MagicDNS"})`);
    } catch (err) {
      log(`could not listen on ${ip}:${PORT}: ${(err as Error).message}`);
    }
  };
  await bindTailnet();
  setInterval(() => void bindTailnet(), 15_000);

  // 同じ Wi-Fi：住所が変わったら受け口を作り直す
  const lan = new Map<string, Relay>();
  const bindLan = async () => {
    const want = new Set(lanAddresses(networkInterfaces()));
    for (const [ip, relay] of lan) {
      if (!want.has(ip)) {
        await relay.close();
        lan.delete(ip);
        log(`stopped listening on ${ip}:${PORT} (Wi-Fi)`);
      }
    }
    for (const ip of want) {
      if (lan.has(ip)) continue;
      try {
        lan.set(ip, await startRelay(deps, [{ host: ip, port: PORT, requireSeal: true, checkPeer: false }]));
        log(`listening on ${ip}:${PORT} (Wi-Fi, sealed only)`);
      } catch (err) {
        log(`could not listen on ${ip}:${PORT}: ${(err as Error).message}`);
      }
    }
  };
  await bindLan();
  setInterval(() => void bindLan(), 15_000);

  // 中継サーバー：Mac から部屋に出ていってつなぐ（中身は Mac の鍵で暗号化されたまま通る）
  const tunnel = cloudRoom ? new CloudTunnel({ server: RELAY_SERVER, room: cloudRoom, relay: local, log }) : null;
  tunnel?.start();

  const shutdown = async () => {
    watcher.stop();
    tunnel?.stop();
    push.close();
    await Promise.all([local.close(), tailnet?.close(), ...[...lan.values()].map((r) => r.close())]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

/** Apple の鍵があれば送る。push-setup で入れたら、中継を動かし直さなくても 1 分で使えるようにする */
function pushSender() {
  let client: ApnsClient | null = null;
  let checkedAt = 0;
  const current = () => {
    // 鍵を入れ直したとき（push-setup をもう一度）も 1 分で切り替わる
    if (Date.now() - checkedAt > 60_000) {
      checkedAt = Date.now();
      const cfg = loadApnsConfig(HOME);
      if (!cfg) {
        client?.close();
        client = null;
      } else if (!client || client.keyId !== cfg.keyId || client.topic !== cfg.topic) {
        client?.close();
        client = new ApnsClient(cfg);
        log(`push: ready (key ${cfg.keyId}, topic ${cfg.topic})`);
      }
    }
    return client;
  };
  return {
    ready: () => current() !== null,
    close: () => client?.close(),
    async send(target: PushTarget, payload: Parameters<ApnsClient["send"]>[1]) {
      const c = current();
      if (!c) return { ok: false };
      const result = await c.send(target, payload);
      if (!result.ok) log(`push: ${result.status} ${result.reason ?? ""} (device ${target.deviceId})`);
      return result;
    },
  };
}
