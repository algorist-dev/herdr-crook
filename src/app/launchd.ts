// Mac にログインしたら中継が自動で動くようにする（launchd の LaunchAgent）。
// Herdr のプラグインの起動フックは「1回だけ動いて終わる」決まりなので、ずっと動く中継は launchd に任せる。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const LABEL = "jp.algorist.crook";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export interface PlistOptions {
  node: string;
  cli: string;
  home: string;
  env: Record<string, string>;
}

export function buildPlist(o: PlistOptions): string {
  // ~/.local/bin：claude や codex の公式のインストール先（モデルの一覧を claude に聞くため）
  const env = { PATH: `${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, CROOK_HOME: o.home, ...o.env };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.node)}</string>
    <string>${xml(o.cli)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(o.home, "relay.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(o.home, "relay.log"))}</string>
</dict>
</plist>
`;
}

/** この plist が、その cli.ts を動かす設定になっているか */
export function plistRunsCli(plist: string, cli: string): boolean {
  return plist.includes(`<string>${xml(cli)}</string>`);
}

export async function install(o: PlistOptions): Promise<void> {
  mkdirSync(o.home, { recursive: true, mode: 0o700 });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath(), buildPlist(o));
  await launchctl(["bootout", `gui/${userInfo().uid}/${LABEL}`]).catch(() => {});
  await bootstrapWithRetry(() => launchctl(["bootstrap", `gui/${userInfo().uid}`, plistPath()]));
}

/**
 * bootout は止め終わる前に返り、その間の bootstrap は「5: Input/output error」で失敗する。
 * あきらめると中継が launchd から外れたままになるので、止め終わるまでやり直す（最長 15 秒）
 */
export async function bootstrapWithRetry(
  run: () => Promise<unknown>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<void> {
  const tries = 30;
  for (let i = 1; ; i++) {
    try {
      await run();
      return;
    } catch (e) {
      if (i >= tries) throw e;
      await wait(500);
    }
  }
}

export async function uninstall(): Promise<void> {
  await launchctl(["bootout", `gui/${userInfo().uid}/${LABEL}`]).catch(() => {});
  if (existsSync(plistPath())) unlinkSync(plistPath());
}

export async function kickstart(): Promise<void> {
  await launchctl(["kickstart", "-k", `gui/${userInfo().uid}/${LABEL}`]);
}

function launchctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("launchctl", args, { timeout: 10_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
