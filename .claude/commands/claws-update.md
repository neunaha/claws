---
name: claws-update
description: Full rebuild — pull latest, re-run installer, show ASCII banner to confirm everything works, show changelog. Standard operating procedure.
---

# /claws-update

Standard operating procedure. Full rebuild every time. The ASCII CLAWS banner MUST render to confirm the update worked.

## What to do

Step 1 — Pull latest and re-run the full installer:
```bash
cd ~/.claws-src && git pull origin main && bash scripts/install.sh
```

Step 2 — Force-render the ASCII banner to prove the hook works:
```bash
unset CLAWS_BANNER_SHOWN && source ~/.claws-src/scripts/shell-hook.sh
```

The user MUST see the big CLAWS ASCII art + connected/disconnected status. If they don't see it, the hook injection failed.

Step 3 — Sync extension:
```bash
cd ~/.claws-src && cp README.md extension/README.md && cp CHANGELOG.md extension/CHANGELOG.md
```

Step 4 — Read the changelog and summarize what's new:
```bash
cat ~/.claws-src/CHANGELOG.md
```

Show the user the latest version's changes as a friendly "here's what's new" message.

Step 5 — Tell the user:

"Claws fully rebuilt to [version]. The CLAWS banner above confirms everything is working.

Reload VS Code to activate extension changes: Cmd+Shift+P → Developer: Reload Window.
Then restart Claude Code (exit + claude) to load updated MCP tools.

Try these:
→ `/claws` for the dashboard
→ `/claws-do <task>` to run anything in a visible terminal
→ `/claws-go <mission>` to spawn an AI worker
→ `/claws-learn` for the full prompt guide"
