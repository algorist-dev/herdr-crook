// スマホから送られた画像を Mac に置く。置き場所は呼ぶ側（中継）が決める。
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const UPLOAD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** スマホから来た画像を保存して、置いた場所を返す。画像でなければ断る */
export function saveImages(dir: string, images: string[]): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  cleanOldUploads(dir);
  const files = images.map((b64) => {
    const bytes = Buffer.from(b64, "base64");
    const ext = imageExtension(bytes);
    if (!ext) throw new Error("画像（JPEG・PNG・GIF・WebP）だけ送れます");
    return { bytes, ext };
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  return files.map(({ bytes, ext }) => {
    const path = join(dir, `iphone-${stamp}-${randomBytes(3).toString("hex")}.${ext}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  });
}

/** 先頭のバイトで画像の種類を見分ける（拡張子はこちらで決める） */
export function imageExtension(bytes: Buffer): "png" | "jpg" | "gif" | "webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** 1 週間より前に送られた画像は消す */
export function cleanOldUploads(dir: string): void {
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("iphone-")) continue;
    try {
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > UPLOAD_KEEP_MS) unlinkSync(path);
    } catch {
      // 消せなくても送るのは続ける
    }
  }
}
