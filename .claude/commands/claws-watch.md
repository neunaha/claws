---
name: claws-watch
description: Live dashboard of all terminals. Shows what's running, what's wrapped, last activity. The control room view.
---

# /claws watch

Show the user everything happening across their terminals right now.

## What to do

1. Call `claws_list` to get all terminals
2. For each wrapped terminal, call `claws_read_log` (last 5 lines) to show latest activity
3. Format as a clean dashboard:

```
╔═══════════════════════════════════════════╗
║   CLAWS — Terminal Control Room           ║
╚═══════════════════════════════════════════╝

  * 1  zsh                      [unwrapped]  active
    3  worker-tests             [WRAPPED]    last: Tests: 5 passed
    4  worker-build             [WRAPPED]    last: Build complete, 2.3MB
    5  worker-lint              [WRAPPED]    last: 0 errors, 3 warnings
```

4. If any wrapped terminals show errors in their last lines, highlight them
5. End with: "Use `/claws do <task>` to start new work, or click any terminal tab to inspect."
