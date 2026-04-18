---
name: claws
description: Master command for Claws terminal orchestration. Context-aware — shows status if no args, or routes to the right action. The one command users need to remember.
---

# /claws

The master command. Does the right thing based on context.

## What to do

If the user typed just `/claws` with no arguments:

1. Check if Claws is installed by looking for the socket:
```bash
test -S .claws/claws.sock 2>/dev/null && echo "CONNECTED" || echo "NOT_CONNECTED"
```

2. If connected — show a live status dashboard:
   - Run `claws_list` to show all terminals
   - Show which are wrapped vs unwrapped
   - Show the Claws version from `~/.claws-src/CHANGELOG.md` (first version line)
   - End with: "Type `/claws do <task>` to get started, or `/claws learn` for the full guide."

3. If not connected — guide them:
   - "Claws extension isn't active yet. Reload VS Code: Cmd+Shift+P → Developer: Reload Window"
   - If `~/.claws-src` doesn't exist: "Claws isn't installed. Run: `/claws setup`"

4. If the user typed `/claws` with arguments, they probably meant one of the subcommands. Route them:
   - "did you mean `/claws do`, `/claws go`, `/claws watch`, `/claws learn`, `/claws setup`, or `/claws update`?"
