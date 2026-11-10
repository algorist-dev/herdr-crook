// 依存の向きと「エージェントの名前を共有ファイルに書かない」ことを見張る。
// 新しいエージェントを足すときに、直す場所がプロバイダと defaults だけで済むようにするため。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const providersRoot = join(src, "providers");
const providerNames = new Set(["claude", "codex", "opencode", "copilot", "pi", "gemini", "hermes"]);

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** コメントを外す（`//` で始まる行と、`/** *\/` の中は見ない） */
function withoutComments(text: string): string {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return noBlock
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
}

/** import と export ... from を外す（ファイルの場所にエージェントの名前が入っていても数えない） */
function withoutModuleSpecifiers(text: string): string {
  return text
    .replace(/\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*["'][^"']+["']\s*;?/g, "")
    .replace(/\bimport\s*["'][^"']+["']\s*;?/g, "");
}

const literal = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;

/** 画面に出す文字やキーの中に、エージェントの名前が残っていないか */
function agentNamesIn(file: string): string[] {
  const text = withoutModuleSpecifiers(withoutComments(read(file)));
  return [...text.matchAll(literal)]
    .map((m) => m[0])
    .filter((value) => /claude|codex|opencode|copilot|gemini|hermes|\bpi\b/i.test(value))
    .filter((value) => !(file.endsWith(join("session", "session.ts")) && value === `"claude"`));
}

interface Imported {
  from: string;
  typeOnly: boolean;
}

function importsOf(file: string): Imported[] {
  const text = withoutComments(read(file));
  const found: Imported[] = [];
  const from = /\b(import|export)\s+(type\s+)?[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(from)) found.push({ from: m[3]!, typeOnly: Boolean(m[2]) });
  const side = /\bimport\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(side)) found.push({ from: m[1]!, typeOnly: false });
  return found;
}

function relativeImportTarget(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return resolve(dirname(file), spec);
}

function firstPart(path: string): string {
  return path.split(sep)[0] ?? "";
}

describe("エージェントの名前は共有ファイルに書かない", () => {
  it("relay・session・transport・paneWatcher・agents に、名前の文字が無い", () => {
    const files = [
      join(src, "relay.ts"),
      join(src, "herdr", "paneWatcher.ts"),
      join(src, "herdr", "agents.ts"),
      ...filesUnder(join(src, "session")),
      ...filesUnder(join(src, "transport")),
    ];
    const bad = files.flatMap((file) => agentNamesIn(file).map((value) => `${relative(src, file)}: ${value}`));
    expect(bad).toEqual([]);
  });
});

describe("プロバイダどうし・層どうしの import", () => {
  it("違うプロバイダを import しない", () => {
    const bad: string[] = [];
    for (const file of filesUnder(providersRoot)) {
      const owner = firstPart(relative(providersRoot, file));
      if (!providerNames.has(owner)) continue;
      for (const imported of importsOf(file)) {
        const target = relativeImportTarget(file, imported.from);
        if (!target) continue;
        const inside = relative(providersRoot, target);
        if (inside.startsWith("..")) continue;
        const other = firstPart(inside);
        if (providerNames.has(other) && other !== owner) {
          bad.push(`${relative(src, file)} → ${imported.from}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("providers と session は app と cli を import しない", () => {
    const bad: string[] = [];
    for (const file of [...filesUnder(providersRoot), ...filesUnder(join(src, "session"))]) {
      for (const imported of importsOf(file)) {
        const target = relativeImportTarget(file, imported.from);
        if (!target) continue;
        const inside = relative(src, target);
        if (inside === "cli.ts" || inside.startsWith(`app${sep}`)) bad.push(`${relative(src, file)} → ${imported.from}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("transport は session と providers を import しない", () => {
    const bad: string[] = [];
    for (const file of filesUnder(join(src, "transport"))) {
      for (const imported of importsOf(file)) {
        const target = relativeImportTarget(file, imported.from);
        if (!target) continue;
        const inside = relative(src, target);
        if (inside.startsWith(`session${sep}`) || inside.startsWith(`providers${sep}`)) {
          bad.push(`${relative(src, file)} → ${imported.from}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("providers は slashCommands.ts を型としてだけ import する（import が回らないように）", () => {
    const bad: string[] = [];
    for (const file of filesUnder(providersRoot)) {
      for (const imported of importsOf(file)) {
        if (!imported.from.endsWith("slashCommands.ts")) continue;
        if (!imported.typeOnly) bad.push(`${relative(src, file)} → ${imported.from}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
