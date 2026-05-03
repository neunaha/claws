---
name: claws-worker
description: Non-blocking by default. Spawn a Claude Code worker in a wrapped terminal; returns terminal_id immediately. Poll completion via claws_workers_wait. Arguments — name (required), mission (required).
---

# /claws-worker <name> <mission>

**Non-blocking by default.** `claws_worker` boots a Claude Code session, sends the mission, and returns `terminal_id` within seconds — it does not hold the MCP socket open while the worker runs. The worker executes autonomously; the orchestrator polls for completion separately.

## Canonical 3-step pattern

**Step 1 — Fire `claws_worker`** (returns `terminal_id` in seconds, never blocks):
```
claws_worker(name="worker-<name>", mission="<full mission text>. print MISSION_COMPLETE when done. go.")
→ { terminal_id, name, status:"running" }
```

**Step 2 — Poll with `claws_workers_wait`** (safe to block here — worker runs independently):
```
claws_workers_wait(terminal_ids=[terminal_id], timeout_ms=300000)
→ { done: true/false, workers:[{terminal_id, status, marker_found}, …] }
```

**Step 3 — Read audit files for ground truth** (always lands on disk regardless of socket state):
```
ls .local/audits/   # worker writes its audit file on completion
```

Spawn a Claude Code worker terminal. The worker hosts a real Claude Code instance running in `--dangerously-skip-permissions` mode and executes the mission autonomously.

**Note:** wrapped terminals exist to host Claude Code, not bare shell commands. If you just need to run a one-shot shell command (`npm test`, `pytest`, etc.), use `claws_exec` instead — see `/claws-do`.

## What to do

If `claws_worker` MCP tool is available, use it — it bundles the full 7-step boot:

```
claws_worker(name="worker-<name>", mission="<full mission text>. print MISSION_COMPLETE when done. go.")
```

Otherwise, follow the manual 7-step sequence:

1. `claws_lifecycle_plan(plan="<2-3 sentence plan>")` — required before any create.
2. `claws_create(name="worker-<name>", wrapped=true)` → terminal id N.
3. `claws_send(id=N, text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions")`
4. Poll `claws_read_log` every 5s until output contains `"trust"` (~20s).
5. `claws_send(id=N, text="1", newline=false)` — accept trust.
6. Poll `claws_read_log` every 5s until output contains `"bypass"` (~10s).
7. `claws_send(id=N, text="<mission>. print MISSION_COMPLETE when done. go.", newline=false)`
   `claws_send(id=N, text="\n", newline=false)` — submit (separate call).

## After dispatch

Poll `claws_read_log(id=N)` every 30s. The mission is done when:
- output contains `MISSION_COMPLETE`, OR
- the worker process exits, OR
- `totalSize` stops growing for >5 min (treat as stuck — RECOVER).

When done, read the final log, report results to the user, then `claws_close(id=N)`. Cleanup is mandatory.

## See also

- `/claws-streaming-worker` — same shape but the worker publishes typed events over the pub/sub bus for real-time observability (use when running ≥3 parallel workers).
- `/claws-do` — auto-routes one-shot shell commands to `claws_exec` and missions to this command.
- `/claws-boot` — pure boot sequence reference.
