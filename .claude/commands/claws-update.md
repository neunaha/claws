---
name: claws-update
description: Update Claws to the latest version by running the upstream update script.
---

# /claws-update

## What this does
Pulls the latest Claws source and re-runs the installer. All update logic lives in `$CLAWS_DIR/scripts/update.sh` — new migration steps added to that script activate automatically without re-installing this command.

## Behavior
- Run this single shell command (do not break into steps):
  ```bash
  CLAWS_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
  bash "$CLAWS_DIR/scripts/update.sh" "$(pwd)"
  ```
- Let the script print its own status — do not interleave commentary
- After the script finishes, tell the user exactly:
  > Update complete. Two things to activate:
  > 1. Reload VS Code — Cmd+Shift+P → Developer: Reload Window
  > 2. Restart Claude Code in this project so the new `.mcp.json` is picked up.

## Examples
```
/claws-update
update claws to the latest version
pull the newest claws
```

## When NOT to use
If MCP tools are missing (not just outdated), use /claws-fix first.
If you want a full diagnostic bundle, use /claws-report.
