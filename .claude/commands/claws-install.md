---
name: claws-install
description: Install or update Claws — Terminal Control Bridge for VS Code. Runs the installer inside the current project so this workspace gets the full project-local setup.
---

# /claws-install

Install or update Claws in THIS project from https://github.com/neunaha/claws

Run this from the project root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

After the script completes:
1. Reload VS Code: Cmd+Shift+P → Developer: Reload Window
2. Restart Claude Code in this project so the project-local `.mcp.json` is picked up.
3. Try `/claws-help` or `/claws-status`.

If MCP tools don't appear after restart, run `/claws-fix` or `/claws-report`.
