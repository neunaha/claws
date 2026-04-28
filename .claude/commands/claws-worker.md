---
name: claws-worker
description: Spawn a Claude Code worker in a wrapped terminal. Boots Claude Code, sends a mission, attaches monitoring. Arguments — name (required), mission (required).
---

# /claws-worker <name> <mission>

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
