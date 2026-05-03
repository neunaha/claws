# Skill: claws-wave-subworker

You are a **sub-worker** in a Claws Wave Army. Your role is one of: `tester` | `reviewer` | `auditor` | `bench` | `doc`.

## Universal sub-worker contract

Every sub-worker MUST follow these rules regardless of role:

| Rule | Requirement |
|---|---|
| Register | `claws_hello` with `waveId` + `subWorkerRole` + `capabilities:['push']` within 60 s |
| Boot event | Publish `wave.<waveId>.<role>.boot` immediately after hello |
| Heartbeat | Publish `worker.<peerId>.heartbeat` every 20 s — server violation at 25 s |
| Phase events | Publish `worker.<peerId>.phase` on every lifecycle transition |
| Error events | Publish `worker.<peerId>.event` kind=ERROR for any blocking failure |
| No --no-verify | Every commit must pass pre-commit hooks |
| Full suite | Run `npm test` before every commit — zero failures required |
| Type gate | Run `npx tsc --noEmit` after every `.ts` edit |
| Complete event | Publish `wave.<waveId>.<role>.complete` as **absolute final act** before printing sentinel |
| Sentinel order | Print role sentinel ONLY AFTER the complete event is published — not before |
| Close terminal | Close your own terminal after printing sentinel |

> **capabilities:['push'] is mandatory** — without it `claws_publish` calls are silently rejected by the
> server (BUG-03 workaround until the server-side fix lands). Pass it in the initial `claws_hello` call.

## Role-specific contracts

### TESTER
- **Phase: RED** — write failing tests first. Tests MUST fail before implementation exists.
- **Phase: GREEN** — re-run after LEAD commits; assert all tests pass.
- Schema: `WaveTesterRedCompleteV1` for red phase report.
- Owns: `extension/test/claws-wave-lifecycle.test.js` (and any new test files).

### REVIEWER
- Read-only role — never modify source files, never commit.
- Read `git diff HEAD~1..HEAD` after each LEAD commit.
- Publish `wave.<waveId>.review.finding` (WaveReviewFindingV1) for each issue found.
- Severity: CRITICAL | HIGH | MEDIUM | LOW.
- LEAD must address CRITICAL and HIGH before final commit.

### AUDITOR
- Read-only role — never modify source files, never commit.
- Sweep for: race conditions, schema mismatches, error handling gaps, regression risks, security issues.
- Publish `wave.<waveId>.audit.finding` (WaveAuditFindingV1) for each finding.
- Categories: `race_condition` | `schema` | `error_handling` | `regression` | `security`.

### BENCH
- Read-only role — runs performance benchmarks after GREEN phase.
- Publish `wave.<waveId>.bench.metric` (WaveBenchMetricV1) for each metric.
- Compare against baseline if available.

### DOC
- Docs-only role — updates CHANGELOG, gap docs, template files.
- Never modifies source (`.ts`) files.
- Publish `wave.<waveId>.doc.complete` (WaveDocCompleteV1) listing files updated.

## Boot sequence

```
0. Arm Monitor on .claws/events.log via Bash run_in_background BEFORE any other action:
   Bash(command="tail -F .claws/events.log", run_in_background=true, description="Claws bus push events")
1. claws_hello({ role: 'worker', peerName: '<waveId>-<role>', waveId, subWorkerRole: '<role>', capabilities: ['push'] })
   // capabilities:['push'] is required — BUG-03 workaround; without it claws_publish is silently rejected
   // Save the returned peerId — use it for all subsequent publish topics (worker.<peerId>.*)
2. Publish wave.<waveId>.<role>.boot
3. Start heartbeat loop — publish worker.<peerId>.heartbeat every 20 s
   // Use peerId (not role name) in the heartbeat topic — this is what resets the server violation timer
4. Begin role-specific work; publish worker.<peerId>.phase on every lifecycle transition
5. Publish phase events as work progresses
6. Publish wave.<waveId>.<role>.complete  ← FINAL act before sentinel
7. Print role sentinel (e.g. ROLE_COMPLETE_<slug>)  ← ONLY after complete event published
8. Stop heartbeat loop
9. Close terminal
```

## Schemas used

- `WorkerHeartbeatV1` — every 20 s
- `WorkerPhaseV1` — phase transitions
- `WorkerEventV1` — errors and progress
- `WaveTesterRedCompleteV1` (tester) — red phase done
- `WaveReviewFindingV1` (reviewer) — each finding
- `WaveAuditFindingV1` (auditor) — each finding
- `WaveBenchMetricV1` (bench) — each metric
- `WaveDocCompleteV1` (doc) — docs update complete

## References

- `extension/src/event-schemas.ts` — all Zod schemas
- `extension/src/wave-registry.ts` — server violation detection
- `.claude/skills/claws-wave-lead/SKILL.md` — LEAD contract
- `.claude/skills/dev-protocol-piafeur/` — PIAFEUR loop
