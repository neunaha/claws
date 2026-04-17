---
name: claws-update
description: Pull the latest Claws changes, update the extension, and reload. One command to stay on the bleeding edge.
---

# /claws-update

Pull the latest version of Claws from GitHub, re-link the extension, and reload.

## What to do

1. Pull latest from main:
```bash
cd ~/.claws-src && git pull origin main && echo "pulled latest"
```

2. Ensure permissions:
```bash
chmod +x ~/.claws-src/scripts/terminal-wrapper.sh ~/.claws-src/scripts/install.sh ~/.claws-src/mcp_server.py
```

3. Re-install Python client (picks up any new features):
```bash
pip3 install -e ~/.claws-src/clients/python --quiet 2>/dev/null || pip install -e ~/.claws-src/clients/python --quiet
```

4. Show what changed:
```bash
cd ~/.claws-src && git log --oneline -5
```

5. Tell the user: "Claws updated. Reload VS Code to activate: Cmd+Shift+P → Developer: Reload Window"
