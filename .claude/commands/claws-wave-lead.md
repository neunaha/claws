---
name: claws-wave-lead
description: Activate LEAD role for a Claws Wave Army. Registers the wave on the server, dispatches sub-workers (TESTER, REVIEWER, AUDITOR, DOC), and drives the PIAFEUR implementation loop until wave.complete.
---

# /claws-wave-lead <waveId> <mission>

You are the **LEAD** sub-worker. Read `.claude/skills/claws-wave-lead/SKILL.md` before proceeding.

## Step 1 — Register and announce

```
// capabilities:['push'] is required — without it claws_publish is silently rejected (BUG-03 workaround)
claws_hello({ role: 'orchestrator', peerName: '<waveId>-lead', waveId: '<waveId>', subWorkerRole: 'lead', capabilities: ['push'] })
claws_wave_create({ waveId: '<waveId>', layers: [...], manifest: ['tester','reviewer','auditor','doc'] })
claws_publish({ topic: 'wave.<waveId>.lead.boot', payload: { waveId, peerName, layers, manifest, started_at } })
claws_lifecycle_plan({ plan: '<1-sentence summary of what this wave ships>' })
```

## Step 2 — Dispatch sub-workers (parallel via claws_fleet)

> **IMPORTANT**: Use `claws_fleet`, NOT `claws_dispatch_subworker`.
> `claws_dispatch_subworker` is serial (BUG-08) and has no auto-close watcher (BUG-09).
> `claws_fleet` dispatches all workers in parallel and returns `terminal_ids` within seconds.

Each sub-worker mission MUST embed the Wave Discipline Contract (hello, heartbeat, complete event).
See `.claude/skills/claws-wave-subworker/SKILL.md` for the full boot sequence to include.

```
claws_fleet({
  cwd: ".",
  workers: [
    { name: "wave-<N>-tester",   mission: "<tester mission — must include wave discipline contract>" },
    { name: "wave-<N>-reviewer", mission: "<reviewer mission — must include wave discipline contract>" },
    { name: "wave-<N>-auditor",  mission: "<auditor mission — must include wave discipline contract>" },
    { name: "wave-<N>-doc",      mission: "<doc mission — must include wave discipline contract>" }
  ]
})
// → { fleet_size: 4, terminal_ids: [...], workers: [{terminal_id, name}, ...] }
// Returns immediately — workers run in parallel. Poll completion in Step 4.
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

> **BUG-10 fix**: Do NOT call `claws_wave_status` once and bail. Use the drain-and-wait loop
> below. The LEAD must not call `claws_wave_complete` until ALL expected roles have published
> their `.complete` event, OR the 20-minute hard timeout fires.

```js
// --- Robust sub-worker wait (BUG-10 fix) ---
// Substitute <waveId> and adjust EXPECTED to match your manifest.
const EXPECTED = new Set(['tester', 'reviewer', 'auditor', 'doc']);
const completed = new Set();
const HARD_TIMEOUT_MS = 20 * 60 * 1000;  // 20-minute ceiling
const DRAIN_WAIT_MS   = 15_000;           // block up to 15 s per drain call
const startedAt = Date.now();
let cursor = 0;

while (completed.size < EXPECTED.size) {
  if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
    const missing = [...EXPECTED].filter(r => !completed.has(r));
    claws_publish({ topic: 'worker.<peerId>.phase',
                    payload: { current_phase: 'harvest',
                               note: `TIMEOUT — still waiting for: ${missing.join(', ')}` } });
    break;  // proceed anyway; wave_complete will record partial results
  }

  const { events, cursor: next } = claws_drain_events({ since_index: cursor, wait_ms: DRAIN_WAIT_MS });
  cursor = next;

  for (const evt of events) {
    // Match wave.<waveId>.<role>.complete — any waveId, any role in EXPECTED
    const m = evt.topic?.match(/^wave\.[^.]+\.(\w+)\.complete$/);
    if (m && EXPECTED.has(m[1]) && !completed.has(m[1])) {
      completed.add(m[1]);
      claws_publish({ topic: 'worker.<peerId>.heartbeat',
                      payload: { current_phase: 'harvest',
                                 note: `${m[1]} done (${completed.size}/${EXPECTED.size})` } });
    }
  }
}
// --- end wait loop ---

// Final gate — must be green before wave_complete
npm run build && npm test

// LEAD complete: publish event FIRST, then call wave_complete, THEN print sentinel
claws_publish({ topic: 'wave.<waveId>.lead.complete',
                payload: { waveId, status: 'ok', commits: [...], regression_clean: true } })
claws_wave_complete({ waveId: '<waveId>', summary: '...', commits: [...], regressionClean: true })

// Print the LEAD sentinel ONLY AFTER wave_complete returns:
// LEAD_COMPLETE_<waveId>
```

## Step 5 — Cleanup

```
# Close all sub-worker terminals (terminal_ids came from claws_fleet in Step 2)
for (const tid of terminal_ids) { claws_close({ id: tid }) }
claws_lifecycle_reflect({ reflect: '<retrospective>' })
```

## Discipline reminders

- `capabilities: ['push']` required in `claws_hello` — without it `claws_publish` is silently dropped
- Heartbeat every 20 s — publish `worker.<peerId>.heartbeat` (peerId from hello response)
- NEVER commit with `--no-verify`
- TESTER's green is required before final commit
- REVIEWER CRITICAL/HIGH findings must be addressed before wave.complete
- Print the LEAD sentinel ONLY AFTER `claws_wave_complete` returns — not before
