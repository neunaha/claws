---
description: Claws orchestration engine — 8-phase lifecycle for multi-terminal agentic SDLC. Invoke this skill before any multi-terminal orchestration task.
---

# Claws Orchestration Engine

## Worker boot sequence (ALWAYS follow this exact order — do not skip steps)

```
Step 1  claws_create name="worker-<slug>" wrapped=true
Step 2  claws_send id=<N> text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions"
Step 3  Poll claws_read_log every 5s until output contains "trust" (~20s)
Step 4  claws_send id=<N> text="1" newline=false
Step 5  Poll claws_read_log every 5s until output contains "bypass" (~10s)
Step 6  claws_send id=<N> text="<your mission text>" newline=false
Step 7  claws_send id=<N> text="
" newline=false   ← separate call, no newline
```

Never send the mission before "bypass" is detected. Never skip the trust acceptance step.

## Real-time event stream (no polling)

The orchestrator subscribes to a pub/sub event stream via `scripts/stream-events.js`
under Monitor. Workers publish events at every checkpoint via `claws_publish`. See
**`docs/event-protocol.md`** for the full convention — schemas, state machine, command
channel, error recovery, authorization rules.

## 8-Phase Lifecycle

### Phase 1 — PLAN
- Identify all workstreams that can run in parallel
- Write a mission string for each worker (end every mission with "print MISSION_COMPLETE when done. go.")
- List which terminals you will create and their slugs

### Phase 2 — SPAWN
- For each worker: execute the boot sequence above (all 7 steps)
- Record the terminal ID returned by claws_create
- Wait for "bypass" before sending each mission

### Phase 3 — DEPLOY
- Send the mission string (Step 6)
- Send the CR (Step 7)
- Note the timestamp; worker is now running

### Phase 4 — OBSERVE
- Poll `claws_read_log` on each terminal every 30s
- Track `totalSize` — if it stops growing for >5 min, the worker may be stuck

### Phase 5 — RECOVER
- If a worker is stuck (no new bytes for 5+ min, no MISSION_COMPLETE):
  1. Read the last 2000 bytes to diagnose
  2. If recoverable: send a nudge via `claws_send`
  3. If not: close the terminal and respawn from Phase 2

### Phase 6 — HARVEST
- Worker signals completion by printing `MISSION_COMPLETE`
- Detect: `totalSize > 85% of context limit` OR output contains `MISSION_COMPLETE`
- Read the final output to extract results, errors, commit hashes

### Phase 7 — CLEANUP
- Call `claws_close` on every terminal you created
- Verify with `claws_list` that no orphan terminals remain
- Cleanup is MANDATORY — stale terminals are a bug

### Phase 8 — REFLECT
- Summarise what each worker did and whether it succeeded
- Commit any uncommitted work
- Report to the user: what changed, what failed, what to do next

## Rules (MUST follow — no exceptions)

- NEVER use Bash for long-lived processes (servers, builds, test runners). Always use claws_create + claws_send.
- ALWAYS use wrapped=true on new terminals.
- ALWAYS follow the 7-step boot sequence before sending any mission.
- ALWAYS close every terminal you opened.
- NEVER touch terminals you did not create.
- NEVER run Claude Code headless (no piped stdin, no --no-input).

## claws/2 orchestration (peer-to-peer)

For tasks requiring real-time coordination between workers:

```
Orchestrator: claws_hello role=orchestrator → peerId
              claws_subscribe topic="task.status"
              claws_subscribe topic="task.completed"
              claws_task_assign assignee=<workerPeerId> title=... prompt=...

Worker:       claws_hello role=worker → peerId
              claws_subscribe topic="task.assigned.<peerId>"
              (receive task) → claws_task_update → claws_task_complete
```
