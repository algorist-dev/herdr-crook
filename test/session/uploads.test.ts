import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanOldUploads, imageExtension, saveImages } from "../../src/session/uploads.ts";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const gif = Buffer.from("GIF89a", "latin1");
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
const notImage = Buffer.from("#!/bin/sh\nrm -rf /");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hm-uploads-"));
}

describe("uploads：先頭のバイトで画像の種類を見分ける", () => {
  it("PNG・JPEG・GIF・WebP を見分ける", () => {
    expect(imageExtension(png)).toBe("png");
    expect(imageExtension(jpg)).toBe("jpg");
    expect(imageExtension(gif)).toBe("gif");
    expect(imageExtension(webp)).toBe("webp");
  });

  it("画像でなければ null", () => {
    expect(imageExtension(notImage)).toBeNull();
    expect(imageExtension(Buffer.alloc(0))).toBeNull();
  });
});

describe("uploads：画像を保存する", () => {
  it("iphone- で始まる名前に 0600 で書き、フォルダは 0700 にする", () => {
    const dir = join(tempDir(), "uploads");
    const [path] = saveImages(dir, [png.toString("base64")]);
    expect(path).toBeDefined();
    expect(path!.startsWith(`${dir}/iphone-`)).toBe(true);
    expect(path!.endsWith(".png")).toBe(true);
    expect(readFileSync(path!)).toEqual(png);
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("4 枚までをそれぞれ別の名前に保存する", () => {
    const dir = tempDir();
    const paths = saveImages(dir, [png.toString("base64"), jpg.toString("base64"), gif.toString("base64"), webp.toString("base64")]);
    expect(paths).toHaveLength(4);
    expect(new Set(paths).size).toBe(4);
    expect(paths.map((p) => p.slice(p.lastIndexOf(".")))).toEqual([".png", ".jpg", ".gif", ".webp"]);
    expect(readdirSync(dir)).toHaveLength(4);
  });

  it("画像でないものが混ざっていたら、何も書かずに断る", () => {
    const dir = tempDir();
    expect(() => saveImages(dir, [png.toString("base64"), notImage.toString("base64")])).toThrow(
      "画像（JPEG・PNG・GIF・WebP）だけ送れます",
    );
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe("uploads：古い画像を掃除する", () => {
  it("1 週間より古い iphone-* だけを消す", () => {
    const dir = tempDir();
    const old = join(dir, "iphone-old.png");
    const fresh = join(dir, "iphone-new.png");
    const other = join(dir, "keep-this.png");
    writeFileSync(old, png);
    writeFileSync(fresh, png);
    writeFileSync(other, png);
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 60 * 60;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    utimesSync(other, eightDaysAgo, eightDaysAgo);

    cleanOldUploads(dir);

    expect(readdirSync(dir).sort()).toEqual(["iphone-new.png", "keep-this.png"]);
  });

  it("画像を保存するときに、ついでに古いものを消す", () => {
    const dir = tempDir();
    const old = join(dir, "iphone-old.png");
    writeFileSync(old, png);
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 60 * 60;
    utimesSync(old, eightDaysAgo, eightDaysAgo);

    saveImages(dir, [png.toString("base64")]);

    expect(readdirSync(dir).some((n) => n === "iphone-old.png")).toBe(false);
  });
});
