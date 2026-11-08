// スマホと中継のあいだでやりとりするメッセージ（WebSocket の文字メッセージ、JSON 1 つずつ）の型。
// スマホから来たものの形を確かめるのは parse.ts。
import type { PaneSummary } from "../herdr/agents.ts";
import type { ChatItem } from "../providers/shared/transcript.ts";
import type { ToolDetail } from "../providers/shared/toolDetail.ts";
import type { Choice } from "../features/choices.ts";
import type { AgentModel } from "../providers/types.ts";
import type { SlashCommandInfo } from "../features/slashCommands.ts";
import type { UsageSnapshot } from "../features/usage.ts";
import type { HerdrThemeConfig } from "../features/herdrTheme.ts";
import type { AgentKind } from "../herdr/installedAgents.ts";
import type { NotificationPrefs } from "../notify/prefs.ts";

export interface ModelRef {
  provider: string;
  id: string;
}

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT = 64 * 1024;
/** 文章に付けられる画像（1 枚は base64 で 4MB まで＝もとは 3MB くらい） */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_B64 = 4 * 1024 * 1024;
/** 1 つのメッセージの大きさの上限（画像 4 枚と文字が入る） */
export const MAX_MESSAGE_BYTES = MAX_IMAGES * MAX_IMAGE_B64 + MAX_TEXT * 4;
/** 新しいワークスペース・タブで起動できるエージェント（Herdr が起動できる種類） */
export type StartableAgent = AgentKind;

/** mirror：Mac と同じ大きさで見る（大きさは変えない）／fit：ペインをスマホの大きさに変える */
export type OpenMode = "mirror" | "fit";

export type ClientMessage =
  | { t: "pair"; code: string; device: string }
  /** lang：iPhone の言語（BCP 47。形が違えば書かなかったことにする） */
  | { t: "hello"; token: string; app?: string; once?: boolean; lang?: string }
  /** アプリの中で言語を替えたとき（そのつど覚え直す） */
  | { t: "lang"; lang: string }
  | { t: "open"; pane: string; cols: number; rows: number; mode: OpenMode }
  | { t: "input"; b64: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "scroll"; dir: "up" | "down"; lines: number }
  | { t: "close" }
  | { t: "prompt"; pane: string; text: string; images?: string[] }
  /** unattended：エージェントを確認なしの引数で立ち上げる（agent が null なら効かない） */
  | { t: "create"; req: string; cwd: string; label: string | null; agent: StartableAgent | null; unattended: boolean }
  | { t: "newTab"; req: string; workspace: string; agent: StartableAgent | null; unattended: boolean }
  | { t: "attach"; pane: string; images: string[] }
  | { t: "paneAction"; pane: string; action: "rename" | "clear" | "close"; label: string | null }
  | { t: "keys"; pane: string; keys: string[] }
  | { t: "answer"; pane: string; key: string; expect: string }
  | { t: "models"; pane: string }
  /** variant：考える量（null なら変えない。OpenCode の "default" は印なし） */
  | { t: "setModel"; pane: string; provider: string; model: string; variant: string | null }
  | { t: "chat"; pane: string }
  | { t: "commands"; pane: string }
  /** query：入力欄で「@」のあとに打った文字（空なら候補の最初のほう） */
  | { t: "files"; pane: string; query: string }
  /** 会話のツールの行を押したときの中身を頼む（item は ChatItem.id） */
  | { t: "toolDetail"; pane: string; item: string }
  /** いまの使用量をもう一度送ってほしい（画面を開き直したときなど） */
  | { t: "usage"; pane: string }
  | { t: "unchat" }
  /** 通知の宛先（Apple のデバイストークン）。prefs：この端末の通知の設定（無ければ送らない） */
  | { t: "push"; token: string | null; env: "sandbox" | "production"; prefs?: NotificationPrefs }
  /** 試しの APNs を送って確かめる（返事は pushTested） */
  | { t: "pushTest" }
  | { t: "ping" };

export type ServerMessage =
  /** unattended：agents のうち、確認なしで立ち上げられるもの／theme：Mac の Herdr のテーマ設定 */
  | { t: "welcome"; machine: string; protocol: number; herdr: boolean; agents: string[]; push: boolean; unattended: string[]; theme?: HerdrThemeConfig }
  /** Mac の Herdr のテーマが変わった（つながっている間だけ届く） */
  | { t: "theme"; theme: HerdrThemeConfig }
  | { t: "paired"; token: string; machine: string }
  | { t: "denied"; reason: "invalid_code" | "invalid_token" | "not_same_tailnet_user" | "too_many_attempts" }
  | { t: "panes"; panes: PaneSummary[]; herdr: boolean }
  | { t: "frame"; seq: number; full: boolean; cols: number; rows: number; b64: string }
  | { t: "closed"; reason: string }
  | { t: "error"; message: string; req?: string }
  | { t: "created"; req: string; workspaceId: string; pane: string; agentStarted: boolean }
  | { t: "choices"; pane: string; question: string | null; options: Choice[]; selected: string | null }
  | { t: "chat"; pane: string; available: boolean; reset: boolean; title: string | null; items: ChatItem[] }
  /** 入力欄で「/」を打ったときの一覧（Mac の組み込み＋ファイルから集めたもの） */
  | { t: "commands"; pane: string; agent: string | null; commands: SlashCommandInfo[] }
  /** 入力欄で「@」を打ったときのファイルの候補（作業フォルダからの相対パス） */
  | { t: "files"; pane: string; query: string; files: string[] }
  /** ツールの行の中身（null は読めなかった） */
  | { t: "toolDetail"; pane: string; item: string; detail: ToolDetail | null }
  /** そのペインの使用量（分からなければ usage は null） */
  | { t: "usage"; pane: string; usage: UsageSnapshot | null }
  | { t: "models"; pane: string; agent: string; current: ModelRef | null; variant: string | null; recent: ModelRef[]; models: AgentModel[] }
  | { t: "modelSet"; pane: string; ok: boolean; current: ModelRef | null; variant: string | null; message: string | null }
  /** Mac から離れているか（アプリが自分で知らせを出すときに使う。つないだとき・変わったとき） */
  | { t: "away"; away: boolean }
  /** 試しの APNs の結果（message は成功・失敗の文、成功でも送ったか分かるように書く） */
  | { t: "pushTested"; ok: boolean; message: string | null }
  | { t: "pong" };
