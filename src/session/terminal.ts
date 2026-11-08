// ターミナル画面の中継と、スマホ表示（fit）で変えたペインの大きさを戻す処理。
// iPhone が開いているペインだけを扱う。エージェントの種類には触らない。
import { bytesToSteps } from "../herdr/inputMapping.ts";
import type { ClientMessage } from "../protocol/messages.ts";
import type { RelayDeps } from "../relay.ts";
import type { Frame, Terminal } from "../herdr/terminalSession.ts";
import type { HandlerTable, PaneSize, RestoreManager, SessionBase, TerminalController } from "./types.ts";
import { describeError } from "./types.ts";

/** スマホ表示で変えたペインを元の大きさに戻す。受け口ぜんぶで 1 つ使う */
export function createRestoreManager(opts: { openTerminal: RelayDeps["openTerminal"]; graceMs: number; log(m: string): void }): RestoreManager {
  let shuttingDown = false;
  const pending = new Map<string, { timer: NodeJS.Timeout; size: PaneSize }>();

  const restoreNow = (pane: string, size: PaneSize) => {
    // 元の大きさで制御を取り直して、すぐ返す
    const restorer = opts.openTerminal(pane, size.cols, size.rows, { onFrame() {}, onClosed() {} }, false);
    setTimeout(() => restorer.close(), 300).unref?.();
    opts.log(`restored ${pane} to ${size.cols}x${size.rows}`);
  };

  const schedule = (pane: string, size: PaneSize) => {
    // 中継を止める途中なら、待たずに戻す
    if (shuttingDown) {
      restoreNow(pane, size);
      return;
    }
    clearTimeout(pending.get(pane)?.timer);
    const timer = setTimeout(() => {
      pending.delete(pane);
      restoreNow(pane, size);
    }, opts.graceMs);
    timer.unref?.();
    pending.set(pane, { timer, size });
  };

  const take = (pane: string): PaneSize | null => {
    const waiting = pending.get(pane);
    if (!waiting) return null;
    clearTimeout(waiting.timer);
    pending.delete(pane);
    return waiting.size;
  };

  const shutdown = () => {
    shuttingDown = true;
    for (const [pane, waiting] of pending) {
      clearTimeout(waiting.timer);
      restoreNow(pane, waiting.size);
    }
    pending.clear();
  };

  return { restoreNow, schedule, take, shutdown };
}

export function createTerminalController(ctx: SessionBase): TerminalController {
  let terminal: Terminal | null = null;
  /** いま開いているペインと開き方。fit なら開く前の大きさ（閉じたら戻す） */
  let current: { pane: string; mode: "mirror" | "fit"; restore: PaneSize | null } | null = null;
  /** デスクトップ表示で送るキーの順番を守る */
  let inputChain: Promise<void> = Promise.resolve();

  /** 開いているターミナルを閉じる。スマホ表示なら元の大きさに戻す（切れたときは少し待ってから） */
  const close = (why: "explicit" | "disconnect") => {
    terminal?.close();
    terminal = null;
    const was = current;
    current = null;
    if (was?.mode === "fit" && was.restore) {
      if (why === "explicit") ctx.services.restores.restoreNow(was.pane, was.restore);
      else ctx.services.restores.schedule(was.pane, was.restore);
    }
  };

  const open = (msg: Extract<ClientMessage, { t: "open" }>) => {
    close("explicit");
    const pane = msg.pane;
    // fit（スマホ表示）：見ている間だけペインをスマホの幅にし、離れたら元に戻す。
    // mirror（デスクトップ表示）：observe で見るだけ。Mac には触らない
    const before = ctx.pane(pane);
    const pending = ctx.services.restores.take(pane);
    let restore = before?.cols && before?.rows ? { cols: before.cols, rows: before.rows } : null;
    if (pending) {
      if (msg.mode === "fit") restore = pending; // 続きなので、戻す大きさは前のまま
      else ctx.services.restores.restoreNow(pane, pending); // デスクトップ表示で開き直したなら、すぐ戻す
    }
    current = { pane, mode: msg.mode, restore };
    if (msg.mode === "fit") ctx.announce(pane, true);
    ctx.services.log(`open ${pane} mode=${msg.mode} ${msg.cols}x${msg.rows}`);
    const opened: Terminal = ctx.services.deps.openTerminal(
      pane,
      msg.cols,
      msg.rows,
      {
        onFrame: (f: Frame) => {
          if (terminal === opened) ctx.send({ t: "frame", ...f });
        },
        onClosed: (reason: string) => {
          if (terminal !== opened) return;
          terminal = null;
          ctx.send({ t: "closed", reason });
          ctx.services.log(`terminal ${pane} closed: ${reason}`);
        },
      },
      msg.mode === "mirror",
    );
    terminal = opened;
  };

  const input = (b64: string) => {
    if (current?.mode === "fit") {
      ctx.announce(current.pane, true);
      terminal?.input(b64);
    } else if (current) {
      const pane = current.pane;
      ctx.announce(pane);
      const steps = bytesToSteps(Buffer.from(b64, "base64"));
      inputChain = inputChain
        .then(async () => {
          for (const step of steps) {
            if ("text" in step) await ctx.services.deps.herdr.request("pane.send_text", { pane_id: pane, text: step.text });
            else await ctx.services.deps.herdr.request("pane.send_keys", { pane_id: pane, keys: step.keys });
          }
        })
        .catch((err) => ctx.send({ t: "error", message: describeError(err) }));
    }
  };

  const resize = (cols: number, rows: number) => {
    if (current?.mode === "fit") terminal?.resize(cols, rows);
  };

  const scroll = (dir: "up" | "down", lines: number) => {
    terminal?.scroll(dir, lines);
  };

  return {
    open,
    input,
    resize,
    scroll,
    close,
    currentPane: () => current?.pane ?? null,
  };
}

export const terminalHandlers: HandlerTable = {
  open: (ctx, msg) => ctx.terminal.open(msg),
  input: (ctx, msg) => ctx.terminal.input(msg.b64),
  resize: (ctx, msg) => ctx.terminal.resize(msg.cols, msg.rows),
  scroll: (ctx, msg) => ctx.terminal.scroll(msg.dir, msg.lines),
  close: (ctx) => ctx.terminal.close("explicit"),
};
