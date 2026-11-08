# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Email **support@algorist.jp** with "Security" in the subject, and include:

- what you found and how to reproduce it
- the plugin version (`version` in `herdr-plugin.toml`) and your macOS and Herdr versions

We will reply within a few days and keep you updated until it is fixed. Please give us a reasonable time to release a fix before disclosing it.

## Supported versions

Only the latest release receives security fixes.

## Scope

- This repository: the Mac plugin (local relay, pairing, end‑to‑end encryption)
- The relay server `crook-relay.algorist.jp` and the Crook app are operated by Algorist; you can report issues with them to the same address

## Design notes

- The local relay listens on 127.0.0.1, your Tailscale IP and your local network IP — never on `0.0.0.0`
- On the local network and the relay server, traffic is end‑to‑end encrypted with the Mac's key (X25519 + HKDF‑SHA256 + ChaCha20‑Poly1305)
- Pairing codes are single use and expire after 5 minutes; only hashes of device keys are stored (mode 0600)
