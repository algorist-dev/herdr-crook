// Herdr がエージェントと見分けないペインを、こちらで見分けて snapshot の agents に足す。
// 手がかりは 2 つ：連携がそのペインに会話を報告している（pane.agent_session.source）こと、
// いまそのペインの前で動いているプロセスがそのエージェントであること（pane.process_info）。
// 報告はエージェントが終わったあとも残るので、プロセスも見て決める。状態は分からないので unknown。
// エージェントの名前はここに書かない（providers の recognize が持つ）。
import type { ForegroundProcess } from "../providers/types.ts";
import type { ProviderRegistry } from "../providers/registry.ts";

type Rec = Record<string, unknown>;

/** プロセスを聞き直すまでの時間（毎回聞くと重いので）。動いていないペインは長めに */
const CACHE_MS = 5_000;
const CACHE_IDLE_MS = 20_000;

export interface RecognizeCache {
  get(paneId: string): { key: string; at: number; running: boolean } | undefined;
  set(paneId: string, value: { key: string; at: number; running: boolean }): void;
  delete(paneId: string): void;
  keys(): IterableIterator<string>;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function processesOf(result: unknown): ForegroundProcess[] {
  const r = (result ?? {}) as Rec;
  const info = ((r.process_info ?? (r.result as Rec | undefined)?.process_info) ?? {}) as Rec;
  const list = Array.isArray(info.foreground_processes) ? (info.foreground_processes as Rec[]) : [];
  return list.map((p) => ({
    name: str(p?.name),
    argv: Array.isArray(p?.argv) ? (p.argv as unknown[]).filter((a): a is string => typeof a === "string") : [],
  }));
}

/**
 * 見分けたペインを agents に足した snapshot を返す（元の snapshot は変えない）。
 * request は Herdr への問い合わせ（pane.process_info）。失敗したら「動いていない」とみなす
 */
export async function addRecognizedAgents(
  snapshot: object,
  providers: ProviderRegistry,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  cache: RecognizeCache,
  now: number,
): Promise<object> {
  const s = snapshot as Rec;
  const panes = Array.isArray(s.panes) ? (s.panes as Rec[]) : [];
  const agents = Array.isArray(s.agents) ? (s.agents as Rec[]) : [];
  const known = new Set(agents.map((a) => str(a?.pane_id)));
  const added: Rec[] = [];
  const seen = new Set<string>();

  const candidates: { pane: Rec; paneId: string; key: string; agent: string; recognizer: NonNullable<ReturnType<ProviderRegistry["recognizerFor"]>>["recognizer"] }[] = [];
  for (const pane of panes) {
    const paneId = str(pane?.pane_id);
    if (!paneId || known.has(paneId)) continue;
    const session = (pane.agent_session ?? null) as Rec | null;
    const found = providers.recognizerFor(str(session?.source));
    if (!found) continue;
    seen.add(paneId);
    candidates.push({ pane, paneId, key: `${found.agent}:${str(session?.value) ?? ""}`, agent: found.agent, recognizer: found.recognizer });
  }
  // ペインごとの問い合わせは並べて投げる（一覧を出すのを遅らせない）
  const results = await Promise.all(
    candidates.map(async (c) => {
      let hit = cache.get(c.paneId);
      const ttl = hit?.running ? CACHE_MS : CACHE_IDLE_MS;
      if (!hit || hit.key !== c.key || now - hit.at > ttl) {
        let running: boolean;
        try {
          running = c.recognizer.isRunning(processesOf(await request("pane.process_info", { pane_id: c.paneId })));
        } catch {
          // 聞けなかったときは前の答えのまま（一覧で行ったり来たりしないように）
          running = hit?.key === c.key ? hit.running : false;
        }
        hit = { key: c.key, at: now, running };
        cache.set(c.paneId, hit);
      }
      if (!hit.running) return null;
      let status = "unknown";
      if (c.recognizer.statusFromScreen) {
        try {
          const r = (await request("pane.read", { pane_id: c.paneId, source: "visible", lines: 60 })) as { read?: { text?: unknown } } | null;
          const text = r?.read?.text;
          if (typeof text === "string" && c.recognizer.statusFromScreen(text) === "blocked") status = "blocked";
        } catch {
          // 読めなければ分からないまま
        }
      }
      return { ...c.pane, agent: c.agent, agent_status: status };
    }),
  );
  for (const r of results) if (r) added.push(r);
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
  return added.length > 0 ? { ...s, agents: [...agents, ...added] } : snapshot;
}
