---
name: claws-wave-subworker
description: Sub-worker discipline contract for Claws Wave Army. Covers registration, heartbeat, phase events, and completion sequence.
type: skill
---

# Skill: claws-wave-subworker

You are a **sub-worker** in a Claws Wave Army. Your role is one of: `tester` | `reviewer` | `auditor` | `bench` | `doc`.

## Universal contract

| Rule | Requirement |
|---|---|
| Register | `claws_hello` with `waveId` + `subWorkerRole` + `capabilities:['push']` within 60 s |
| Boot event | Publish `wave.<waveId>.<role>.boot` immediately after hello |
| Heartbeat | Publish `worker.<peerId>.heartbeat` every 20 s — server violation at 25 s |
| Phase events | Publish `worker.<peerId>.phase` on every lifecycle transition |
| Error events | Publish `worker.<peerId>.event` kind=ERROR for any blocking failure |
| No --no-verify | Every commit must pass pre-commit hooks |
| Full suite | `npm test` before every commit — zero failures required |
| Type gate | `npx tsc --noEmit` after every `.ts` edit |
| Complete event | Publish `wave.<waveId>.<role>.complete` as **absolute final act** before sentinel |
| Sentinel order | Print role sentinel ONLY AFTER the complete event is published |

> **capabilities:['push'] is mandatory** — without it `claws_publish` is silently rejected (BUG-03). Pass it in the initial `claws_hello`.

## Boot sequence

```
0. Arm Monitor on .claws/events.log via Bash run_in_background BEFORE any other action
1. claws_hello({ role:'worker', peerName:'<waveId>-<role>', waveId, subWorkerRole:'<role>', capabilities:['push'] })
   // Save returned peerId — use it for all subsequent publish topics (worker.<peerId>.*)
2. Publish wave.<waveId>.<role>.boot
3. Start heartbeat: publish worker.<peerId>.heartbeat every 20 s
4. Begin role-specific work; publish worker.<peerId>.phase on every lifecycle transition
5. Publish wave.<waveId>.<role>.complete  ← FINAL act before sentinel
6. Print role sentinel (e.g. ROLE_COMPLETE_<slug>)  ← ONLY after complete event published
7. Stop heartbeat
8. Close terminal
```

## Role-specific contracts

**TESTER**: write failing tests first (RED phase), then re-run after LEAD commits (GREEN).
**REVIEWER**: read-only. Publish `wave.<waveId>.review.finding` per issue. CRITICAL/HIGH must be addressed.
**AUDITOR**: read-only. Sweep for race conditions, schema mismatches, error gaps, security issues.
**BENCH**: run performance benchmarks after GREEN. Compare against baseline.
**DOC**: update CHANGELOG, gap docs, template files. Never modify source `.ts` files.

## Schemas used

- `WorkerHeartbeatV1`, `WorkerPhaseV1`, `WorkerEventV1`
- `WaveTesterRedCompleteV1`, `WaveReviewFindingV1`, `WaveAuditFindingV1`, `WaveBenchMetricV1`, `WaveDocCompleteV1`

## References

- `extension/src/event-schemas.ts`
- `extension/src/wave-registry.ts`
- `.claude/skills/claws-wave-lead/SKILL.md`
