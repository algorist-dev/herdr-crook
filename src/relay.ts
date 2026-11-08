// スマホとつなぐ中継の組み立て。受け口（transport）・つながった先のやりとり（session）・
// エージェントごとの部品（providers）をつなぐだけにして、中身はそれぞれのファイルに任せる。
import type { WebSocket } from "ws";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyPair } from "./net/e2ee.ts";
import { listSlashCommands, type SlashCommandInfo } from "./features/slashCommands.ts";
import { listFiles } from "./features/files.ts";
import { herdrConfigPath, readHerdrThemeSnapshot, type HerdrThemeSnapshot } from "./features/herdrTheme.ts";
import type { PairingStore } from "./pairing/pairing.ts";
import type { WatchState } from "./herdr/paneWatcher.ts";
import type { Terminal, TerminalHandlers } from "./herdr/terminalSession.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import { createRestoreManager } from "./session/terminal.ts";
import type { RelayServices } from "./session/types.ts";
import { createSession } from "./session/session.ts";
import { startTransport } from "./transport/connection.ts";

export { imageExtension } from "./session/uploads.ts";

export interface WatcherLike {
  current(): WatchState;
  kindOf(paneId: string): "agent" | "terminal" | null;
  poke(): void;
  markUnattended(paneId: string): void;
  on(event: "change", fn: (s: WatchState) => void): unknown;
  off(event: "change", fn: (s: WatchState) => void): unknown;
}

export interface RelayDeps {
  store: Pick<PairingStore, "redeem" | "verify" | "isActive" | "markSeen"> & Partial<Pick<PairingStore, "setPush" | "setLang">>;
  /** いまつながっている端末（裏にいる端末にだけ通知を送るため。受け口どうしで同じものを使う） */
  presence?: { add(deviceId: string): void; remove(deviceId: string): void };
  /** Mac から iPhone に通知を送れるか（Apple の鍵が入っているか） */
  pushReady?: () => boolean;
  /** 試しの APNs を送って、その端末に届くか確かめる（pushTest→pushTested。無いなら「送れませんでした」） */
  pushTest?: (deviceId: string) => Promise<{ ok: boolean; reason: string | null }>;
  watcher: WatcherLike;
  herdr: { request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };
  openTerminal(pane: string, cols: number, rows: number, handlers: TerminalHandlers, observe: boolean): Terminal;
  isAllowedPeer(remoteAddress: string): Promise<boolean>;
  machine: string;
  log?: (message: string) => void;
  /** 消された端末の接続を切るために確かめる間隔（テストでは短く） */
  checkDevicesMs?: number;
  /** Mac の鍵（あれば、暗号化してつなげる。同じ Wi-Fi と中継サーバーでは必ず暗号化） */
  keyPair?: KeyPair;
  /** スマホ表示のまま切れたとき、元の大きさに戻すまで待つ時間（アプリを少し裏に回しただけなら戻さない） */
  restoreGraceMs?: number;
  /** Mac に知らせを出す（スマホから操作を始めたとき）。なければ Herdr の notification.show */
  notify?: (title: string, body: string) => void;
  /** スマホから送られた画像を置くフォルダ */
  uploadDir?: () => string;
  /** 新しいワークスペースのフォルダが Mac にあるか */
  dirExists?: (path: string) => boolean;
  /** Mac に入っているエージェント（新しいタブで選べるもの） */
  agents: () => string[];
  /** モデルの一覧を開いてから待つ時間など（テストでは 0） */
  openCodeWait?: (ms: number) => Promise<void>;
  /** 会話記録が増えていないか見る間隔 */
  chatPollMs?: number;
  /** 入力欄の「/」に出すコマンド（組み込み＋Mac のファイル）。テストでは差しかえる */
  slashCommands?: (agent: string | null, cwd: string | null) => SlashCommandInfo[];
  /** 入力欄の「@」に出すファイルの候補。テストでは差しかえる */
  listFiles?: (cwd: string | null, query: string) => string[];
  /** Mac の Herdr のテーマ設定の読み口。mtimeMs が変わったら iPhone に知らせる */
  herdrTheme?: () => HerdrThemeSnapshot;
  /** テーマの変更を見る間隔（テストでは短く） */
  herdrThemePollMs?: number;
  /** Mac から離れているかを見る間隔（テストでは短く） */
  awayPollMs?: number;
  /** エージェントごとの部品 */
  providers: ProviderRegistry;
}

export interface Relay {
  ports: number[];
  /** WebSocket のように振る舞うもの（中継サーバーを通した iPhone）をつなぐ */
  attach(ws: WebSocket, ip: string, opts: { requireSeal: boolean; checkPeer: boolean }): void;
  close(): Promise<void>;
}

/** 受け口。requireSeal：暗号化しない相手は断る（同じ Wi-Fi）／checkPeer：Tailscale で同じアカウントか確かめる */
export interface ListenOptions {
  host: string;
  port: number;
  requireSeal?: boolean;
  checkPeer?: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startRelay(deps: RelayDeps, listen: ListenOptions[]): Promise<Relay> {
  const log = deps.log ?? (() => {});
  const notify =
    deps.notify ??
    ((title: string, body: string) => {
      deps.herdr.request("notification.show", { title, body, sound: "none" }).catch(() => {});
    });

  deps.herdrTheme ??= () => readHerdrThemeSnapshot(herdrConfigPath());

  const services: RelayServices = {
    deps,
    providers: deps.providers,
    restores: createRestoreManager({ openTerminal: deps.openTerminal, graceMs: deps.restoreGraceMs ?? 15_000, log }),
    modelSwitching: new Set(),
    notify,
    uploadDir: deps.uploadDir ?? (() => join(tmpdir(), "crook-uploads")),
    dirExists:
      deps.dirExists ??
      ((path: string) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      }),
    slashCommands: deps.slashCommands ?? ((agent, cwd) => listSlashCommands({ agent, cwd })),
    listFiles: deps.listFiles ?? ((cwd, query) => listFiles({ cwd, query })),
    wait: deps.openCodeWait ?? sleep,
    log,
  };

  const transport = await startTransport(
    {
      store: deps.store,
      presence: deps.presence,
      isAllowedPeer: deps.isAllowedPeer,
      keyPair: deps.keyPair,
      log: deps.log,
      checkDevicesMs: deps.checkDevicesMs,
      // cli が後から書きかえるので、毎回読む
      machine: () => deps.machine,
    },
    listen,
    (link) => createSession(services, link),
  );

  return {
    ports: transport.ports,
    attach: transport.attach,
    async close() {
      services.restores.shutdown();
      await transport.close();
    },
  };
}
