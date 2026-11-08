// つながった 1 台の iPhone とのやりとりで使う型。ハンドラ（session/*.ts）はこれだけに頼る。
import type { ClientMessage, ServerMessage } from "../protocol/messages.ts";
import type { PaneSummary } from "../herdr/agents.ts";
import type { RelayDeps } from "../relay.ts";
import type { SlashCommandInfo } from "../features/slashCommands.ts";
import type { UsageSnapshot } from "../features/usage.ts";
import { HerdrError } from "../herdr/herdrClient.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { ProviderPaneContext } from "../providers/types.ts";

export interface PaneSize {
  cols: number;
  rows: number;
}

/** スマホ表示（fit）で変えたペインを元の大きさに戻す。受け口ぜんぶで 1 つ */
export interface RestoreManager {
  /** すぐ戻す */
  restoreNow(pane: string, size: PaneSize): void;
  /** 少し待ってから戻す（アプリを少し裏に回しただけなら戻さない）。shutdown のあとはすぐ戻す */
  schedule(pane: string, size: PaneSize): void;
  /** 戻す予定を取り消して、その大きさを返す（なければ null） */
  take(pane: string): PaneSize | null;
  /** 待っているものを全部すぐ戻す（中継を止めるとき） */
  shutdown(): void;
}

/** startRelay 1 回につき 1 つ。全部の接続で共有する */
export interface RelayServices {
  deps: RelayDeps;
  providers: ProviderRegistry;
  restores: RestoreManager;
  /** モデルを切り替えているペイン（そのあいだ入力を断る） */
  modelSwitching: Set<string>;
  notify(title: string, body: string): void;
  uploadDir(): string;
  dirExists(path: string): boolean;
  slashCommands(agent: string | null, cwd: string | null): SlashCommandInfo[];
  listFiles(cwd: string | null, query: string): string[];
  wait(ms: number): Promise<void>;
  log(message: string): void;
}

export interface TerminalController {
  open(msg: Extract<ClientMessage, { t: "open" }>): void;
  input(b64: string): void;
  resize(cols: number, rows: number): void;
  scroll(dir: "up" | "down", lines: number): void;
  /** explicit：iPhone が閉じた（すぐ戻す）／disconnect：切れた（少し待って戻す） */
  close(why: "explicit" | "disconnect"): void;
  /** いま開いているペイン */
  currentPane(): string | null;
}

export interface ChatController {
  /** そのペインの会話・選択肢・使用量の見張りを始める（前のものは止める） */
  start(pane: string): void;
  stop(): void;
  /** 最後に送った使用量（そのペインのものでなければ null） */
  lastUsage(pane: string): UsageSnapshot | null;
  sendCommands(pane: string): void;
  sendFiles(pane: string, query: string): void;
}

/** terminal・chat 以外。TerminalController・ChatController を作るときに渡す */
export interface SessionBase {
  services: RelayServices;
  deviceId: string;
  send(msg: ServerMessage): void;
  pane(paneId: string): PaneSummary | undefined;
  kindOf(paneId: string): "agent" | "terminal" | null;
  poke(): void;
  /** Mac に「スマホから操作中」を出す（接続ごと・ペインごとに 1 回） */
  announce(paneId: string, resized?: boolean): void;
  /** pane.read（visible）。lines の既定は 80。読めなければ "" */
  readScreen(paneId: string, lines?: number): Promise<string>;
}

export interface SessionContext extends SessionBase {
  terminal: TerminalController;
  chat: ChatController;
}

export type MessageType = ClientMessage["t"];
export type Handler<T extends MessageType> = (ctx: SessionContext, msg: Extract<ClientMessage, { t: T }>) => Promise<void> | void;
export type HandlerTable = { [T in MessageType]?: Handler<T> };

/** プロバイダに渡すもの */
export function providerContext(ctx: SessionBase, pane: PaneSummary): ProviderPaneContext {
  return {
    paneId: pane.paneId,
    pane,
    herdr: ctx.services.deps.herdr,
    readScreen: () => ctx.readScreen(pane.paneId),
    wait: (ms) => ctx.services.wait(ms),
    poke: () => ctx.poke(),
    log: (m) => ctx.services.log(m),
  };
}

/** iPhone に出すエラーの文（relay.ts の describeError をそのまま移したもの） */
export function describeError(err: unknown): string {
  if (err instanceof HerdrError) {
    switch (err.code) {
      case "agent_blocked":
        return "エージェントが返事待ちです。先に画面で選んでから送ってください";
      case "not_found":
      case "pane_not_found":
        return "そのペインはもうありません";
      default:
        return `Herdr: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
