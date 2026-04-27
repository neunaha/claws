---
name: claws-plan
description: Log the PLAN phase — required before spawning any worker terminals. The lifecycle gate blocks claws_create until this runs.
---

# /claws-plan — Phase 1: PLAN

The lifecycle gate in the PreToolUse hook will BLOCK claws_create until `.claws/lifecycle-state.json` exists with phase "PLAN". This command unlocks it.

## Steps

1. **State the mission** (answer these before writing the file):
   - What are you trying to accomplish?
   - How many parallel workers do you need?
   - What does success look like (MISSION_COMPLETE criteria)?

2. **Write the lifecycle state file** to unlock terminal creation:

Write to `.claws/lifecycle-state.json`:
```json
{
  "phase": "PLAN",
  "phases_completed": ["PLAN"],
  "plan": "<your 1-3 sentence mission summary>",
  "workers": [],
  "started_at": "<current ISO timestamp>",
  "harvest": null,
  "reflect": null
}
```

3. **Confirm**: "PLAN phase logged. Lifecycle gate unlocked — proceed to SPAWN."

## The full lifecycle after PLAN

SPAWN → claws_create workers (gate now open)
DEPLOY → claws_send missions (post-tool-use hook auto-advances)
OBSERVE → claws_read_log polling every 10-30s
RECOVER → nudge stuck workers
HARVEST → collect MISSION_COMPLETE outputs
CLEANUP → claws_close ALL workers (stop hook enforces this)
REFLECT → write .claws/lifecycle-reflect.md (stop hook enforces this)
