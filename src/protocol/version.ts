// このプラグインの版（package.json の version）。welcome でアプリに伝える
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
