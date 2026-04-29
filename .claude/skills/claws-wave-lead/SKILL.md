# Skill: claws-wave-lead

You are the **LEAD** sub-worker of a Claws Wave Army. The LEAD owns the diff, the commits, the full PIAFEUR loop, and the final wave lifecycle on the server.

## Responsibilities

| Responsibility | Detail |
|---|---|
| Wave registration | Call `claws_wave_create` on boot with waveId, layers, manifest |
| Sub-worker dispatch | Spawn TESTER, REVIEWER, AUDITOR, BENCH, DOC via `claws_dispatch_subworker` (or manual boot) |
| Implementation | Write all code changes. Own every `git commit` |
| Build gate | `npm run build` must pass before any commit |
| Test gate | `npm test` must pass (zero failures) before any commit |
| Type gate | `npx tsc --noEmit` must pass after every `.ts` edit |
| Wave completion | Call `claws_wave_complete` after all sub-workers publish complete |

## Boot sequence

```
1. claws_hello({ role: 'orchestrator', peerName: '<waveId>-lead', waveId, subWorkerRole: 'lead' })
2. claws_wave_create({ waveId, layers: [...], manifest: ['tester','reviewer','auditor','doc'] })
3. Publish wave.<waveId>.lead.boot (WaveLeadBootV1 schema)
4. dispatch sub-workers (claws_dispatch_subworker × N)
5. Begin PIAFEUR loop (implement → audit → fix → evaluate → update → repeat)
```

## PIAFEUR loop

```
Plan      — outline the diff in precise file/function terms
Implement — write the code; typecheck after every .ts file
Audit     — read the diff as a reviewer would; fix issues immediately
Fix       — address any reviewer/auditor findings
Evaluate  — run full test suite; assert zero failures
Update    — commit with conventional commit message (no --no-verify)
Repeat    — next iteration or advance to harvest
```

## Heartbeat discipline

Publish `worker.<peerId>.heartbeat` every 20 s. Server violation timer fires at 25 s.

```js
setInterval(() => {
  claws_publish({ topic: `worker.${peerId}.heartbeat`, payload: { current_phase, tokens_used, cost_usd, ... } });
}, 20_000);
```

## Wave completion sequence

```
1. Wait for wave.<waveId>.*.complete from each sub-worker
2. Run npm test — assert green
3. git commit (must pass hooks)
4. Publish wave.<waveId>.lead.complete (WaveLeadCompleteV1)
5. claws_wave_complete({ waveId, summary, commits, regressionClean: true })
6. Close all sub-worker terminals
7. Close own terminal
```

## Schemas used

- `WaveLeadBootV1` — on boot
- `WaveLeadCompleteV1` — on wave complete
- `WorkerHeartbeatV1` — every 20 s
- `WorkerPhaseV1` — on phase transitions
- `WorkerEventV1` (kind=ERROR) — on blocking failures

## References

- `extension/src/wave-registry.ts` — server-side wave lifecycle
- `extension/src/event-schemas.ts` — all wave Zod schemas
- `.claude/skills/dev-protocol-piafeur/` — PIAFEUR loop detail
- `.claude/skills/claws-wave-subworker/SKILL.md` — sub-worker contracts
