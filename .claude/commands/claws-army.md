---
name: claws-army
description: Launch a full Wave Army — LEAD + all sub-workers — for a complex implementation task. Use when a task needs parallel TDD, code review, audit, and documentation in a single coordinated wave.
---

# /claws-army <waveId> <mission>

Deploys a complete Claws Wave Army:

| Role | Terminal | Responsibility |
|---|---|---|
| LEAD | wave-<N>-lead | Implements, commits, owns lifecycle |
| TESTER | wave-<N>-tester | Writes red tests first, validates green after |
| REVIEWER | wave-<N>-reviewer | Code review after each LEAD commit |
| AUDITOR | wave-<N>-auditor | Race conditions, schema, regression sweep |
| DOC | wave-<N>-doc | CHANGELOG, gap docs, templates |

## Pre-flight

```
claws_lifecycle_plan({ plan: 'Wave Army: <waveId> — <one sentence mission summary>' })
```

## Army deployment (parallel via claws_fleet)

> **Use `claws_fleet`, NOT `claws_dispatch_subworker`.**
> `claws_dispatch_subworker` is serial (BUG-08: each call blocks ~27 s before starting the next)
> and has no auto-close watcher for sub-worker terminals (BUG-09). Both bugs are unresolved.
> `claws_fleet` is the proven parallel path: all workers boot simultaneously, auto-close on complete.

Each sub-worker mission MUST embed the Wave Discipline Contract. See
`.claude/skills/claws-wave-subworker/SKILL.md` for the full boot sequence to include in each mission.
Key requirement: `claws_hello` must include `capabilities: ['push']` (BUG-03 workaround).

```
# Step 1 — Register wave (before dispatching)
claws_wave_create({ waveId: '<waveId>', layers: ['<layer1>', ...], manifest: ['tester','reviewer','auditor','doc'] })

# Step 2 — Dispatch all sub-workers in parallel (returns terminal_ids immediately)
claws_fleet({
  cwd: ".",
  workers: [
    { name: "wave-<N>-tester",   mission: "<tester mission — embed wave discipline contract>" },
    { name: "wave-<N>-reviewer", mission: "<reviewer mission — embed wave discipline contract>" },
    { name: "wave-<N>-auditor",  mission: "<auditor mission — embed wave discipline contract>" },
    { name: "wave-<N>-doc",      mission: "<doc mission — embed wave discipline contract>" }
  ]
})
// → { fleet_size: 4, terminal_ids: [...] }

# Step 3 — Poll completion (while LEAD runs PIAFEUR loop)
claws_workers_wait({ terminal_ids: [...], timeout_ms: 1200000 })
```

Then switch to LEAD role and follow `/claws-wave-lead`.

## Monitoring

```
claws_wave_status({ waveId: '<waveId>' })      # check heartbeat ages + completion flags
claws_drain_events({ since_index: 0 })         # read all bus events
claws_read_log({ id: <tid> })                  # read specific terminal output
```

## Completion criteria

- [ ] All sub-workers published `wave.<waveId>.*.complete`
- [ ] `npm test` passes with zero failures
- [ ] `npm run build` succeeds
- [ ] `git log` shows conventional commit(s) from this wave
- [ ] REVIEWER has no open CRITICAL or HIGH findings
- [ ] `claws_wave_complete` called with `regressionClean: true`

## Sub-worker discipline contract

Every sub-worker MUST follow `.claude/skills/claws-wave-subworker/SKILL.md`:
- Register via `claws_hello` with `waveId` + `subWorkerRole` + **`capabilities: ['push']`** within 60 s
  (BUG-03 workaround — without capabilities:['push'] all claws_publish calls are silently rejected)
- Publish boot event immediately after hello
- Heartbeat every 20 s via `worker.<peerId>.heartbeat` — use the peerId returned by hello, not the role name
  (BUG-06 note: the violation timer is reset by publishing to `worker.<peerId>.heartbeat`; topics
  with role-name instead of peerId do NOT reset the timer in the current server build)
- Publish phase events, error events
- Publish `wave.<waveId>.<role>.complete` as **absolute final act** before printing sentinel
- Print role sentinel ONLY AFTER complete event is published (LEAD waits for this event on the bus)
- NEVER commit with `--no-verify`
- Run full test suite before every commit

## Violation recovery

If `claws_drain_events` shows a `wave.<waveId>.violation` event for a sub-worker:

```
claws_read_log({ id: <stuck_tid> })   # diagnose
# If truly stuck: close and re-dispatch
claws_close({ id: <stuck_tid> })
claws_dispatch_subworker({ waveId, role: '<role>', mission: '<mission>' })
```
