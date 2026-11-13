// Hermes のモデル。一覧は Hermes の公式の入口 ACP（hermes acp の session/new の models）、
// 切り替えは /model <モデル> --provider <提供元> --session（この会話だけ。設定ファイルは変えない）。
// ACP は起動に 30 秒ほどかかり、聞くたびに Hermes の記録へ空の会話が 1 行増える（一覧には出ない）ので、ファイルに 1 日覚えておく。
// Herdr は Hermes の状態を知らないので、作業中かは画面で見る。作業中に打つと今の作業を止めてしまう（busy_input_mode の既定が interrupt）。
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentModel, ModelControl, ModelListing, ModelSwitchResult, ProviderPaneContext } from "../types.ts";
import { switchBySlash, type InputState } from "../shared/slashModel.ts";

/** ペインに打つので、空白や制御文字の無いものだけ通す。- で始まるものはフラグと取り違えられるので通さない */
const SAFE = /^[A-Za-z0-9][\w.:/@+-]*$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** provider:model を分ける。名前つきの接続先は custom:<名前>:<モデル>。モデルの ID には : が入ることがある */
function splitId(value: string): { provider: string; id: string } | null {
  const parts = value.split(":");
  const head = parts[0] === "custom" ? 2 : 1;
  if (parts.length <= head) return null;
  return { provider: parts.slice(0, head).join(":"), id: parts.slice(head).join(":") };
}

/** ACP の session/new の答えから一覧を作る */
export function parseHermesModels(result: unknown): AgentModel[] {
  const available = record(record(result)?.models)?.availableModels;
  if (!Array.isArray(available)) return [];
  return available.flatMap((entry): AgentModel[] => {
    const row = record(entry);
    if (typeof row?.modelId !== "string") return [];
    const parsed = splitId(row.modelId);
    if (!parsed || !SAFE.test(parsed.provider) || !SAFE.test(parsed.id)) return [];
    // 名前は「Anthropic · claude-haiku-4-5」の形
    const label = typeof row.name === "string" && row.name.includes(" · ") ? row.name.split(" · ")[0]!.trim() : parsed.provider;
    return [{ provider: parsed.provider, id: parsed.id, name: parsed.id, providerName: label, variants: [] }];
  });
}

/** ACP で一覧を聞く。動かせない・エラー・時間切れは空（標準エラーは読まない） */
export function listFromAcp(bin = "hermes", args: string[] = ["acp"], timeoutMs = 90_000): Promise<AgentModel[]> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let finished = false;
    const finish = (models: AgentModel[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      // 起動の途中は SIGTERM で止まらないことがある
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    const send = (id: number, method: string, params: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    const onLine = (line: string) => {
      let message: Record<string, unknown> | null;
      try {
        message = record(JSON.parse(line));
      } catch {
        return;
      }
      // method があるのは Hermes からの問い合わせ（答えではない）
      if (message?.method !== undefined) return;
      if (message?.id === 1) {
        if (message.error) return finish([]);
        send(2, "session/new", { cwd: homedir(), mcpServers: [] });
      } else if (message?.id === 2) {
        finish(message.error ? [] : parseHermesModels(message.result));
      }
    };
    child.on("error", () => finish([]));
    child.on("close", () => finish([]));
    child.stdin.on("error", () => finish([]));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_ACP_BUFFER) return finish([]);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    });
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  });
}

const MAX_ACP_BUFFER = 8 * 1024 * 1024;
const DAY_MS = 24 * 3_600_000;
const RETRY_MS = 10 * 60_000;

function readSaved(file: string): { at: number; models: AgentModel[] } | null {
  try {
    const saved = record(JSON.parse(readFileSync(file, "utf8")));
    if (typeof saved?.at !== "number" || !Array.isArray(saved.models) || saved.models.length === 0) return null;
    const models = saved.models as AgentModel[];
    const valid = (m: AgentModel) =>
      [m?.provider, m?.id].every((v) => typeof v === "string" && SAFE.test(v)) && typeof m.name === "string" && typeof m.providerName === "string" && Array.isArray(m.variants);
    return models.every(valid) ? { at: saved.at, models } : null;
  } catch {
    return null;
  }
}

/** ファイルに覚える一覧。新しければそのまま、古ければ手元のを返して裏で読み直す。手元に無いときだけ待つ */
export function persistentList(load: () => Promise<AgentModel[]>, file: string, now: () => number = Date.now): () => Promise<AgentModel[]> {
  let saved = readSaved(file);
  let running: Promise<void> | null = null;
  let tried = -Infinity;

  const refresh = (): Promise<void> => {
    tried = now();
    running ??= load()
      .then((models) => {
        if (models.length === 0) return;
        saved = { at: now(), models };
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
      })
      .catch(() => {})
      .finally(() => {
        running = null;
      });
    return running;
  };

  const known = () => saved?.models ?? [];

  return async () => {
    if (saved && now() - saved.at < DAY_MS) return saved.models;
    const mayTry = now() - tried >= RETRY_MS;
    if (saved) {
      if (mayTry && !running) void refresh();
      return saved.models;
    }
    if (running) await running;
    else if (mayTry) await refresh();
    return known();
  };
}

const RULE = /^─{2,}/;
const nonBlank = (screen: string) => screen.split("\n").filter((l) => l.trim());
const statusLine = (lines: string[]) => {
  const last = lines.at(-1)?.trim() ?? "";
  return last.startsWith("☤ ") ? last : null;
};

/**
 * いつもの入力の画面か。下から帯（☤ モデル…）・線・「❯」で始まる入力欄・線。
 * 作業中は欄が「☤ ❯」、承認中は「⚠ ❯」になり、帯の時計が ⏱ になる。書きかけは文字だけでは案内と区別できないので hermesHasDraft で見る
 */
export function hermesInput(screen: string): InputState {
  const lines = nonBlank(screen);
  const status = statusLine(lines);
  if (!status || status.includes("⏱") || !RULE.test(lines.at(-2) ?? "")) return { ready: false, draft: false };
  let top = lines.length - 3;
  while (top >= 0 && !RULE.test(lines[top]!)) top--;
  return { ready: top >= 0 && (lines[top + 1] ?? "").startsWith("❯"), draft: false };
}

/** 入力欄に書きかけがあるか（色つきの画面で見る）。斜体の字は Hermes の案内。読めないときは「ある」として打たない */
export function hermesHasDraft(ansi: string): boolean {
  const line = ansi.split("\n").findLast((l) => l.replace(/\x1b\[[0-9;]*m/g, "").startsWith("❯"));
  if (line === undefined) return true;
  const content = line.slice(line.indexOf("❯") + 1).replace(/^(?:\x1b\[[0-9;]*m| )+/, (head) => (head.includes("\x1b[3m") ? "\x1b[3m" : ""));
  return content !== "" && !content.startsWith("\x1b[3m");
}

/** 帯のいちばん左のモデル名 */
export function hermesCurrentModel(screen: string): string | null {
  const status = statusLine(nonBlank(screen));
  return status ? (/^☤\s+(.+?)(?:\s+·|$)/.exec(status)?.[1] ?? null) : null;
}

/** 帯に出る形（Hermes の cli_status_bar_mixin と同じ。/ の後ろ・.gguf を除く・26 文字まで） */
export function hermesBarName(id: string): string {
  const short = (id.split("/").at(-1) ?? id).replace(/\.gguf$/, "");
  return short.length > 26 ? `${short.slice(0, 23)}...` : short;
}

const stripAnsi = (ansi: string) => ansi.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * 色つきの画面 1 枚から「打てるか・書きかけか」を決める（別々に読むと、あいだで画面が変わる）。
 * 打てる画面でないときは書きかけと言わない：switchBySlash は書きかけを見てもう一度 Enter を押すので、
 * Hermes の確認の画面（高いモデルなど。先頭が「切り替える」）に Enter を送らないようにする
 */
export function hermesInputFromAnsi(ansi: string): InputState {
  const ready = hermesInput(stripAnsi(ansi)).ready;
  return { ready, draft: ready && hermesHasDraft(ansi) };
}

async function readAnsi(ctx: ProviderPaneContext): Promise<string> {
  try {
    const r = (await ctx.herdr.request("pane.read", { pane_id: ctx.paneId, source: "visible", lines: 80, format: "ansi" })) as { read?: { text?: unknown } } | null;
    return typeof r?.read?.text === "string" ? r.read.text : "";
  } catch {
    return "";
  }
}

export function createHermesModels(load?: () => Promise<AgentModel[]>, file?: string): ModelControl {
  // providers は app を読めない決まりなので、設定フォルダの場所はここで出す（app/paths.ts と同じ）
  const home = process.env.CROOK_HOME ?? join(homedir(), ".config", "crook");
  const list = persistentList(load ?? (() => listFromAcp()), file ?? join(home, "hermes-models.json"));
  return {
    async list(ctx): Promise<ModelListing> {
      const models = await list();
      const bar = hermesCurrentModel(await ctx.readScreen());
      const matches = models.filter((m) => hermesBarName(m.id) === bar);
      // 帯では区別できないものは「いまのモデル」にしない
      const found = matches.length === 1 ? matches[0] : undefined;
      return { current: found ? { provider: found.provider, id: found.id } : null, variant: null, recent: [], models };
    },
    async switch(ctx, req): Promise<ModelSwitchResult> {
      const models = await list();
      const target = models.find((m) => m.id === req.model && m.provider === req.provider);
      if (!target) return { ok: false, current: null, variant: null, message: "そのモデルは選べません" };
      const barName = hermesBarName(target.id);
      if (models.some((m) => m !== target && hermesBarName(m.id) === barName)) {
        return { ok: false, current: null, variant: null, message: "同じ名前のモデルがほかにもあり、切り替わったか確かめられません。Mac で /model を使ってください" };
      }
      const r = await switchBySlash(
        { ...ctx, readScreen: () => readAnsi(ctx) },
        {
          command: `/model ${target.id} --provider ${target.provider} --session`,
          target: barName,
          input: hermesInputFromAnsi,
          current: (ansi) => hermesCurrentModel(stripAnsi(ansi)),
        },
      );
      if (!r.ok) return { ok: false, current: null, variant: null, message: r.message ?? null };
      ctx.poke();
      return { ok: true, current: { provider: target.provider, id: target.id }, variant: null, message: null };
    },
  };
}
