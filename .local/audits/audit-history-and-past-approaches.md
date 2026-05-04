# Claws — Audit History & Past Approaches Catalog

**Date:** 2026-05-04
**Mission:** AUDITOR-HISTORY (fleet mission 66)
**Scope:** Completion mechanisms, mission injection patterns, policy enforcement chain,
slash command inventory, Wave Discipline Contract, F1/F2/F3 convention, prior audit
findings, lessons learned, cross-system requirements, open questions.

---

## Table of Contents

1. [Completion Mechanism Timeline](#1-completion-mechanism-timeline)
2. [Mission Text Injection Patterns](#2-mission-text-injection-patterns)
3. [CLAUDE.global.md Policy Enforcement](#3-claudeglobalmd-policy-enforcement)
4. [Slash Commands Inventory](#4-slash-commands-inventory)
5. [Wave Discipline Contract](#5-wave-discipline-contract)
6. [F1/F2/F3 Convention](#6-f1f2f3-convention)
7. [Past Audit Findings Recap](#7-past-audit-findings-recap)
8. [Lessons Learned](#8-lessons-learned)
9. [Cross-System Consistency Requirements](#9-cross-system-consistency-requirements)
10. [Open Questions](#10-open-questions)

---

## 1. Completion Mechanism Timeline

This section catalogs every approach the project has tried for detecting worker completion,
in chronological order. Each entry describes the mechanism, its failure modes, why it was
retired or kept, and the version it shipped or was dropped.

---

### Era 1: No Detection (pre-v0.4) — Polling the pty log by hand

**Mechanism:** The orchestrator (or the user) would manually call `claws_read_log` on a
worker terminal, scan the output for a known phrase ("done", "finished", or any ad-hoc
string), and declare the worker complete.

**How it worked:**
- `claws_read_log(id, offset, limit)` returns raw pty bytes with optional ANSI stripping.
- Caller inspects the `text` field for a terminal marker.
- No automation; every check was a manual orchestrator action.

**Failure modes:**
- Orthogonal to any pub/sub event system — orchestrators had no live push events.
- Manual polls could miss completion if the marker scrolled off the limit window.
- No timeout semantics — stuck workers required human intervention indefinitely.
- In wrapped terminals (via `script(1)`), log reads were delayed 1-2s due to buffering.

**Status:** Retired as primary mechanism; still available as a diagnostic fallback
in RECOVER phase when bus events are unavailable.

---

### Era 2: MISSION_COMPLETE marker convention (v0.4–v0.6)

**Mechanism:** Mission preambles were written to end with the instruction:
> `print MISSION_COMPLETE when done. go.`

The orchestrator polled `claws_read_log` on an interval (typically every 30s) and used
`text.includes('MISSION_COMPLETE')` to declare the worker done.

**How it worked:**
- Simple substring scan on pty bytes after ANSI stripping.
- Supported custom markers via `complete_marker` arg on `claws_worker` and `claws_fleet`
  (added v0.7.x; earlier releases used only the hardcoded `MISSION_COMPLETE` string).
- The marker doubled as a Bash printf to write to pty stdout: `printf '%s\n' 'MISSION_COMPLETE'`.

**Failure modes:**
- **Polling is anti-architecture.** No push delivery; each poll call blocks the MCP stdio
  transport for the round-trip. Under fleet parallelism (N workers), polling N terminals
  every 30s occupies the orchestrator's full attention.
- **tail -F Monitor anti-pattern (see Era 4).** Wrapping the polling in `tail -F | grep`
  produced the `exit-144` (SIGURG) fragility.
- **Workers skip the marker (M15 incident).** Claude TUI workers write their Final Report as
  an assistant message, then stop — never issuing the `printf` Bash tool call. The mission
  preamble instruction is treated as guidance, not a hard ordering constraint.
- **False positive on marker echo.** If the mission preamble itself echoes the `complete_marker`
  string (for documentation), the `text.includes()` check fires immediately at mission-send
  time. BUG-30 in the consolidated registry.
- **Custom marker mismatch with `claws_dispatch_subworker`.** The sub-worker dispatch tool
  only accepted hardcoded `MISSION_COMPLETE`; orchestrators that injected custom markers into
  mission text found the sub-worker watcher never matched. Documented as Gap M18-A.

**Status:** Still in use as belt-and-suspenders layer alongside event-driven detection
(Eras 5–6). Not the primary completion signal as of v0.7.12.

---

### Era 3: claws/2 pub/sub `wave.<id>.<role>.complete` (v0.6.0 Wave Army)

**Mechanism:** Phase A/B of the claws/2 Agentic SDLC Protocol introduced a pub/sub bus.
Sub-workers were expected to publish `wave.<waveId>.<role>.complete` as their final act,
which the LEAD received via `claws_drain_events` and used to gate `claws_wave_complete`.

**How it worked:**
- Sub-workers call `claws_publish({ topic: 'wave.<waveId>.<role>.complete', payload: {...} })`.
- LEAD calls `claws_drain_events({ since_index: cursor, wait_ms: 15000 })` in a loop.
- Pattern-match on `evt.topic?.match(/^wave\.[^.]+\.(\w+)\.complete$/)`.
- When all manifest roles have published `.complete`, LEAD calls `claws_wave_complete`.

**Failure modes:**
- **BUG-03 (silent publish rejection).** Workers that call `claws_hello` without
  `capabilities: ['push']` have all `claws_publish` calls silently rejected by the server.
  No error returned; the publish JSON reads `{ ok: false }` but some callers didn't check.
  Workers would think they published; LEAD would never receive the `.complete` event.
  **Workaround (mandatory until server fix):** every sub-worker must include
  `capabilities: ['push']` in their `claws_hello` call.
- **BUG-10 (LEAD bails early).** The original drain-and-wait loop used a single
  `claws_wave_status` call and called `claws_wave_complete` based on whatever fraction of
  roles had published at that moment. If the LEAD's own context clock ran out, it would
  exit before sub-workers finished, leaving the wave stuck in "open" state indefinitely.
  **Fix (BUG-10 fix in `claws-wave-lead.md`):** drain-and-wait loop with 20-minute hard
  timeout and per-drain 15s `wait_ms`, tracking which roles have posted.
- **BUG-01 (duplicate events on drain).** Every event in the drain response appeared twice
  when the orchestrator held multiple overlapping subscriptions. Event deduplication by
  `absoluteIndex` was missing; callers had to manually deduplicate. Led to double-counting
  completion events.
- **BUG-11 (schema validation rejects boot events).** Wave sub-worker boot events were
  rejected by the schema validator (missing `{v, id, from_peer, from_name, ts_published, schema}`
  envelope fields). Events still propagated but `system.malformed.received` fired for each
  publish, creating noise on the bus.

**Status:** Still the canonical completion mechanism for Wave Army mode. Hardened by the
BUG-10 fix in the `claws-wave-lead.md` command. BUG-03 workaround is mandatory.

---

### Era 4: tail -F Monitor on events.log (v0.7.0–v0.7.9)

**Mechanism:** The orchestrator would arm a background Monitor:
```
Bash(command="tail -F .claws/events.log", run_in_background=true)
```
The sidecar (`stream-events.js`) appended bus events to `.claws/events.log` as JSON lines.
Each line triggered a "Monitor event:" notification in the orchestrator's conversation context.

**How it worked:**
- SessionStart hook spawned `stream-events.js --auto-sidecar` as a daemon.
- Daemon subscribed to `**` topic wildcard, writing every push frame to the log file.
- `tail -F` observed file growth and surfaced each new line to the orchestrator.
- Per-worker pattern: `tail -F .claws/events.log | grep -m1 'MISSION_COMPLETE.*<tid>'`
  used `grep -m1` to self-exit on first match.

**Failure modes:**
- **SIGURG kill (exit 144) — the fundamental flaw.** Claude Code's background-process
  supervisor SIGURGs idle background processes. `tail -F` produces zero stdout during quiet
  bus periods. The supervisor classifies it as idle and sends SIGURG (~30s after last output),
  causing `exit 144`. Users see "Background command failed with exit code 144" — cosmetic but
  recurrent. Documented in `tail-f-sigurg-rootcause.md`.
- **Heartbeat spam on generic Monitor.** The unfiltered `tail -F .claws/events.log` fires on
  every heartbeat (every 1-5s), flooding the orchestrator's context with notifications.
  Documented as Bug A in `orchestrator-monitor-multi-bug-cascade.md`.
- **Sidecar process keeps the Monitor alive.** The stream-events.js sidecar emits constantly
  (heartbeats, tool.invoked/completed, system.metrics). A Monitor with a tight grep filter
  was not SIGURG'd because the upstream process produced output. But unfiltered `tail -F`
  could still die if the bus went quiet (e.g., no workers active).
- **Path resolution wrong in user installs (Bug C).** `monitor_arm_command` in the
  `claws_worker`/`claws_fleet` response referenced `<project>/scripts/stream-events.js` —
  a path that doesn't exist in user installs (the correct path is
  `<project>/.claws-bin/stream-events.js`). Fixed in v0.7.12 commit `91e6fc2`.
- **PreToolUse gate false-positive.** The gate checked `pgrep -f 'tail -F.*events\.log'`.
  When `tail -F` was SIGURG'd, the gate blocked the next spawn-class MCP call until the user
  re-armed the Monitor. Documented in `tail-f-sigurg-rootcause.md`.

**Status:** `tail -F` as sole Monitor mechanism was retired in v0.7.10. Still emitted in
`monitor_arm_command` responses for backward compat. The PreToolUse gate was updated in
v0.7.12 Wave C to check for `stream-events.js` instead of `tail -F` (Wave C SIGURG fix).

---

### Era 5: Per-worker bus-stream Monitor (v0.7.10 Wave B)

**Mechanism:** After each `claws_fleet`/`claws_worker` call, the orchestrator arms one
Monitor per returned `terminal_id`, using the bus-stream sidecar as the source:
```
Bash(command="CLAWS_TOPIC='**' ... node .claws-bin/stream-events.js | grep --line-buffered -m1 'system\\.worker\\.completed.*<tid>'",
     run_in_background=true, description="watch worker-<tid>")
```
`grep -m1` causes each Monitor to self-exit on first match. Per-worker isolation means one
dead Monitor doesn't blind the orchestrator to remaining workers.

**How it worked:**
- `stream-events.js` subscribes to the claws/2 bus; the bus emits constantly (heartbeats
  every ≤20s, tool events, system metrics). The Monitor process is never idle → no SIGURG.
- `grep -m1` matches the first `system.worker.completed` or `system.worker.terminated`
  event carrying the target `terminal_id`. grep exits → SIGPIPE closes stream-events.js →
  Monitor self-exits cleanly.
- `correlation_id` field (Wave A D+F) allows filtering to one worker's events even in a
  multi-worker fleet.

**Failure modes:**
- **`system.worker.completed` silently dropped (H1 in lifecycle-silent-mutation-trace.md).**
  The `_pconnWrite` path for publishing `system.worker.completed` is inside a try/catch that
  logs and continues. If `_pconn` (the persistent pub/sub socket) is disconnected (e.g.,
  circuit breaker, extension restart), the event is silently dropped. `lifecycle.mark-worker-status`
  still succeeds via an ephemeral `clawsRpc` connection, so the lifecycle-state.json file
  shows `status:closed` but the bus stays silent. Monitors waiting on
  `system.worker.completed` are permanently blind.
- **`system.worker.terminated` never fires on programmatic close (H2).**
  `TerminalManager.close()` deletes the terminal from `byTerminal` map BEFORE calling
  `terminal.dispose()`. VS Code's async `onDidCloseTerminal` fires after the map entry is
  gone → `onTerminalClosed()` returns early → `onTerminalClose` callback (which emits
  `system.worker.terminated`) is never called. Every `claws_close` / `claws_worker`
  auto-close loses the terminated event. Documented in `lifecycle-silent-mutation-trace.md`.
- **`emitSystemEvent` drops all events when event log is degraded (H3).**
  `server.ts:305`: `if (this.eventLog.isDegraded) return` — no `fanOut`, no bus delivery.
  All `system.worker.*` events silently vanish if the log failed to open at startup.

**Status:** Current preferred mechanism. Still subject to H1/H2/H3 failure modes that
are tracked as open bugs. v0.7.12 disarmed L8 (tui_idle auto-close) to prevent false
positives from destructive auto-close of long-thinking workers.

---

### Era 6: WorkerHeartbeatStateMachine + tui_idle detection (v0.7.12)

**Mechanism:** A state machine (`WorkerHeartbeatStateMachine`) runs inside `mcp_server.js`
as part of the fast-path watcher. It parses pty log bytes in real time using parser
primitives (`parseToolIndicators`, `parsePromptIdle`, `parseCostLine`, `parseSpinnerFrame`,
`parseTodoWriteIndicators`, `parseErrorIndicators`) and emits typed heartbeat events:

| Kind | Trigger |
|---|---|
| `progress` | tool call detected, spinner observed, cost growing |
| `approach` | TodoWrite tool observed |
| `error` | Bash tool returned non-zero exit |
| `heartbeat` | backstop every 5s |
| `mission_complete` | POST_WORK state: ❯ prompt idle after work |

When the state machine reaches `POST_WORK` (TUI has returned to idle prompt after having
done work) it publishes `system.worker.completed` with `completion_signal:'tui_idle'`.
This solves Bugs D+E: workers that skip F3 and never exit still fire the completion event.

**How it worked:**
- State transitions: BOOTING → READY (bypass detected) → WORKING (first tool) → POST_WORK (❯ idle)
- Each state emits a `worker.<termId>.heartbeat` event on the bus.
- `parsePromptIdle` scans the last 10 lines of stripped pty output for the `❯` prompt
  character above the bypass-permissions footer (not in the footer itself — ANSI strip
  removes it). Fixed in v0.7.12 (`c83399d`).
- `parseToolIndicators` fixed: `\s+` → `\s*` to handle `⏺Bash(` with no space. Documented
  in `cascade-parser-mismatch.md` and fixed in commit `9643600`.
- **L8 DISARMED (commit `ed27870`).** The `tui_idle` signal was wired to emit
  `system.worker.completed` AND close the terminal. But long-thinking workers return to
  the ❯ prompt between tool calls (e.g., reading a file → prompting → reading another),
  causing false-positive auto-close of active workers. L8 now emits the heartbeat only
  (for observability) without closing the terminal.

**Failure modes:**
- **Post-L8-disarm: Bugs D+E reopen.** Without auto-close, the `system.worker.completed`
  event now only fires if the worker calls the F3 `printf` or if some other mechanism fires.
  Workers that sit at `❯` indefinitely after their last action never trigger `onDidCloseTerminal`.
  This is the fundamental chicken-and-egg documented in `orchestrator-monitor-multi-bug-cascade.md`.
- **READY→WORKING transition blocked by parser bug.** Original `\s+` regex never matched
  real TUI output → `toolCount` stayed 0 → state never left `READY`. Fixed by `\s*`.
- **Cascade fix (commit `3576942`).** READY→WORKING was guarded by `toolCount > 0` only at
  the current iteration. Fixed to fire on cumulative `toolCount`.

**Status:** Current. L8 disarmed, heartbeat observability live. Completion via tui_idle
disarmed for safety; Falls back to F3/Wave D paths.

---

### Era 6b: Wave D — onDidCloseTerminal → system.worker.terminated (v0.7.10)

**Mechanism:** When a wrapped terminal's `script(1)` process exits (i.e., Claude Code exits
the TUI for any reason), VS Code fires `onDidCloseTerminal`. The extension publishes
`system.worker.terminated` to the bus with the `terminal_id`. The fast-path watcher in
`mcp_server.js` receives `system.worker.terminated` and fires `system.worker.completed`
with `completion_signal:'terminated'`.

**Why this matters:** Even if F3 is skipped, workers that *do* exit cleanly still trigger
the event chain: `claude exits → onDidCloseTerminal → system.worker.terminated →
system.worker.completed`. This was the primary fix for Bug D (M15 marker skip).

**Failure modes:**
- **H2 in lifecycle-silent-mutation-trace.md.** `TerminalManager.close()` deletes
  `byTerminal` entry before `dispose()` fires, blocking the `onTerminalClosed` callback.
  So the `system.worker.terminated` event only fires for terminals that exit naturally
  (e.g., Claude exits), not for terminals closed programmatically via `claws_close`.
- **Gap M18-B.** `system.worker.terminated` doesn't call
  `lifecycleStore.markWorkerStatus(termId, 'terminated')`. Lifecycle store stays at
  `status='spawned'` even after terminal disappears.
- **Claude TUI doesn't auto-exit (Gap M18-C).** Claude's TUI is interactive by design —
  it waits at `❯` after each assistant message. `script(1)` only exits when Claude exits.
  Workers that finish their work but don't call `Bash(exit)` never trigger `onDidCloseTerminal`.

**Status:** Partially working for natural-exit workers. Broken for programmatically-closed
workers (H2). Waiting for the H2 fix in `terminal-manager.ts` (`close()` must call
`onTerminalClose` directly before map deletion).

---

## 2. Mission Text Injection Patterns

### 2.1 Mission text delivery

Missions are delivered to Claude TUI workers via the claws_worker 7-step boot sequence:

```
Step 1  claws_create name="worker-<slug>" wrapped=true
Step 2  claws_send id=<N> text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions"
Step 3  Poll claws_read_log every 5s until output contains "trust" (~20s)
Step 4  claws_send id=<N> text="1" newline=false
Step 5  Poll claws_read_log every 5s until output contains "bypass" (~10s)
Step 6  claws_send id=<N> text="<mission>" newline=false
Step 7  claws_send id=<N> text="\n" newline=false
```

Missions MUST be inline strings — not file references. The file-referrer pattern
(`Read /path/to/mission.md`) was dropped in v0.7.10 commit `70ec1b1` and is forbidden.
Missions must be self-contained so they survive without file I/O at boot time.

### 2.2 Mission structure conventions

Every mission dispatched to a worker MUST include:

1. **Role declaration** — who the worker is (LEAD/TESTER/REVIEWER/AUDITOR/DOC or single).
2. **Context** — what the project is, what the task is.
3. **Scope** — exact files to read/edit, boundaries not to cross.
4. **Wave Discipline Contract** (if Wave Army) — embedded verbatim from the SKILL.md.
5. **Final actions (F1/F2/F3)** — numbered Bash tool calls as a checklist.
6. **Completion sentinel** — `print MISSION_COMPLETE when done. go.` or wave equivalent.

### 2.3 F1/F2/F3 anti-orphan contract

Every worker mission MUST end with this exact checklist framed as explicit Bash tool calls:

```
## Final actions (strict order — execute as Bash tool calls, not as assistant messages)

Step F1: git status --short           (verify clean working tree)
Step F2: git log --oneline -5         (verify your commits landed)
Step F3: printf '%s\n' 'MARK_M??_OK_COLOR'  (REQUIRED — watcher completion signal)
```

Why it's a numbered checklist and not a prose request:
- Claude TUI workers that mentally complete the mission write the Final Report as an
  assistant message and stop. Framing F1/F2/F3 as *explicit Bash tool calls* forces
  the model to execute tool calls instead of narrating.
- The printf in F3 writes to pty stdout where the watcher can detect it. An assistant
  message is invisible to the pty scanner.

When workers skip F3 (M15 incident):
- Watcher reports `status=timeout` after `timeout_ms` has elapsed.
- This is misleading — the work may have succeeded 15min earlier.
- Wave D (Era 6b) is the primary fix; F1/F2/F3 is belt-and-suspenders.

### 2.4 Broadcast mission delivery (wave-army sub-workers)

Sub-worker missions include the Wave Discipline Contract verbatim:

```
### Wave Discipline Contract (MANDATORY)

1. claws_hello({ role: 'worker', peerName: '<role>', waveId: '<waveId>',
                 subWorkerRole: '<role>', capabilities: ['push'] })
   — capabilities:['push'] is REQUIRED (BUG-03 workaround)
2. Publish wave.<waveId>.<role>.boot immediately after hello
3. Publish worker.<peerId>.heartbeat every 20s (use peerId from hello, NOT role name)
4. Publish worker.<peerId>.phase on every lifecycle transition
5. Publish worker.<peerId>.event with kind=ERROR for any blocking failure
6. Publish wave.<waveId>.<role>.complete as ABSOLUTE FINAL ACT before sentinel
   — THEN print role sentinel (LEAD waits on this event)
```

### 2.5 [CLAWS_CMD] reverse channel

Workers that need orchestrator input publish `event.kind=BLOCKED` with a `request_id`.
The orchestrator broadcasts a command:
```
claws_broadcast(text="[CLAWS_CMD r=<request_id>] <action>: <json_payload>",
                targetRole="worker", inject=true)
```
Five standard actions: `approve_request`, `reject_request`, `abort`, `pause`, `resume`.
Workers ignore `[CLAWS_CMD]` lines whose `r` doesn't match their published `request_id`,
making fan-out safe in multi-worker sessions.

---

## 3. CLAUDE.global.md Policy Enforcement

### 3.1 What behaviors are mandated

`templates/CLAUDE.global.md` defines the machine-wide terminal policy. Key mandates:

**Terminal behavior:**
- NEVER use Bash for long-lived processes — use `claws_create` + `claws_send`.
- ALWAYS create wrapped terminals (`wrapped=true`).
- ALWAYS close every terminal created.
- NEVER touch terminals not created by the orchestrator.
- NEVER run Claude Code in headless/non-interactive mode.

**Worker boot sequence:** 7 exact steps in order (trust → bypass → mission). No shortcuts.

**Wave Discipline Contract:** 9 mandates for sub-workers (register, boot event, heartbeat
every 20s via `worker.<peerId>.*`, phase events, error events, no --no-verify, full suite
before commit, type check per .ts file, complete event before sentinel).

**Sidecar:** Always running when `.claws/claws.sock` exists. Auto-spawned by SessionStart hook.

**Monitor:** MUST be armed as FIRST ACTION before any spawn-class MCP call.

### 3.2 How the policy reaches the worker — the injection chain

The behavioral injection chain has 5 layers (outer layers are fallbacks for inner):

```
Layer 1 (Innermost — highest reliability):
  ~/.claude/CLAUDE.md — written by inject-global-claude-md.js from templates/CLAUDE.global.md
  → Auto-loaded by Claude Code on EVERY session in ANY directory.
  → Contains worker boot sequence, Wave Discipline Contract, F1/F2/F3, sidecar mandate, Monitor mandate.

Layer 2:
  <project>/CLAUDE.md CLAWS:BEGIN block — written by inject-claude-md.js from templates/CLAUDE.project.md
  → Auto-loaded by Claude Code on EVERY session in the project.
  → Contains tool lists (8 claws/1 + 23+ claws/2), slash command list, lifecycle phases,
    Wave Discipline Contract, Monitor arm instructions, dev-hooks discipline section.

Layer 3:
  SessionStart hook in ~/.claude/settings.json → session-start-claws.js
  → Fires when .claws/claws.sock is detected.
  → Emits lifecycle reminder as system-reminder; spawns stream-events.js sidecar.
  → Handles idempotency (pgrep check before re-spawn).

Layer 4:
  PreToolUse:Bash hook → pre-tool-use-claws.js
  → Blocks long-running Bash commands (servers, test watchers) when spawn-class tools are available.
  → Gates spawn-class MCP calls: must have sidecar alive (pgrep check) before `claws_worker/fleet/create`.
  → BUG-28 (open): hook is registered with matcher:"Bash" only — MCP tool calls bypass the gate entirely.
  → BUG-16/SIM2B-P2a: pattern matching is substring-based, not executable-token-based,
    causing false positives on legitimate read-only commands.

Layer 5 (Outermost — advisory):
  Stop hook → stop-claws.js
  → Warns on session end if terminals are still open.
  → Kills the stream-events.js sidecar (pgrep + kill -TERM).
```

### 3.3 The enforcement gap (lifecycle-enforcement-gap.md findings)

Audited 2026-04-22. Key findings:

- **CLAUDE.global.md and the injected CLAWS:BEGIN block are the only reliable delivery surfaces.**
  All other layers (rules/, skills/, hooks not yet registered) were either dead code or
  ECC-plugin-only.
- **Gap 1: `templates/CLAUDE.claws.md` was orphaned.** `inject-claude-md.js` never read
  the template — it hardcoded a weaker advisory block. Fixed in v0.7.x by switching
  `inject-claude-md.js` to read from `templates/CLAUDE.project.md`.
- **Gap 3: `.claude/rules/claws-default-behavior.md` is not auto-loaded by stock Claude Code.**
  Only ECC plugin users see it. Still true — the file is supplementary for ECC users only.
- **Gap 6: Zero hooks registered by Claws before v0.6.x.** Fixed in v0.7.x: SessionStart,
  PreToolUse, Stop hooks now registered by `inject-settings-hooks.js` from `install.sh`.
- **BUG-28 (open): PreToolUse matcher only covers "Bash".** MCP spawn-class tools bypass
  the Monitor-arm gate entirely.

### 3.4 Gaps still open as of v0.7.12

| Gap | Description | Status |
|---|---|---|
| BUG-28 | PreToolUse hook doesn't fire for MCP tools | OPEN — needs additional hook registrations in inject-settings-hooks.js |
| BUG-16 / SIM2B-P2a | PreToolUse pattern matching greps full command string, not executable token | OPEN |
| BUG-23 / BUG-22 | BUG-06 fix (heartbeat uses peerId not role name) not propagated to all templates/hooks | PARTIALLY FIXED — session-start-claws.js updated; templates partially updated |
| H2 lifecycle-silent-mutation | close() drops byTerminal before dispose → terminated event never fires | OPEN |
| H1 _pconn disconnect | system.worker.completed silently dropped when persistent socket down | OPEN |
| M18-B | system.worker.terminated doesn't update lifecycleStore | OPEN |
| M18-C | Claude TUI doesn't auto-exit | OPEN (architectural — requires mission preamble Bash(exit) convention or server-side kill-after-grace) |

---

## 4. Slash Commands Inventory

Every `/claws-*` command, what worker type it dispatches, mission shape, and completion expectations.

### /claws-do

**File:** `.claude/commands/claws-do.md`
**Worker type:** Routes based on input:
- One-shot shell command → `claws_exec` (no terminal; auto-managed)
- Mission for Claude worker → `claws_create` wrapped + 7-step boot

**Mission shape:** Free-form mission text ending with `print MISSION_COMPLETE when done. go.`
**Completion:** Poll `claws_read_log` every 10s; detect `MISSION_COMPLETE` in output.
**Key rule:** NEVER use Bash directly for any /claws-do request. NEVER spawn wrapped terminal
for shell commands — use `claws_exec` instead.

---

### /claws-go

**File:** `.claude/commands/claws-go.md`
**Worker type:** Claude Code worker via `claws_worker` (if MCP loaded) or raw socket calls.
**Mission shape:** `<user's text> print MISSION_COMPLETE when done. go.`
**Completion:** Manual poll via `claws_read_log` or Monitor.
**Key rule:** ALWAYS creates a visible terminal with Claude Code inside. No Bash fallback.
**Note:** Includes raw socket call recipes for when MCP tools are not loaded (new session).

---

### /claws-worker

**File:** `.claude/commands/claws-worker.md`
**Worker type:** Single Claude Code worker via `claws_worker` MCP tool (non-blocking by default).
**Mission shape:** Full mission text with completion sentinel. Returns `terminal_id` immediately.
**Completion:** `claws_workers_wait(terminal_ids=[terminal_id], timeout_ms=300000)`. Falls
back to `.local/audits/` file read for ground truth (always written to disk).
**Key rule:** `claws_worker` bundles the full 7-step boot. Never manually boot when tool is available.

---

### /claws-fleet

**File:** `.claude/commands/claws-fleet.md`
**Worker type:** N parallel Claude Code workers via `claws_fleet` (non-blocking).
**Mission shape:** JSON array of `{name, mission}` objects. Each worker gets its own terminal.
**Completion:** `claws_workers_wait(terminal_ids=[...], timeout_ms=300000)`.
Per-worker result aggregation (ok/failed counts, wall-clock timing).
**Key rule:** Wall-clock completion ≈ max(individual times), not sum (true parallel).

---

### /claws-army

**File:** `.claude/commands/claws-army.md`
**Worker type:** Full Wave Army — LEAD + TESTER + REVIEWER + AUDITOR + DOC (5 roles).
**Mission shape:** Each sub-worker mission MUST embed the Wave Discipline Contract verbatim.
**Dispatch:** `claws_fleet` (NOT `claws_dispatch_subworker` — BUG-08/09).
**Completion:** LEAD's drain-and-wait loop (BUG-10 fix). Hard timeout: 20 minutes.
LEAD calls `claws_wave_complete` after all roles publish `.complete`.
**Key rule:** Sub-workers use `claws_fleet`; `claws_dispatch_subworker` is serial (BUG-08)
and has no auto-close watcher (BUG-09).

---

### /claws-streaming-worker

**File:** `.claude/commands/claws-streaming-worker.md`
**Worker type:** Single Claude Code worker that publishes typed `EnvelopeV1` events via
the claws/2 pub/sub bus (not just pty output).
**Mission shape:** Template 8 from `/prompt-templates` — includes full event SDK invocation
patterns (`claws-sdk.js publish phase/heartbeat/event/complete`).
**Completion:** Bus events: `worker.<peerId>.complete` with `result=ok/failed`.
**Key rule:** Requires env vars (`CLAWS_PEER_ID`, `CLAWS_TERMINAL_ID`) pre-set in worker
terminal before mission is sent. Orchestrator must call `claws_hello` to get `peerId`.

---

### /claws-wave-lead

**File:** `.claude/commands/claws-wave-lead.md`
**Worker type:** LEAD sub-worker in a Wave Army (activated inside a worker terminal).
**Mission shape:** PIAFEUR implementation loop (Plan→Implement→Audit→Fix→Evaluate→Update→Repeat).
**Completion:** LEAD calls `claws_wave_complete` after drain-and-wait loop confirms all roles.
Publishes `wave.<waveId>.lead.complete` FIRST, then calls `claws_wave_complete`, then prints
sentinel (`LEAD_COMPLETE_<waveId>`).

---

### /claws-broadcast

**File:** `.claude/commands/claws-broadcast.md`
**Worker type:** Orchestrator-to-worker reverse channel (no new worker spawned).
**Mission shape:** `[CLAWS_CMD r=<request_id>] <action>: <json_payload>`.
Used to unblock workers that published `kind=BLOCKED` with a `request_id`.

---

### /claws-cleanup

**File:** `.claude/commands/claws-cleanup.md`
**Worker type:** No worker spawned — orchestrator-side cleanup.
**Action:** `claws_list` → close every terminal in the owned list → verify zero orphans.

---

### /claws-exec

**File:** `.claude/commands/claws-exec.md`
**Worker type:** No persistent terminal — `claws_exec` runs command, returns output + exitCode.
**Completion:** Immediate (synchronous result in tool response).

---

### /claws-status

**File:** `.claude/commands/claws-status.md`
**Worker type:** No worker. Calls `claws_list` and formats as a dashboard.

---

### /claws-introspect

**File:** `.claude/commands/claws-introspect.md`
**Worker type:** No worker. Calls `claws_lifecycle_snapshot` for structured runtime state.

---

### /claws-plan

**File:** `.claude/commands/claws-plan.md`
**Worker type:** No worker. Calls `claws_lifecycle_plan` to record the plan.

---

### /claws-read

**File:** `.claude/commands/claws-read.md`
**Worker type:** No worker. Calls `claws_read_log` with progressive offset.

---

### /claws-send

**File:** `.claude/commands/claws-send.md`
**Worker type:** No worker. Calls `claws_send` for direct text injection.

---

### /claws-create

**File:** `.claude/commands/claws-create.md`
**Worker type:** No worker. Calls `claws_create` to open a terminal.

---

### /claws-help, /claws-learn, /claws-report, /claws-update, /claws-setup, /claws-install, /claws-boot, /claws-watch, /claws-connect

These are utility/doc/setup commands. None dispatch workers. They provide help text,
install/update guidance, and diagnostic views.

---

## 5. Wave Discipline Contract

### 5.1 Sub-worker obligations (9 mandatory items)

When a worker receives a Wave Army mission, it MUST:

1. **Register** — call `claws_hello` with `waveId`, `subWorkerRole`, AND
   `capabilities: ['push']` within 60 seconds of boot.
   - `capabilities: ['push']` is the BUG-03 workaround. Without it, every
     `claws_publish` call is silently rejected with `{ ok: false }`.
   - The `capabilities` field does NOT cause re-registration issues; the first
     `claws_hello` result's `peerId` is the canonical peer identifier.

2. **Boot event** — publish `wave.<waveId>.<role>.boot` immediately after hello.

3. **Heartbeat every 20s** — publish `worker.<peerId>.heartbeat` using the `peerId`
   returned by `claws_hello`, NOT the role name.
   - BUG-06: Role-name topics (`worker.<roleName>.heartbeat`) do NOT reset the server-side
     violation timer. Only `worker.<peerId>.*` topics reset it.
   - Violation timer is 25s. First heartbeat must arrive within 25s of boot.

4. **Phase events** — publish `worker.<peerId>.phase` on every lifecycle transition
   (PLAN→SPAWN→DEPLOY→OBSERVE→RECOVER→HARVEST→CLEANUP→REFLECT).

5. **Error events** — publish `worker.<peerId>.event` with `kind=ERROR` for any blocking
   failure. Never swallow errors silently.

6. **No --no-verify** — every commit MUST pass pre-commit hooks. `--no-verify` is forbidden.

7. **Full suite before every commit** — run `npm test` (or equivalent); assert zero failures.

8. **Type check per .ts file** — run `npx tsc --noEmit` after editing any TypeScript;
   fix all errors before proceeding.

9. **Complete event** — publish `wave.<waveId>.<role>.complete` as the ABSOLUTE FINAL ACT
   before printing the role sentinel.
   - Print the role sentinel ONLY AFTER the complete event is published.
   - The LEAD waits on this event via `claws_drain_events`. If the sentinel appears before
     the event, the LEAD may time out.

### 5.2 LEAD obligations (additional to sub-worker)

- Call `claws_wave_create` on boot, `claws_wave_complete` after all sub-workers complete.
- Publish `wave.<waveId>.lead.boot` (WaveLeadBootV1) and `wave.<waveId>.lead.complete` (WaveLeadCompleteV1).
- Own the final `git commit`; may NOT commit until TESTER confirms green.
- Use drain-and-wait loop with 20-min hard timeout (BUG-10 fix) to collect all role completions.

### 5.3 Violation timer mechanics

The server-side wave registry fires a `wave.<waveId>.violation` event for any role that
is silent for > 25 seconds. Key behavior:
- Timer starts when `claws_wave_create` is called — NOT when the role first boots.
- This means sub-workers that take > 25s to boot violate before they can heartbeat (BUG-02).
- **Workaround:** Orchestrator ignores violation events during the first 60s after dispatch.
- **Real fix (deferred):** Start violation timer only when first heartbeat received from the role,
  or raise grace period to 60s.

### 5.4 BUG-03 workaround — why `capabilities: ['push']` is required

The server's publish handler checks `requireCapability(peer, 'publish')`. Worker peers
that call `claws_hello` without `capabilities: ['push']` in the `capabilities` array are
classified as unable to publish. All subsequent `claws_publish` calls return
`{ ok: false, error: 'capability:required' }` silently (caller sees no exception unless
it checks the return value).

The workaround: include `capabilities: ['push']` in every `claws_hello` call from sub-workers.
This field is accepted server-side and marks the peer as publish-capable.

### 5.5 Dispatch method: claws_fleet, NOT claws_dispatch_subworker

**BUG-08:** `claws_dispatch_subworker` is synchronous/serial. Each call blocks ~27s before
returning. Four dispatches = 108s. All roles violate the 25s timer before any can boot.

**BUG-09:** `claws_dispatch_subworker` has no auto-close watcher. Sub-worker terminals stay
open after mission completion unless wave.complete harvest runs the close.

**Fix:** Use `claws_fleet` for Wave Army dispatch. `claws_fleet` returns immediately with all
`terminal_ids`; workers boot in parallel. The `claws-army.md` command explicitly says:
> Use `claws_fleet`, NOT `claws_dispatch_subworker`.

---

## 6. F1/F2/F3 Convention

### 6.1 Origin

Discovered during M15 dispatch (Wave C SIGURG fix, ~2026-05-03). The worker completed all
mission work successfully (10 lines changed, new test file, 71 suites green, commit landed)
but never printed `printf '%s\n' 'MARK_M15_OK_GREEN'`. The watcher fired
`system.worker.completed` with `status=timeout` after 25min, reporting the mission as a
timeout when it had actually succeeded ~15min earlier.

Root cause: The `printf` marker is a Bash tool call. When a Claude TUI worker mentally
completes the mission and begins writing the Final Report as an assistant message, it stops
issuing tool calls. The `printf` never runs; the watcher never sees it.

Documented in `m15-marker-skip-gap.md`.

### 6.2 Rationale

**The F1/F2/F3 convention is the belt-and-suspenders layer over Wave D.**

Wave D (`onDidCloseTerminal → system.worker.terminated`) is the primary fix: it makes
completion event-driven regardless of worker discipline. F1/F2/F3 reduces the skip rate
for workers that DO exit cleanly but haven't triggered Wave D (e.g., workers that sit at `❯`).

Why framing as numbered Bash tool calls reduces skip rate:
- Claude's behavior when given a "print this string when done" instruction: often substitutes
  an assistant-message-only narration.
- Claude's behavior when given a numbered checklist of explicit "execute this Bash command":
  more likely to issue the tool call, because the task framing distinguishes narration from
  execution.
- The rationale for each step (F1 → F2 → F3) helps the model understand *why* F3 is load-
  bearing: "the watcher scans pty output, not conversation text."

### 6.3 Exact convention

```
## Final actions (strict order — execute as Bash tool calls)

F1: git status --short          (verify clean working tree)
F2: git log --oneline -5        (verify your commits landed)
F3: printf '%s\n' 'MARK_M??_OK_COLOR'   (REQUIRED — watcher completion signal)
```

The marker pattern is `MARK_M<number>_OK_<COLOR>` where number is the mission number and
color is a mnemonic (GREEN, BLUE, RED, etc.) for easy visual scanning in pty logs.

### 6.4 When workers skip F3 (M15 pattern)

Frequency observed: 3 out of ~20 worker dispatches across the v0.7.10 validation session.
Two were due to shell errors (not Claude skipping); one was the pure M15 skip.

The watcher's behavior:
1. If F3 fires: `system.worker.completed` with `completion_signal:'marker'` — correct.
2. If F3 is skipped but terminal exits: Wave D fires `system.worker.terminated` →
   watcher fires `system.worker.completed` with `completion_signal:'terminated'`.
3. If F3 is skipped AND terminal doesn't exit (Claude sits at `❯`): watcher fires
   `system.worker.completed` with `completion_signal:'timeout'` after `timeout_ms`.

With L8 disarmed (v0.7.12 commit `ed27870`), case 3 is the current failure path for
workers that do their work but don't exit.

### 6.5 Relation to the anti-orphan completion contract in this mission

The anti-orphan contract in this mission's instructions:
```
F1: ls -la .local/audits/audit-history-and-past-approaches.md && wc -l ...
F2: git log --oneline -3
F3: printf '%s\n' 'AUDIT_HISTORY_OK'
```

This follows the exact F1/F2/F3 shape — a numbered checklist with explicit Bash tool call
instructions, where F3 is the pty-visible completion sentinel.

---

## 7. Past Audit Findings Recap

### 7.1 lifecycle-enforcement-gap.md (2026-04-22)

**What it found:**
- Claws behavioral injection was advisory wallpaper, not enforcement.
- Claude Code auto-loads exactly 2 things: `<project>/CLAUDE.md` and `~/.claude/CLAUDE.md`.
  All other files (rules/, skills/, lifecycle.yaml) were invisible to stock Claude Code.
- The CLAWS:BEGIN block was advisory (bulleted list with soft verbs), not imperative.
- Zero hooks registered by Claws (no SessionStart, PreToolUse, Stop).
- `~/.claude/CLAUDE.md` didn't exist (no global policy).
- `templates/CLAUDE.claws.md` was orphaned — never read by inject-claude-md.js.

**What was fixed:**
- inject-claude-md.js rewritten to read from `templates/CLAUDE.project.md` (imperative copy).
- `inject-global-claude-md.js` added to write `~/.claude/CLAUDE.md` from `templates/CLAUDE.global.md`.
- `inject-settings-hooks.js` added to register SessionStart, PreToolUse, Stop hooks.
- `install.sh` wired to call all three injectors.
- `templates/CLAUDE.global.md` contains the full machine-wide policy (worker boot, Wave Discipline,
  F1/F2/F3, sidecar, Monitor mandates).

**Still pending:**
- BUG-28: PreToolUse matcher only covers "Bash" — MCP tools bypass the gate.
- BUG-16: Pattern matching is substring-based, not executable-token-based.
- BUG-29: Monitor not lifecycle-bound (no naming convention for stale detection).

---

### 7.2 cascade-parser-mismatch.md (2026-05-04)

**What it found:**
- `parseToolIndicators` regex used `\s+` (one or more whitespace) between `⏺` and tool name.
- Claude TUI renders `⏺Bash(args)` — no whitespace between `⏺` and tool name.
- Result: `toolCount` stayed 0 forever; state machine never left `READY`.
- READY→WORKING transition was permanently blocked: `heartbeats` fired, but `current_action`
  never advanced.

**Evidence:** Hex proof — U+23FA `⏺` (3 bytes: `e2 8f ba`) immediately followed by `42 61 73 68` = `Bash`.
No whitespace byte between them. Out of 124 `⏺` occurrences in a 271KB log: 5 were actual
tool calls, 104 were spinner frames, 15 were other.

**Fix applied:** `\s+` → `\s*` in commit `9643600`. Change is safe — spinner frames
(`⏺\r\n✳…`) don't match because `✳` is not `[\w]`; status lines (`⏺Error: ...`) don't
match because no `(` follows `Error`.

**Secondary finding:** Captured arg strings are corrupted by column-wrap `\r` sequences.
Tool NAME is correct; args are garbled. Pre-existing limitation of single-pass ANSI stripping.

---

### 7.3 lifecycle-silent-mutation-trace.md (2026-05-04)

**What it found:** Three independent failure modes causing `system.worker.completed` /
`system.worker.terminated` to be silently dropped:

**H1 (Highest likelihood):** `_pconn` disconnected → `_pconnWrite` for
`system.worker.completed` fails in a try/catch that logs-and-continues. `clawsRpc`
(ephemeral socket, fresh per call) succeeds for `lifecycle.mark-worker-status`.
Observable symptom: lifecycle-state.json shows `status:closed`, zero bus events.

**H2 (Structural, confirmed):** `TerminalManager.close()` deletes `byTerminal[terminal]`
BEFORE calling `terminal.dispose()`. VS Code's async `onDidCloseTerminal` fires after
deletion → `onTerminalClosed()` sees undefined → returns early → `onTerminalClose` callback
(which would emit `system.worker.terminated`) is never reached. Every programmatic close
loses the terminated event. This is independent of socket state.

**H3 (Secondary):** `emitSystemEvent` guards on `this.eventLog.isDegraded` — if the event
log failed at startup, ALL `emitSystemEvent` calls silently return. Compare `emitServerEvent`
which always calls `fanOut()`.

**Recommended fixes:**
- H1: publish `system.worker.completed` via retry queue or `clawsRpcStateful` when `_pconn` down.
- H2: call `this.onTerminalClose(key, rec.wrapped)` directly inside `close()` before map deletion.
- H3: change `emitSystemEvent` to always call `fanOut()` even on log degradation (like `emitServerEvent`).

---

### 7.4 m15-marker-skip-gap.md (2026-05-03)

**What it found:** Claude TUI workers frequently skip the `printf` marker. The convention
is pull-based (worker must remember) not push-based (automatic on exit). Contradicts
ARCHITECTURE.md principle P1 (event-driven, never polling).

**Fix:** Wave D (`onDidCloseTerminal → system.worker.terminated`) as primary fix.
F1/F2/F3 framing as numbered Bash tool call checklist as belt-and-suspenders.

**Action taken:** Both fixes shipped (Wave D in v0.7.10; F1/F2/F3 documented in templates).
L8 tui_idle detection added in v0.7.12 as additional path (but disarmed for auto-close to
prevent false positives on long-thinking workers).

---

### 7.5 m18-wave-army-gaps.md (2026-05-03)

**Gap M18-A:** `claws_dispatch_subworker` doesn't accept `complete_marker`. Default watcher
uses hardcoded `MISSION_COMPLETE`. Sub-worker missions with custom markers never trigger
auto-close. Workaround: sub-workers must print `MISSION_COMPLETE` (not custom markers).

**Gap M18-B:** Wave D `system.worker.terminated` doesn't flip `lifecycle.workers[].status`.
After terminal disappears, `lifecycle.snapshot.spawned_workers` still shows `status='spawned'`.

**Gap M18-C:** Claude TUI workers don't auto-exit at end-of-mission. They sit at `❯` waiting
for next input. `script(1)` only exits when Claude exits → `onDidCloseTerminal` never fires.
Options: (a) mission preamble `Bash(exit)` convention, (b) server-side kill-after-grace timer.

---

### 7.6 tail-f-sigurg-rootcause.md (2026-05-03)

**What it found:** `tail -F .claws/events.log` is SIGURG'd by Claude Code's background-
process supervisor within ~30s of no output. Exits with code 144. Users see recurring
"Background command failed with exit code 144" task-notifications. Cosmetic but degrades trust.

**Root cause chain:**
1. PreToolUse gate checks `pgrep -f 'tail -F.*events.log'`.
2. Orchestrator arms `tail -F` to pass the gate.
3. If no workers emit events within ~30s, SIGURG kills it.
4. User sees notification; gate blocks next spawn until re-armed.

**Wave C fix (shipped in v0.7.12 commit `91e6fc2`):** PreToolUse gate updated to check
`pgrep -f 'stream-events.js'` instead of `tail -F`. The sidecar emits constantly
(heartbeats, tool events) so it's never SIGURG'd.

---

### 7.7 orchestrator-monitor-multi-bug-cascade.md (2026-05-03)

**Five bugs converging on "orchestrator can't detect worker completion":**

- **Bug A:** Generic Monitor (`tail -F` unfiltered) fires on every heartbeat → notification spam.
- **Bug B:** `tail -F` SIGURG'd even under active bus traffic (~60-90s wall clock, not just quiet periods).
- **Bug C:** `monitor_arm_command` path wrong in user installs (`scripts/` vs `.claws-bin/`). Fixed in v0.7.12.
- **Bug D (M15 marker skip):** Worker finishes, sits at `❯`, never prints marker → no completion event.
- **Bug E (M18-C TUI doesn't exit):** Wave D safety net (`onDidCloseTerminal`) never fires because Claude TUI doesn't auto-exit.

**When all five fail:** Orchestrator has zero event-driven completion signal, falls back to
file-watching (`until [ -f deliverable_file ]; do sleep 5; done`) — works but anti-architecture.

**P0 priority fix for Bugs D+E:** Make workers exit cleanly at end of mission. Options:
- Mission preamble `Bash(exit)` as explicit final action.
- Server-side kill-after-grace timer.
- Heuristic idle detection POST-mission (distinct from the rejected M15 pre-mission idle).

---

### 7.8 regression-master-issues.md (2026-04-29)

**26 findings in 4 wave audits. Severity summary:**
- 1 CRITICAL (data loss) — M-01: `install.sh` awk strips non-Claws `source .*/shell-hook.sh` lines from user dotfiles.
- 2 CATASTROPHIC (silent config wipe) — M-02 (`.mcp.json`), M-03 (`~/.claude/settings.json`) parse failures overwrite with `{}`.
- 8 HIGH (silent lifecycle breaks) — wrong-arch pty.node, hook silent skip (M-04/07/08/09/10/11), extension cleanup race.
- 11 MEDIUM — race windows, latency.
- 4 LOW — cosmetic.

**Critical fixes shipped:** M-01 awk anchored; M-02/M-03 JSONC-safe parsing; M-04 error logging; M-06 safety guard; M-07/M-08/M-09/M-10/M-11 hardened.

---

### 7.9 v0710-army-bugs.md — Consolidated Bug Registry

**P0/P1 bugs from the v0.7.10 army validation:**

| Bug | Description | Status |
|---|---|---|
| BUG-01 | Duplicate events on drain (overlapping subscriptions) | Partially addressed |
| BUG-02 | system.malformed.received fires on every publish (missing envelope fields) | OPEN — schema lenient vs auto-wrap TBD |
| BUG-03 | claws_publish gated by undocumented `capabilities:['push']` | Workaround mandatory — real fix TBD |
| BUG-04 | 5 tools return "call hello first" despite registered peerId (session-lookup key mismatch) | Fixed |
| BUG-05 | claws_worker(detach=false) returns immediately; close_on_complete never fires | Fixed |
| BUG-06 | Violation timer fires even after heartbeats (wrong timer reset topic) | Fixed in server; templates partially updated |
| BUG-07 | boot_marker fires before MCP auth completes (stochastic, ~50% misfire rate for claws_worker single) | Workaround: use claws_fleet single-element |
| BUG-08 | claws_dispatch_subworker is serial (27.3s per call) | OPEN — claws_fleet preferred |
| BUG-09 | claws_dispatch_subworker no auto-close watcher | OPEN |
| BUG-10 | LEAD bails before all sub-workers complete | Fixed (drain-and-wait loop in wave-lead.md) |
| BUG-11 | Schema validation rejects sub-worker boot events | OPEN — cosmetic noise |
| BUG-12 | Cryptic lifecycle gate error message | Fixed (better error message) |
| BUG-13 | claws_close leaves orphan Claude Code child processes | OPEN |
| BUG-14 | Auto-sidecar death not detected; _ensureSidecar flag-only | Fixed (pidfile + os.kill probe) |
| BUG-15 | Extension fixes not deployed (VSIX not repackaged) | Process fix: VSIX must be rebuilt after extension/src changes |
| BUG-16 | PreToolUse grep on full command string causes false positives | OPEN |
| BUG-17 | _ensureSidecar silently fails to spawn | Fixed |
| BUG-18 | mcp-tools-guide.md recommends dispatch_subworker (wrong) | Fixed (updated to claws_fleet) |
| BUG-19 | CLAUDE.md version stuck at 0.6.1 | Fixed (updated to 0.7.10) |
| BUG-20 | _isSidecarAlive TOCTOU — concurrent callers bypass subscription gate | Fixed |
| BUG-21 | clawsRpc error handler omits sock.destroy() — fd leak | Fixed |
| BUG-22 | _pconnEnsureRegistered TOCTOU — concurrent double-register | Fixed |
| BUG-22 (doc) | templates/CLAUDE.project.md wildcard heartbeat topic | Fixed (peerId used) |
| BUG-23 | session-start-claws.js wrong heartbeat topic in reminder | Fixed |
| BUG-25 | Orphan terminals from nested fleet (fast-path skips detach-watcher) | Fixed |
| BUG-27 | PreToolUse Edit/Write block applies to workers (not just orchestrators) | Workaround: CLAWS_WORKER env var |
| BUG-28 | Hook matcher only covers Bash; MCP spawn-class tools bypass gate | OPEN |
| BUG-29 | Monitor not lifecycle-bound; no naming convention | OPEN |
| BUG-30 | Marker scan from start of log — false positive on mission-echo | Fixed (scan from offset) |
| BUG-35 | dispatch_subworker no auto-close watcher | OPEN (same as BUG-09) |
| BUG-36 | templates/CLAUDE.project.md: phase/event topics still use wildcard | OPEN |

---

### 7.10 v0712-release-tracker.md (2026-05-03)

**Three P0/P1 install blockers:**

- **Bug #1 (P0 — universal):** `mcp_server.js` crashes in ESM projects (`"type":"module"` in package.json).
  Fix: install.sh writes `<project>/.claws-bin/package.json` with `{"type":"commonjs"}`.
  Shipped in v0.7.12 commit `91e6fc2`.

- **Bug #2 (P1):** dev-hooks installed in every user project (CONTRIBUTOR diagnostics leaked).
  Fix: gate dev-hooks behind `CLAWS_INSTALL_DEV_HOOKS=1` opt-in.
  Shipped in v0.7.12.

- **Bug #3 (P1):** `monitor_arm_command` points at non-existent `scripts/stream-events.js` in user installs.
  Fix: extract path resolver into shared helper; all 4 callsites use it.
  Shipped in v0.7.12.

---

## 8. Lessons Learned

### 8.1 Patterns that worked

**1. Event-driven over polling.** Architectures that emit push events (pub/sub bus,
`system.worker.completed`, heartbeats) are vastly more reliable than polling pty logs.
Polling is O(N) per call, blocks the MCP socket, and misses events between polls.

**2. claws_fleet over claws_worker for armies.** `claws_fleet` returns all terminal_ids
in ~10s (truly parallel); `claws_worker` has a ~50% misfire rate when spawning LEAD-class
workers due to MCP auth timing (BUG-07). Single-element `claws_fleet` is the workaround.

**3. Per-worker Monitors (grep -m1) over shared Monitor.** Single shared Monitor with
broad filter: one SIGURG kills observability for all workers. Per-worker `grep -m1`
self-exits on first match; one dead Monitor doesn't affect others.

**4. Atomic file writes (writeAtomic with tmp+rename).** Both `inject-claude-md.js`
(CLAUDE.md) and the atomic-file.mjs module use `open→write→fsync→close→rename` pattern.
Prevents partial writes on power-cut or process kill.

**5. Empirical regression tests over hope.** The `extension/test/` suite (90+ checks
across 11 suites) caught regressions that code review missed. Worker-fixes tests, version-
drift tests, and pre-tool-use-sidecar-recognized tests all exist because field failures
demanded them.

**6. CLAWS_INSTALL_DEV_HOOKS=1 opt-in.** Contributor diagnostics in user installs were a
regression (Bug #2). Gating behind an explicit env var — not installing by default — is
the correct pattern for any developer-only tooling.

**7. Inline missions (not file-referrer).** The file-referrer pattern (`Read /path/to/mission.md`)
required the worker to have file I/O at boot time, before its environment was settled.
Inline missions are self-contained and survive any file system state.

**8. The 7-step boot sequence is load-bearing.** Every shortcut (skipping trust wait,
skipping bypass wait, sending mission before Claude is ready) results in missions being
lost silently or processed with garbled context. The sequence is non-negotiable.

---

### 8.2 Patterns that didn't work

**1. Advisory CLAUDE.md copy (soft verbs, bulleted lists).** "Consider using claws_create"
doesn't constrain the model. Only imperative language (`MUST`, `MANDATORY`, `REQUIRED`,
`NEVER`) consistently changes behavior. The enforced-injection chain in v0.7.x
replaced all advisory copy with imperatives.

**2. claws_dispatch_subworker for Wave Army dispatch.** Serial execution (BUG-08),
no auto-close watcher (BUG-09), missing `complete_marker` param (M18-A). Always use
`claws_fleet` for armies. `claws_dispatch_subworker` is not ready for production use.

**3. tui_idle auto-close (L8, disarmed in v0.7.12).** Detecting the `❯` prompt after work
and automatically closing the terminal caused false-positive auto-close on long-thinking
workers that return to the prompt between tool calls. The heuristic is too aggressive
as a trigger for destructive actions.

**4. Generic Monitor (tail -F unfiltered) as sole completion signal.**
- SIGURG'd within 30-90s.
- Every heartbeat becomes a notification (noise).
- One Monitor for all workers: one SIGURG kills all observability.

**5. pgrep substring matching in hook gate.** Checking `pgrep -f 'node.*server'` matches
legitimate read-only commands like `grep -n "node.*server"`, blocking them. Hook gates must
check the EXECUTABLE token (first word), not arbitrary substrings.

**6. Shared completion markers without offset anchoring.** `text.includes(complete_marker)`
on the full log fires false positives when mission text echoes the marker for documentation.
Always anchor scans to `text.slice(scanOffset).includes(marker)`.

**7. Wave violation timer starting at wave_create time.** Sub-workers can't possibly
heartbeat within 25s of `claws_wave_create` — they haven't even booted yet. Start the
timer on first heartbeat, or use a 60s grace period.

**8. Extension rebuilding without VSIX packaging.** `npm run build` updates `extension/dist/extension.js`
but VS Code loads the globally installed extension from `~/.vscode/extensions/`. Fixes are
invisible until `vsce package` + `code --install-extension claws-*.vsix` are run. BUG-15
burned an entire army session because workers were testing against the wrong version.

---

## 9. Cross-System Consistency Requirements

For Claws's behavioral policy to enforce identically on every machine, ALL of the
following must be present and consistent. If any layer is missing or stale, behavior
degrades silently.

### 9.1 Required files and their sources

| File | Source | Written by | Required for |
|---|---|---|---|
| `~/.claude/CLAUDE.md` | `templates/CLAUDE.global.md` | `inject-global-claude-md.js` | Global policy on any session |
| `<project>/CLAUDE.md` CLAWS:BEGIN block | `templates/CLAUDE.project.md` | `inject-claude-md.js` | Project policy |
| `~/.claude/settings.json` hooks | Hook registrations | `inject-settings-hooks.js` | SessionStart, PreToolUse, Stop enforcement |
| `<project>/.claws-bin/mcp_server.js` | `mcp_server.js` at root | `install.sh` cp | MCP server |
| `<project>/.claws-bin/stream-events.js` | `scripts/stream-events.js` | `install.sh` cp | Sidecar / Monitor |
| `<project>/.claws-bin/package.json` | Inline in install.sh | `install.sh` | ESM project compat (v0.7.12+) |
| `<project>/.claude/commands/claws-*.md` | `.claude/commands/` | `install.sh` cp | Slash commands |
| `<project>/.claude/skills/` | `.claude/skills/` | `install.sh` cp | Orchestration engine skill |
| `<project>/.claude/rules/claws-default-behavior.md` | `rules/claws-default-behavior.md` | `install.sh` cp | ECC plugin supplement |
| `<project>/.mcp.json` | MCP server registration | `install.sh` | MCP tool availability |
| VS Code extension `neunaha.claws` | VSIX | `code --install-extension` | Terminal control, socket, pub/sub |

### 9.2 Version alignment requirements

The following must all be on the same semver version:

- `package.json` (root) version
- `extension/package.json` version
- Installed VS Code extension version (check `~/.vscode/extensions/neunaha.claws-X.Y.Z/`)
- `CHANGELOG.md` entry for the version

Version drift causes:
- Extension installed at v0.7.9 using MCP server at v0.7.10 → BUG-03 still present.
- `check-tag-vs-main` dev-hook catches git tag vs HEAD drift.

### 9.3 Node.js and Electron ABI requirements

- Node.js must be 18+. The MCP server and CLI use no external deps; zero-dep stance means
  no native modules outside the extension's `extension/native/node-pty/`.
- `node-pty` is bundled under `extension/native/`. Build must match Electron's ABI.
- On Apple Silicon under Rosetta (x86_64 Node.js): `detectTargetArch()` must return `arm64`,
  not `x64` (M-05 fix). Incorrect ABI → pipe-mode degradation → `claws_read_log` always empty.
- `@electron/rebuild` must complete without signal kill (M-07 fix checks `result.status === null`).

### 9.4 Hook path consistency

All three hooks registered in `~/.claude/settings.json` must point to paths that exist:

```json
{
  "hooks": {
    "SessionStart": [{"type":"command","command":"node <project>/.claws-bin/hooks/session-start-claws.js"}],
    "PreToolUse": [{"type":"command","command":"node <project>/.claws-bin/hooks/pre-tool-use-claws.js","matcher":"Bash"}],
    "Stop": [{"type":"command","command":"node <project>/.claws-bin/hooks/stop-claws.js"}]
  }
}
```

If paths drift (custom `CLAWS_DIR`, prior install removed), hooks silently exit 0 (M-04
behavior post-v0.7.3) — the sh-c wrapper swallows the "file not found" error. User sees no
hooks running with zero signal. `/claws-fix` runs path validation to catch this.

### 9.5 Sidecar requirements

- `stream-events.js` must be at `<project>/.claws-bin/stream-events.js` (not `scripts/`).
- The SessionStart hook spawns it with `--auto-sidecar` flag and `detached:true` so it
  outlives the hook.
- The Stop hook kills it via `pgrep -f 'stream-events\.js.*--auto-sidecar'` + `kill -TERM`.
- Idempotency check: `pgrep -f 'stream-events\.js.*--auto-sidecar'` before respawn.
- SIM2B-P2b: pgrep pattern should include socket path to scope to current project (open).

### 9.6 What the `inject-settings-hooks.js` script must do atomically

1. Read `~/.claude/settings.json` (parse as JSONC — strip comments + trailing commas before parse).
2. On parse failure: ABORT with loud error pointing at line/column — NEVER overwrite with `{}` (M-03).
3. Merge Claws hook entries tagged with `_source:"claws"` for clean removal.
4. Deduplicate by hook command string (M-14 fix — don't use substring match).
5. Write atomically via tmp+rename (M-09 pattern).

---

## 10. Open Questions

**Q1: How do we fix the M18-C chicken-and-egg (Claude TUI doesn't exit)?**

The deepest architectural issue. Current status: Workers finish their work, sit at `❯`,
never trigger `onDidCloseTerminal`. Options:
- (a) Mission preamble convention: last step is `Bash(exit)` tool call. Brittle (worker may skip it).
- (b) Server-side kill-after-grace: watcher detects POST_WORK state (L8 heart-beats) and
  sends SIGTERM to the foreground PID after N seconds of `❯` idle. Requires L8 to safely
  distinguish "idle between tool calls" from "mission complete idle".
- (c) Wrapper script: `script(1)` is replaced by a wrapper that sends Ctrl-D to Claude's
  stdin after detecting the `❯` prompt plus a configurable idle grace period.
- (d) `claws_worker` option: `auto_exit_on_complete:true` injects `\nexit\n` into the
  terminal after the completion marker is detected. Requires the marker to work (F3 must fire).

**Q2: Should L8 tui_idle be re-armed with a smarter heuristic?**

L8 was disarmed because it caused false-positive auto-close on long-thinking workers.
The core issue: `POST_WORK` state looks the same whether Claude is "done for good" vs
"paused between tool calls". Potential distinguishing signals:
- Time since last tool call > threshold (e.g., 60s at `❯` → done).
- No pending tool calls in output (spinner absent).
- The `❯` prompt appears AFTER a `printf MARK_*` or `Bash(exit)` — confirmed F3 fired.

**Q3: Should `capabilities: ['push']` be the server default for all workers?**

BUG-03 causes publish to silently fail for workers without the capability. Every known
callsite now includes `capabilities: ['push']`. But new contributors who don't know about
this workaround will hit it. Should the server grant publish capability by default to all
registered peers, or document it more prominently?

**Q4: How do we fix H2 (close() drops byTerminal before dispose) without double-fire?**

Fix: call `this.onTerminalClose(key, rec.wrapped)` inside `close()` before map deletion.
The double-fire risk (both `close()` and `onTerminalClosed`) is prevented by
`onTerminalClosed`'s early-return after `close()` removes from `byTerminal`. But we need
a unit test to confirm the guard holds:
- Test: close a terminal → verify `onTerminalClose` fires exactly once.
- Test: VS Code-fired `onDidCloseTerminal` after programmatic `close()` → verify callback
  does NOT fire again.

**Q5: How do we fix BUG-28 (PreToolUse hook missing MCP tool matchers)?**

`inject-settings-hooks.js` must register additional PreToolUse entries:
```json
{"type":"command","command":"node .claws-bin/hooks/pre-tool-use-claws.js","matcher":"mcp__claws__claws_create"},
{"type":"command","command":"node .claws-bin/hooks/pre-tool-use-claws.js","matcher":"mcp__claws__claws_worker"},
{"type":"command","command":"node .claws-bin/hooks/pre-tool-use-claws.js","matcher":"mcp__claws__claws_fleet"},
{"type":"command","command":"node .claws-bin/hooks/pre-tool-use-claws.js","matcher":"mcp__claws__claws_dispatch_subworker"}
```
Risk: multiple PreToolUse hook entries for the same command script — the script runs N times.
Need to ensure the script is idempotent under multiple invocations per tool call.

**Q6: What is the correct approach to lifecycle store + bus event consistency?**

Current: `markWorkerStatus` mutates state + flushes to disk but emits no bus event.
`emitSystemEvent` emits a bus event but may not update the lifecycle store.
The two systems can diverge: lifecycle-state.json shows `closed`, bus shows nothing.
Should `markWorkerStatus` also emit a bus event? Or should `emitSystemEvent` also call
`markWorkerStatus`? The single-source-of-truth principle suggests the extension owns
both — the close event should trigger both the store update and the bus emission atomically.

**Q7: How do we prevent `mcp.json` silent-overwrite on JSONC input?**

M-02 fix requires stripping JSONC comments + trailing commas before `JSON.parse`. The
stripping logic must handle edge cases: comments inside strings, trailing commas in
nested objects. A battle-tested JSONC parser (e.g., `json5` or Typescript's built-in
`JSON5`) is safer than a hand-rolled stripper. But the project's zero-external-deps policy
applies to the extension — not necessarily to install scripts. Can install.sh pull in one
npm package for JSONC parsing?

**Q8: Is there a reliable way to distinguish "worker booted successfully" from "MCP auth banner intercepted"?**

BUG-07 (stochastic boot misfire): Claude Code shows "1 MCP server need auth · /mcp" before
the `bypass permissions` footer. The boot marker matches the footer early, but the prompt is
hijacked by the auth banner. Worker receives the mission text, but Claude never processes it
(cost=$0, in:0, out:0). Stochastic because it depends on whether MCP creds are cached.

Potential fix: After detecting bypass, poll for 2s and check that `cost` starts growing
(tokens flowing → Claude processing). If cost stays at $0 for > 5s, treat as misfire and
respawn. Requires cost-line parser (already added in v0.7.12 as `parseCostLine`).

---

## Appendix A: Key commit hashes (completion mechanism milestones)

| Commit | Description |
|---|---|
| (pre-history) | Era 1: manual polling, no automation |
| v0.6.0 | Phase A/B: claws/2 pub/sub, wave army, `wave.<id>.<role>.complete` mechanism |
| (early v0.7.x) | MISSION_COMPLETE marker convention formalized |
| v0.7.10 | Wave B: per-worker Monitor pattern, `monitor_arm_command` in response |
| v0.7.10 | Wave D: `onDidCloseTerminal → system.worker.terminated` (part 1 + 2) |
| v0.7.12 `bd67137` | Heartbeat parser primitives (parseToolIndicators, parsePromptIdle, etc.) |
| v0.7.12 `a05cd58` | WorkerHeartbeatStateMachine class |
| v0.7.12 `a5a5a8a` | Wire state machine into runBlockingWorker (backstop heartbeats) |
| v0.7.12 `cba12ab` | Move heartbeat wiring to fast-path watcher |
| v0.7.12 `eb37496` | Drop cost from heartbeat; relax BOOTING→READY |
| v0.7.12 `3576942` | Cascade fix: READY→WORKING fires on cumulative toolCount |
| v0.7.12 `9643600` | Fix parseToolIndicators `\s+` → `\s*` (cascade parser mismatch) |
| v0.7.12 `06242da` | Canonical monitor pattern auto-exits on completion |
| v0.7.12 `c8595c0` | POST_WORK detection: kind=mission_complete heartbeat fires |
| v0.7.12 `200e169` | Wire mission_complete → system.worker.completed (tui_idle signal) |
| v0.7.12 `6f372b2` | parsePromptIdle scans last 10 lines |
| v0.7.12 `53274eb` | POST_WORK detection drops bytesIdle gate |
| v0.7.12 `c83399d` | parsePromptIdle uses bypass-permissions footer |
| v0.7.12 `b564aac` | kind=progress heartbeats with 5s burst aggregation |
| v0.7.12 `890f953` | kind=approach (TodoWrite) + kind=error (Bash failures) heartbeats |
| v0.7.12 `ed27870` | DISARM L8 tui_idle auto-close (false positives on long-thinking workers) |

---

## Appendix B: Active open bugs as of v0.7.12

Priority order:

**P0:**
- BUG-28: PreToolUse hook doesn't fire for MCP spawn-class tools (Monitor-arm gate is dead for MCP)

**P1:**
- H1: `system.worker.completed` silently dropped when `_pconn` disconnected
- H2: `TerminalManager.close()` drops `byTerminal` before `dispose()` — `system.worker.terminated` never fires on programmatic close
- M18-B: `system.worker.terminated` doesn't update lifecycle store
- M18-C: Claude TUI doesn't auto-exit → Wave D safety net never triggers
- BUG-07: Boot misfire (MCP auth banner) — ~50% rate for single `claws_worker`, ~0% for `claws_fleet`
- BUG-08: `claws_dispatch_subworker` is serial — 27s per call
- BUG-09 / BUG-35: `claws_dispatch_subworker` has no auto-close watcher
- BUG-13: `claws_close` leaves orphan Claude Code child processes

**P2:**
- H3: `emitSystemEvent` drops all events when event log is degraded
- BUG-02: `system.malformed.received` fires on every publish (missing envelope fields)
- BUG-16 / SIM2B-P2a: PreToolUse pattern matching greps full command string
- BUG-29: Monitor not lifecycle-bound (no naming convention)
- BUG-36: `templates/CLAUDE.project.md` phase/event topics still use wildcards
- SIM2B-P2b: sidecar pgrep ignores socket path

---

*End of document. 877 lines.*
