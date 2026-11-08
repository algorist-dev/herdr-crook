import { describe, expect, it } from "vitest";
import { bytesToSteps } from "../src/herdr/inputMapping.ts";

const b = (s: string) => Buffer.from(s, "utf8");

describe("bytesToSteps", () => {
  it("ふつうの文字は text にまとめる（日本語も）", () => {
    expect(bytesToSteps(b("ls -la"))).toEqual([{ text: "ls -la" }]);
    expect(bytesToSteps(b("直して"))).toEqual([{ text: "直して" }]);
  });

  it("Enter・Esc・Tab・⌫・矢印・Shift+Tab はキーの名前にする", () => {
    expect(bytesToSteps(b("\r"))).toEqual([{ keys: ["enter"] }]);
    expect(bytesToSteps(b("\n"))).toEqual([{ keys: ["enter"] }]);
    expect(bytesToSteps(b("\x1b"))).toEqual([{ keys: ["esc"] }]);
    expect(bytesToSteps(b("\t"))).toEqual([{ keys: ["tab"] }]);
    expect(bytesToSteps(b("\x7f"))).toEqual([{ keys: ["backspace"] }]);
    expect(bytesToSteps(b("\x1b[A\x1b[B\x1b[C\x1b[D"))).toEqual([{ keys: ["up", "down", "right", "left"] }]);
    expect(bytesToSteps(b("\x1b[Z"))).toEqual([{ keys: ["shift+tab"] }]);
  });

  it("Ctrl＋文字", () => {
    expect(bytesToSteps(b("\x03"))).toEqual([{ keys: ["ctrl+c"] }]);
    expect(bytesToSteps(b("\x12"))).toEqual([{ keys: ["ctrl+r"] }]);
  });

  it("順番を保って、文字とキーを交互に並べる", () => {
    expect(bytesToSteps(b("echo hi\r"))).toEqual([{ text: "echo hi" }, { keys: ["enter"] }]);
    expect(bytesToSteps(b("a\x7f\x7fb"))).toEqual([{ text: "a" }, { keys: ["backspace", "backspace"] }, { text: "b" }]);
  });

  it("わからない制御文字は捨てる", () => {
    expect(bytesToSteps(b("\x00a\x1b[99~"))).toEqual([{ text: "a" }]);
  });
});
