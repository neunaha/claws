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
0. Arm Monitor on .claws/events.log via Bash run_in_background BEFORE any other action:
   Bash(command="tail -F .claws/events.log", run_in_background=true, description="Claws bus push events")
1. claws_hello({ role: 'orchestrator', peerName: '<waveId>-lead', waveId, subWorkerRole: 'lead', capabilities: ['push'] })
   // capabilities:['push'] required — without it claws_publish is silently rejected (BUG-03 workaround)
2. claws_wave_create({ waveId, layers: [...], manifest: ['tester','reviewer','auditor','doc'] })
3. Publish wave.<waveId>.lead.boot (WaveLeadBootV1 schema)
4. Dispatch sub-workers via claws_fleet (parallel) — NOT claws_dispatch_subworker (BUG-08: serial, BUG-09: no auto-close)
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

> **BUG-10 fix**: Do NOT check `claws_wave_status` once and bail. Loop on `claws_drain_events`
> until ALL roles in EXPECTED have published their `.complete` event, OR a 20-minute hard
> timeout fires. Only then proceed to `claws_wave_complete`.

```js
// Step 1 — Drain-and-wait for all sub-worker complete events
const EXPECTED = new Set(['tester', 'reviewer', 'auditor', 'doc']); // match manifest
const completed = new Set();
const HARD_TIMEOUT_MS = 20 * 60 * 1000;
const DRAIN_WAIT_MS   = 15_000;
const startedAt = Date.now();
let cursor = 0;

while (completed.size < EXPECTED.size) {
  if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
    const missing = [...EXPECTED].filter(r => !completed.has(r));
    claws_publish({ topic: `worker.${peerId}.phase`,
                    payload: { current_phase: 'harvest',
                               note: `TIMEOUT waiting for: ${missing.join(', ')}` } });
    break;
  }
  const { events, cursor: next } = claws_drain_events({ since_index: cursor, wait_ms: DRAIN_WAIT_MS });
  cursor = next;
  for (const evt of events) {
    const m = evt.topic?.match(/^wave\.[^.]+\.(\w+)\.complete$/);
    if (m && EXPECTED.has(m[1]) && !completed.has(m[1])) {
      completed.add(m[1]);
      claws_publish({ topic: `worker.${peerId}.heartbeat`,
                      payload: { current_phase: 'harvest',
                                 note: `${m[1]} done (${completed.size}/${EXPECTED.size})` } });
    }
  }
}

// Step 2 — Final gate
// npm test  — assert green
// git commit (must pass hooks, no --no-verify)

// Step 3 — Publish LEAD complete FIRST, then call wave_complete, THEN print sentinel
claws_publish({ topic: `wave.${waveId}.lead.complete`,
                payload: { waveId, status: 'ok', commits: [...], regression_clean: true } })
claws_wave_complete({ waveId, summary: '...', commits: [...], regressionClean: true })
// Print sentinel ONLY AFTER wave_complete returns — not before:
// LEAD_COMPLETE_<waveId>

// Step 4 — Close all sub-worker terminals, then own terminal
for (const tid of terminal_ids) { claws_close({ id: tid }) }
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
