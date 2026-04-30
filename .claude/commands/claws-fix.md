---
name: claws-fix
description: Auto-diagnose and repair Claws connection issues. Runs $CLAWS_DIR/scripts/fix.sh (default ~/.claws-src) — which checks every piece of the install chain, auto-repairs what it can (missing symlinks, missing project .mcp.json, stale sockets), and reports what still needs a VS Code reload or Claude Code restart. All diagnostic logic is in the script so new checks added to fix.sh activate automatically on the next git pull.
---

# /claws-fix

Run this when `claws_*` tools aren't available or something about Claws isn't working.

```bash
CLAWS_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
bash "$CLAWS_DIR/scripts/fix.sh" "$(pwd)"
```

ONE bash call. Do NOT break into multiple steps. Do NOT interleave commentary. The script prints a `[check]` line per item with `✓ / → / ✗` markers; let it speak.

## What the script checks and fixes

All logic lives in `$CLAWS_DIR/scripts/fix.sh` — updated automatically via `git pull`. The current checks:

1. **Source clone** at `~/.claws-src` exists (if not: tell the user to run the installer).
2. **Extension bundle** `dist/extension.js` present — auto-rebuilds via `npm` if missing; falls back to legacy JS if rebuild fails.
3. **Editor symlink** `~/.vscode/extensions/neunaha.claws-<version>` — auto-recreates if missing.
4. **Project `.mcp.json`** registers `claws` — auto-writes it (and vendors `.claws-bin/mcp_server.js`) if missing.
5. **MCP handshake** — spawns `mcp_server.js` and sends `initialize`. Reports the failure reason if it errors.
6. **Socket liveness** — checks `.claws/claws.sock` exists AND responds. Removes stale socket files so VS Code can re-create on reload.
7. **Global `~/.claude/settings.json`** — informational: notes if a global claws entry coexists with the project one.

New checks or auto-repairs go into `fix.sh` in the repo. No change to this markdown is required for users to pick them up.

## After the script finishes, tell the user EXACTLY this

If the script printed `All checks passed`:

> Everything is wired up. **Activate by:** (1) Reload VS Code, (2) Restart Claude Code in this project. The `claws_*` tools will be available after that.

If the script printed `X still open`:

> Some issues couldn't be auto-fixed. Run `/claws-report` to bundle the full diagnostic into a shareable file — the output path is printed at the end of the report. Paste the file contents in a GitHub issue or share them with me.

Never suggest manual shell commands to fix specific steps — the script owns all auto-repair logic; if it couldn't fix something, either a VS Code reload / Claude Code restart will, or it's a real bug that needs a report.
