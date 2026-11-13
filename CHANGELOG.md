# Changelog

All notable changes to this plugin are listed here. Versions follow [Semantic Versioning](https://semver.org/) (x.y.z).

## [1.2.0] - 2026-11-13

For the Crook for Herdr app 1.2.0.

### Added

- Switch Hermes models from the iPhone
- "Update on Mac": the app can ask the Mac to run `herdr plugin update` in a new "Crook update" workspace (after you confirm), and shows why when the update can't run

### Fixed

- The relay server connection no longer gets stuck after a non-101 response (for example 429 or 503) until the relay restarts
- The Mac now gives up on a relay server handshake that never answers, and reconnects when pongs stop arriving
- Running `ensure` from a named Herdr session no longer restarts the main relay

## [1.1.0] - 2026-11-10

For the Crook for Herdr app 1.1.0.

### Added

- Notifications while the app is in the background, delivered through the Crook relay server. No Apple key is needed on your Mac
- Gemini CLI (with an API key), Pi and Hermes: conversation view, tool details, choices and usage. Hermes notifies you only when it's waiting for approval
- The relay tells the app which plugin version is running, so the app can ask you to update

### Fixed

- After `herdr plugin update` and a Herdr restart, the local relay now moves to the new plugin folder. Before, the launchd agent kept pointing at the old folder, which Herdr removes when it restarts
- Reinstalling the launchd agent now waits for the previous relay to stop, so the relay isn't left stopped
- The chat view no longer shows context summaries and background-task notices as if you had sent them

## [1.0.0] - 2026-11-08

First public release, for the Crook for Herdr app 1.0.0.

### Added

- Local relay on the Mac (launchd agent `jp.algorist.crook`) that the Crook app connects to over Tailscale, the same Wi‑Fi (end‑to‑end encrypted) or the Crook relay server (end‑to‑end encrypted)
- Pairing with a one‑time QR code (`prefix+m` in Herdr) that expires after 5 minutes
- Agent list with status, live terminal, chat view, one‑tap answers to prompts, voice and photo input, `@` file mentions
- Model and reasoning switching, usage (context, tokens, limits, cost) for Claude Code, Codex, OpenCode and GitHub Copilot CLI
- Commands: `status`, `devices`, `revoke`, `uninstall`, `statusline-install`

[1.1.0]: https://github.com/algorist-dev/herdr-crook/releases/tag/v1.1.0
[1.0.0]: https://github.com/algorist-dev/herdr-crook/releases/tag/v1.0.0
