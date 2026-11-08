# Crook for Herdr — Mac plugin

The Mac side of [Crook for Herdr](https://crook.algorist.jp), an iPhone and iPad app to watch and control your [Herdr](https://herdr.dev) agents.
This plugin runs a small relay on your Mac. The app connects only to it.

Crook is made by Algorist and is not affiliated with the Herdr project.

## Requirements

- macOS with Herdr 0.9 or later
- Node.js 23.6 or later (TypeScript runs directly)
- The Crook app on iPhone or iPad (iOS 18 or later)

## Install

```bash
herdr plugin install algorist-dev/crook-herdr
```

Then restart Herdr (`herdr server stop`, then `herdr`). On the first start the plugin starts the relay (a launchd agent, `jp.algorist.crook`) and adds `prefix+m` to your Herdr config.

## Pair

In Herdr, press `prefix` then `m` (usually `ctrl+b`, `m`). Scan the QR code with Crook. The code works once and expires after 5 minutes.

## How it connects

Crook tries, in order:

1. **Tailscale** — the relay listens on your Tailscale IP and only accepts devices of the same Tailscale user.
2. **Same Wi‑Fi** — end‑to‑end encrypted with your Mac's key (from the QR code).
3. **Relay server** (`crook-relay.algorist.jp`, Cloudflare) — forwards end‑to‑end encrypted data it cannot read. Free, limited to 120 minutes and 200 MB per Mac per day (reset at 00:00 UTC). Set `CROOK_RELAY_SERVER=off` to disable.

The relay never listens on `0.0.0.0`. Pairing codes are single use and expire after 5 minutes; only hashes of device keys are stored (`~/.config/crook/devices.json`, mode 0600).

## Commands

Run from the plugin folder (`herdr plugin config-dir algorist.crook` shows where Herdr keeps its config):

```bash
node src/cli.ts status     # is the relay running?
node src/cli.ts devices    # paired devices
node src/cli.ts revoke ID  # remove a device
node src/cli.ts uninstall  # stop the relay and remove the launchd agent
```

## Notifications

While the app is open and connected, it shows notifications itself. Notifications while the app is in the background are not available in this version for most users (they need an Apple Push key for the app's team).

## Privacy

See the [privacy policy](https://crook.algorist.jp/privacy). Photos you send are saved in `~/.config/crook/uploads` so the agent can read them and are deleted after one week.

## Development

```bash
npm ci
npm test
npm run typecheck
```

## License

MIT
