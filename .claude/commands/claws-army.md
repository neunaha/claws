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

## Army deployment (all calls in parallel)

```
# Register wave first
claws_wave_create({ waveId: '<waveId>', layers: ['<layer1>', ...], manifest: ['tester','reviewer','auditor','doc'] })

# Dispatch all sub-workers simultaneously
claws_dispatch_subworker({ waveId, role: 'tester',   mission: '<tester mission>' })
claws_dispatch_subworker({ waveId, role: 'reviewer', mission: '<reviewer mission>' })
claws_dispatch_subworker({ waveId, role: 'auditor',  mission: '<auditor mission>' })
claws_dispatch_subworker({ waveId, role: 'doc',      mission: '<doc mission>' })
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
- Register via `claws_hello` with `waveId` + `subWorkerRole` within 60 s
- Publish boot event, heartbeat every 20 s, phase events, error events, complete event
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
