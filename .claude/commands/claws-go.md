---
name: claws-go
description: Spawn a Claude Code worker terminal instantly. Give it a mission and watch it work. The fastest way to delegate a task to an AI worker you can observe.
---

# /claws go <mission>

Spawn a visible Claude Code worker and send it a mission. You watch it work in real time.

## What to do

1. Take the user's mission text
2. Call `claws_worker` with:
   - name: derive a short slug from the mission (e.g., "fix auth bug" → "fix-auth")
   - mission: the user's text + " print MISSION_COMPLETE when done. go."
   - launch_claude: true (default — auto-launches Claude Code with full permissions)
3. Tell the user: "Worker spawned in terminal [name]. Watch it in your terminal panel. I'll monitor and report when it's done."
4. Monitor via `claws_read_log` until MISSION_COMPLETE or error
5. Read final state, report results, close terminal

## Examples

- `/claws go fix the failing test in utils.test.ts`
- `/claws go refactor the database module to use connection pooling`
- `/claws go write unit tests for the auth middleware`
- `/claws go audit package.json for outdated dependencies and update them`
