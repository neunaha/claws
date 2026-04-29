---
name: claws-wave-lead
description: Activate LEAD role for a Claws Wave Army. Registers the wave on the server, dispatches sub-workers (TESTER, REVIEWER, AUDITOR, DOC), and drives the PIAFEUR implementation loop until wave.complete.
---

# /claws-wave-lead <waveId> <mission>

You are the **LEAD** sub-worker. Read `.claude/skills/claws-wave-lead/SKILL.md` before proceeding.

## Step 1 — Register and announce

```
claws_hello({ role: 'orchestrator', peerName: '<waveId>-lead', waveId: '<waveId>', subWorkerRole: 'lead' })
claws_wave_create({ waveId: '<waveId>', layers: [...], manifest: ['tester','reviewer','auditor','doc'] })
claws_publish({ topic: 'wave.<waveId>.lead.boot', payload: { waveId, peerName, layers, manifest, started_at } })
claws_lifecycle_plan({ plan: '<1-sentence summary of what this wave ships>' })
```

## Step 2 — Dispatch sub-workers (parallel)

```
claws_dispatch_subworker({ waveId: '<waveId>', role: 'tester',   mission: '<tester mission>' })
claws_dispatch_subworker({ waveId: '<waveId>', role: 'reviewer', mission: '<reviewer mission>' })
claws_dispatch_subworker({ waveId: '<waveId>', role: 'auditor',  mission: '<auditor mission>' })
claws_dispatch_subworker({ waveId: '<waveId>', role: 'doc',      mission: '<doc mission>' })
```

## Step 3 — PIAFEUR loop (repeat until green)

1. **Plan** — exact list of files and functions to change
2. **Implement** — write the code; `npx tsc --noEmit` after every `.ts` file
3. **Audit** — read the diff yourself; fix obvious issues before reviewer sees them
4. **Fix** — address CRITICAL/HIGH findings from REVIEWER and AUDITOR
5. **Evaluate** — `cd extension && npm test` — assert zero failures
6. **Update** — `git add <files> && git commit -m "feat(...): ..."` — NO --no-verify
7. Publish `worker.<peerId>.phase` + heartbeat; repeat if needed

## Step 4 — Harvest and complete

```
# Wait for all sub-workers to publish wave.<waveId>.*.complete
claws_wave_status({ waveId: '<waveId>' })   # check completion flags

# Final checks
npm run build && npm test

# Publish complete events
claws_publish({ topic: 'wave.<waveId>.lead.complete', payload: { waveId, status: 'ok', commits: [...], regression_clean: true } })
claws_wave_complete({ waveId: '<waveId>', summary: '...', commits: [...], regressionClean: true })
```

## Step 5 — Cleanup

```
# Close all sub-worker terminals
claws_close({ id: <tester_tid> })
claws_close({ id: <reviewer_tid> })
claws_close({ id: <auditor_tid> })
claws_close({ id: <doc_tid> })
claws_lifecycle_reflect({ reflect: '<retrospective>' })
```

## Discipline reminders

- Heartbeat every 20 s — publish `worker.*.heartbeat`
- NEVER commit with `--no-verify`
- TESTER's green is required before final commit
- REVIEWER CRITICAL/HIGH findings must be addressed before wave.complete
