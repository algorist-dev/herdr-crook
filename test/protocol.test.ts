import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol/parse.ts";

describe("parseClientMessage", () => {
  it("通知のボタンからの返事（answer）：番号と、どの質問への返事かの印", () => {
    expect(parseClientMessage(JSON.stringify({ t: "answer", pane: "w1:p1", key: "2", expect: "ab12cd34ab12cd34" }))).toEqual({ t: "answer", pane: "w1:p1", key: "2", expect: "ab12cd34ab12cd34" });
    expect(parseClientMessage(JSON.stringify({ t: "answer", pane: "w1:p1", key: "x", expect: "ab12cd34ab12cd34" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "answer", pane: "w1:p1", key: "1" }))).toBeNull();
  });

  it("モデル：一覧を頼む・モデルと考える量を切り替える", () => {
    expect(parseClientMessage(JSON.stringify({ t: "models", pane: "w1:p1" }))).toEqual({ t: "models", pane: "w1:p1" });
    expect(parseClientMessage(JSON.stringify({ t: "setModel", pane: "w1:p1", provider: "opencode-go", model: "kimi-k3", variant: "high" }))).toEqual({ t: "setModel", pane: "w1:p1", provider: "opencode-go", model: "kimi-k3", variant: "high" });
    expect(parseClientMessage(JSON.stringify({ t: "setModel", pane: "w1:p1", provider: "claude", model: "opus" }))).toEqual({ t: "setModel", pane: "w1:p1", provider: "claude", model: "opus", variant: null });
    expect(parseClientMessage(JSON.stringify({ t: "setModel", pane: "w1:p1", provider: "x y", model: "kimi-k3" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "setModel", pane: "w1:p1", provider: "claude", model: "opus", variant: "HIGH; rm" }))).toBeNull();
  });

  it("その場だけのつながり（once）は hello に印を付けられる", () => {
    expect(parseClientMessage(JSON.stringify({ t: "hello", token: "t", once: true }))).toEqual({ t: "hello", token: "t", once: true });
  });

  it("hello の言語は BCP 47 の形だけ通す（形が違えば書かなかったことにする）", () => {
    expect(parseClientMessage(JSON.stringify({ t: "hello", token: "t", lang: "en" }))).toEqual({ t: "hello", token: "t", lang: "en" });
    expect(parseClientMessage(JSON.stringify({ t: "hello", token: "t", lang: "zh-Hans" }))).toEqual({ t: "hello", token: "t", lang: "zh-Hans" });
    expect(parseClientMessage(JSON.stringify({ t: "hello", token: "t", lang: "../x" }))).toEqual({ t: "hello", token: "t" });
    expect(parseClientMessage(JSON.stringify({ t: "hello", token: "t", lang: "a".repeat(33) }))).toEqual({ t: "hello", token: "t" });
  });

  it("アプリの中で言語を替えたときのメッセージ", () => {
    expect(parseClientMessage(JSON.stringify({ t: "lang", lang: "en" }))).toEqual({ t: "lang", lang: "en" });
    expect(parseClientMessage(JSON.stringify({ t: "lang", lang: "../x" }))).toBeNull();
  });

  it("通知の宛先（Apple のデバイストークン、16 進）。空なら止める", () => {
    const token = "ab".repeat(32);
    expect(parseClientMessage(JSON.stringify({ t: "push", token, env: "sandbox" }))).toEqual({ t: "push", token, env: "sandbox" });
    expect(parseClientMessage(JSON.stringify({ t: "push", token: null, env: "production" }))).toEqual({ t: "push", token: null, env: "production" });
    expect(parseClientMessage(JSON.stringify({ t: "push", token: "xyz", env: "sandbox" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "push", token, env: "other" }))).toBeNull();
    // 設定が壊れていても宛先は受ける（設定だけ無いことにする）
    expect(parseClientMessage(JSON.stringify({ t: "push", token, env: "sandbox", prefs: { mutedWorkspaces: ["bad id"] } }))).toEqual({ t: "push", token, env: "sandbox" });
    expect(parseClientMessage(JSON.stringify({ t: "push", token, env: "sandbox", prefs: { enabled: false } }))).toMatchObject({ t: "push", token, prefs: { enabled: false } });
  });

  it("中継サーバー用の封をした宛先。おかしな封は封だけ無いことにする", () => {
    const token = "ab".repeat(32);
    const sealed = "A".repeat(120);
    expect(parseClientMessage(JSON.stringify({ t: "push", token, env: "production", sealed }))).toEqual({ t: "push", token, env: "production", sealed });
    expect(parseClientMessage(JSON.stringify({ t: "push", token, env: "production", sealed: null }))).toEqual({ t: "push", token, env: "production", sealed: null });
    expect(parseClientMessage(JSON.stringify({ t: "push", token, env: "production", sealed: "a/b" }))).toEqual({ t: "push", token, env: "production" });
    expect(parseClientMessage(JSON.stringify({ t: "push", token, env: "production", sealed: "A".repeat(2000) }))).toEqual({ t: "push", token, env: "production" });
    // 通知を止めるときは封も要らない
    expect(parseClientMessage(JSON.stringify({ t: "push", token: null, env: "production", sealed }))).toEqual({ t: "push", token: null, env: "production" });
  });
  it("合言葉でのペアリング", () => {
    expect(parseClientMessage('{"t":"pair","code":"abc","device":"iPhone"}')).toEqual({ t: "pair", code: "abc", device: "iPhone" });
  });

  it("鍵での接続", () => {
    expect(parseClientMessage('{"t":"hello","token":"tok","app":"0.1"}')).toEqual({ t: "hello", token: "tok", app: "0.1" });
  });

  it("ターミナルを開く。大きさは 10〜500 に収める", () => {
    expect(parseClientMessage('{"t":"open","pane":"w1:p1","cols":44,"rows":30,"mode":"fit"}')).toEqual({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "fit" });
    expect(parseClientMessage('{"t":"open","pane":"w1:p1","cols":2,"rows":9000,"mode":"fit"}')).toEqual({ t: "open", pane: "w1:p1", cols: 10, rows: 500, mode: "fit" });
  });

  it("開き方（mirror／fit）。書いていなければ受け付けない", () => {
    expect(parseClientMessage('{"t":"open","pane":"w1:p1","cols":44,"rows":30,"mode":"mirror"}')).toEqual({ t: "open", pane: "w1:p1", cols: 44, rows: 30, mode: "mirror" });
    expect(parseClientMessage('{"t":"open","pane":"w1:p1","cols":44,"rows":30}')).toBeNull();
    expect(parseClientMessage('{"t":"open","pane":"w1:p1","cols":44,"rows":30,"mode":"x"}')).toBeNull();
  });

  it("キー入力（base64）と文字の入力", () => {
    expect(parseClientMessage('{"t":"input","b64":"G1tB"}')).toEqual({ t: "input", b64: "G1tB" });
    expect(parseClientMessage('{"t":"input","b64":"not base64!"}')).toBeNull();
    expect(parseClientMessage('{"t":"prompt","pane":"w1:p2","text":"テストを直して"}')).toEqual({ t: "prompt", pane: "w1:p2", text: "テストを直して" });
  });

  it("大きさの変更・スクロール・閉じる", () => {
    expect(parseClientMessage('{"t":"resize","cols":50,"rows":20}')).toEqual({ t: "resize", cols: 50, rows: 20 });
    expect(parseClientMessage('{"t":"scroll","dir":"up","lines":3}')).toEqual({ t: "scroll", dir: "up", lines: 3 });
    expect(parseClientMessage('{"t":"scroll","dir":"left","lines":3}')).toBeNull();
    expect(parseClientMessage('{"t":"close"}')).toEqual({ t: "close" });
  });

  it("ペインの名前は Herdr の形だけ受け付ける", () => {
    expect(parseClientMessage('{"t":"open","pane":"; rm -rf /","cols":40,"rows":20}')).toBeNull();
    expect(parseClientMessage('{"t":"open","pane":"--takeover","cols":40,"rows":20}')).toBeNull();
  });

  it("会話を見る・やめる・コマンドの一覧を頼む", () => {
    expect(parseClientMessage('{"t":"chat","pane":"w1:p2"}')).toEqual({ t: "chat", pane: "w1:p2" });
    expect(parseClientMessage('{"t":"commands","pane":"w1:p2"}')).toEqual({ t: "commands", pane: "w1:p2" });
    expect(parseClientMessage('{"t":"unchat"}')).toEqual({ t: "unchat" });
    expect(parseClientMessage('{"t":"chat","pane":"../x"}')).toBeNull();
    expect(parseClientMessage('{"t":"commands","pane":"../x"}')).toBeNull();
  });

  it("ツールの行の中身を頼む（item は 200 文字まで）", () => {
    expect(parseClientMessage('{"t":"toolDetail","pane":"w1:p2","item":"a2:0"}')).toEqual({ t: "toolDetail", pane: "w1:p2", item: "a2:0" });
    expect(parseClientMessage(JSON.stringify({ t: "toolDetail", pane: "w1:p2", item: "a".repeat(200) }))).toEqual({
      t: "toolDetail",
      pane: "w1:p2",
      item: "a".repeat(200),
    });
    expect(parseClientMessage(JSON.stringify({ t: "toolDetail", pane: "w1:p2", item: "a".repeat(201) }))).toBeNull();
    expect(parseClientMessage('{"t":"toolDetail","pane":"../x","item":"a2:0"}')).toBeNull();
    expect(parseClientMessage('{"t":"toolDetail","pane":"w1:p2"}')).toBeNull();
  });

  it("使用量をもう一度送ってほしいと頼む", () => {
    expect(parseClientMessage('{"t":"usage","pane":"w1:p2"}')).toEqual({ t: "usage", pane: "w1:p2" });
    expect(parseClientMessage('{"t":"usage","pane":"../x"}')).toBeNull();
  });

  it("入力欄の「@」に出すファイルの候補を頼む", () => {
    expect(parseClientMessage('{"t":"files","pane":"w1:p2","query":"src/ap"}')).toEqual({ t: "files", pane: "w1:p2", query: "src/ap" });
    expect(parseClientMessage('{"t":"files","pane":"w1:p2","query":""}')).toEqual({ t: "files", pane: "w1:p2", query: "" });
    expect(parseClientMessage('{"t":"files","pane":"../x","query":""}')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "files", pane: "w1:p2", query: "a".repeat(201) }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "files", pane: "w1:p2", query: "a\0b" }))).toBeNull();
  });

  it("新しいワークスペースを作る。フォルダは絶対パスか ~ から。エージェントは決まったものだけ", () => {
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"~/src/api","label":"api","agent":"claude"}')).toEqual({
      t: "create", req: "r1", cwd: "~/src/api", label: "api", agent: "claude", unattended: false,
    });
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"/tmp"}')).toEqual({ t: "create", req: "r1", cwd: "/tmp", label: null, agent: null, unattended: false });
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"src/api"}')).toBeNull();
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"/tmp","agent":"rm -rf"}')).toBeNull();
    expect(parseClientMessage('{"t":"create","cwd":"/tmp"}')).toBeNull();
  });

  it("文章に画像を付けられる（4 枚まで・base64）。画像があれば文字は空でもよい", () => {
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
    expect(parseClientMessage(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "見て", images: [img] }))).toEqual({ t: "prompt", pane: "w1:p1", text: "見て", images: [img] });
    expect(parseClientMessage(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "", images: [img] }))).toEqual({ t: "prompt", pane: "w1:p1", text: "", images: [img] });
    expect(parseClientMessage(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "x", images: [img, img, img, img, img] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "x", images: ["not base64!"] }))).toBeNull();
  });

  it("画像は大きくても受け付けるが、文字は大きすぎると捨てる", () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 1).toString("base64");
    expect(parseClientMessage(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "x", images: [big] }))?.t).toBe("prompt");
    const tooBig = Buffer.alloc(6 * 1024 * 1024, 1).toString("base64");
    expect(parseClientMessage(JSON.stringify({ t: "prompt", pane: "w1:p1", text: "x", images: [tooBig] }))).toBeNull();
  });

  it("ワークスペースに新しいタブ（セッション）を足す", () => {
    expect(parseClientMessage('{"t":"newTab","req":"r1","workspace":"w1","agent":"claude"}')).toEqual({ t: "newTab", req: "r1", workspace: "w1", agent: "claude", unattended: false });
    expect(parseClientMessage('{"t":"newTab","req":"r1","workspace":"w1"}')).toEqual({ t: "newTab", req: "r1", workspace: "w1", agent: null, unattended: false });
    expect(parseClientMessage('{"t":"newTab","req":"r1","workspace":"w1; rm"}')).toBeNull();
    expect(parseClientMessage('{"t":"newTab","req":"r1","workspace":"w1","agent":"vim"}')).toBeNull();
    expect(parseClientMessage('{"t":"newTab","req":"r1","workspace":"w1","agent":"opencode"}')).toMatchObject({ agent: "opencode" });
  });

  it("確認なしの立ち上げ：無ければ false、true だけ通し、ほかの型は捨てる", () => {
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"/tmp","agent":"claude"}')).toEqual({
      t: "create", req: "r1", cwd: "/tmp", label: null, agent: "claude", unattended: false,
    });
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"/tmp","agent":"claude","unattended":true}')).toEqual({
      t: "create", req: "r1", cwd: "/tmp", label: null, agent: "claude", unattended: true,
    });
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"/tmp","agent":null,"unattended":true}')).toMatchObject({ agent: null, unattended: true });
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"/tmp","agent":"claude","unattended":"yes"}')).toBeNull();
    expect(parseClientMessage('{"t":"create","req":"r1","cwd":"/tmp","agent":"claude","unattended":1}')).toBeNull();
    expect(parseClientMessage('{"t":"newTab","req":"r1","workspace":"w1","agent":"claude","unattended":true}')).toEqual({
      t: "newTab", req: "r1", workspace: "w1", agent: "claude", unattended: true,
    });
    expect(parseClientMessage('{"t":"newTab","req":"r1","workspace":"w1","agent":"claude","unattended":"yes"}')).toBeNull();
    expect(parseClientMessage('{"t":"newTab","req":"r1","workspace":"w1","agent":"claude","unattended":1}')).toBeNull();
  });

  it("ターミナルに画像を貼る（Enter は押さない）", () => {
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
    expect(parseClientMessage(JSON.stringify({ t: "attach", pane: "w1:p1", images: [img] }))).toEqual({ t: "attach", pane: "w1:p1", images: [img] });
    expect(parseClientMessage(JSON.stringify({ t: "attach", pane: "w1:p1", images: [] }))).toBeNull();
  });

  it("タブ（ペイン）の操作：名前を変える・画面を消す・閉じる", () => {
    expect(parseClientMessage('{"t":"paneAction","pane":"w1:p1","action":"rename","label":"レビュー"}')).toEqual({ t: "paneAction", pane: "w1:p1", action: "rename", label: "レビュー" });
    expect(parseClientMessage('{"t":"paneAction","pane":"w1:p1","action":"rename","label":""}')).toEqual({ t: "paneAction", pane: "w1:p1", action: "rename", label: null });
    expect(parseClientMessage('{"t":"paneAction","pane":"w1:p1","action":"close"}')).toEqual({ t: "paneAction", pane: "w1:p1", action: "close", label: null });
    expect(parseClientMessage('{"t":"paneAction","pane":"w1:p1","action":"clear"}')?.t).toBe("paneAction");
    expect(parseClientMessage('{"t":"paneAction","pane":"w1:p1","action":"kill"}')).toBeNull();
  });

  it("知らない形や壊れた JSON は捨てる", () => {
    expect(parseClientMessage("{")).toBeNull();
    expect(parseClientMessage('{"t":"rm"}')).toBeNull();
    expect(parseClientMessage('{"t":"pair"}')).toBeNull();
    expect(parseClientMessage("[]")).toBeNull();
  });

  it("大きすぎる文字は捨てる", () => {
    const huge = "a".repeat(70_000);
    expect(parseClientMessage(JSON.stringify({ t: "prompt", pane: "w1:p1", text: huge }))).toBeNull();
  });
});
