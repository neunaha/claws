---
name: claws-status
description: Show a live dashboard of all active Claws terminals and their lifecycle state.
---

# /claws-status

## What this does
Calls `claws_list` and formats all active terminals as a readable table. Optionally reads `.claws/lifecycle-state.json` to add a lifecycle status column. Quick health check before starting orchestration work.

## Behavior
- Call `claws_list` to get all terminals
- Read `.claws/lifecycle-state.json` if it exists (best-effort, ignore if missing)
- Format as a table with columns: ID | Name | Wrapped | Age | Lifecycle State
- Report total counts: N terminals, N wrapped
- If no terminals: "No active terminals. Claws is connected and idle."
- If socket absent: "Claws socket not found. Reload VS Code to activate."

## Examples
```
/claws-status
what terminals are open?
show me the terminal dashboard
```

## When NOT to use
To run a task or spawn a worker, use /claws-do.
To close terminals, use /claws-cleanup.
To diagnose a broken install, use /claws-fix.
