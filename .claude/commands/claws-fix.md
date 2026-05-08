---
name: claws-fix
description: Diagnose and auto-repair a broken Claws installation in one command.
---

## MANDATORY — read before running

1. **Acknowledge in 1 line.** "Running Claws repair script." No more.
2. **Do NOT enter plan mode.** This is a single Bash call.
3. **Run the repair script via Bash — one call, no sub-steps. No worker spawn.**

---

# /claws-fix

## What this does
Runs `$CLAWS_DIR/scripts/fix.sh` which checks every piece of the install chain — extension bundle, editor symlink, `.mcp.json`, socket liveness, shell hooks — auto-repairs what it can, and reports what still needs a VS Code reload or Claude Code restart. All repair logic lives in the script so new checks activate on the next `git pull`.

## Behavior
- Run this single shell command:
  ```bash
  CLAWS_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
  bash "$CLAWS_DIR/scripts/fix.sh" "$(pwd)"
  ```
- Do not break into multiple steps — let the script's `[check] ✓ / → / ✗` output speak
- If the script prints "All checks passed":
  > Everything is wired up. Activate: (1) Reload VS Code, (2) Restart Claude Code in this project.
- If the script reports unresolved issues:
  > Some issues need manual attention. Run /claws-report to bundle diagnostics for a GitHub issue.

## Examples
```
/claws-fix
claws tools aren't showing up
fix the claws installation
```

## When NOT to use
If Claws is working but you want to update it, use /claws-update.
If you need a shareable diagnostic file, use /claws-report.
