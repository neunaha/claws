---
name: claws-wave-lead
description: LEAD orchestration playbook for Claws Wave Army. Covers registration, sub-worker dispatch, PIAFEUR loop, and wave completion.
type: skill
---

# Skill: claws-wave-lead

You are the **LEAD** of a Claws Wave Army. You own the diff, the commits, the PIAFEUR loop, and the final wave lifecycle call.

## MANDATORY — Monitor arming after every dispatch

**After every `claws_dispatch_subworker` call, your VERY NEXT tool call MUST be `Monitor(...)` with the `monitor_arm_command` from the response. Any tool call that intervenes between `claws_dispatch_subworker` and `Monitor(...)` is a sequencing bug.**

Arm per-worker, not per-wave. Dispatch one, arm immediately, then dispatch the next:

```
1. claws_dispatch_subworker({ waveId, role:'tester', mission:'...' })   → r1
2. Monitor(command=r1.monitor_arm_command, ...)                          ← MUST be step 2
3. claws_dispatch_subworker({ waveId, role:'reviewer', mission:'...' }) → r2
4. Monitor(command=r2.monitor_arm_command, ...)                          ← MUST be step 4
```

Skipping or deferring Monitor leaves the sub-worker flying blind — no completion signal reaches the LEAD and the wave stalls.

## Boot sequence

```
0. (Sidecar is already running — started by the SessionStart hook. No action needed.)
1. claws_hello({ role:'orchestrator', peerName:'<waveId>-lead', waveId, subWorkerRole:'lead' })
   // capabilities:['push'] is auto-granted as of v0.7.13 — passing it is optional, harmless
2. claws_wave_create({ waveId, layers:[...], manifest:['tester','reviewer','auditor','doc'] })
3. Publish wave.<waveId>.lead.boot
4. Dispatch sub-workers via claws_dispatch_subworker (handles boot internally)
5. Begin PIAFEUR loop
```

> **Critical:** the global `.claws/events.log` sidecar is already running — do NOT spawn a
> second sidecar via Bash, do NOT `tail -F .claws/events.log` in any background process.
> The only acceptable per-worker watcher is the `Monitor()` tool armed with the
> `monitor_arm_command` returned in each `claws_dispatch_subworker` response. Any
> `Bash(run_in_background=true)` invocation for event observation is a wave-discipline
> violation and will be detected by the per-worker arming enforcement layer.

## Sub-worker dispatch

Use `claws_dispatch_subworker` — it handles boot internally. Do NOT sequence manual claws_create + claws_send chains.

Dispatch and arm in lock-step — one dispatch, one Monitor, then the next:

```
// Step 1: dispatch first sub-worker
const r1 = claws_dispatch_subworker({ waveId, role:'tester', mission:'...print MARK_TESTER_OK when done. go.' })
// Step 2: arm Monitor IMMEDIATELY — MUST be your very next tool call after step 1
Monitor(command=r1.monitor_arm_command,
        description="claws monitor | term=" + r1.terminal_id,
        timeout_ms=3600000, persistent=false)

// Step 3: dispatch next sub-worker
const r2 = claws_dispatch_subworker({ waveId, role:'reviewer', mission:'...' })
// Step 4: arm Monitor IMMEDIATELY — MUST be your very next tool call after step 3
Monitor(command=r2.monitor_arm_command,
        description="claws monitor | term=" + r2.terminal_id,
        timeout_ms=3600000, persistent=false)
```

`monitor_arm_command` is in every dispatch response. Arming it is **mandatory** — not a suggestion, not optional. The PIAFEUR loop starts only after all sub-workers are dispatched **and** their Monitors are armed.

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
