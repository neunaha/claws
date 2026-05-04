<!-- CLAWS-GLOBAL:BEGIN v1 -->
## Claws — Machine-Wide Terminal Policy

Claws may be installed in the current project. Before running any long-lived process, check whether `.claws/claws.sock` exists in the project root.

### If `.claws/claws.sock` exists — you are in a Claws project

You MUST follow these rules:

1. **NEVER use Bash for long-lived processes** (servers, test watchers, builds, REPLs). Use `claws_create` + `claws_send`.
2. **ALWAYS create wrapped terminals** (`wrapped=true`) to enable log reading.
3. **ALWAYS close every terminal you create** when the task is done.
4. **NEVER touch terminals you did not create.**
5. **NEVER run Claude Code in headless/non-interactive mode.**

### Worker boot sequence (exact — do not skip steps)

```
Step 1  claws_create name="worker-<slug>" wrapped=true
Step 2  claws_send id=<N> text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions"
Step 3  Poll claws_read_log every 5s until output contains "trust" (~20s)
Step 4  claws_send id=<N> text="1" newline=false
Step 5  Poll claws_read_log every 5s until output contains "bypass" (~10s)
Step 6  claws_send id=<N> text="<mission>" newline=false
Step 7  claws_send id=<N> text="
" newline=false
```

### Lifecycle (8 phases — apply to every multi-terminal orchestration)

PLAN → SPAWN → DEPLOY → OBSERVE → RECOVER → HARVEST → CLEANUP → REFLECT

### Wave Discipline Contract (mandatory for Wave Army sub-workers)

When you receive a Wave Army mission you are a sub-worker. You MUST:

1. **Register** — call `claws_hello` with `waveId` and `subWorkerRole` within 60 s of boot.
   - As of v0.7.13: push capability is auto-granted on `claws_hello` — no need to specify `capabilities` explicitly.
     Existing workers that still pass `capabilities: ['push']` continue to work (Set.add is idempotent).
2. **Publish boot event** — publish `wave.<waveId>.<role>.boot` immediately after hello.
3. **Heartbeat every 20 s** — publish `worker.<peerId>.heartbeat` continuously while active.
   - Use the `peerId` returned by `claws_hello` — NOT the role name — in the heartbeat topic.
     The server violation timer (25 s) is only reset by heartbeats on `worker.<peerId>.*` topics.
     (BUG-06 note: role-name topics do not reset the timer in the current server build.)
4. **Phase events** — publish `worker.<peerId>.phase` on every lifecycle transition.
5. **Error events** — publish `worker.<peerId>.event` with `kind=ERROR` for any blocking failure; never swallow errors silently.
6. **No --no-verify** — every commit MUST pass pre-commit hooks. `--no-verify` is forbidden.
7. **Full suite before every commit** — run `npm test` (or equivalent); assert zero failures.
8. **Type check per .ts file** — run `npx tsc --noEmit` after editing any TypeScript; fix all errors before proceeding.
9. **Complete event** — publish `wave.<waveId>.<role>.complete` as **absolute final act** before printing the role sentinel.
   - Print the role sentinel ONLY AFTER the complete event is published. The LEAD waits on this
     event via `claws_drain_events`; if the sentinel appears before the event, the LEAD may time out.

### Worker completion signaling (5-layer convention)

Every Claude worker mission MUST end with these layers, in order. F3 is the primary close trigger — one zero-arg call handles everything. F4 and F5 are independent backups.

F1 (Bash tool call): git status --short                  — verify state
F2 (Bash tool call): git log --oneline -5                 — verify commits

F3 (MCP tool call — PRIMARY completion signal, REQUIRED):
```
claws_done()
```
(reads CLAWS_TERMINAL_ID from env, publishes system.worker.completed, closes terminal)

F4 (Bash tool call — BACKUP, REQUIRED):
```
printf '%s\n' '__CLAWS_DONE__'
```

F5 (chat narration — last-resort BACKUP):
End your final assistant message with the literal string `__CLAWS_DONE__` on its own line.

Why five layers: F1/F2 verify outcomes. F3 is the structural completion (MCP call → bus event → server picks up via `system.worker.completed`). F4 is the pty-byte backup that fires even if Claude skips the MCP call. F5 catches the case where Claude bypasses both tool calls and just narrates.

Deprecated (kept as fallback): `claws_publish(topic="worker.<id>.complete", payload={...})` still works via the existing pub/sub path.

Standard marker: `__CLAWS_DONE__` — same string for every worker. `correlation_id` distinguishes workers on the bus; the marker just signals "done".

### Sidecar is mandatory

When `.claws/claws.sock` exists, the orchestrator MUST have an active `stream-events.js` sidecar Monitor running. The `SessionStart` hook auto-spawns one with `--auto-sidecar` flag and `detached:true` so it outlives the hook. If the sidecar dies during a session, re-spawn it before making any worker call:

```
node .claws-bin/stream-events.js --auto-sidecar .claws/claws.sock &
disown
```

The `Stop` hook kills the sidecar cleanly via `pgrep -f 'stream-events.js.*--auto-sidecar'` + `kill -TERM`. Never skip the Stop hook — it is the sidecar's shutdown gate.

### Monitor is mandatory

The orchestrator MUST arm a Monitor on `.claws/events.log` as the FIRST ACTION of every Claude Code session, BEFORE any `claws_create` / `claws_worker` / `claws_fleet` / `claws_dispatch_subworker` call.

Exact command (use lifecycle-bound description so stale Monitors are distinguishable):

```
Bash(command="tail -F .claws/events.log", run_in_background=true,
     description="claws bus | plan=<slug> | sess=<ISO-hour>")
```

Example: `description="claws bus | plan=v0710-fix | sess=2026-05-02T04"`

Without this, the orchestrator is blind to worker completion events and must rely on polling. The PreToolUse hook will refuse spawn-class MCP calls if Monitor is not armed.

**Per-worker Monitor pattern (v0.7.10+ — PREFERRED):**
After each `claws_fleet` / `claws_worker` call, arm **one Monitor per returned `terminal_id`** using
the `monitor_arm_command` field in the response. Run all N Bash calls in parallel:

```
Bash(command="tail -F .claws/events.log | grep -m1 'MISSION_COMPLETE.*<tid>'",
     run_in_background=true, description="watch worker-<tid>")
```

`grep -m1` self-exits on first match. Per-worker isolation prevents one dead Monitor from
blinding the orchestrator to all remaining workers (the `exit-144` fragility of the single
shared Monitor). See the claws-orchestration-engine SKILL.md for the full pattern.

**Troubleshooting:**
- Verify Monitor is alive: `pgrep -f "tail.*events.log"` (exit 0 = running, non-zero = dead)
- Re-arm if dead: run the Bash command above again
- If `.claws/events.log` does not exist: the SessionStart hook creates it on sidecar spawn; `tail -F` waits gracefully for file creation

### If `.claws/claws.sock` does not exist

No Claws server running. Use standard tools. If the user explicitly installs Claws for this project, re-read `.claws-bin/README.md` for project-specific tool list.
<!-- CLAWS-GLOBAL:END v1 -->
