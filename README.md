<div align="center">

<img src="docs/images/icon.png" width="96" alt="Crook icon" />

# herdr-crook

**The Herdr plugin for [Crook](https://crook.algorist.jp) — see your AI coding agents on iPhone and iPad, and answer them with one tap.**

[![Version](https://img.shields.io/github/v/release/algorist-dev/herdr-crook?style=flat-square&label=version)](https://github.com/algorist-dev/herdr-crook/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![herdr](https://img.shields.io/badge/herdr-0.9%2B-8a2be2?style=flat-square)](https://herdr.dev)
[![Node.js](https://img.shields.io/badge/node-23.6%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-000000?style=flat-square&logo=apple&logoColor=white)](#requirements)
[![App Store](https://img.shields.io/badge/App_Store-coming_soon-0D96F6?style=flat-square&logo=apple&logoColor=white)](https://crook.algorist.jp)

English | [日本語](README.ja.md)

</div>

> [!IMPORTANT]
> This plugin is the Mac side of **Crook for Herdr**, an iPhone and iPad app. You need the app to use it.
> The app is waiting for App Store review — **coming soon** on the App Store. See [crook.algorist.jp](https://crook.algorist.jp).

<p align="center"><img src="docs/images/screens-en.jpg" alt="Crook on iPhone: the agent list with the waiting agent first, a terminal asking for permission with Yes buttons, and the chat view" width="820" /></p>

## What you get

- **Who needs you comes first** — every agent in Herdr on your Mac, ordered waiting → done → working → idle, with the same marks as Herdr (● ◐ ✓ ○).
- **Answer in one tap** — when an agent asks for permission, the choices appear as buttons in the app.
- **The real terminal** — the live, colored terminal of any pane, with an extra keys row (esc, tab, arrows, ctrl, ^C).
- **Talk, type, or attach** — read the conversation as chat and send the next instruction by text or voice, with photos and `@files`.
- **Usage at a glance** — context, tokens, 5‑hour and weekly limits and cost.
- **No account, no SSH setup** — pair with a one‑time QR code. Crook connects only to your own Mac.

Works with Claude Code, Codex, OpenCode and GitHub Copilot CLI, plus any terminal pane in Herdr.

## Quick start

1. **Install the plugin** on your Mac:

   ```bash
   herdr plugin install algorist-dev/herdr-crook
   ```

2. **Restart Herdr** (`herdr server stop`, then `herdr`). On the first start the plugin starts its local relay (a launchd agent, `jp.algorist.crook`) and adds the `prefix+m` shortcut.
3. **Pair**: in Herdr press `prefix` then `m` (usually `ctrl+b`, `m`) and scan the QR code with the Crook app. The code works once and expires after 5 minutes.

## Requirements

- macOS with [Herdr](https://herdr.dev) 0.9 or later
- Node.js 23.6 or later (TypeScript runs directly, no build step)
- The Crook app on iPhone or iPad with iOS 18 or later (App Store, coming soon)
- Optional: [Tailscale](https://tailscale.com) on the Mac and the iPhone/iPad. Without it, Crook connects over the same Wi‑Fi at home and through the encrypted relay server when you're away

## How it works

```mermaid
flowchart LR
  subgraph mac["Your Mac"]
    herdr["herdr"] <-- "local socket" --> plugin["herdr-crook<br/>(local relay)"]
  end
  plugin <-- "1. Tailscale" --> app["Crook app<br/>iPhone / iPad"]
  plugin <-- "2. same Wi‑Fi<br/>end‑to‑end encrypted" --> app
  plugin <-- "3. end‑to‑end encrypted" --> relay[("Relay server<br/>crook-relay.algorist.jp")]
  relay <--> app
```

The plugin reads your agents through Herdr's local socket and runs a small relay on your Mac. The app connects to it, trying in order:

1. **Tailscale** — the relay listens on your Tailscale IP and only accepts devices of the same Tailscale user.
2. **Same Wi‑Fi** — end‑to‑end encrypted with your Mac's key, which the app gets from the QR code.
3. **Relay server** (`crook-relay.algorist.jp`, run by Algorist on Cloudflare) — forwards end‑to‑end encrypted data it cannot read. Free, limited to 120 minutes and 200 MB per Mac per day (reset at 00:00 UTC).

The Crook app is distributed on the App Store and the relay server is operated by Algorist. This repository contains the Mac plugin only.

## Privacy and security

| Where | What |
|---|---|
| **Your paired devices only** | Agent list and status, the terminal of panes you open, the conversation of agents you open, file names for `@` completion, usage numbers, your Herdr theme, and (in the QR code) your Mac's Tailscale / local addresses |
| **Relay server** | Only end‑to‑end encrypted frames it cannot read, plus per‑Mac daily usage counters and connection counts per IP address for rate limiting. Nothing is stored |
| **Algorist** | Nothing. No accounts, analytics, ads or tracking — in the plugin and in the app |

- **Pairing**: one‑time codes that expire after 5 minutes. Only hashes of device keys are stored (`~/.config/crook/devices.json`, mode 0600). The relay never listens on `0.0.0.0`.
- **Encryption**: on Wi‑Fi and through the relay server, everything is end‑to‑end encrypted (X25519 + ChaCha20‑Poly1305) with your Mac's key from the QR code.
- **Photos** you send are saved in `~/.config/crook/uploads` (mode 0600) so the agent can read them, and deleted after one week.

Details: [privacy policy](https://crook.algorist.jp/privacy). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Notifications

While the app is open and connected, it tells you when an agent is waiting for you or has finished. Notifications while the app is in the background are planned for the next version (delivered through the relay server, without an Apple key on your Mac).

## Commands

Run from the plugin folder (`herdr plugin list` shows where it is installed):

```bash
node src/cli.ts status     # is the relay running?
node src/cli.ts devices    # paired devices
node src/cli.ts revoke ID  # remove a device
node src/cli.ts uninstall  # stop the relay and remove the launchd agent
```

Optional, for Claude Code: `node src/cli.ts statusline-install` adds one line to `~/.claude/statusline.sh` (a backup is kept as `.bak-crook`) so the app can show exact context % and 5‑hour / weekly limits.

| Environment variable | Effect |
|---|---|
| `CROOK_RELAY_SERVER=off` | Never use the relay server (Tailscale and same Wi‑Fi only) |

## Troubleshooting

<details>
<summary><b>The app can't connect to my Mac</b></summary>

Make sure Herdr is running and `node src/cli.ts status` says the relay is running. The app tries Tailscale, then the same Wi‑Fi, then the relay server. If you paired before the relay server existed, scan a new QR code once so the app gets your Mac's key.
</details>

<details>
<summary><b>The QR code doesn't work</b></summary>

Each code works once and expires after 5 minutes. Press `prefix` then `m` again for a new one.
</details>

<details>
<summary><b>The plugin doesn't start after installing</b></summary>

Check `node --version` — Node.js 23.6 or later is required (installation stops with a message on older versions). Then restart Herdr (`herdr server stop`, then `herdr`).
</details>

<details>
<summary><b>How do I remove everything?</b></summary>

Run `node src/cli.ts uninstall`, then `herdr plugin uninstall algorist.crook`. Your pairing data is in `~/.config/crook`; delete that folder to remove it too.
</details>

More help: [crook.algorist.jp/support](https://crook.algorist.jp/support) · [open an issue](https://github.com/algorist-dev/herdr-crook/issues/new/choose)

## FAQ

**Is it free?** Yes. The plugin is MIT‑licensed and the app is free, with no account and no in‑app purchases.

**Is Crook made by the Herdr project?** No. Crook is made by [Algorist](https://algorist.jp/) and is not affiliated with the Herdr project.

**Can Algorist see my code or conversations?** No. Data goes only between your Mac and your paired devices. Through the relay server it is end‑to‑end encrypted, so the relay cannot read it.

**Do I need Tailscale?** No. Without Tailscale, Crook connects over the same Wi‑Fi, and through the end‑to‑end encrypted relay server when you're away (up to 120 minutes and 200 MB per Mac per day). With Tailscale, it connects directly from anywhere with no daily limit.

**Can I use it away from home?** Yes — through Tailscale if you use it, otherwise through the relay server.

**Does it work with Linux or Windows?** Not yet — the plugin uses launchd and is tested on macOS only.

## Development

```bash
npm ci
npm test
npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © Algorist

## Support development

Crook is free. If it saves you time, you can support development on [Buy Me a Coffee](https://buymeacoffee.com/algorist).
