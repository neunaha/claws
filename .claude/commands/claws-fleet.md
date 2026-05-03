---
name: claws-fleet
description: Non-blocking by default. Spawn N parallel workers from a task list; returns terminal_ids immediately. Poll completion via claws_workers_wait. Each task gets its own wrapped terminal + monitor.
---

# /claws-fleet <task-file-or-inline-json>

**Non-blocking by default.** `claws_fleet` spawns all workers and returns `terminal_ids` within seconds — it does not hold the MCP socket open while workers run. Workers execute independently; the orchestrator polls for completion separately.

## Canonical 3-step pattern

**Step 1 — Fire `claws_fleet`** (returns `terminal_ids` in seconds, never blocks):
```
claws_fleet(cwd="...", workers=[{name:"a", mission:"..."}, {name:"b", mission:"..."}])
→ { fleet_size, terminal_ids, workers:[{terminal_id, name}, …] }
```

**Step 2 — Poll with `claws_workers_wait`** (safe to block here — workers run independently):
```
claws_workers_wait(terminal_ids=[…], timeout_ms=300000)
→ { done: true/false, workers:[{terminal_id, status, marker_found}, …] }
```

**Step 3 — Read audit files for ground truth** (always lands on disk regardless of socket state):
```
ls .local/audits/   # each worker writes its own audit file
```

Spawn a fleet of parallel workers. Each task in the list gets its own wrapped terminal, its own command, and its own monitor. The orchestrator watches all monitors and reports as each worker completes.

## Input format

Either a JSON file path or inline JSON array:

```json
[
  {"name": "lint", "command": "npm run lint"},
  {"name": "test", "command": "npm test"},
  {"name": "build", "command": "npm run build"}
]
```

## What to do

1. Parse the task list.

2. For each task, in parallel:
   a. Create a wrapped terminal via `/claws-create <name>`
   b. Send the command via `/claws-send <id> <command>`
   c. Attach a Monitor to the pty log

3. Aggregate results as workers complete. Report:
   - Which workers finished successfully (exit 0 detected in log)
   - Which workers failed (error/traceback detected)
   - Which workers are still running

4. When all workers reach terminal state:
   - Close all worker terminals
   - Stop all monitors
   - Report final fleet summary: N succeeded, N failed, total wall-clock

## Example usage

```
/claws-fleet [{"name":"audit-a","command":"python3 scripts/audit_latency.py"},{"name":"audit-b","command":"python3 scripts/audit_tokens.py"}]
```
