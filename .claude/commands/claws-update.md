---
name: claws-update
description: Update Claws to the latest version. Pulls the source, then delegates all update logic to ~/.claws-src/scripts/update.sh — so new steps added to that script are picked up automatically on the next update, without ever needing to re-install the slash command itself.
---

# /claws-update

**Run from the project root.** This command is a thin dispatcher — all the real work lives in `~/.claws-src/scripts/update.sh`, which is refreshed by `git pull` on every run. That means when we add new update steps (migrations, cleanup, notifications), they activate automatically on the next update.

```bash
bash ~/.claws-src/scripts/update.sh "$(pwd)"
```

Equivalent via curl URL (no local clone assumed):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/update.sh)
```

ONE bash call. Do NOT break into multiple steps. Do NOT interleave commentary. The script prints its own status; let it speak.

## What happens (owned by `scripts/update.sh`, not this markdown)

1. **Pull latest source** into `~/.claws-src` via `git pull --ff-only`.
2. **Delegate to `update.sh`** which then:
   - Syncs `README.md` and `CHANGELOG.md` into `extension/` for the VSIX.
   - Runs `scripts/install.sh` against the current project. That alone handles: TS rebuild, extension symlink, project-local `.mcp.json` + `.claws-bin/` + `.claude/`, CLAUDE.md migration + fenced injection, shell-hook refresh, 10-check verification, install log at `/tmp/claws-install-<timestamp>.log`, and the ASCII banner.
   - Prints the newest `## [x.y.z]` section from `CHANGELOG.md`.
   - Runs any post-update migrations (e.g. cleaning stale `.claws/claws.sock` files older than a day).
   - Re-sources `shell-hook.sh` so the in-terminal banner updates.

Any new update step — a breaking-change warning, a data migration, a cleanup task — is added to `update.sh` in the repo. Users get it on their very next `/claws-update` with no action required from them (or from me) beyond the pull itself.

## After the output finishes, tell the user EXACTLY this

Update complete. **Two things to activate:**

1. **Reload VS Code** — `Cmd+Shift+P → Developer: Reload Window`
2. **Restart Claude Code in this project** — exit this Claude session and re-open `claude` from the project root so the new project-local `.mcp.json` is picked up.

If anything looks off:
- **MCP tools not appearing?** → run `/claws-fix`
- **Something failed or looked wrong?** → run `/claws-report` to bundle logs + diagnostics into a shareable file (`~/claws-report-<timestamp>.txt`).
- **Install log** — the banner at the end of the install section prints the exact log path (`/tmp/claws-install-<timestamp>.log`).
