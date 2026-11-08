import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeStore } from "../src/providers/opencode/store.ts";

function makeDb() {
  const path = join(mkdtempSync(join(tmpdir(), "hm-oc-")), "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id text primary key, parent_id text, directory text not null, title text not null, time_created integer not null, time_updated integer not null, time_archived integer, cost real, tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer, model text);
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
  `);
  const session = db.prepare("insert into session (id, parent_id, directory, title, time_created, time_updated, time_archived) values (?,?,?,?,?,?,?)");
  session.run("ses_old", null, "/repo/app", "前の作業", 1, 10, null);
  session.run("ses_new", null, "/repo/app", "ログインを直す", 2, 20, null);
  session.run("ses_child", "ses_new", "/repo/app", "子", 3, 30, null);
  session.run("ses_other", null, "/repo/web", "web", 4, 40, null);
  db.prepare(
    "update session set cost = ?, tokens_input = ?, tokens_output = ?, tokens_reasoning = ?, tokens_cache_read = ?, tokens_cache_write = ?, model = ? where id = ?",
  ).run(0.1405, 380631, 24572, 41553, 14575232, 0, JSON.stringify({ id: "deepseek-v4.1-flash", providerID: "opencode-go" }), "ses_new");
  const message = db.prepare("insert into message values (?,?,?,?,?)");
  message.run("msg_1", "ses_new", 100, 100, JSON.stringify({ role: "user" }));
  message.run("msg_2", "ses_new", 200, 200, JSON.stringify({ role: "assistant" }));
  message.run("msg_3", "ses_new", 300, 300, JSON.stringify({ role: "assistant", tokens: { total: 230000, input: 1000, output: 200, reasoning: 100, cache: { read: 228700, write: 0 } } }));
  const part = db.prepare("insert into part values (?,?,?,?,?,?)");
  part.run("prt_1", "msg_1", "ses_new", 100, 100, JSON.stringify({ type: "text", text: "ログインが落ちる" }));
  part.run("prt_2", "msg_1", "ses_new", 101, 101, JSON.stringify({ type: "text", text: "<system>", synthetic: true }));
  part.run("prt_3", "msg_2", "ses_new", 200, 200, JSON.stringify({ type: "reasoning", text: "考え中" }));
  part.run("prt_4", "msg_2", "ses_new", 201, 201, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" } } }));
  part.run("prt_5", "msg_2", "ses_new", 202, 202, JSON.stringify({ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/repo/app/src/login.ts" } } }));
  part.run("prt_6", "msg_2", "ses_new", 203, 203, JSON.stringify({ type: "text", text: "直しました" }));
  part.run("prt_7", "msg_2", "ses_new", 204, 204, JSON.stringify({ type: "step-finish" }));
  db.close();
  return path;
}

describe("OpenCode の会話を読む", () => {
  it("そのフォルダのいちばん新しい会話（子でない・しまっていない）を、チャットの形にする", () => {
    const store = new OpenCodeStore(makeDb());
    const chat = store.read("/repo/app")!;
    expect(chat.title).toBe("ログインを直す");
    expect(chat.items).toEqual([
      { id: "prt_1", role: "user", kind: "text", text: "ログインが落ちる" },
      { id: "prt_4", role: "assistant", kind: "tool", tool: "Bash", text: "npm test" },
      { id: "prt_5", role: "assistant", kind: "tool", tool: "Read", text: "src/login.ts" },
      { id: "prt_6", role: "assistant", kind: "text", text: "直しました" },
    ]);
    store.close();
  });

  it("セッションの集計と最後の返事から使用量を読む", () => {
    const store = new OpenCodeStore(makeDb());
    const chat = store.read("/repo/app")!;
    expect(chat.usage).toEqual({
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
      contextUsed: 230000,
      contextLimit: null,
      contextPercent: null,
      tokens: { input: 380631, output: 24572, cacheRead: 14575232, cacheWrite: 0, reasoning: 41553 },
      cost: 0.1405,
      limits: [],
      source: "opencode",
    });
    store.close();
  });

  it("会話がないフォルダや、データベースがなければ null", () => {
    const store = new OpenCodeStore(makeDb());
    expect(store.read("/nowhere")).toBeNull();
    expect(new OpenCodeStore("/no/such/opencode.db").read("/repo/app")).toBeNull();
  });
});
