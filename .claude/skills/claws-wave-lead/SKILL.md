---
name: claws-wave-lead
description: LEAD orchestration playbook for Claws Wave Army. Covers registration, sub-worker dispatch, PIAFEUR loop, and wave completion.
type: skill
---

# Skill: claws-wave-lead

You are the **LEAD** of a Claws Wave Army. You own the diff, the commits, the PIAFEUR loop, and the final wave lifecycle call.

## Boot sequence

```
0. Arm Monitor on .claws/events.log via Bash run_in_background BEFORE any other action
1. claws_hello({ role:'orchestrator', peerName:'<waveId>-lead', waveId, subWorkerRole:'lead', capabilities:['push'] })
   // capabilities:['push'] required — without it claws_publish is silently rejected (BUG-03)
2. claws_wave_create({ waveId, layers:[...], manifest:['tester','reviewer','auditor','doc'] })
3. Publish wave.<waveId>.lead.boot
4. Dispatch sub-workers via claws_dispatch_subworker (handles boot internally)
5. Begin PIAFEUR loop
```

## Sub-worker dispatch

Use `claws_dispatch_subworker` — it handles boot internally. Do NOT sequence manual claws_create + claws_send chains.

```
claws_dispatch_subworker({ waveId, role:'tester', mission:'...print MARK_TESTER_OK when done. go.' })
claws_dispatch_subworker({ waveId, role:'reviewer', mission:'...' })
```

Arm one Monitor per returned `terminal_id` using the `monitor_arm_command` field.

## PIAFEUR loop

```
Plan      — outline the exact diff in file/function terms
Implement — write the code; npx tsc --noEmit after every .ts edit
Audit     — read the diff as a reviewer; fix issues immediately
Fix       — address reviewer/auditor findings
Evaluate  — npm test; assert zero failures
Update    — git commit (conventional message, no --no-verify)
Repeat    — next iteration or advance to harvest
```

## Heartbeat discipline

Publish `worker.<peerId>.heartbeat` every 20 s. Server violation timer fires at 25 s.

## Wave completion sequence

```
// Loop on claws_drain_events until all sub-workers publish their .complete event
const EXPECTED = new Set(['tester','reviewer','auditor','doc']);
const completed = new Set();
const HARD_TIMEOUT_MS = 20 * 60 * 1000;
let cursor = 0;

while (completed.size < EXPECTED.size) {
  if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
    // log missing roles, break
    break;
  }
  const { events, cursor: next } = claws_drain_events({ since_index: cursor, wait_ms: 15000 });
  cursor = next;
  for (const evt of events) {
    const m = evt.topic?.match(/^wave\.[^.]+\.(\w+)\.complete$/);
    if (m && EXPECTED.has(m[1])) completed.add(m[1]);
  }
}

// Final gates: npm test green, git commit passes hooks
claws_publish({ topic:`wave.${waveId}.lead.complete`, payload:{...} })
claws_wave_complete({ waveId, summary:'...', commits:[...], regressionClean:true })
// Print sentinel ONLY AFTER wave_complete returns
// LEAD_COMPLETE_<waveId>
```

## Schemas used

- `WaveLeadBootV1` — on boot
- `WaveLeadCompleteV1` — on wave complete
- `WorkerHeartbeatV1` — every 20 s
- `WorkerPhaseV1` — phase transitions
- `WorkerEventV1` kind=ERROR — blocking failures

## References

- `extension/src/wave-registry.ts`
- `extension/src/event-schemas.ts`
- `.claude/skills/claws-wave-subworker/SKILL.md`
