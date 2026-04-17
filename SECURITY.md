# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a Vulnerability

If you discover a security vulnerability in Claws, **do not open a public issue.** Instead:

1. Email the maintainer via the contact on the [GitHub profile](https://github.com/neunaha)
2. Include: description, reproduction steps, potential impact
3. Allow 48 hours for an initial response

## Security Model

**Unix socket**: Created with `chmod 600` (owner-only). Only processes running as the same OS user can connect. No authentication layer — same-user access is the trust boundary.

**WebSocket (planned)**: Will require token-based authentication + TLS. Tokens will be generated per-session and displayed in the VS Code output panel.

**Terminal access**: Claws can send text into any terminal in the VS Code window. This is by design — it's the core feature. If an untrusted process connects to the socket, it has full terminal control. Protect the socket file with OS-level permissions.

**Pty logs**: Wrapped terminal logs contain everything typed and displayed in the terminal, including passwords, tokens, and secrets entered interactively. The logs are stored in `.claws/terminals/` with default filesystem permissions. Add `.claws/` to your `.gitignore` (already included in the default `.gitignore`).
