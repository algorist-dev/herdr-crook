# Contributing

Thanks for your interest in Crook! Issues and pull requests are welcome.

## Before you start

- For bugs, [open an issue](https://github.com/algorist-dev/herdr-crook/issues/new/choose) with your macOS, Herdr, Node.js and plugin versions.
- For bigger changes or new agent support, please open an issue first so we can agree on the approach.
- Security problems: see [SECURITY.md](SECURITY.md) instead of opening an issue.

## Development

```bash
npm ci
npm test          # vitest
npm run typecheck # tsc
```

- Node.js 23.6 or later runs the TypeScript directly. Use only erasable syntax (no `enum`, no constructor parameter properties).
- To try your changes with Herdr: `herdr plugin link .` (and `herdr plugin unlink algorist.crook` to go back).
- Agent-specific code lives in `src/providers/<agent>/` only. Do not put agent names in `src/session/` or `src/transport/` (`test/architecture.test.ts` checks this).
- Write tests first. Keep pull requests small and focused, and describe what you tested.

## Notes

- The Crook app (iOS) and the relay server are not part of this repository.
- By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
