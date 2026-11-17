// Herdr が「終わった（done）」「待機（idle）」と言っているエージェントでも、画面に選択肢と
// 「Enter to select」の案内が出ていれば返事待ち（blocked）として扱う。
// 2026-11-17、監督のペインで AskUserQuestion が出ている間に Herdr の状態が done と blocked を
// 行き来し、iPhone に選択肢が出たり消えたりした（出ている時間の大半は done だった）。
// エージェントの名前はここに書かない（画面の形だけで決める）。
import { isAskingOnScreen } from "../features/choices.ts";

type Rec = Record<string, unknown>;
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const RECHECK = new Set(["done", "idle"]);

export async function markAskingAsBlocked(snapshot: object, request: Request): Promise<object> {
  const s = snapshot as Rec;
  const agents = Array.isArray(s.agents) ? (s.agents as Rec[]) : [];
  const targets = agents.filter((a) => typeof a?.pane_id === "string" && RECHECK.has(String(a.agent_status)));
  if (targets.length === 0) return snapshot;
  const asking = new Set<string>();
  await Promise.all(
    targets.map(async (a) => {
      try {
        const r = (await request("pane.read", { pane_id: a.pane_id, source: "visible", lines: 60 })) as { read?: { text?: unknown } } | null;
        const text = r?.read?.text;
        if (typeof text === "string" && isAskingOnScreen(text)) asking.add(a.pane_id as string);
      } catch {
        // 読めなければ Herdr の言うとおり
      }
    }),
  );
  if (asking.size === 0) return snapshot;
  const fix = (a: Rec) => (asking.has(a?.pane_id as string) ? { ...a, agent_status: "blocked" } : a);
  const panes = Array.isArray(s.panes) ? (s.panes as Rec[]).map(fix) : s.panes;
  return { ...s, agents: agents.map(fix), panes };
}
