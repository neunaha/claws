---
name: claws
description: Master command for Claws terminal orchestration. Shows live status or routes to /claws-do.
---

# /claws [task]

## What this does
Context-aware master command. With no arguments it shows a live dashboard of all active terminals and the Claws version. With arguments it forwards the request to /claws-do so you never need to remember which command to use.

## Behavior

**No arguments — show status dashboard:**
- Call `claws_list` to enumerate all active terminals
- Read the first version line from CHANGELOG.md for the Claws version
- Format terminals as a table: ID | Name | Wrapped | PID
- End with: "Type /claws-do '<task>' to do anything. /claws-help for the full reference."

**If `.claws/claws.sock` is absent:**
- "Claws is not active. Reload VS Code: Cmd+Shift+P → Developer: Reload Window."
- If `~/.claws-src` is missing: "Claws is not installed — contact your project owner."

**With arguments:**
- Treat the arguments as a task and execute /claws-do behavior directly.
- Do not ask clarifying questions — classify and act.

## Examples
```
/claws
/claws fix the failing test in auth.test.ts
/claws run npm test and show me the output
```

## When NOT to use
If you want the full command reference, use /claws-help.
If you want to close terminals, use /claws-cleanup.
