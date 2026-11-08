// 本番で使うプロバイダの一覧。エージェントを足すときは、ここに 1 行増やす。
// 作るだけではファイルを読んだりコマンドを動かしたりしない（読むのはメソッドが呼ばれたとき）。
import { createClaudeProvider, type ClaudeProviderOptions } from "./claude/index.ts";
import { createCodexProvider, type CodexProviderOptions } from "./codex/index.ts";
import { createCopilotProvider, type CopilotProviderOptions } from "./copilot/index.ts";
import { createOpenCodeProvider, type OpenCodeProviderOptions } from "./opencode/index.ts";
import { ProviderRegistry } from "./registry.ts";

export interface DefaultProviderOptions {
  claude?: ClaudeProviderOptions;
  codex?: CodexProviderOptions;
  opencode?: OpenCodeProviderOptions;
  copilot?: CopilotProviderOptions;
}

export function createDefaultProviders(opts: DefaultProviderOptions = {}): ProviderRegistry {
  return new ProviderRegistry([
    createClaudeProvider(opts.claude),
    createCodexProvider(opts.codex),
    createOpenCodeProvider(opts.opencode),
    createCopilotProvider(opts.copilot),
  ]);
}

let shared: ProviderRegistry | null = null;

/** 何も渡さないときに使う 1 つだけのもの（はじめて呼ばれたときに作る） */
export function defaultProviders(): ProviderRegistry {
  return (shared ??= createDefaultProviders());
}
