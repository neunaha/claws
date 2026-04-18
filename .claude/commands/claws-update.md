---
name: claws-update
description: One command. Pulls latest, rebuilds everything, shows what's new, renders the CLAWS banner. The user types /claws-update and waits. Nothing else needed.
---

# /claws-update

Run this single command. It does EVERYTHING — pull, rebuild, re-inject, sync, verify, show changelog, render banner:

```bash
cd ~/.claws-src && git pull origin main 2>&1 && bash scripts/install.sh && cp README.md extension/README.md && cp CHANGELOG.md extension/CHANGELOG.md && echo "" && echo "  ═══════════════════════════════════════" && echo "  WHAT'S NEW:" && echo "  ═══════════════════════════════════════" && head -30 CHANGELOG.md | tail -25 && echo "" && echo "  ═══════════════════════════════════════" && unset CLAWS_BANNER_SHOWN && source scripts/shell-hook.sh
```

That's it. ONE bash call. Do NOT break this into multiple steps. Do NOT add your own commentary between the steps. Run the command, let the output speak for itself.

After the output finishes, tell the user ONE thing:

"Update complete. Reload VS Code (Cmd+Shift+P → Reload Window) then restart Claude Code (exit + claude) to activate new MCP tools."
