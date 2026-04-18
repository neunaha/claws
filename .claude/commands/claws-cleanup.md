---
name: claws-cleanup
description: Close all worker terminals you created. Clean slate. Use after a fleet run or when the terminal panel is cluttered.
---

# /claws cleanup

Close all Claws worker terminals. Leave user-created terminals untouched.

## What to do

1. Call `claws_list` to get all terminals
2. Identify terminals with names starting with "worker-", "claws-", or any terminal you created in this session
3. For each one: `claws_close`
4. Call `claws_list` again to confirm they're gone
5. Tell the user: "Cleaned up N worker terminals. Your terminals are untouched."
