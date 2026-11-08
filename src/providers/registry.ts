import type { PaneSummary } from "../herdr/agents.ts";
import type { AgentProvider, ChatSource, HerdrAgentRecord } from "./types.ts";

/** エージェントの種類 → プロバイダ */
export class ProviderRegistry {
  private readonly byId = new Map<string, AgentProvider>();

  constructor(providers: AgentProvider[]) {
    for (const p of providers) {
      // 同じ名前を 2 回入れたら、あとのものが黙って勝たないように止める
      if (this.byId.has(p.id)) throw new Error(`プロバイダ ${p.id} が 2 つあります`);
      this.byId.set(p.id, p);
    }
  }

  get(agent: string | null | undefined): AgentProvider | null {
    return agent ? this.byId.get(agent) ?? null : null;
  }

  all(): AgentProvider[] {
    return [...this.byId.values()];
  }

  /** 一覧の chatId。知らないエージェントでも、Herdr が Claude のセッションだと言っていれば読む（いまの agents.ts と同じ） */
  chatKey(record: HerdrAgentRecord, cwd: string | null): string | null {
    const p = this.get(record.agent);
    if (p) return p.chatKey(record, cwd);
    return record.sessionSource === "herdr:claude" && record.sessionValue ? record.sessionValue : null;
  }

  /**
   * そのペインの会話を読む部品。エージェントが持っていなくても chatId があれば Claude のもので読む（いまの relay と同じ）。
   * このとき Claude の statusline も重なる（いまの relay は agent が claude のときだけ）。statusline はセッション ID ごとなので、それでよいことにした
   */
  chatSourceFor(pane: Pick<PaneSummary, "agent" | "chatId">): ChatSource | null {
    const own = this.get(pane.agent)?.chat;
    if (own) return own;
    return pane.chatId ? this.get("claude")?.chat ?? null : null;
  }

  /** そのエージェントの確認なしの引数。できなければ null */
  unattendedArgs(agent: string | null | undefined): readonly string[] | null {
    return this.get(agent)?.unattendedArgs ?? null;
  }

  /** 一覧に出す会話の題名 */
  title(agent: string | null, chatKey: string): string | null {
    const source = this.chatSourceFor({ agent, chatId: chatKey });
    try {
      return source?.title(chatKey) ?? null;
    } catch {
      return null;
    }
  }
}
