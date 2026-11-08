import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinSlashCommands, discoverSlashCommands, listSlashCommands } from "../src/features/slashCommands.ts";

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("slash commands", () => {
  it("組み込みのコマンドはエージェントごとに違う", () => {
    expect(builtinSlashCommands("claude").map((c) => c.name)).toEqual(["clear", "compact", "init", "review", "help"]);
    expect(builtinSlashCommands("codex").map((c) => c.name)).toContain("model");
    expect(builtinSlashCommands(null).map((c) => c.name)).toEqual(["clear", "help"]);
  });

  it("Mac のコマンドとスキルのファイルを動的に足す（組み込みが優先）", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-slash-"));
    const cwd = mkdtempSync(join(tmpdir(), "hm-cwd-"));
    write(join(home, ".claude", "commands", "deploy.md"), "---\ndescription: 本番に出す\n---\n");
    write(join(home, ".claude", "commands", "git", "sync.md"), "---\ndescription: main にそろえる\n---\n");
    write(join(cwd, ".claude", "commands", "local.md"), "---\ndescription: このフォルダだけのコマンド\n---\n");
    write(join(home, ".claude", "skills", "review-cpp", "SKILL.md"), "---\nname: review-cpp\ndescription: C++ を見直す\n---\n");

    const list = listSlashCommands({ agent: "claude", cwd, home, env: {} });
    expect(list.find((c) => c.name === "deploy")).toEqual({ name: "deploy", summary: "本番に出す", kind: "command" });
    expect(list.find((c) => c.name === "git/sync")?.summary).toBe("main にそろえる");
    expect(list.find((c) => c.name === "local")?.kind).toBe("command");
    expect(list.find((c) => c.name === "review-cpp")).toEqual({ name: "review-cpp", summary: "C++ を見直す", kind: "skill" });
  });

  it("同じ名前ならファイルの説明で上書きする", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-slash-"));
    write(join(home, ".claude", "commands", "clear.md"), "---\ndescription: ぼくの clear\n---\n");
    const list = listSlashCommands({ agent: "claude", home, env: {} });
    expect(list.find((c) => c.name === "clear")?.summary).toBe("ぼくの clear");
    expect(list.filter((c) => c.name === "clear")).toHaveLength(1);
  });

  it("複数行で書いた説明も 1 行にして読む", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-slash-"));
    write(join(home, ".claude", "skills", "long", "SKILL.md"), "---\ndescription: >\n  長い説明の\n  つづき\n---\n");
    const list = listSlashCommands({ agent: "claude", home, env: {} });
    expect(list.find((c) => c.name === "long")?.summary).toBe("長い説明の つづき");
  });

  it("同じ名前のスキルはコマンドを隠さない", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-slash-"));
    write(join(home, ".claude", "skills", "clear", "SKILL.md"), "---\ndescription: べつの clear\n---\n");
    const list = listSlashCommands({ agent: "claude", home, env: {} });
    expect(list.find((c) => c.name === "clear")).toEqual({ name: "clear", summary: "会話を消して、最初からにする", kind: "command" });
  });

  it("Codex と OpenCode の置き場所も見る。危ない名前は出さない", () => {
    const home = mkdtempSync(join(tmpdir(), "hm-slash-"));
    const codex = join(home, ".codex");
    const config = join(home, ".config", "opencode");
    write(join(codex, "prompts", "fix.md"), "---\ndescription: 直す\n---\n");
    write(join(config, "command", "explain.md"), "---\ndescription: 説明する\n---\n");
    write(join(home, ".claude", "commands", "bad name.md"), "---\ndescription: だめ\n---\n");
    const env = { CODEX_HOME: codex, XDG_CONFIG_HOME: join(home, ".config") };
    expect(discoverSlashCommands("codex", null, home, env).find((c) => c.name === "fix")?.summary).toBe("直す");
    expect(discoverSlashCommands("opencode", null, home, env).find((c) => c.name === "explain")?.summary).toBe("説明する");
    expect(discoverSlashCommands("claude", null, home, env).some((c) => c.name.includes(" "))).toBe(false);
  });
});
