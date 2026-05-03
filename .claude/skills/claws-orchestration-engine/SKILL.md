---
description: Claws orchestration engine — 10-phase lifecycle for multi-terminal agentic SDLC. Invoke this skill before any multi-terminal orchestration task.
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

## 10-Phase Lifecycle Ring

The 8-phase ring (PLAN → SPAWN → DEPLOY → OBSERVE → RECOVER → HARVEST → CLEANUP → REFLECT)
is wrapped by two meta-phases: SESSION-BOOT (before PLAN) and SESSION-END (after REFLECT).
Every worker mode shares the outer ring and forks only inside SPAWN, rejoining at OBSERVE.

See the full enforcement gate catalogue: `.local/audits/v0710-enforcement-matrix.md`

---

### Phase 0 — SESSION-BOOT _(before PLAN)_

Triggered automatically by the `SessionStart` hook (`session-start-claws.js`):

1. Hook detects `.claws/claws.sock` → confirms server is live.
2. Idempotency check: `pgrep -f 'stream-events.js.*--auto-sidecar'` — skip if already running.
3. Spawns sidecar: `node .claws-bin/stream-events.js --auto-sidecar` → stdout appends to `.claws/events.log`.
4. Emits system-reminder: **"FIRST-ACTION — arm Monitor: tail -F .claws/events.log"**.
5. **Orchestrator MUST call** `Bash(command="tail -F .claws/events.log", run_in_background=true, description="Claws bus push events")` before any other action.

**Monitor arm is mandatory.** Without it the orchestrator is blind to all push events.
The PreToolUse deny gate (Gate A) will block spawn-class MCP calls if the sidecar is not alive.

---

### Phase 1 — PLAN

- Identify all workstreams that can run in parallel.
- Write a mission string for each worker (end every mission with the completion sentinel).
- Call `claws_lifecycle_plan(plan_text)` → persists to `.claws/lifecycle-state.json`; publishes `lifecycle.plan.created`.
- List terminal slugs and assign modes (single / fleet / army / raw / exec).

**Pre-conditions:** SESSION-BOOT complete; Monitor armed.
**Gate C (lifecycle-required):** `claws_create` is blocked until a plan is recorded.

---

### Phase 2 — SPAWN _(mode fork)_

**Pre-conditions:** PLAN complete; sidecar SUBSCRIBED (enforced by PreToolUse Gate A / `_ensureSidecarOrThrow`).

Mode fork — choose exactly one per orchestration cycle:

| Mode   | Tool                         | Description                                      |
|--------|------------------------------|--------------------------------------------------|
| single | `claws_worker(name, mission)`| One terminal; auto-boot sequence handled by MCP  |
| fleet  | `claws_fleet(workers:[…])`   | N terminals in parallel; returns `terminal_ids`  |
| army   | `claws_fleet` → LEAD → fleet | LEAD spawns sub-workers; LEAD calls wave_create  |
| raw    | `claws_create` + 7-step boot | Manual boot; full control over every step        |
| exec   | `claws_exec(command)`        | No persistent terminal; skips directly to HARVEST|

Every non-exec spawn response includes `monitor_arm_required:true` + `monitor_arm_command` as a
reminder hint. Record all returned `terminal_ids`.

**Transition:** SPAWN → DEPLOY (all terminals created) | SPAWN → RECOVER (creation failed) | SPAWN → FAILED (sidecar unavailable)

---

### Phase 3 — DEPLOY

- **raw** mode: send mission via 7-step boot sequence (trust → bypass → mission).
- **single/fleet**: `claws_worker`/`claws_fleet` auto-handles boot; mission already transmitted.
- **army**: LEAD calls `claws_wave_create(waveId, manifest)` to register wave on server.
  LEAD publishes `wave.<id>.lead.boot`. LEAD dispatches sub-workers via `claws_fleet`.
- Workers begin execution; each publishes `worker.<peerId>.boot`.

**Transition:** DEPLOY → OBSERVE (all boot events ack'd within 30s) | DEPLOY → RECOVER (boot timeout)

---

### Phase 4 — OBSERVE _(event-driven — no polling; all modes converge here)_

Monitor delivers push frames live from `.claws/events.log`:

| Event topic             | Meaning                                      | Action                              |
|-------------------------|----------------------------------------------|-------------------------------------|
| `worker.*.heartbeat`    | Liveness pulse (every 20s)                  | Reset stuck timer                   |
| `worker.*.phase`        | Lifecycle transition                         | Update per-worker state             |
| `worker.*.event`        | BLOCKED / ERROR / PROGRESS / WARNING         | BLOCKED → `claws_broadcast inject:true`; ERROR → RECOVER |
| `worker.*.complete`     | Worker done                                  | Move to HARVEST when all done       |
| `wave.<id>.*.boot`      | Army sub-worker alive (army mode)            | Mark registered                     |
| `wave.<id>.violation`   | Sub-worker missed heartbeat >25s (army)      | RECOVER for that sub-worker         |

**Stuck detection:** no `worker.*.heartbeat` for >25s → check `claws_read_log` to diagnose.

**Legacy fallback** (workers that do not publish events): poll `claws_read_log` every 30s;
watch `totalSize` — if it stops growing for >5 min, the worker may be stuck.

**Command dispatch** when worker publishes `kind=BLOCKED` with `request_id`:
```
claws_broadcast(
  text="[CLAWS_CMD r=<request_id>] resume: {}",
  targetRole="worker",
  inject=true
)
```

**Transition:** OBSERVE → HARVEST (all `.complete` events / MISSION_COMPLETE) | OBSERVE → RECOVER (stuck / ERROR)

---

### Phase 5 — RECOVER _(conditional — entered from SPAWN / DEPLOY / OBSERVE)_

1. `claws_read_log(id, offset, limit:2000)` — read last output to diagnose.
2. If worker published `request_id` (BLOCKED): `claws_broadcast(inject:true)` with `resume: {}`.
3. If recoverable without request_id: `claws_send(id, nudge_text)`.
4. If terminal unresponsive: `claws_close(id)` → respawn from SPAWN (targeted re-entry).
5. Fleet: recover only failed workers; healthy workers stay in OBSERVE.
6. >3 retries for one worker → FAILED for that worker.

**Transition:** RECOVER → OBSERVE (worker re-engaged) | RECOVER → DEPLOY (full respawn) | RECOVER → FAILED (unrecoverable)

---

### Phase 6 — HARVEST

- **single**: read terminal log for MISSION_COMPLETE + result summary.
- **fleet**: aggregate per-worker results; tally ok/failed counts.
- **army**: LEAD runs `claws_drain_events(wait_ms:15000)` loop until all manifest roles publish `.complete`. Hard timeout: 20 min. LEAD publishes `wave.<id>.lead.complete`. LEAD calls `claws_wave_complete(waveId, summary)`.
- **exec**: output already in `claws_exec` response; harvest is immediate.

Extract commit hashes, test results, and error summaries before moving to CLEANUP.

**Transition:** HARVEST → CLEANUP (all results collected) | HARVEST → FAILED (20min hard timeout with missing sub-workers)

---

### Phase 7 — CLEANUP

1. `claws_list()` — enumerate all open terminals.
2. `claws_close(id)` for every terminal created in this orchestration cycle.
3. Army: LEAD closes all sub-worker terminals first, then its own.
4. `claws_list()` again — assert no orphans.
5. `claws_lifecycle_advance("CLEANUP")` persists state.

**Cleanup is MANDATORY.** Stale terminals are a bug. The Stop hook warns on any unclosed terminals.

**Transition:** CLEANUP → REFLECT (zero orphans) | CLEANUP → FAILED (VS Code crash preventing close)

---

### Phase 8 — REFLECT

1. Write summary: what each worker did, ok/failed outcome, commits made.
2. `claws_lifecycle_reflect(summary)` → persists reflect text to lifecycle-state.json; publishes `lifecycle.reflect.done`.
3. Report to user: what changed, what failed, what to do next.
4. JSONL phase is terminal — next orchestration starts a new PLAN (cycle N+1).

---

### Phase 9 — SESSION-END _(after REFLECT or on abnormal exit)_

Triggered automatically by the `Stop` hook (`stop-claws.js`):

1. `pgrep -f 'stream-events.js.*--auto-sidecar'` → SIGTERM → sidecar exits cleanly.
2. Sidecar writes `{"type":"sidecar.closed"}` to `.claws/events.log` before exit.
3. Monitor receives `sidecar.closed` → orchestrator knows event stream is done.
4. `.claws/events.log` retained on disk as session audit trail.
5. Hook warns (advisory, never blocks) if any terminals still open or REFLECT was not reached.

---

## Real-time event stream (no polling)

The orchestrator subscribes to a pub/sub event stream via `scripts/stream-events.js`
under Monitor. Workers publish events at every checkpoint via `claws_publish`. See
**`docs/event-protocol.md`** for the full convention — schemas, state machine, command
channel, error recovery, authorization rules.

## Per-worker Monitor pattern (v0.7.10+)

When `claws_fleet` or `claws_worker` returns, each entry includes a `monitor_arm_command` scoped to that
worker's `terminal_id`. Arm **one Monitor per worker** in parallel immediately after the spawn call:

```bash
# Example: claws_fleet returned terminal_ids [42, 43, 44]
Bash(command="tail -F .claws/events.log | grep -m1 'MISSION_COMPLETE.*42\\|42.*MISSION_COMPLETE'",
     run_in_background=true, description="watch worker-42")
Bash(command="tail -F .claws/events.log | grep -m1 'MISSION_COMPLETE.*43\\|43.*MISSION_COMPLETE'",
     run_in_background=true, description="watch worker-43")
Bash(command="tail -F .claws/events.log | grep -m1 'MISSION_COMPLETE.*44\\|44.*MISSION_COMPLETE'",
     run_in_background=true, description="watch worker-44")
```

`grep -m1` causes each Monitor to self-exit on first match — no manual teardown needed.
Wall-clock completion ≈ max(individual times), not sum.

**Why per-worker instead of shared:**
The single shared Monitor had `exit-144` fragility: an unrelated event could cause grep to exit
early, leaving the orchestrator blind for all remaining workers simultaneously. Per-worker
isolation means one Monitor dying does not affect the others. The `monitor_arm_command` field
is always present in fleet/worker responses — use it directly.

**Back-compat:** the global bus Monitor (`tail -F .claws/events.log` with no grep filter) remains
valid as a supplementary observer for debugging. It is no longer the sole liveness mechanism.

---

## Rules (MUST follow — no exceptions)

- NEVER use Bash for long-lived processes (servers, builds, test runners). Always use claws_create + claws_send.
- ALWAYS arm Monitor on `.claws/events.log` as the FIRST ACTION (before any spawn call).
- ALWAYS arm per-worker Monitors (one per terminal_id) immediately after fleet/worker spawn.
- ALWAYS use wrapped=true on new terminals.
- ALWAYS follow the 7-step boot sequence before sending any mission (raw mode).
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
