---
name: claws-cleanup
description: Close all worker terminals after a fleet run. Leaves user-created terminals untouched.
---

# /claws-cleanup

## What this does
Finds all terminals with worker-style names (prefixed with "worker-") and closes them via `claws_close`. Confirms the count with the user if there are any before proceeding. Idempotent — safe to run multiple times.

## Behavior
- Call `claws_list` to enumerate all terminals
- Identify terminals whose name starts with "worker-" or matches ones you created this session
- If 0 found: "Nothing to clean up — terminal panel is already clear."
- If N found: confirm "Close N worker terminals? (Y to proceed)" then call `claws_close` for each
- Call `claws_list` again to confirm removal
- Report: "Closed N terminals. Your terminals are untouched."

## Examples
```
/claws-cleanup
clean up all worker terminals
close everything after the fleet run
```

## When NOT to use
Do not use to close specific terminals by ID — call `claws_close(id=N)` directly.
Do not use if you want to close ALL terminals including user ones — that requires explicit confirmation.
