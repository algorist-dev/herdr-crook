import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFiles, matchFiles } from "../src/features/files.ts";

function write(root: string, path: string, text = ""): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

describe("listFiles（入力欄の「@」に出すファイル）", () => {
  it("作業フォルダのファイルを並べる。いらないフォルダは見ない", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-files-"));
    write(root, "src/app.ts");
    write(root, "src/api/client.ts");
    write(root, "README.md");
    write(root, "node_modules/pkg/index.js");
    write(root, ".build/out/app");
    write(root, "dist/bundle.js");
    expect(listFiles({ cwd: root, query: "" })).toEqual(["README.md", "src/api/client.ts", "src/app.ts"]);
  });

  it("git の管理しているファイルから探す（.gitignore は出さない）", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-files-"));
    write(root, "a.ts");
    write(root, "ignored.log");
    write(root, ".gitignore", "ignored.log\n");
    execFileSync("git", ["init", "-q", root]);
    expect(listFiles({ cwd: root, query: "" }).sort()).toEqual([".gitignore", "a.ts"]);
  });

  it("打った文字で絞る（頭・ファイル名・どこかに含む の順）", () => {
    const files = ["src/app.ts", "src/api.ts", "docs/api.md", "app.ts"];
    expect(matchFiles(files, "ap")).toEqual(["app.ts", "src/app.ts", "src/api.ts", "docs/api.md"]);
    expect(matchFiles(files, "src/ap")).toEqual(["src/app.ts", "src/api.ts"]);
    expect(matchFiles(files, "README")).toEqual([]);
  });

  it("多すぎるときは上限まで。フォルダがなければ空", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-files-"));
    for (let i = 0; i < 30; i++) write(root, `f${String(i).padStart(2, "0")}.ts`);
    expect(listFiles({ cwd: root, query: "" })).toHaveLength(30);
    expect(listFiles({ cwd: root, query: "", limit: 5 })).toHaveLength(5);
    expect(listFiles({ cwd: "/no/such/folder", query: "" })).toEqual([]);
    expect(listFiles({ cwd: null, query: "" })).toEqual([]);
  });
});
