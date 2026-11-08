// スマホから来たメッセージの形を確かめる。1 種類 1 関数の表にしてある。
import { isAgentKind } from "../herdr/installedAgents.ts";
import { parseNotificationPrefs } from "../notify/prefs.ts";
import { MAX_IMAGE_B64, MAX_IMAGES, MAX_MESSAGE_BYTES, MAX_TEXT, type ClientMessage, type StartableAgent } from "./messages.ts";

const PANE_ID = /^[A-Za-z0-9_]+:[A-Za-z0-9_]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

type Parser = (m: Record<string, unknown>) => ClientMessage | null;

export const CLIENT_PARSERS: { [T in ClientMessage["t"]]: Parser } = {
  pair: (m) => (isText(m.code, 256) && isText(m.device, 256) ? { t: "pair", code: m.code, device: m.device } : null),
  hello: (m) => {
    if (!isText(m.token, 256)) return null;
    const hello: ClientMessage = { t: "hello", token: m.token };
    if (isText(m.app, 32)) hello.app = m.app;
    if (m.once === true) hello.once = true;
    // hello では形が違えば「書かなかったこと」にする（つなぎは捨てない）
    if (isLanguage(m.lang)) hello.lang = m.lang;
    return hello;
  },
  lang: (m) => (isLanguage(m.lang) ? { t: "lang", lang: m.lang } : null),
  models: (m) => (isPane(m.pane) ? { t: "models", pane: m.pane } : null),
  setModel: (m) => {
    const id = /^[A-Za-z0-9._:@/-]{1,128}$/;
    if (!isPane(m.pane) || typeof m.provider !== "string" || !id.test(m.provider) || typeof m.model !== "string" || !id.test(m.model)) return null;
    if (m.variant !== undefined && m.variant !== null && (typeof m.variant !== "string" || !/^[a-z]{1,16}$/.test(m.variant))) return null;
    return { t: "setModel", pane: m.pane, provider: m.provider, model: m.model, variant: typeof m.variant === "string" ? m.variant : null };
  },
  answer: (m) => {
    if (!isPane(m.pane) || typeof m.key !== "string" || !/^[1-9]$/.test(m.key)) return null;
    if (typeof m.expect !== "string" || !/^[0-9a-f]{16}$/.test(m.expect)) return null;
    return { t: "answer", pane: m.pane, key: m.key, expect: m.expect };
  },
  open: (m) => {
    if (!isPane(m.pane) || !isNum(m.cols) || !isNum(m.rows)) return null;
    if (m.mode !== "mirror" && m.mode !== "fit") return null;
    return { t: "open", pane: m.pane, cols: clamp(m.cols), rows: clamp(m.rows), mode: m.mode };
  },
  input: (m) => (typeof m.b64 === "string" && m.b64.length <= MAX_TEXT && BASE64.test(m.b64) ? { t: "input", b64: m.b64 } : null),
  resize: (m) => (isNum(m.cols) && isNum(m.rows) ? { t: "resize", cols: clamp(m.cols), rows: clamp(m.rows) } : null),
  scroll: (m) => {
    if ((m.dir !== "up" && m.dir !== "down") || !isNum(m.lines)) return null;
    return { t: "scroll", dir: m.dir, lines: Math.max(1, Math.min(200, Math.round(m.lines))) };
  },
  close: () => ({ t: "close" }),
  prompt: (m) => {
    if (!isPane(m.pane) || typeof m.text !== "string" || m.text.length > MAX_TEXT) return null;
    if (m.images === undefined) return m.text.length > 0 ? { t: "prompt", pane: m.pane, text: m.text } : null;
    const images = m.images;
    if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES) return null;
    if (!images.every((i) => typeof i === "string" && i.length > 0 && i.length <= MAX_IMAGE_B64 && BASE64.test(i))) return null;
    return { t: "prompt", pane: m.pane, text: m.text, images: images as string[] };
  },
  create: (m) => {
    if (!isText(m.req, 64) || !isText(m.cwd, 1024) || !/^(\/|~\/|~$)/.test(m.cwd) || m.cwd.includes("\0")) return null;
    if (m.label !== undefined && m.label !== null && !isText(m.label, 80)) return null;
    if (m.agent !== undefined && m.agent !== null && !isAgentKind(m.agent)) return null;
    if (m.unattended !== undefined && typeof m.unattended !== "boolean") return null;
    return {
      t: "create",
      req: m.req,
      cwd: m.cwd,
      label: typeof m.label === "string" ? m.label : null,
      agent: (m.agent as StartableAgent | undefined) ?? null,
      unattended: m.unattended === true,
    };
  },
  keys: (m) => {
    if (!isPane(m.pane) || !Array.isArray(m.keys) || m.keys.length === 0 || m.keys.length > 32) return null;
    if (!m.keys.every((k) => typeof k === "string" && /^[a-z0-9+_-]{1,24}$/.test(k))) return null;
    return { t: "keys", pane: m.pane, keys: m.keys as string[] };
  },
  paneAction: (m) => {
    if (!isPane(m.pane) || (m.action !== "rename" && m.action !== "clear" && m.action !== "close")) return null;
    if (m.label !== undefined && m.label !== null && (typeof m.label !== "string" || m.label.length > 60)) return null;
    const label = typeof m.label === "string" && m.label.trim() ? m.label.trim() : null;
    return { t: "paneAction", pane: m.pane, action: m.action, label };
  },
  attach: (m) => {
    const images = m.images;
    if (!isPane(m.pane) || !Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES) return null;
    if (!images.every((i) => typeof i === "string" && i.length > 0 && i.length <= MAX_IMAGE_B64 && BASE64.test(i))) return null;
    return { t: "attach", pane: m.pane, images: images as string[] };
  },
  newTab: (m) => {
    if (!isText(m.req, 64) || typeof m.workspace !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(m.workspace)) return null;
    if (m.agent !== undefined && m.agent !== null && !isAgentKind(m.agent)) return null;
    if (m.unattended !== undefined && typeof m.unattended !== "boolean") return null;
    return {
      t: "newTab",
      req: m.req,
      workspace: m.workspace,
      agent: (m.agent as StartableAgent | undefined) ?? null,
      unattended: m.unattended === true,
    };
  },
  chat: (m) => (isPane(m.pane) ? { t: "chat", pane: m.pane } : null),
  commands: (m) => (isPane(m.pane) ? { t: "commands", pane: m.pane } : null),
  files: (m) => {
    if (!isPane(m.pane) || typeof m.query !== "string" || m.query.length > 200 || m.query.includes("\0")) return null;
    return { t: "files", pane: m.pane, query: m.query };
  },
  toolDetail: (m) => (isPane(m.pane) && isText(m.item, 200) ? { t: "toolDetail", pane: m.pane, item: m.item } : null),
  usage: (m) => (isPane(m.pane) ? { t: "usage", pane: m.pane } : null),
  unchat: () => ({ t: "unchat" }),
  push: (m) => {
    if (m.env !== "sandbox" && m.env !== "production") return null;
    // prefs は乗っていれば中身を確かめる。合わなければ設定だけ無いことにし、宛先は受ける（通知が止まらないように）
    const prefs = parseNotificationPrefs(m.prefs);
    if (m.token === null) {
      return prefs ? { t: "push", token: null, env: m.env, prefs } : { t: "push", token: null, env: m.env };
    }
    if (typeof m.token !== "string" || !/^[0-9a-f]{32,200}$/.test(m.token)) return null;
    return prefs ? { t: "push", token: m.token, env: m.env, prefs } : { t: "push", token: m.token, env: m.env };
  },
  pushTest: () => ({ t: "pushTest" }),
  ping: () => ({ t: "ping" }),
};

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;

  const parser = typeof m.t === "string" && Object.hasOwn(CLIENT_PARSERS, m.t) ? CLIENT_PARSERS[m.t as ClientMessage["t"]] : null;
  return parser ? parser(m) : null;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isPane(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && PANE_ID.test(value);
}

function isLanguage(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && LANGUAGE.test(value);
}

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(n: number): number {
  return Math.max(10, Math.min(500, Math.round(n)));
}
