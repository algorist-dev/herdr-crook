// shared/protocol の見本が、いまの Mac の確かめ方を通ることだけ見る（くわしいものは protocolFixtures.test.ts）。
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClientMessage } from "../src/protocol/parse.ts";

const root = join(import.meta.dirname, "..", "..", "shared", "protocol");
// 見本はアプリと同じリポジトリにだけある（公開しているプラグインだけのリポジトリでは見ない）
const hasFixtures = existsSync(root);
const files = (dir: string) => (hasFixtures ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".json")) : []);

describe.skipIf(!hasFixtures)("やりとりの見本", () => {
  it.each(files("client"))("client/%s は Mac が受け付け、読み直しても同じ", (name) => {
    const text = readFileSync(join(root, "client", name), "utf8");
    const parsed = parseClientMessage(text);
    expect(parsed).not.toBeNull();
    // 見本に書いたキーは、読んだあとも同じ値（省略したキーは Mac が null などで埋める）
    expect(parsed).toMatchObject(JSON.parse(text));
    expect(parseClientMessage(JSON.stringify(parsed))).toEqual(parsed);
  });

  it.each(files("server"))("server/%s は JSON として読めて t がある", (name) => {
    const value = JSON.parse(readFileSync(join(root, "server", name), "utf8")) as { t?: unknown };
    expect(typeof value.t).toBe("string");
  });
});
