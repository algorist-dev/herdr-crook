import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHermesProvider, hermesScreenStatus, isHermesProcess } from "../../src/providers/hermes/index.ts";
import { HermesStore, hermesHome } from "../../src/providers/hermes/store.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const SESSION = "local-9a167f8f2013226d0070c0def17d3bc9ed11f1def19ef8f9a8cae4c85dffa644";

/** 実物（Hermes 0.23 の state.db）から取った行で、小さなデータベースを作る */
function makeDb(extra: (db: DatabaseSync) => void = () => {}): string {
  const path = join(mkdtempSync(join(tmpdir(), "hermes-db-")), "state.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, cwd TEXT, started_at REAL,
    message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    reasoning_tokens INTEGER, billing_provider TEXT, estimated_cost_usd REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT,
    tool_name TEXT, timestamp REAL, finish_reason TEXT, reasoning TEXT, active INTEGER, display_kind TEXT, message_uid TEXT);`);
  for (const s of JSON.parse(readFileSync(join(fixtures, "hermes-0.23-session.json"), "utf8")) as Record<string, unknown>[]) {
    db.prepare(
      "INSERT INTO sessions (id, source, model, title, cwd, started_at, message_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider, estimated_cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(s.id as string, s.source as string, s.model as string, s.title as string, s.cwd as string, s.started_at as number, s.message_count as number,
      s.input_tokens as number, s.output_tokens as number, s.cache_read_tokens as number, s.cache_write_tokens as number, 0, "anthropic", s.estimated_cost_usd as number);
  }
  for (const m of JSON.parse(readFileSync(join(fixtures, "hermes-0.23-messages.json"), "utf8")) as Record<string, unknown>[]) {
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning, active, display_kind, message_uid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(m.id as number, m.session_id as string, m.role as string, (m.content as string) ?? null, (m.tool_call_id as string) ?? null, (m.tool_calls as string) ?? null,
      (m.tool_name as string) ?? null, m.timestamp as number, (m.finish_reason as string) ?? null, (m.reasoning as string) ?? null, m.active as number, null, m.message_uid as string);
  }
  extra(db);
  db.close();
  return path;
}

describe("Hermes の会話（実物の見本、0.23 の state.db）", () => {
  it("あなたの発言・ツール・返事を読み、ツールの結果の行は出さない", () => {
    const chat = new HermesStore(makeDb()).read(SESSION)!;
    expect(chat.title).toBe("Read note.txt and delete scratch-dir");
    expect(chat.items).toEqual([
      { id: "d1a44adc45f544cda248ff804df203bc", role: "user", kind: "text", text: "Read note.txt, then run `rm -rf ./scratch-dir` in the terminal. Reply in one short line." },
      { id: "bf89a58e31ea436d9a55e12d73061bd6:toolu_014Y3ekDZmBBr35qZc9qDa6c", role: "assistant", kind: "tool", tool: "read_file", text: "note.txt" },
      { id: "bf89a58e31ea436d9a55e12d73061bd6:toolu_016iV2oVjjyZrKrtc6zzDb4V", role: "assistant", kind: "tool", tool: "terminal", text: "rm -rf ./scratch-dir" },
      { id: "3e7b01d769724ee097ad13233ae313ed", role: "assistant", kind: "text", text: "note.txt contains \"hello\"; scratch-dir removed." },
    ]);
  });

  it("使用量は sessions の累計（トークン・費用・モデル）", () => {
    const usage = new HermesStore(makeDb()).read(SESSION)!.usage!;
    expect(usage).toMatchObject({
      source: "hermes",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      tokens: { input: 10, output: 111, cacheRead: 13678, cacheWrite: 13916, reasoning: 0 },
      cost: 0.0193278,
    });
  });

  it("縮めたときの古い世代（active=0）は読まない", () => {
    const path = makeDb((db) =>
      db.prepare("INSERT INTO messages (id, session_id, role, content, active, timestamp, message_uid) VALUES (99, ?, 'user', '古い', 0, 0, 'old')").run(SESSION),
    );
    expect(new HermesStore(path).read(SESSION)!.items.map((i) => i.text)).not.toContain("古い");
  });

  describe("Hermes が自分で入れた行", () => {
    const END = "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---";
    const add = (db: DatabaseSync, id: number, role: string, content: string, kind: string | null = null) =>
      db.prepare("INSERT INTO messages (id, session_id, role, content, active, timestamp, message_uid, display_kind) VALUES (?, ?, ?, ?, 1, 9, ?, ?)").run(id, SESSION, role, content, `x${id}`, kind);
    const texts = (fill: (db: DatabaseSync) => void) => new HermesStore(makeDb(fill)).read(SESSION)!.items.map((i) => i.text);

    it("縮めたときの要約は、人の発言にも返事にも出さない", () => {
      const out = texts((db) => {
        add(db, 100, "user", "[CONTEXT COMPACTION — REFERENCE ONLY] 要約その1");
        add(db, 101, "assistant", "[CONTEXT SUMMARY]: 要約その2");
      });
      expect(out.join("\n")).not.toContain("要約その");
    });

    it("要約が発言の行に混ざっていたら、発言のところだけ出す", () => {
      const out = texts((db) => {
        add(db, 100, "user", `[CONTEXT COMPACTION — REFERENCE ONLY] 要約\n\n${END}\n\n後ろの本当の発言`);
        add(db, 101, "user", "[PRIOR CONTEXT — for reference only; not a new message]\n前の本当の発言\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n要約");
      });
      expect(out).toEqual(expect.arrayContaining(["後ろの本当の発言", "前の本当の発言"]));
      expect(out).not.toContain("要約");
    });

    it("お知らせと発言が 1 行にまとまっていたら、発言は残す", () => {
      const out = texts((db) => {
        add(db, 100, "user", "[System: 再開しました]\n\n本当の発言");
      });
      expect(out).toContain("本当の発言");
      expect(out).not.toContain("[System: 再開しました]\n\n本当の発言");
    });

    it("display_kind の列が無い古いデータベースでも読める", () => {
      const out = new HermesStore(makeDb((db) => db.exec("ALTER TABLE messages DROP COLUMN display_kind"))).read(SESSION)!;
      expect(out.items).toHaveLength(4);
    });

    it("お知らせ（[System: …]・種類の付いた行）は発言にしない。ふつうの発言はそのまま", () => {
      const out = texts((db) => {
        add(db, 100, "user", "[System: 再開しました]");
        add(db, 101, "user", "モデルを替えた知らせ", "model_switch");
        add(db, 102, "user", "ふつうの発言");
      });
      expect(out).toContain("ふつうの発言");
      expect(out).not.toContain("[System: 再開しました]");
      expect(out).not.toContain("モデルを替えた知らせ");
    });
  });

  it("ツールの中身：コマンドと結果（承認の文も）", () => {
    const store = new HermesStore(makeDb());
    const detail = store.toolDetail(SESSION, "bf89a58e31ea436d9a55e12d73061bd6:toolu_016iV2oVjjyZrKrtc6zzDb4V")!;
    expect(detail.running).toBe(false);
    expect(detail.error).toBe(false);
    expect(detail.sections.map((s) => s.text)).toContain("rm -rf ./scratch-dir");
    const read = store.toolDetail(SESSION, "bf89a58e31ea436d9a55e12d73061bd6:toolu_014Y3ekDZmBBr35qZc9qDa6c")!;
    expect(read.sections.map((s) => s.text).join("\n")).toContain("1|hello");
    expect(store.toolDetail(SESSION, "nope:x")).toBeNull();
  });

  it("データベースが無い・会話が無いときは null", () => {
    expect(new HermesStore("/nowhere/state.db").read(SESSION)).toBeNull();
    expect(new HermesStore(makeDb()).read("local-none")).toBeNull();
  });

  it("HERMES_HOME があればそこ、なければ ~/.hermes", () => {
    expect(hermesHome({ HERMES_HOME: "/h" }, "/home/me")).toBe("/h");
    expect(hermesHome({}, "/home/me")).toBe("/home/me/.hermes");
  });
});

describe("Hermes の見分け（Herdr 0.9.5 は見分けないので、こちらで）", () => {
  it("0.23 のインストーラーの起動（python3 -I -c …from hermes_cli.main import main…）", () => {
    // 実物の pane.process_info の形（スクリプトは短くした）
    const argv = ["/home/u/.hermes/tools/python-3.14/bin/python3", "-I", "-c", "import os\nsys.path.insert(0, '/home/u/.hermes/hermes-agent')\nfrom hermes_cli.main import main\nsys.exit(main())\n"];
    expect(isHermesProcess([{ name: "python3.14", argv }])).toBe(true);
    expect(isHermesProcess([{ name: "hermes", argv: ["hermes"] }])).toBe(true);
    expect(isHermesProcess([{ name: "python3", argv: ["/x/bin/hermes", "chat"] }])).toBe(true);
  });

  it("シェルや、ほかの python は Hermes でない", () => {
    expect(isHermesProcess([{ name: "zsh", argv: ["-zsh"] }])).toBe(false);
    expect(isHermesProcess([{ name: "python3", argv: ["python3", "-I", "-c", "print('hermes')"] }])).toBe(false);
    // ほかのコマンドの引数に hermes が出てくるだけでは Hermes でない（レビューの指摘）
    expect(isHermesProcess([{ name: "git", argv: ["git", "switch", "hermes"] }])).toBe(false);
    expect(isHermesProcess([{ name: "nvim", argv: ["nvim", "hermes"] }])).toBe(false);
    expect(isHermesProcess([{ name: "tail", argv: ["tail", "-f", "logs/hermes"] }])).toBe(false);
    expect(isHermesProcess([{ name: "python3", argv: ["python3", "-m", "hermes_cli.main"] }])).toBe(true);
    expect(isHermesProcess([])).toBe(false);
  });

  it("プロバイダ：連携の報告（herdr:hermes）で見分け、確認なしは --yolo", () => {
    const p = createHermesProvider({ dbPath: "/nowhere" });
    expect(p.recognize?.sessionSource).toBe("herdr:hermes");
    expect(p.unattendedArgs).toEqual(["--yolo"]);
    expect(p.chatKey({ agent: "hermes", sessionSource: "herdr:hermes", sessionValue: "local-1" }, "/a")).toBe("hermes:local-1");
    expect(p.chatKey({ agent: "hermes", sessionSource: null, sessionValue: null }, "/a")).toBeNull();
  });

  it("会話を開くと読み、変わらなければ送らない", () => {
    const p = createHermesProvider({ dbPath: makeDb() });
    const stream = p.chat!.open(() => `hermes:${SESSION}`);
    const first = stream.poll();
    expect(first.chat?.items).toHaveLength(4);
    expect(first.usage?.cost).toBeCloseTo(0.0193278, 7);
    expect(stream.poll().chat).toBeNull();
    expect(p.chat!.title(`hermes:${SESSION}`)).toBe("Read note.txt and delete scratch-dir");
  });
});

describe("Hermes の承認の画面（実物、0.23）", () => {
  it("危ないコマンドの承認が出ていれば blocked", () => {
    expect(hermesScreenStatus(readFileSync(join(fixtures, "hermes-0.23-approval.txt"), "utf8"))).toBe("blocked");
  });

  it("いつもの入力の画面は null", () => {
    const idle = ["☤ Hermes", "note.txt contains \"hello\"; scratch-dir removed.", "─".repeat(40), "❯ Find and fix a failing test", "─".repeat(40), " ☤ claude-haiku-4-5 · ~14K/200K"].join("\n");
    expect(hermesScreenStatus(idle)).toBeNull();
  });
});

describe("Hermes の承認の画面：文が変わったら「分からない」に落ちる", () => {
  const approval = () => readFileSync(join(fixtures, "hermes-0.23-approval.txt"), "utf8");

  it("案内の文（↑/↓ to select, Enter to confirm）が変わったら null（誤って返事待ちにしない）", () => {
    expect(hermesScreenStatus(approval().replace("↑/↓ to select, Enter to confirm", "↑/↓ で選んで Enter で決定"))).toBeNull();
    expect(hermesScreenStatus(approval().replace("↑/↓ to select, Enter to confirm", ""))).toBeNull();
  });

  it("選択肢の形（❯ 1.）が変わったら null", () => {
    expect(hermesScreenStatus(approval().replace("❯ 1. Allow once", "> [1] Allow once"))).toBeNull();
  });

  it("案内の文が画面の上のほう（40 行より前）に残っているだけなら null", () => {
    const old = approval() + "\n" + Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n");
    expect(hermesScreenStatus(old)).toBeNull();
  });
});
