// Hermes Agent のプロバイダ。会話の表示・題名・ツールの中身・使用量と、確認なしの立ち上げ（--yolo）。
// Herdr 0.9.5 は Hermes 0.23 を見分けない（python3 -I -c で動くため。上流の #5518 で直り、まだ出ていない）。
// そこで Herdr の Hermes の連携の報告（herdr:hermes）と前のプロセスで、こちらで見分ける（recognize）。
// 状態（作業中・返事待ち）は分からないので、返事待ちの知らせは鳴らない（画面・サイト・ストアにそう書く）。
import type { AgentProvider, ChatPoll, ChatSource, ChatUpdate, ForegroundProcess } from "../types.ts";
import { createHermesModels } from "./models.ts";
import { HermesStore } from "./store.ts";

export interface HermesProviderOptions {
  /** state.db の場所。既定は $HERMES_HOME/state.db（~/.hermes/state.db） */
  dbPath?: string;
}

const PREFIX = "hermes:";
const SOURCE = "herdr:hermes";

const base = (path: string | undefined) => (path ?? "").split("/").pop() ?? "";

/**
 * 前で動いているのが Hermes か。プログラムの名前と起動の形だけを見る（ほかの引数に hermes が出てくるだけでは決めない）。
 * - hermes（コンソールスクリプト）／python … /bin/hermes
 * - 0.23 のインストーラー：python3 -I -c "<…from hermes_cli.main import main…>"
 * - python -m hermes_cli.main
 */
export function isHermesProcess(processes: ForegroundProcess[]): boolean {
  return processes.some((p) => {
    const [prog, ...args] = p.argv;
    if (p.name === "hermes" || base(prog) === "hermes") return true;
    if (!/^python/.test(base(prog)) && !/^python/.test(p.name ?? "")) return false;
    const script = args.find((a) => !a.startsWith("-"));
    if (script && base(script) === "hermes") return true;
    const c = args.indexOf("-c");
    if (c >= 0 && (args[c + 1] ?? "").includes("from hermes_cli.main import main")) return true;
    const m = args.indexOf("-m");
    return m >= 0 && args[m + 1] === "hermes_cli.main";
  });
}

/** 承認の画面（危ないコマンド・質問）が出ているか。0.23 の実物の画面から */
export function hermesScreenStatus(screen: string): "blocked" | null {
  const lines = screen.split("\n").slice(-40);
  const hint = lines.some((l) => l.includes("↑/↓ to select, Enter to confirm"));
  const option = lines.some((l) => /^[\s│]*❯\s*1\.\s+\S/.test(l));
  return hint && option ? "blocked" : null;
}

export function createHermesProvider(opts: HermesProviderOptions = {}): AgentProvider {
  let store: HermesStore | null = null;
  const db = () => (store ??= new HermesStore(opts.dbPath));
  const idOf = (key: string) => (key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null);

  const chat: ChatSource = {
    open(key) {
      // 送ったものの JSON。返事は書きかわりながら伸びるので、変わったら毎回全部送り直す（OpenCode と同じ）
      let last = "";
      let first = true;
      return {
        poll(): ChatPoll {
          const id = idOf(key() ?? "");
          const wasFirst = first;
          first = false;
          if (!id) {
            if (wasFirst) return { chat: { available: false, reset: true, title: null, items: [] } };
            return { chat: null };
          }
          const found = db().read(id);
          // 読んでいる途中のエラー（書き込みと重なったなど）は、前に送ったままにする
          if (found === undefined) return { chat: null };
          const update: ChatUpdate = found
            ? { available: true, reset: true, title: found.title, items: found.items }
            : { available: false, reset: true, title: null, items: [] };
          const serialized = JSON.stringify(update);
          let out: ChatUpdate | null = null;
          if (serialized !== last) {
            last = serialized;
            out = update;
          }
          return { chat: out, usage: found?.usage ?? null };
        },
        close() {
          // データベースは開いたまま使い回す
        },
      };
    },
    title: (key) => {
      const id = idOf(key);
      return id ? db().title(id) : null;
    },
    toolDetail: (key, itemId) => {
      const id = idOf(key);
      return id ? db().toolDetail(id, itemId) : null;
    },
  };

  return {
    id: "hermes",
    recognize: { sessionSource: SOURCE, isRunning: isHermesProcess, statusFromScreen: hermesScreenStatus },
    unattendedArgs: ["--yolo"],
    chatKey: (record) => (record.sessionSource === SOURCE && record.sessionValue ? `${PREFIX}${record.sessionValue}` : null),
    chat,
    models: createHermesModels(),
  };
}
