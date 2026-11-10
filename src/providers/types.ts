// エージェント（Claude・Codex・OpenCode・Copilot…）ごとに違うところを、この形にそろえる。
// 中継（session/）はエージェントの名前を知らず、ここにあるメソッドを呼ぶだけにする。
import type { PaneSummary } from "../herdr/agents.ts";
import type { ChatItem } from "./shared/transcript.ts";
import type { ToolDetail } from "./shared/toolDetail.ts";
import type { ModelRef } from "../protocol/messages.ts";
import type { SlashCommandInfo } from "../features/slashCommands.ts";
import type { TranscriptUsage } from "../features/usage.ts";

/** エージェントのモデル（OpenCode と Claude で同じ形。iPhone の一覧もこの形） */
export interface AgentModel {
  provider: string;
  id: string;
  name: string;
  /** 一覧の右に出る提供元の名前（OpenCode Go など） */
  providerName: string;
  /** 選べる考える量（OpenCode の variant・Claude の effort）。OpenCode は空のこともある */
  variants: string[];
  /** コンテキストの上限（分かるときだけ。OpenCode の limit.context） */
  contextLimit?: number;
}

/** Herdr に頼むところ（HerdrClient の request だけ） */
export interface HerdrPort {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** Herdr の session.snapshot の agents[] の 1 件から、要るところだけ取り出したもの */
export interface HerdrAgentRecord {
  /** エージェントの種類（"claude" など）。分からなければ null */
  agent: string | null;
  /** agent_session.source（例 "herdr:claude"）。なければ null */
  sessionSource: string | null;
  /** agent_session.value（Claude ならセッション ID）。空・なければ null */
  sessionValue: string | null;
}

/** プロバイダがペインを操作するときに使うもの（session が作って渡す） */
export interface ProviderPaneContext {
  paneId: string;
  /** いまの一覧にあるそのペイン */
  pane: PaneSummary;
  herdr: HerdrPort;
  /** pane.read（visible・80 行）の文字。読めなければ "" */
  readScreen(): Promise<string>;
  /** 待つ（テストではすぐ戻る） */
  wait(ms: number): Promise<void>;
  /** 一覧を読み直してもらう（watcher.poke） */
  poke(): void;
  log(message: string): void;
}

/** iPhone に送るモデルの一覧（ServerMessage の "models" から t・pane・agent を除いたもの） */
export interface ModelListing {
  current: ModelRef | null;
  variant: string | null;
  recent: ModelRef[];
  models: AgentModel[];
}

export interface ModelSwitchRequest {
  provider: string;
  model: string;
  /** 考える量。null なら変えない */
  variant: string | null;
}

/** ServerMessage の "modelSet" から t・pane を除いたもの。失敗なら ok:false と message */
export interface ModelSwitchResult {
  ok: boolean;
  current: ModelRef | null;
  variant: string | null;
  message: string | null;
}

export interface ModelControl {
  list(ctx: ProviderPaneContext): Promise<ModelListing>;
  /**
   * 切り替える。「返事待ち」「作業中」「いま切り替え中」の確かめと、announce は呼ぶ側（session/models.ts）がする。
   * ここでは、モデルが見つからない・画面がいつもの入力でない、などの理由を message で返す
   */
  switch(ctx: ProviderPaneContext, req: ModelSwitchRequest): Promise<ModelSwitchResult>;
}

/** iPhone に送る会話（ServerMessage の "chat" から t・pane を除いたもの） */
export interface ChatUpdate {
  available: boolean;
  reset: boolean;
  title: string | null;
  items: ChatItem[];
}

/**
 * poll の結果。chat が null なら送るものなし。
 * usage：書かない（undefined）なら使用量は送らない／null は「分からない」を送る。
 * 送らないときは `usage: undefined` と書かずに、キーごと書かないこと
 */
export interface ChatPoll {
  chat: ChatUpdate | null;
  usage?: TranscriptUsage | null;
}

export interface ChatStream {
  /**
   * 見張りの 1 回分。session が最初に 1 回、そのあと 700ms ごとに呼ぶ。
   * 1 回目は必ず chat を返す（記録がまだなければ available:false・reset:true・items:[]）。
   * 投げた例外は session が受けて、見張りを止める
   */
  poll(): ChatPoll;
  close(): void;
}

export interface ChatSource {
  /** key()：いまのペインの chatId（/clear などで変わるので、毎回これで読み直す） */
  open(key: () => string | null): ChatStream;
  /** 一覧に出す会話の題名。軽くすること（一覧を作るたびに呼ばれる）。分からなければ null */
  title(chatKey: string): string | null;
  /** その会話の 1 件のツールの中身。見つからなければ null（軽くなくてよい。押したときだけ呼ばれる） */
  toolDetail?(chatKey: string, itemId: string): ToolDetail | null;
}

/** ペインの前で動いているプロセス（Herdr の pane.process_info の foreground_processes の 1 件） */
export interface ForegroundProcess {
  name: string | null;
  argv: string[];
}

/**
 * Herdr がエージェントと見分けないときに、こちらで見分ける手がかり。
 * 連携がそのペインに会話を報告していて（agent_session.source）、しかもいま前で動いているプロセスがそのエージェントのときだけ
 * エージェントのペインとして扱う（報告は終わったあとも残るので、報告だけでは決めない）。状態は分からない（unknown）
 */
export interface AgentRecognizer {
  sessionSource: string;
  isRunning(processes: ForegroundProcess[]): boolean;
  /** 画面（見えている範囲）から分かる状態。承認の画面が出ていれば "blocked"、分からなければ null */
  statusFromScreen?(screen: string): "blocked" | null;
}

export interface AgentProvider {
  /** Herdr のエージェントの種類と同じ名前（"claude"・"codex"・"opencode"・"copilot"） */
  readonly id: string;
  /** Herdr が見分けないエージェントを、連携の報告と前のプロセスで見分ける（Herdr が見分けるものは書かない） */
  readonly recognize?: AgentRecognizer;
  /** 「確認なし」で立ち上げるときにエージェントに付ける引数。できないエージェントは書かない */
  readonly unattendedArgs?: readonly string[];
  /** 一覧の PaneSummary.chatId。会話を読めないなら null */
  chatKey(record: HerdrAgentRecord, cwd: string | null): string | null;
  chat?: ChatSource;
  models?: ModelControl;
  /** 入力欄の「/」の組み込みコマンド */
  builtinCommands?(): SlashCommandInfo[];
  /** Mac のファイルから集めるコマンド・スキル（読めなくても投げない） */
  discoverCommands?(cwd: string | null, home: string, env: NodeJS.ProcessEnv): SlashCommandInfo[];
}
