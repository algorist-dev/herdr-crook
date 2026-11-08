# Changelog

All notable changes to this plugin are listed here. Versions follow [Semantic Versioning](https://semver.org/) (x.y.z).

## [1.0.0] - 2026-11-08

First public release, for the Crook for Herdr app 1.0.0.

### Added

- Local relay on the Mac (launchd agent `jp.algorist.crook`) that the Crook app connects to over Tailscale, the same Wi‑Fi (end‑to‑end encrypted) or the Crook relay server (end‑to‑end encrypted)
- Pairing with a one‑time QR code (`prefix+m` in Herdr) that expires after 5 minutes
- Agent list with status, live terminal, chat view, one‑tap answers to prompts, voice and photo input, `@` file mentions
- Model and reasoning switching, usage (context, tokens, limits, cost) for Claude Code, Codex, OpenCode and GitHub Copilot CLI
- Commands: `status`, `devices`, `revoke`, `uninstall`, `statusline-install`

[1.0.0]: https://github.com/algorist-dev/herdr-crook/releases/tag/v1.0.0
