---
name: claws-plan
description: Log the PLAN phase — required before spawning any worker terminals. The lifecycle gate blocks claws_create until this runs.
---

# /claws-plan — Phase 1: PLAN

The server-side lifecycle gate blocks `claws_create` until a PLAN has been logged. This command unlocks it.

## Steps

1. **State the mission** (answer these before logging the plan):
   - What are you trying to accomplish?
   - How many parallel workers do you need?
   - What does success look like (MISSION_COMPLETE criteria)?

2. **Log the PLAN via the MCP tool** — this writes server-owned state and unlocks `claws_create`:

```
mcp__claws__claws_lifecycle_plan(plan="<your 1-3 sentence mission summary>")
```

The server validates the plan is non-empty, creates `.claws/lifecycle-state.json` under its own ownership, and returns `{ state: { phase: "PLAN", ... } }`.

3. **Confirm**: "PLAN phase logged. Lifecycle gate unlocked — proceed to SPAWN."

## The full lifecycle after PLAN

SPAWN → claws_create workers (gate now open)
DEPLOY → claws_send missions (advance via claws_lifecycle_advance)
OBSERVE → claws_read_log polling every 10-30s
RECOVER → nudge stuck workers
HARVEST → collect MISSION_COMPLETE outputs
CLEANUP → claws_close ALL workers (stop hook enforces this)
REFLECT → mcp__claws__claws_lifecycle_reflect (stop hook enforces this)
