import { describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApnsClient, apnsHost, loadApnsConfig, makeProviderToken, pushPayload, saveApnsConfig } from "../src/notify/apns.ts";

describe("APNs", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("Apple に出す合図（JWT）は ES256 で、鍵の ID とチームが入る", () => {
    const jwt = makeProviderToken({ keyId: "ABC123DEFG", teamId: "TEAM123456", key: pem }, 1_700_000_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1_700_000_000 });
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });

  it("開発用の宛先と本番の宛先", () => {
    expect(apnsHost("sandbox")).toBe("https://api.sandbox.push.apple.com");
    expect(apnsHost("production")).toBe("https://api.push.apple.com");
  });

  it("知らせの中身：題名・本文・音・ペイン（押したら開く）", () => {
    const payload = pushPayload({ paneId: "w1:p1", kind: "needs-input", title: "1:claude · web", body: "返事を待っています" });
    expect(payload).toEqual({
      aps: { alert: { title: "1:claude · web", body: "返事を待っています" }, sound: "default", "thread-id": "w1:p1", category: "hm.reply" },
      pane: "w1:p1",
      kind: "needs-input",
    });
  });

  it("設定は鍵ファイルを本人だけが読める場所にしまい、読み戻せる", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-apns-"));
    const src = join(dir, "AuthKey_ABC123DEFG.p8");
    writeFileSync(src, pem);
    expect(loadApnsConfig(dir)).toBeNull();
    saveApnsConfig(dir, { keyPath: src, keyId: "ABC123DEFG", teamId: "TEAM123456", topic: "jp.algorist.crook" });
    const cfg = loadApnsConfig(dir);
    expect(cfg).toMatchObject({ keyId: "ABC123DEFG", teamId: "TEAM123456", topic: "jp.algorist.crook" });
    expect(cfg!.key).toContain("PRIVATE KEY");
  });

  it("鍵ファイルの名前（AuthKey_<ID>.p8）から鍵の ID を読む", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-apns-"));
    const src = join(dir, "AuthKey_XYZ987WVUT.p8");
    writeFileSync(src, pem);
    saveApnsConfig(dir, { keyPath: src, teamId: "TEAM123456", topic: "jp.algorist.crook" });
    expect(loadApnsConfig(dir)!.keyId).toBe("XYZ987WVUT");
  });
});

describe("ApnsClient", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const cfg = { keyId: "ABC123DEFG", teamId: "TEAM123456", topic: "jp.algorist.crook", key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const payload = pushPayload({ paneId: "w1:p1", kind: "finished", title: "t", body: "b" });

  async function server(handler: (stream: import("node:http2").ServerHttp2Stream, headers: import("node:http2").IncomingHttpHeaders) => void) {
    const { createServer } = await import("node:http2");
    const s = createServer();
    s.on("stream", handler);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
  }

  it("宛先・合図・トピックを付けて送り、200 なら届いた", async () => {
    let seen: import("node:http2").IncomingHttpHeaders = {};
    const s = await server((stream, headers) => {
      seen = headers;
      stream.respond({ ":status": 200 });
      stream.end();
    });
    const client = new ApnsClient(cfg, { host: () => s.url });
    const r = await client.send({ token: "ab".repeat(32), env: "sandbox" }, payload);
    client.close();
    await s.close();
    expect(r.ok).toBe(true);
    expect(seen[":path"]).toBe(`/3/device/${"ab".repeat(32)}`);
    expect(seen["apns-topic"]).toBe("jp.algorist.crook");
    expect(String(seen.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("アプリが消された（410）ときだけ宛先を消してよい。BadDeviceToken は残す", async () => {
    let answer = { status: 410, reason: "Unregistered" };
    const s = await server((stream) => {
      stream.respond({ ":status": answer.status, "content-type": "application/json" });
      stream.end(JSON.stringify({ reason: answer.reason }));
    });
    const client = new ApnsClient(cfg, { host: () => s.url });
    expect(await client.send({ token: "aa", env: "sandbox" }, payload)).toMatchObject({ ok: false, invalidToken: true });
    answer = { status: 400, reason: "BadDeviceToken" };
    expect(await client.send({ token: "aa", env: "sandbox" }, payload)).toMatchObject({ ok: false, invalidToken: false, reason: "BadDeviceToken" });
    client.close();
    await s.close();
  });

  it("返事がなければ時間切れで終わる（待ち続けない）", async () => {
    const s = await server(() => {
      // 何も返さない
    });
    const client = new ApnsClient(cfg, { host: () => s.url, timeoutMs: 100 });
    const r = await client.send({ token: "aa", env: "sandbox" }, payload);
    client.close();
    await s.close();
    expect(r.ok).toBe(false);
  });
});
