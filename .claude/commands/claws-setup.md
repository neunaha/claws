---
name: claws-setup
description: First-time setup or reinstall. Runs the full installer — clones repo, links extension, installs client, registers MCP, injects context. Everything in one command.
---

# /claws setup

First-time install or full reinstall.

## What to do

Run the installer:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

After it completes, tell the user:

"Claws is installed. Reload VS Code: Cmd+Shift+P → Developer: Reload Window.

After reload:
- Your terminal dropdown has 'Claws Wrapped Terminal'
- Every Claude Code session has 8 terminal control tools
- Type `/claws` to see the dashboard
- Type `/claws do <anything>` to get started
- Type `/claws learn` for the full guide"
