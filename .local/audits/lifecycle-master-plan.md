# Claws Lifecycle Master Plan
## Comprehensive Synthesis — Mission 67 LEAD

**Source documents synthesized:**
1. `docs/ARCHITECTURE.md` — 513 lines, canonical architectural anchor
2. `.local/audits/audit-lifecycle-core.md` — 757 lines, lifecycle store/engine/rules deep dive
3. `.local/audits/audit-vscode-integration.md` — 757 lines, VS Code API surface + terminal FSM
4. `.local/audits/audit-mcp-dispatch.md` — 1104 lines, all dispatch entry points + worker types
5. `.local/audits/audit-heartbeat-integration.md` — 652 lines, L1-L10 plan vs reality
6. `.local/audits/audit-history-and-past-approaches.md` — 1306 lines, eras + lessons learned

**Generated:** 2026-05-04  
**Status:** SYNTHESIS — no source code changes in this document

---

## Table of Contents

1. [State of the Union](#1-state-of-the-union)
2. [Lifecycle 10-Phase Deep Dive](#2-lifecycle-10-phase-deep-dive)
3. [Worker Types Matrix](#3-worker-types-matrix)
4. [Monitor↔Lifecycle Sync Model](#4-monitorlifecycle-sync-model)
5. [Heartbeat in the Lifecycle](#5-heartbeat-in-the-lifecycle)
6. [Past Approaches Catalog](#6-past-approaches-catalog)
7. [Bug Catalog — Consolidated and Ranked](#7-bug-catalog--consolidated-and-ranked)
8. [Terminal-to-Terminal Communication](#8-terminal-to-terminal-communication)
9. [Cross-System Consistency Requirements](#9-cross-system-consistency-requirements)
10. [Phased Fix Roadmap](#10-phased-fix-roadmap)
11. [Open Questions for Human Review](#11-open-questions-for-human-review)
12. [References — File:Line Citations](#12-references--fileline-citations)

---

## 1. State of the Union

### 1.1 What Claws Is (and Isn't)

Claws is a **bridge** — not a terminal emulator, not a remote shell, not a multiplexer. It turns VS Code's integrated terminals into programmable, observable endpoints addressable from any external process (AI orchestrator, CI runner, automation script) via a local Unix socket or WebSocket.

The system has three runtime layers:
1. **Extension layer** (`extension/src/*.ts`): Runs inside VS Code. Owns terminal objects, pty processes, pub/sub bus, lifecycle state machine.
2. **MCP server** (`mcp_server.js`): Standalone Node.js process. Exposes 38 tools to Claude Code / any MCP client. Connects to the extension via Unix socket.
3. **Stream-events sidecar** (`scripts/stream-events.js`): Subscribes to the claws/2 pub/sub bus; emits each push frame as one stdout line — enables `Monitor` to consume the event stream without polling.

### 1.2 Current Version and Shipped Features

**Version 0.7.12** (as of 2026-05-04):

| Feature | Status |
|---------|--------|
| Terminal create/list/send/exec/readLog/close | Shipped v0.1 |
| Wrapped terminals (script(1) pty capture) | Shipped v0.2 |
| Safety gate (TUI detection, warn-not-block) | Shipped v0.3 |
| TypeScript rewrite, esbuild bundling | Shipped v0.4 |
| VS Code configuration (10 settings) | Shipped v0.5 |
| Status bar, commands, keybindings | Shipped v0.5 |
| Peer registry, pub/sub, task registry | Shipped v0.6.0 (claws/2) |
| Behavioral injection enforcement chain | Shipped v0.6.1 |
| 10-phase lifecycle state machine | Shipped v0.7.x |
| Lifecycle auto-advance engine (cascade) | Shipped v0.7.10 |
| Worker heartbeat L1-L7 (fast-path) | Shipped v0.7.12 |
| Worker heartbeat L8 (tui_idle auto-close) | DISARMED v0.7.12 (commit ed27870) |
| Wave D (onDidCloseTerminal → terminated) | Shipped v0.7.10 |
| D+F architecture (correlation_id, atomic spawn+monitor) | Shipped v0.7.10 |
| claws_fleet (parallel N-worker dispatch) | Shipped v0.7.9 |
| claws_dispatch_subworker | Shipped v0.7.9 |
| wave_create/status/complete | Shipped v0.7.9 |
| Worker heartbeat L9 (monitor awk exit) | Shipped v0.7.12 |
| Worker heartbeat L10 (mission_failed) | NOT SHIPPED |

### 1.3 The Fundamental Tension

Claws is built on two competing design forces:

**Force A — Non-blocking MCP transport**: The MCP stdio transport cannot safely hold a response open for more than a few seconds. `claws_worker` and `claws_fleet` must return immediately with `terminal_ids`. This means the orchestrator MUST poll or subscribe for completion.

**Force B — Reliable completion detection**: The orchestrator NEEDS to know when a worker is done (to harvest results, advance lifecycle, close terminals). This requires durable in-process watchers that survive the MCP response boundary.

The current implementation attempts to solve this tension with:
- In-process `_detachWatchers` array (MCP server, never garbage-collected until completion)
- 4 completion signal types (marker, error_marker, pub_complete, terminated)
- `claws_workers_wait` as a synchronization point
- `Monitor + stream-events.js` as an async completion signal consumer

But there are 40+ bugs across these subsystems, several at P0. The following sections catalog them in detail.

### 1.4 The Three Critical Gaps

Before diving into details, three structural gaps explain most downstream failures:

**Gap 1 — H2 (Wave D dead for programmatic close)**  
`TerminalManager.close()` deletes `byTerminal` BEFORE calling `dispose()`. When `onDidCloseTerminal` fires, the map lookup fails silently. `system.worker.terminated` never publishes. Wave D safety net is completely non-functional for all programmatic close paths.

**Gap 2 — BUG-28 (Monitor gate has wrong matcher)**  
The `PreToolUse` hook uses `matcher:"Bash"` — it fires for Bash tool calls but NOT for MCP tool calls (`claws_worker`, `claws_fleet`, `claws_dispatch_subworker`). Orchestrators that spawn workers without arming a Monitor first are never warned or blocked. The gate protects the wrong surface.

**Gap 3 — Watcher coverage asymmetry**  
Heartbeat state machine (L4-L7) is only wired into the fast-path watcher (`_fpTick`). The three other dispatch paths — `runBlockingWorker` detach mode, `runBlockingWorker` blocking poll, `_dswTick` — have NO heartbeat publishing. An orchestrator monitoring a fleet worker or dispatch_subworker gets no live progress signal.

---

## 2. Lifecycle 10-Phase Deep Dive

### 2.1 Phase Table

The lifecycle state machine is defined across three files:
- `lifecycle-store.ts` — state storage, gate methods, transition enforcement
- `lifecycle-engine.ts` — auto-advance trigger logic
- `lifecycle-rules.ts` — `canTransition(from, to)` truth table

```
Phase Index | Phase Name   | Description
------------|--------------|--------------------------------------------------
0           | SESSION-BOOT | Extension activated, socket open, no plan yet
1           | PLAN         | Plan text received, ready to spawn workers
2           | SPAWN        | Workers being created (terminals allocated)
3           | DEPLOY       | Workers active, commands dispatched
4           | OBSERVE      | Workers running, monitoring for completion
5           | RECOVER      | Failure detected, recovery logic running
6           | HARVEST      | All workers complete, collecting results
7           | CLEANUP      | Closing terminals, releasing resources
8           | REFLECT      | Post-session analysis (auto-generated)
9           | SESSION-END  | Session closed, all resources released
-           | FAILED       | Unrecoverable error (reachable from any phase)
```

### 2.2 Transition Table (canTransition truth matrix)

`lifecycle-rules.ts` encodes which `(from, to)` pairs are legal:

```
FROM          TO              ALLOWED?   GATE CONDITION
SESSION-BOOT  PLAN            YES        (no gate — first plan call)
SESSION-BOOT  FAILED          YES        always
PLAN          SPAWN           YES        hasPlan() === true
PLAN          FAILED          YES        always
SPAWN         DEPLOY          YES        spawnedCount > 0
SPAWN         FAILED          YES        always
DEPLOY        OBSERVE         YES        (no explicit gate)
DEPLOY        FAILED          YES        always
OBSERVE       RECOVER         YES        errorCount > 0
OBSERVE       HARVEST         YES        allWorkersComplete()
OBSERVE       FAILED          YES        always
RECOVER       OBSERVE         YES        (after recovery action taken)
RECOVER       HARVEST         YES        allWorkersComplete() after recovery
RECOVER       FAILED          YES        always
HARVEST       CLEANUP         YES        (no explicit gate — BUG-2)
HARVEST       FAILED          YES        always
CLEANUP       REFLECT         YES        openTerminalsCount === 0
REFLECT       SESSION-END     YES        hasReflectText() — BUG-4 bypasses this
SESSION-END   (none)          TERMINAL   —
FAILED        PLAN            NO         silent no-op — BUG-5
FAILED        SESSION-END     YES        allows clean exit
```

**Key invariants** (enforced in `lifecycle-store.ts`):
- `phases_completed` is session-cumulative (increments every transition) — not per-mission. BUG-6: this makes the counter meaningless for multi-mission sessions.
- Every transition records `{ phase, timestamp, actor }` in the audit log.
- Transitions publish `system.lifecycle.advanced` on the pub/sub bus.

### 2.3 Gate Methods — Dead Code Analysis

Four gate methods exist in `lifecycle-store.ts`. Two are dead code:

```typescript
// LIVE: used by server.ts:860
hasPlan(): boolean

// DEAD: not called from server.ts or lifecycle-engine.ts
canSpawn(): boolean   // BUG-1 — server.ts:863 calls only hasPlan()

// LIVE: used by auto-advance engine
allWorkersComplete(): boolean

// DEAD: not called anywhere
canEndSession(): boolean   // BUG-7 — SESSION-END advance missing gate
```

The `canSpawn()` dead code means the SPAWN phase can be entered without the checks `canSpawn` was meant to enforce (spawned worker count tracking, spawn budget).

The `canEndSession()` dead code means SESSION-END can be reached without verifying that all resources are released (open terminals == 0, pending events drained).

### 2.4 Auto-Advance Engine

`lifecycle-engine.ts` drives automatic phase cascades. The engine fires after every state mutation:

```
Trigger: any terminal status update, any worker completion event

Cascade rules:
1. If phase == SPAWN and all spawned terminals are DEPLOY-ready:
   → advance to DEPLOY (auto)
2. If phase == OBSERVE and allWorkersComplete():
   → advance to HARVEST (auto)
3. If phase == HARVEST and harvestComplete():
   → advance to CLEANUP (auto)
4. If phase == CLEANUP and openTerminalsCount == 0:
   → advance to REFLECT (auto)
5. If phase == REFLECT and no reflectText:
   → generate synthetic reflectText + advance to SESSION-END (auto) — BUG-8
```

**BUG-8**: The auto-REFLECT → SESSION-END cascade generates a synthetic reflect text (hardcoded template, not real analysis). The reflect text is supposed to be a genuine post-session summary. This makes the REFLECT phase meaningless — it advances through automatically with boilerplate.

### 2.5 The FAILED→PLAN No-Op (BUG-5)

When a session enters FAILED, the correct recovery is:

```
FAILED → plan() → PLAN → SPAWN → ...
```

But `lifecycle-store.ts:119` implements `plan()` as:

```typescript
plan(text: string): void {
  if (this.state.phase === 'FAILED') {
    // Silent no-op — BUG-5
    return;
  }
  // ... actual plan logic
}
```

This means a session that hits FAILED is stuck. The user must restart. The correct behavior is to allow re-plan from FAILED (or at minimum document that FAILED is terminal and surface a clear error).

### 2.6 The bypass canTransition Bug (BUG-4)

`lifecycle-store.ts:251` implements `reflect()` using a direct state mutation instead of `canTransition`:

```typescript
// BUG-4: bypasses canTransition gate
reflect(text: string): void {
  this.state.phase = 'REFLECT';
  this.state.reflectText = text;
  this.emit('advanced', { to: 'REFLECT' });
}
```

Compare with the correct pattern used by `advance()`:

```typescript
advance(to: Phase): void {
  if (!canTransition(this.state.phase, to)) {
    throw new Error(`Invalid transition: ${this.state.phase} → ${to}`);
  }
  // ...
}
```

The `reflect()` bypass means REFLECT can be entered from any phase, including phases where it makes no semantic sense (e.g., SPAWN → REFLECT skipping all worker work).

### 2.7 The HARVEST→CLEANUP Gate Bypass (BUG-2)

`server.ts:1610-1622` advances from HARVEST to CLEANUP with:

```typescript
lifecycle.advance('CLEANUP');  // BUG-2: no canCleanup gate
```

`canCleanup()` (if it existed) should verify:
- All worker results have been read (harvestComplete)
- No pending pub/sub messages in flight

Without this gate, CLEANUP begins while harvest callbacks may still be running — potential race condition on result data.

### 2.8 The Double-Call Pattern (BUG-B)

Every detach watcher that completes calls `mark-worker-status` TWICE:

```
Call 1: mark-worker-status(id, 'complete')   — set completion status
Call 2: mark-worker-status(id, 'closed')     — required for canReflect
```

The reason: `canReflect()` in `lifecycle-store.ts` checks `workerStatus === 'closed'`, not `'complete'`. So the lifecycle will never advance to REFLECT unless the status is specifically `'closed'`.

But `'closed'` semantically means the terminal was closed, not that the mission completed. These are two different things. The double-call pattern is a workaround for an API design flaw — the lifecycle gate should check `'complete'` OR `'closed'`, not only `'closed'`.

### 2.9 phases_completed Session vs Mission (BUG-6)

The `phases_completed` counter in `lifecycle-state.json` increments on every phase transition across the entire session. For a session with 3 missions:

```
Mission 1: SESSION-BOOT→PLAN→SPAWN→DEPLOY→OBSERVE→HARVEST→CLEANUP→REFLECT→SESSION-END
  = 8 transitions, phases_completed = 8

Mission 2 (same session): ... 8 more transitions
  phases_completed = 16

Mission 3: ... 8 more transitions
  phases_completed = 24
```

Any tooling that uses `phases_completed` to gauge how far into a lifecycle a session is will get a meaningless number. The counter should either be reset per-mission or tracked separately as `session_phases_completed` vs `mission_phases_completed`.

---

## 3. Worker Types Matrix

### 3.1 Overview

Six distinct worker dispatch mechanisms exist in the codebase. They differ fundamentally in lifecycle integration, heartbeat publishing, monitor armament, and completion detection.

```
Worker Type           | Blocking | HB | Lifecycle | Monitor  | Primary Use
----------------------|----------|----|-----------|----------|-------------------
claws_create          | No       | No | best-effort| None    | General terminals
claws_worker (fp)     | No       | Yes| full      | auto     | Primary AI workers
runBlockingWorker(D)  | No       | No | partial   | manual   | Fleet/sub-workers
runBlockingWorker(B)  | Yes      | No | partial   | none     | Sync wait callers
claws_fleet           | No       | No | partial   | manual   | Parallel N-worker
claws_dispatch_subwkr | No       | No | partial   | manual   | Wave sub-workers
wave tools            | No       | No | bus-native | auto    | Wave army pattern
```

### 3.2 claws_create

**Spawn behavior:**
- Calls `terminalManager.create(name, cwd, wrapped)` directly
- Returns `{ id, logPath? }` immediately
- Does NOT register a watcher
- Does NOT advance lifecycle beyond SPAWN best-effort

**Lifecycle entries:**
- `lifecycle.registerSpawn(terminalId)` called best-effort (try/catch, error logged not thrown)
- No `registerMonitor` — watcher never registered

**Monitor armament:**
- None. Caller is 100% responsible for monitoring completion.

**Heartbeat publishing:**
- None. This tool creates a dumb terminal — no HeartbeatStateMachine.

**Completion paths:**
- Only Wave D (onDidCloseTerminal → terminated) if terminal is closed via user X or RPC `close`
- Wave D is dead for programmatic `claws_close` (H2 bug)

**Close behavior:**
- Caller must call `claws_close` explicitly
- claws_close has BUG-B-close (see §7)

**Known bugs:**
- H2: onDidCloseTerminal fires but byTerminal lookup fails
- BUG-B-close: close doesn't cancel watchers or update lifecycle

**Design note:** This is intentionally minimal. It's a "dumb terminal" — the orchestrator controls everything. The lifecycle integration is best-effort because many `claws_create` usages are for non-worker terminals (dev servers, REPLs, build processes).

### 3.3 claws_worker (Fast-Path)

**Spawn behavior:**
- Allocates `correlation_id` (UUID) for D+F tracking
- Calls `terminalManager.create(name, cwd, wrapped=true)` 
- Sends boot sequence: `claude --model claude-sonnet-4-6 --dangerously-skip-permissions`
- Returns immediately with `{ terminal_id, correlation_id, monitor_arm_command }`
- Starts `_fpTick` watcher in `setImmediate` (non-blocking)

**_fpTick watcher behavior (detailed):**
```
Tick interval: 5000ms
Boot detection: parsePromptIdle v3 (looks for 'bypass permissions on' in last 30 lines)
Mission inject: after boot detected, sends mission text via bracketed paste
Post-mission detection: detectCompletion(text) scans for marker/error_marker/pub_complete
Heartbeat: HeartbeatStateMachine L4-L7 active throughout
Auto-close: L8 tui_idle detection — DISARMED (ed27870)
```

**Lifecycle entries:**
- `lifecycle.registerSpawn(terminalId)` — sync, before return
- `lifecycle.registerMonitor(terminalId, watcher)` — sync, before return
- D+F: both registered before MCP response returned (atomic)

**Monitor armament:**
- `monitor_arm_command` in response is a real `stream-events.js | grep correlation_id` command
- Per-worker Monitor pattern supported
- BUG-H: `claws_fleet`'s top-level `monitor_arm_command` is documentation text, not a command (only fleet, not claws_worker directly)

**Heartbeat publishing:**
```
L4: WORKING → READY transition detection → publishes worker.<id>.heartbeat kind=progress
L5: tool call detection (Bash/Read/Write) → publishes kind=progress
L6: approach detection (TodoWrite) → publishes kind=approach
L7: error detection (Bash failure) → publishes kind=error
L8: tui_idle detection (parsePromptIdle) → DISARMED
L9: completion → publishes kind=mission_complete → claws_workers_wait unblocks
```

**Completion paths:**
1. Marker: `printf '%s\n' 'MARKER'` in F3 → detectCompletion matches → watcher fires
2. Error marker: error pattern in output → detectCompletion error branch
3. pub_complete: `[CLAWS_PUB] topic=...` in output → detectCompletion pub branch
4. terminated (Wave D): onDidCloseTerminal → system.worker.terminated → watcher fires

**Known bugs:**
- BUG-A: Full log text passed to detectCompletion — if mission text itself contains the marker string on its own line, instant false positive on inject

**Design strength:** This is the most complete worker type. D+F architecture, heartbeat L4-L9, 4 completion signals, proper lifecycle registration. The right choice for all AI worker missions.

### 3.4 runBlockingWorker (detach:true mode)

Used by `claws_fleet` and indirectly by `claws_dispatch_subworker`.

**Spawn behavior:**
- Takes pre-created terminal (not created internally)
- Sends mission text via bracketed paste
- Registers `_detachWatcher` for the terminal
- Returns immediately (detached — caller gets back control)

**_detachWatcher behavior:**
```
Tick interval: 5000ms
Boot detection: MCP auth banner check ('Authorization required' or similar)
Mission inject: mission was sent before watcher started — no second inject
Detection: detectCompletion(fullLog) on every tick — BUG: full log, no markerScanFrom
Heartbeat: NONE — no HeartbeatStateMachine
```

**Lifecycle entries:**
- `lifecycle.registerSpawn` — best-effort
- `lifecycle.registerMonitor` — best-effort
- Less robust than fast-path because detach mode was added later

**Monitor armament:**
- Returns `monitor_arm_command` per worker
- BUG-H: fleet-level `monitor_arm_command` is static doc text

**Heartbeat publishing:**
- NONE. An orchestrator monitoring a fleet worker via the pub/sub bus gets NO live progress signal. The only heartbeat is the global system.metrics tick.

**Completion paths:**
- Same 4 as fast-path
- BUG-D: `claws_workers_wait` only checks marker + error_marker (misses pub_complete and terminated)

**Known bugs:**
- Full log to detectCompletion (same as BUG-A logic)
- No heartbeat state machine
- BUG-D in claws_workers_wait

### 3.5 runBlockingWorker (blocking poll mode)

The synchronous variant. Caller blocks until completion or timeout.

**Spawn behavior:**
- Same as detach mode but runs a synchronous polling loop
- Waits for detectCompletion(fullLog) to return true
- Timeout configurable (default: 600000ms / 10 min)

**Primary use case:**
- Internal sync operations where the MCP tool call can afford to block
- NOT suitable for production orchestration (blocks MCP socket)

**Lifecycle entries:**
- Same as detach mode

**Heartbeat publishing:**
- NONE. Same gap as detach mode.

**Completion paths:**
- Polling: direct detectCompletion check every 5s until true
- No Wave D integration (blocking mode exits before terminal close)

**Known bugs:**
- Blocks the MCP stdio transport for the entire worker duration
- No heartbeat
- Full log to detectCompletion

### 3.6 claws_fleet

**Spawn behavior:**
- Parses `workers[]` array from args
- For each worker: calls `terminalManager.create` + `runBlockingWorker(detach:true)`
- Dispatches all workers in parallel via `Promise.all`
- Returns immediately with `{ workers: [{terminal_id, monitor_arm_command}], monitor_arm_command }`

**The false-parallel problem:**
- Each runBlockingWorker detach call sets up a watcher and returns
- But the create calls are sequential in the Promise.all if creates are serial
- The workers run in parallel (that part is correct) but the setup may serialize

**Monitor armament:**
- Per-worker `monitor_arm_command` — correct
- Top-level `monitor_arm_command` — BUG-H: static documentation string, not executable

**Heartbeat publishing:**
- NONE (delegates to runBlockingWorker detach, which has no HB)

**Lifecycle integration:**
- Inherits all limitations of runBlockingWorker
- No fleet-level lifecycle tracking (no "fleet is HARVESTING" state)

**Known bugs:**
- BUG-H: top-level monitor_arm_command
- No fleet heartbeat
- All runBlockingWorker bugs apply

### 3.7 claws_dispatch_subworker

Designed for Wave Army sub-worker dispatch. Has the most accumulated bugs.

**Spawn behavior:**
- Creates terminal
- Sends boot sequence for sub-worker (Claude + Wave Discipline Contract mission)
- Returns immediately — but with BUG: returns BEFORE the background setImmediate starts
- The `_dswTick` watcher setup happens in a `setImmediate` callback

**BUG-F (dispatch_subworker boot detection):**
`_dswTick` uses the OLD boot detection: looking for 'trust' substring in the last 5 lines. But Claude Code v0.7+ changed the trust prompt text. The current fast-path uses `parsePromptIdle v3` (bypass permissions footer). `_dswTick` never detects boot and never injects the mission.

**BUG-C (full log to detectCompletion):**
Same as BUG-A — full log text, no markerScanFrom.

**BUG-E (no heartbeat state machine):**
`_dswTick` has no HeartbeatStateMachine. Sub-workers deployed via dispatch_subworker produce no heartbeat events. Orchestrators monitoring wave armies get no per-worker progress.

**Lifecycle entries:**
- Best-effort registerSpawn
- No registerMonitor for the _dswTick watcher (structural gap)

**Known bugs:**
- BUG-F: boot detection stale (uses 'trust', should use 'bypass permissions on')
- BUG-C: full log to detectCompletion
- BUG-E: no heartbeat

### 3.8 Wave Tools (claws_wave_*)

`claws_wave_create`, `claws_wave_status`, `claws_wave_complete`

**Design:**
- Higher-level abstraction over fleet dispatch
- Wave has explicit lifecycle: PENDING → ACTIVE → COMPLETE
- Sub-workers self-register via `claws_hello` with `waveId`

**Spawn behavior:**
- `claws_wave_create`: registers wave in server state, returns waveId
- Sub-workers are still created via `claws_dispatch_subworker` or manually
- `claws_wave_status`: queries registered sub-worker hellos + heartbeats
- `claws_wave_complete`: marks wave COMPLETE, fires wave.complete event

**Heartbeat publishing:**
- Wave tools themselves: NO direct heartbeat
- Sub-workers that follow Wave Discipline Contract publish their own heartbeats
- Wave status is derived from sub-worker heartbeats (aggregated)

**Lifecycle integration:**
- Wave state is SEPARATE from the main 10-phase lifecycle
- No bridge between wave completion and lifecycle HARVEST phase
- This is a structural gap: when a wave completes, lifecycle stays in OBSERVE unless manually advanced

**Known bugs:**
- BUG-E applies to sub-workers
- No bridge from wave.complete to lifecycle HARVEST
- claws_wave_status may show stale sub-worker data if heartbeats dropped

---

## 4. Monitor↔Lifecycle Sync Model

### 4.1 The Ideal Model

The ideal Monitor↔lifecycle sync model is:

```
Orchestrator arms Monitor BEFORE spawning workers
    ↓
Workers run, publish heartbeats/events to bus
    ↓
Monitor (stream-events.js | grep correlation_id) receives events
    ↓
Lifecycle auto-advances: SPAWN → DEPLOY → OBSERVE → HARVEST → CLEANUP → REFLECT
    ↓
Monitor receives system.worker.completed, exits cleanly
    ↓
Orchestrator harvests results, closes terminals
```

### 4.2 Reality — Per Worker Type

```
Worker Type           | Monitor Auto-Armed | Lifecycle Sync | Bus Events
----------------------|--------------------|-----------|-----------------
claws_worker (fp)     | monitor_arm_cmd    | FULL       | HB L4-L9
runBlockingWorker(D)  | per-worker cmd     | PARTIAL    | NONE
claws_fleet           | per-worker cmd     | PARTIAL    | NONE
                      | (top-level BROKEN) |            |
claws_dispatch_sub    | manual only        | PARTIAL    | NONE (BUG-E)
claws_create          | NONE               | BEST-EFFORT| NONE
```

### 4.3 The PreToolUse Gate (BUG-28)

The enforcement chain's `PreToolUse` hook is supposed to warn if a Monitor is not armed before spawning workers:

```javascript
// inject-settings-hooks.js — current (broken) matcher
{
  "type": "PreToolUse",
  "matcher": "Bash",  // BUG-28: Bash only, not MCP tools
  "hooks": [...]
}
```

This means:
- `claws_worker` call — no PreToolUse warning (wrong matcher)
- `claws_fleet` call — no PreToolUse warning (wrong matcher)
- Any MCP tool call — no PreToolUse warning

The gate fires only for Bash calls. An orchestrator that calls `claws_worker` without arming a Monitor first never receives the warning.

**Fix:** matcher should be `"Bash|MCP"` or `"(claws_worker|claws_fleet|claws_dispatch_subworker)"`.

### 4.4 The H2 Gap — Wave D Dead for Programmatic Close

`TerminalManager.close()` (`terminal-manager.ts:283-297`):

```typescript
close(id: number): void {
  const entry = this.byId.get(id);
  if (!entry) return;
  
  // H2 BUG: deletes from byTerminal BEFORE dispose()
  this.byTerminal.delete(entry.terminal);
  this.byId.delete(id);
  
  entry.terminal.dispose();  // fires onDidCloseTerminal AFTER byTerminal delete
}
```

When `onDidCloseTerminal` fires (from `dispose()`), it tries:

```typescript
onDidCloseTerminal(terminal) {
  const entry = this.byTerminal.get(terminal);  // undefined — already deleted
  if (!entry) return;  // silent return — system.worker.terminated NEVER fires
  // ...
}
```

**Impact:**
- All `claws_close` calls → `system.worker.terminated` never fires
- All auto-close paths (L8 tui_idle, orphan scanner) → terminated never fires
- Wave D safety net is completely dead for programmatic close
- Only user-X close (terminal panel close button) works correctly

**Fix:** Move `byTerminal.delete` to AFTER `dispose()` completes, or use `entry.terminal` reference in the close listener captured at create time.

### 4.5 _pconn Write Race (H1)

When a detach watcher fires `system.worker.completed`, it writes via `_pconnWrite(payload)`. But `_pconn` is the persistent claws/2 socket connection from `mcp_server.js` to the extension. If the socket disconnects and reconnects between worker spawn and completion:

```typescript
// mcp_server.js — detach watcher completion
try {
  await _pconnWrite({ push: 'message', topic: 'system.worker.completed', ... });
} catch (e) {
  console.error('_pconn write error (H1)', e);  // logged but not re-thrown
  // BUG: event silently dropped, lifecycle state stays OBSERVE
}
```

The try/catch swallows the write failure. The lifecycle-state.json is updated to show 'closed', but the pub/sub event never reaches subscribers. Any Monitor waiting for `system.worker.completed` will hang until timeout.

**Fix:** On write failure, retry once after 1s reconnect. If still fails, write a local flag file `.claws/worker-<id>-completed.flag` that `claws_workers_wait` can poll as fallback.

---

## 5. Heartbeat in the Lifecycle

### 5.1 L1-L10 Plan vs Reality

The heartbeat system was designed as a 10-level progressive enhancement plan (L1-L10). Current status:

```
Level | Name                        | Plan Location    | Status
------|-----------------------------|------------------|------------------
L1    | HB parser infrastructure    | heartbeat-parsers| SHIPPED (v0.7.12)
L2    | State machine definition    | hb-state-machine | SHIPPED (v0.7.12)
L3    | Integration into watchers   | mcp_server.js    | SHIPPED (v0.7.12)
L4    | WORKING state detection     | _fpTick only     | SHIPPED (fast-path)
L5    | Tool call progress events   | _fpTick only     | SHIPPED (fast-path)
L6    | Approach (TodoWrite) events | _fpTick only     | SHIPPED (fast-path)
L7    | Error (Bash failure) events | _fpTick only     | SHIPPED (fast-path)
L8    | tui_idle auto-close         | _fpTick          | DISARMED (ed27870)
L9    | mission_complete HB kind    | _fpTick          | SHIPPED (v0.7.12)
L10   | mission_failed HB kind      | _fpTick          | NOT SHIPPED
```

**Critical gap:** L4-L9 are fast-path ONLY. The plan intended L4-L9 for ALL 4 watchers:
- `_fpTick` ✓ shipped
- `runBlockingWorker` detach ✗ not shipped
- `runBlockingWorker` blocking ✗ not shipped
- `_dswTick` ✗ not shipped

### 5.2 The HeartbeatStateMachine States

```
State     | Triggers                          | Exit Condition
----------|-----------------------------------|------------------
BOOTING   | Created                           | Boot prompt detected
READY     | Boot prompt found                 | Mission inject sent
WORKING   | Mission injected, tool call seen  | Worker goes quiet OR completes
POST_WORK | Quiet period detected             | Resume or complete
COMPLETE  | Completion signal (any of 4)      | Terminal
```

State transitions publish events on `worker.<peerId>.heartbeat` topic:

```
BOOTING  → READY:    kind=progress, message='boot detected, mission injected'
READY    → WORKING:  kind=progress, message='first tool call detected'
WORKING  → POST_WORK: kind=progress, message='worker quiet'
POST_WORK → WORKING: kind=progress, message='worker resumed'
POST_WORK → COMPLETE: kind=mission_complete, message='completion signal received'
```

### 5.3 parsePromptIdle — Version History

**v1** (original, M15 era):
```javascript
// Check if last line ends with ❯
const lastLine = lines[lines.length - 1].trim();
return lastLine === '❯' || lastLine.endsWith(' ❯');
```
Failed because: ANSI stripping ate the ❯ color codes, and the footer section (`claude --model ...`) appeared AFTER the prompt in some configurations.

**v2** (intermediate):
```javascript
// Check last 10 lines for ❯
return lines.slice(-10).some(l => l.trim().endsWith('❯'));
```
Failed because: The Ink UI re-renders the entire screen on every keypress; 'scanning last 10 lines' produced false positives during mission text rendering.

**v3** (current, shipped):
```javascript
// Look for 'bypass permissions on' in last 30 lines
// This is the stable footer that Claude Code always renders after trust acceptance
const last30 = lines.slice(-30).join('\n');
return last30.includes('bypass permissions on');
```
Works because: The bypass permissions footer is rendered once after trust acceptance and stays visible in the last 30 lines throughout the session.

**Stale tests:** Two test cases in `heartbeat-parsers.test.js` still test v1/v2 behavior (❯ detection). They fail because v3 uses the bypass footer pattern. These tests need updating.

### 5.4 L8 Disarm Context (commit ed27870)

**L8 was:** After detecting `tui_idle` state (worker has been in POST_WORK for >N seconds with no tool calls), auto-close the terminal to free resources.

**Why disarmed:** Workers doing deep analysis (architectural thinking, large synthesis) would go quiet for 2-5 minutes between tool calls. The tui_idle detector incorrectly classified this as "worker stuck" and auto-closed the terminal, killing in-progress work. The false positive rate was ~40% for long-thinking missions.

**The core problem:** L8 uses absence of tool calls as the signal, but absence is ambiguous — it could be genuine idle OR deep thinking. The system cannot distinguish between these states from the outside.

### 5.5 Options for L8 Re-Enablement

**Option A: Token-stream delta detection**
Detect whether the Claude TUI is still rendering tokens (cursor movement, partial lines). If the pty is receiving bytes, the worker is thinking. If the pty is completely silent for >60s (no cursor blinks, no rendering), the worker is truly idle.

- Pro: High accuracy, true idle detection
- Con: Requires byte-level pty monitoring, not just line-level log scanning

**Option B: Expand spinner regex**
Claude Code's TUI renders a spinner character during API calls. Parse the spinner pattern from the pty log. If spinner was active in the last N seconds, worker is not idle.

- Pro: Simple regex extension, low implementation cost
- Con: Spinner may not render in all Claude versions; pty stripping may eat spinner bytes

**Option C: Final-message pattern detection**
Claude Code renders a distinctive "Press Enter to continue" or "Session complete" message when it genuinely finishes and has no pending tool calls. Detect this specific message rather than absence of activity.

- Pro: High precision (true positive only fires when Claude actually finished)
- Con: Pattern is UI-version-specific; breaks with Claude Code updates

**Option D: Two-phase confirmation window**
When idle detected, don't auto-close. Instead, publish `worker.tui_idle.warning` and wait 60s. If still idle after 60s, then auto-close. The orchestrator can cancel the auto-close by publishing `worker.extend`.

- Pro: Graceful degradation, operator intervention window
- Con: 60s window still wrong for deep-thinking workers (2-5 min)

**Option E: Hybrid bytesIdle + prompt-suggestion immunity**
Track bytes received per pty log scan interval. If bytes_delta == 0 for N consecutive scans AND no suggestion/approach events in last 5 min, classify as idle. The approach heartbeat (L6, TodoWrite detection) acts as a keep-alive.

- Pro: Uses existing heartbeat infrastructure, low false positive rate
- Con: Requires per-scan byte tracking (new plumbing in _fpTick)

**Recommendation:** Option D (two-phase) for next release (v0.7.13), Option E (hybrid) as v0.8.x enhancement. The 60s warning window in Option D gives orchestrators the ability to extend without requiring new pty infrastructure.

### 5.6 Watcher Coverage Gap — Root Cause

The gap between fast-path heartbeats and the other 3 watchers is architectural: heartbeat was designed and implemented against `_fpTick` only, then `runBlockingWorker` and `_dswTick` were added later without backporting heartbeat.

The `HeartbeatStateMachine` constructor takes a `terminalId` and a `publishFn` callback:

```typescript
class HeartbeatStateMachine {
  constructor(
    private terminalId: number,
    private publishFn: (kind: string, message: string) => void
  ) {}
}
```

Backporting heartbeat to the other 3 watchers requires:
1. Instantiate `HeartbeatStateMachine` at watcher start
2. Call `hbsm.onLogUpdate(newLines)` each tick
3. The machine handles state transitions and calls `publishFn` automatically

This is ~10 lines of code per watcher. The machine does the heavy lifting. The gap exists because of coordination failure between the heartbeat team (L4-L7) and the watcher team (runBlockingWorker, _dswTick) — not because it's hard to implement.

---

## 6. Past Approaches Catalog

### 6.1 Completion Detection Eras

**Era 0: No completion detection (v0.1-v0.2)**
- Workers ran and the orchestrator had to poll `readLog` manually
- No completion signals, no lifecycle, no timeout

**Era 1: Shell integration markers (v0.3)**
- `onDidEndTerminalShellExecution` event in VS Code API
- Sends a UUID sentinel; completion fires when VS Code reports exit code
- Failed because: VS Code shell integration is unreliable in wrapped terminals. The event fires intermittently. In TUI sessions (Claude Code, vim), it never fires because the shell prompt never returns.

**Era 2: Regex scan with polling (v0.4)**
- `readLog` + regex on every tick
- Marker pattern: `CLAWS_COMPLETE` or `MARK_M??_OK_COLOR`
- Worked but had false positives when mission text contained the marker

**Era 3: detectCompletion with markerScanFrom (v0.5-v0.6)**
- Introduced `markerScanFrom` offset: scan only content AFTER mission injection
- Eliminates false positives for mission text containing marker
- **Currently only implemented in runBlockingWorker detach, NOT in _fpTick (BUG-A)**

**Era 4: pub_complete signal + pub/sub (v0.6-v0.7)**
- Workers publish `[CLAWS_PUB] topic=...` line to be detected in log
- Also received via pub/sub bus subscription
- Redundant signal: if bus drops it, log scan catches it

**Era 5: Wave D (onDidCloseTerminal) (v0.7.10)**
- Terminal close fires `onDidCloseTerminal` → `system.worker.terminated` event
- Safety net for stuck watchers
- **Broken by H2 for programmatic close**

**Era 6: Heartbeat state machine (v0.7.12)**
- L1-L9 shipped for fast-path workers
- Provides live progress visibility, not just completion detection
- L10 (mission_failed) not yet shipped

### 6.2 Mission Injection Patterns

**Pattern A: Inline text (current standard)**
Mission text sent directly via `claws_send` with bracketed paste. Text is in the `claws_worker` call itself, not in a file. Introduced because the file-referrer pattern (Pattern B) was error-prone.

**Pattern B: File referrer (DEPRECATED)**
Worker received "Read /path/to/mission.md and follow its instructions." Pattern dropped in v0.7.10 commit 70ec1b1. The file had to be created before the worker was spawned; race conditions when multiple workers were spawned in parallel. FORBIDDEN — do not use.

**Pattern C: Wave Discipline Contract**
Sub-workers receive the full Wave Discipline Contract text as preamble + their specific mission as appendix. This ensures BUG-03 workaround (`capabilities:['push']`), heartbeat requirements, and F1/F2/F3 convention are always in scope.

### 6.3 F1/F2/F3 Convention — Origin and Purpose

**Origin:** M15 incident (audit-history-and-past-approaches.md). A worker completed its mission but skipped the `printf` marker call — instead, it summarized the results in an assistant message. The watcher scanned pty output (not conversation text) and never saw the marker. The watcher ran to timeout (25 min), reporting "timeout" even though the work succeeded.

**Convention:**
```
F1: git status --short          (verify clean working tree)
F2: git log --oneline -5        (verify commits landed)
F3: printf '%s\n' 'MARK_M??_OK_COLOR'   (pty-visible completion signal)
```

**Why numbered:** Framing as "F1/F2/F3" and presenting as a numbered checklist of explicit Bash tool calls prevents Claude from substituting an assistant-message-only summary. The model MUST execute tool calls (pty-visible) not narrate them (assistant-message-only, invisible to watcher).

**Why F3 must be a Bash tool call:** The watcher scans pty output. An `echo` or `printf` in an assistant text block is invisible to the watcher. Only a Bash tool execution that writes to pty stdout is detected by the watcher's log scan.

### 6.4 9 Past Audit Findings (from audit-history-and-past-approaches.md)

1. **M01**: Safety gate blocking Claude sends. Fixed by changing default from block to warn.
2. **M08**: Bracket paste fragmentation. Fixed by wrapping multi-line sends in `\x1b[200~...\x1b[201~`.
3. **M15**: F1/F2/F3 convention established after printf marker skip incident.
4. **M22**: `_fpTick` false positive completion on mission text containing marker. Partial fix: markerScanFrom — but NOT applied to _fpTick (BUG-A is the unfixed residual).
5. **M31**: Boot detection v1 (❯) fails. v2 introduced (last 10 lines ❯).
6. **M44**: Boot detection v2 false positives during Ink re-renders. v3 introduced (bypass permissions footer).
7. **M51**: Wave D designed; H2 bug introduced silently when TerminalManager.close() was refactored.
8. **M58**: BUG-03 workaround documented: `capabilities:['push']` required in claws_hello.
9. **M62**: HeartbeatStateMachine L8 disarmed after false positives on deep-thinking workers.

### 6.5 Lessons Learned Tables

**Table 1: Completion Detection**

| Lesson | Rule |
|--------|------|
| Shell integration is unreliable for TUI sessions | Never rely on `onDidEndTerminalShellExecution` as primary signal |
| Marker scan must be anchored post-injection | Always set `markerScanFrom` to post-mission content offset |
| Wave D needs atomicity | Register `onDidCloseTerminal` listener BEFORE adding to `byTerminal`, or use captured reference |
| Absence of activity ≠ idle | Never use "no tool calls for N seconds" as the only idle signal |
| Bus events can be dropped | Every bus event should have a pty log fallback signal |

**Table 2: Worker Discipline**

| Lesson | Rule |
|--------|------|
| Printf in assistant message is invisible to watcher | F3 MUST be a Bash tool call |
| File-referrer missions cause races | Missions MUST be inline |
| Role name ≠ peerId | Heartbeat topic MUST use `worker.<peerId>.*` not `worker.<role>.*` |
| BUG-03 is silent | `capabilities:['push']` MUST be in hello or claws_publish silently drops |
| --no-verify destroys trust | Never skip pre-commit hooks |

---

## 7. Bug Catalog — Consolidated and Ranked

This catalog consolidates bugs from all 5 audit documents, deduplicates them, and assigns priority ranks (P0=ship blocker, P1=critical regression, P2=quality issue).

### 7.1 P0 Bugs — Ship Blockers

**H2 — Wave D dead for programmatic close**
- File: `extension/src/terminal-manager.ts:283-297`
- Impact: `system.worker.terminated` never fires when `claws_close` is called or auto-close triggers. Wave D safety net completely non-functional for all non-user-X close paths.
- Root cause: `byTerminal.delete` before `dispose()` → onDidCloseTerminal fires after map entry gone
- Fix: Move delete to AFTER dispose, or capture entry reference in close listener at create time

**BUG-28 — PreToolUse hook wrong matcher**
- File: `scripts/inject-settings-hooks.js`
- Impact: Monitor-arm gate fires for Bash only, not for MCP spawn-class tools. Orchestrators spawn workers without Monitor; watcher fires completion but orchestrator is blind.
- Root cause: `matcher:"Bash"` instead of matching MCP tool names
- Fix: Extend matcher to include MCP tool names or use a different hook mechanism

**BUG-F — _dswTick boot detection stale**
- File: `mcp_server.js` (_dswTick implementation)
- Impact: `claws_dispatch_subworker` NEVER detects boot and NEVER injects mission. All dispatch_subworker calls silently do nothing — worker waits forever.
- Root cause: Using 'trust' substring detection (v1 pattern) instead of v3 (bypass permissions footer)
- Fix: Replace 'trust' detection with `parsePromptIdle(lines)` v3 function call

### 7.2 P1 Bugs — Critical Quality Issues

**H1 — _pconn write silently dropped**
- File: `mcp_server.js` (detach watcher completion logic)
- Impact: If pconn disconnects between spawn and completion, `system.worker.completed` is silently dropped. Lifecycle stays OBSERVE, Monitor hangs until timeout.
- Fix: Retry once on failure; if still failing, write `.claws/worker-<id>-completed.flag` as fallback

**BUG-A — Fast-path full log to detectCompletion**
- File: `mcp_server.js:2044` (_fpTick)
- Impact: If mission text itself contains the marker string on its own line, instant false positive — worker reports complete before even starting.
- Fix: Pass `markerScanFrom = offset_after_mission_injection` to detectCompletion

**BUG-B-close — claws_close doesn't cancel watchers**
- File: `mcp_server.js:1598-1601`
- Impact: After user calls `claws_close`, the detach watcher continues polling for up to 10 min, then reports "timeout" or "user-closed" depending on timing. Misleading logs, wasted cycles.
- Fix: Cancel matching `_detachWatcher` entry when `claws_close` is called; emit `system.worker.completed` with `completion_signal:'user-closed'`

**BUG-1 — canSpawn dead code**
- File: `extension/src/lifecycle-store.ts`
- Impact: SPAWN phase entered without enforcing spawn budget or count tracking. Risk of infinite spawn loops if orchestrator bugs out.
- Fix: Add call to `canSpawn()` in server.ts:863 before advancing to SPAWN

**BUG-5 — FAILED→PLAN silent no-op**
- File: `extension/src/lifecycle-store.ts:119`
- Impact: Session that hits FAILED is permanently stuck; user must restart.
- Fix: Either allow re-plan from FAILED (correct) or throw a clear error explaining FAILED is terminal

**BUG-7 — canEndSession dead code**
- File: `extension/src/lifecycle-store.ts`
- Impact: SESSION-END reached without verifying all terminals closed, all pending events drained.
- Fix: Add call to `canEndSession()` in the SESSION-END advance path

**BUG-D — claws_workers_wait checks only 2 of 4 signals**
- File: `mcp_server.js` (claws_workers_wait implementation)
- Impact: Workers that complete via `pub_complete` or `terminated` (Wave D) are not detected by `claws_workers_wait`. Orchestrators using `claws_workers_wait` get false "timeout" for these workers.
- Fix: Add checks for `pub_complete` pattern and `terminated` event in the wait loop

**BUG-C — _dswTick full log to detectCompletion**
- File: `mcp_server.js` (_dswTick)
- Same as BUG-A but for dispatch_subworker. Lower priority than BUG-F (which makes _dswTick completely non-functional anyway).

**BUG-E — _dswTick no heartbeat state machine**
- File: `mcp_server.js` (_dswTick)
- Impact: Sub-workers deployed via dispatch_subworker produce no live progress events. Wave army orchestrators are blind to per-worker progress.
- Fix: Instantiate HeartbeatStateMachine in _dswTick (10 lines, same pattern as _fpTick)

**HB-stale-tests — Two stale tests in heartbeat-parsers.test.js**
- File: `extension/test/heartbeat-parsers.test.js`
- Impact: Test suite has false failures (2 tests testing v1/v2 parsePromptIdle behavior that no longer ships)
- Fix: Update tests to use v3 pattern (bypass permissions footer) or delete them if v1/v2 are truly gone

### 7.3 P2 Bugs — Quality Issues

**BUG-2 — HARVEST→CLEANUP bypasses canCleanup**
- File: `extension/src/server.ts:1610-1622`
- Impact: CLEANUP begins before harvest callbacks complete. Potential data loss for harvest results written near the transition boundary.
- Fix: Add `canCleanup()` method and gate; advance only when harvest results are stable

**BUG-4 — reflect() bypasses canTransition**
- File: `extension/src/lifecycle-store.ts:251`
- Impact: REFLECT reachable from any phase. Semantically wrong but rarely triggers in practice.
- Fix: Route reflect() through canTransition check

**BUG-6 — phases_completed session-cumulative**
- File: `extension/src/lifecycle-store.ts` (phases_completed tracking)
- Impact: phases_completed is meaningless in multi-mission sessions
- Fix: Add `mission_phases_completed` counter, reset on each new plan

**BUG-7 — canEndSession dead code** (same as P1 above, cross-listed)

**BUG-8 — auto-REFLECT generates synthetic reflect text**
- File: `extension/src/lifecycle-engine.ts:48`
- Impact: REFLECT phase has no real analysis content. Post-session summaries are boilerplate.
- Fix: Either require explicit reflectText (no auto-advance from REFLECT) or implement a real summarizer

**BUG-H — fleet top-level monitor_arm_command is doc text**
- File: `mcp_server.js` (claws_fleet response construction)
- Impact: Orchestrators that try to use the top-level monitor_arm_command get a documentation string, not an executable command.
- Fix: Either build a real composite monitor command or remove the field entirely (per-worker commands are correct)

**BUG-VS03 — orphan scanner skips onTerminalClose**
- File: `extension/src/terminal-manager.ts` (orphan scan logic)
- Impact: When orphan scan closes a terminal, `system.worker.terminated` never fires (same root as H2 but a separate code path).
- Fix: Same as H2 fix, or explicitly call `onTerminalClose(entry)` from orphan scan close path

**BUG-VS04 — deactivate() doesn't kill ClawsPty processes**
- File: `extension/src/extension.ts` (deactivate hook)
- Impact: On VS Code reload/window close, ClawsPty child processes are orphaned as zombie processes.
- Fix: Iterate all active ClawsPty instances in deactivate() and call .kill()

**BUG-VS06 — spawnSync pgrep/ps blocks extension host**
- File: `extension/src/terminal-manager.ts` (foreground PID detection)
- Impact: Each `send` call runs a synchronous pgrep/ps (500ms each). With N terminals, this blocks the extension host for 500ms * N.
- Fix: Cache foreground PID, invalidate on process change events. Or use async child_process.exec.

**BUG-VS07 — SIGTERM targets foreground PID only, not process group**
- File: `extension/src/terminal-manager.ts` (kill logic)
- Impact: Killing the foreground process leaves background processes (node children, script(1) children) alive.
- Fix: SIGTERM the process group: `process.kill(-pgid, 'SIGTERM')`

**BUG-RELOAD-1 — VS Code reload sends no terminal close events**
- File: `extension/src/extension.ts`
- Impact: On VS Code reload (Cmd+Shift+P → Developer: Reload Window), no `onDidCloseTerminal` fires. Lifecycle stays OBSERVE, watchers run to timeout.
- Fix: Intercept `window.onDidChangeWindowState` or `deactivate()` to synthesize terminal close events before unload.

**BUG-RELOAD-2 — deactivate() timeout too short for socket cleanup**
- File: `extension/src/extension.ts` (deactivate implementation)
- Impact: Socket server close may not complete before VS Code kills the extension host (5s limit). Leaves port/socket file behind.
- Fix: Write socket file removal synchronously in deactivate() as the very first action, before async cleanup.

### 7.4 Bug Count Summary

| Priority | Count | Description |
|----------|-------|-------------|
| P0       | 3     | H2, BUG-28, BUG-F — ship blockers |
| P1       | 8     | H1, BUG-A, BUG-B-close, BUG-1, BUG-5, BUG-7, BUG-D, BUG-C/E |
| P2       | 10    | BUG-2/4/6/8/H, BUG-VS03/04/06/07, BUG-RELOAD-1/2 |
| **Total**| **21**| (consolidated, deduplicated from 40+ raw bug references) |

---

## 8. Terminal-to-Terminal Communication

### 8.1 The Problem Space

Claws currently supports **orchestrator → worker** communication (send mission, read output). It does NOT support **worker → orchestrator** or **worker → worker** communication through Claws itself. Workers that need to report partial results or request help from the orchestrator must use the pub/sub bus directly.

Three scenarios that require terminal-to-terminal communication:

1. **Worker requests a resource** from orchestrator (e.g., "I need the contents of this file, please send them")
2. **Worker reports partial result** that orchestrator should act on before completion
3. **Peer workers coordinate** (e.g., Worker A finds something relevant to Worker B's mission)

### 8.2 Pattern 1: Pub/Sub Direct (Current)

Workers publish to `worker.<peerId>.event` with `kind=progress` and a `message` field. The orchestrator subscribes with `claws_subscribe` and receives events via `claws_drain_events`.

**Pro:** Already implemented, uses existing infrastructure  
**Con:** Orchestrator must poll `claws_drain_events` on a tight loop. No backpressure. If orchestrator is in a long-running tool call, events queue up or drop.

**Use when:** Simple status updates that don't require orchestrator action.

### 8.3 Pattern 2: Shared File System Handshake

Worker writes a partial result to `.local/audits/<worker-id>-partial.md`. Orchestrator uses `claws_workers_wait` and then reads the file. For synchronization, worker publishes `worker.<peerId>.event kind=approach message='partial result ready at path'`.

**Pro:** Persistent, survives socket disconnects, easily inspectable  
**Con:** Requires orchestrator to poll for files; coupling via file naming convention

**Use when:** Partial results are large (too big for pub/sub payload) or need to survive session.

### 8.4 Pattern 3: Task Registry RPC

Use the task registry (`claws_task_assign`, `claws_task_update`, `claws_task_complete`) as an explicit RPC mechanism:

1. Orchestrator creates a task with `claws_task_assign(worker_id, 'provide-context', payload)`
2. Worker periodically polls `claws_task_list(filter=mine)` to see assigned tasks
3. Worker completes task with result payload via `claws_task_complete(task_id, result)`
4. Orchestrator receives `task.completed` event

**Pro:** Explicit RPC semantics, lifecycle tracked, observable  
**Con:** Worker must poll task_list. No push notification to worker (only to orchestrator).

**Use when:** Worker → orchestrator requests for data or decisions.

### 8.5 Pattern 4: Inline Heartbeat Payload

Extend the `kind=progress` heartbeat to carry a structured payload:

```json
{
  "kind": "progress",
  "message": "partial result ready",
  "payload": {
    "type": "partial_result",
    "content": "first 500 chars of finding..."
  }
}
```

Orchestrator extracts payload from heartbeat events during observation.

**Pro:** Low ceremony, uses existing heartbeat infrastructure  
**Con:** Heartbeat events aren't designed as request/response; no ACK mechanism. Payload size limits apply (pub/sub frame size).

**Use when:** Small structured updates that don't require orchestrator action (progress reports, statistics).

### 8.6 Pattern 5: Claws v3 — Bidirectional Channels (Design Proposal)

For true peer-to-peer worker communication, Claws v3 could add:
- `claws_channel_create(name, peers[])` — creates a named channel between specific peers
- `claws_channel_send(channel_id, message)` — send to channel
- Channel push frames arrive at all subscribed peers

This is not yet designed or planned. It would require:
- Channel registry in peer-registry.ts
- Channel message routing in server.ts pubsub handler
- New MCP tools and push frame type

**Recommendation:** Defer to v0.9.x. Patterns 1-4 cover the current use cases adequately.

---

## 9. Cross-System Consistency Requirements

### 9.1 The Five Subsystems

```
Subsystem A: Lifecycle state machine (lifecycle-store.ts, -engine.ts, -rules.ts)
Subsystem B: Terminal manager (terminal-manager.ts, claws-pty.ts)
Subsystem C: MCP dispatch (mcp_server.js: claws_worker, claws_fleet, etc.)
Subsystem D: Pub/sub bus (server.ts: peer-registry.ts)
Subsystem E: VS Code API surface (extension.ts)
```

### 9.2 Consistency Requirements Table

```
Requirement                   | A↔B | A↔C | A↔D | B↔D | C↔D | B↔E
------------------------------|-----|-----|-----|-----|-----|-----
Terminal ID consistent        |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓
Worker status consistent      |  ✓  |  ~  |  ✗  |  ~  |  ~  |  ~
Completion signal consistent  |  ✗  |  ✗  |  ✗  |  ✗  |  ✗  |  ✗
Close events consistent       |  ✓  |  ✗  |  ✗  |  ✗  |  ✗  |  ✗
Heartbeat topics consistent   |  N/A|  ~  |  ~  |  ~  |  ~  |  N/A
```

Legend: ✓ = consistent, ✗ = inconsistent (known bug), ~ = partial, N/A = not applicable

### 9.3 Terminal ID Consistency

Terminal IDs are assigned by `terminal-manager.ts` (monotonically increasing integer). All subsystems use the same ID. This is consistent. The only risk is ID reuse across VS Code sessions — IDs reset on extension reload, which could cause stale references if `.claws/lifecycle-state.json` persists across reloads.

**Requirement:** IDs should include a session epoch (e.g., `sess.<ISO-minute>.<seq>`) to avoid cross-session aliasing.

### 9.4 Worker Status Consistency

Worker status flows through:
1. `_detachWatcher` calls `mark-worker-status(id, status)` → persists in watcher state
2. `claws_lifecycle.advance` uses worker status to determine phase gates
3. Pub/sub events carry status in payload

Inconsistency: `mark-worker-status` and `lifecycle.advance` are two separate calls. If the call succeeds but the advance fails (e.g., lifecycle constraint violation), the internal watcher state shows 'complete' but lifecycle is still OBSERVE. The subsystems diverge.

**Requirement:** `mark-worker-status` should be atomic with `lifecycle.advance` — use a transaction or ensure both succeed or both fail.

### 9.5 Close Event Consistency

When a terminal closes, four things should happen consistently:
1. `byTerminal.delete(terminal)` — terminal-manager cleanup
2. `system.worker.terminated` published — bus event
3. `_detachWatcher` notified — watcher cleanup
4. Lifecycle advances (if all workers closed) — lifecycle update

Currently, only one code path does all four: user-X close (onDidCloseTerminal fires → finds entry in byTerminal → publishes terminated → watcher poll detects terminated).

For `claws_close` (programmatic close), only 1 of 4 happens (byTerminal cleanup). This is the H2 bug consequence.

**Requirement:** All close paths must invoke the same `onTerminalClose(entry)` handler. `TerminalManager.close()` must fire `onTerminalClose` explicitly since it bypasses VS Code's event.

### 9.6 Heartbeat Topic Consistency

The Wave Discipline Contract (WDC) mandates:

```
Heartbeat topic: worker.<peerId>.heartbeat
Phase topic:     worker.<peerId>.phase
Event topic:     worker.<peerId>.event
```

Where `peerId` is returned by `claws_hello`, NOT the role name.

BUG-06 (WDC note): Using role name in heartbeat topic doesn't reset the server's violation timer. The 25s timer is reset only by `worker.<peerId>.*` topics. Workers that use `worker.<role>.*` appear dead to the server even while publishing.

**Requirement:** All Wave Discipline Contract documentation and worker mission templates must prominently state: "Use peerId (returned by claws_hello), never role name, in heartbeat topics."

---

## 10. Phased Fix Roadmap

### 10.1 Tier 1: Must Fix Before Ship (v0.7.13 target)

These are the P0 + highest P1 bugs that create user-visible failures or data loss.

**Fix 1.1 — H2: byTerminal delete ordering** (P0)
- File: `extension/src/terminal-manager.ts:283-297`
- Change: Move `this.byTerminal.delete(entry.terminal)` to AFTER `entry.terminal.dispose()`
- Test: Add test — call `claws_close`, verify `system.worker.terminated` fires
- Risk: Low — a two-line reorder; no logic change
- Estimated effort: 30 min

**Fix 1.2 — BUG-F: _dswTick boot detection** (P0)
- File: `mcp_server.js` (_dswTick)
- Change: Replace `lines.slice(-5).some(l => l.includes('trust'))` with call to `parsePromptIdle(lines)`
- Test: Existing _dswTick integration test should now detect boot
- Risk: Low — using proven v3 function
- Estimated effort: 1 hour (includes test update)

**Fix 1.3 — BUG-28: PreToolUse hook matcher** (P0)
- File: `scripts/inject-settings-hooks.js`
- Change: Extend matcher to include MCP tool names or use a separate PreToolUse hook entry
- Test: Verify hook fires when `claws_worker` is called without Monitor armed
- Risk: Medium — hook registration format may need testing
- Estimated effort: 2 hours

**Fix 1.4 — BUG-A: Fast-path markerScanFrom** (P1)
- File: `mcp_server.js:2044` (_fpTick)
- Change: Record `markerScanFrom = logOffset` at mission injection time; pass to detectCompletion
- Test: Add test with mission text containing marker string — verify no false positive
- Risk: Low — same pattern already in runBlockingWorker
- Estimated effort: 1 hour

**Fix 1.5 — BUG-B-close: claws_close watcher cleanup** (P1)
- File: `mcp_server.js:1598-1601`
- Change: When `claws_close` is called, find matching entry in `_detachWatchers`, cancel tick, emit `system.worker.completed` with `completion_signal:'user-closed'`
- Test: Verify watcher stops after claws_close; verify system.worker.completed fires
- Risk: Medium — modifies watcher lifecycle
- Estimated effort: 2 hours

**Fix 1.6 — BUG-D: claws_workers_wait missing signals** (P1)
- File: `mcp_server.js` (claws_workers_wait)
- Change: Add checks for pub_complete pattern and `system.worker.terminated` events in the wait loop
- Test: Verify workers_wait returns when worker publishes pub_complete; verify when Wave D fires
- Risk: Low — additive logic
- Estimated effort: 2 hours

**Fix 1.7 — HB stale tests** (P1/hygiene)
- File: `extension/test/heartbeat-parsers.test.js`
- Change: Update 2 stale tests to use v3 parsePromptIdle (bypass permissions footer)
- Risk: Very low — test-only change
- Estimated effort: 30 min

**Tier 1 total estimated effort: ~10 hours**

### 10.2 Tier 2: Quality and Observability (v0.8.x target)

**Fix 2.1 — BUG-E: Heartbeat for runBlockingWorker and _dswTick** (P1)
- Add `HeartbeatStateMachine` instantiation to 3 remaining watchers
- Estimated effort: 4 hours

**Fix 2.2 — BUG-5: FAILED→PLAN recovery** (P1)
- Allow re-plan from FAILED, or throw a clear terminal error
- Estimated effort: 2 hours

**Fix 2.3 — BUG-VS03: orphan scan close event** (P2)
- Call `onTerminalClose(entry)` explicitly from orphan scan close path
- Estimated effort: 1 hour

**Fix 2.4 — BUG-VS04: deactivate kills ClawsPty** (P2)
- Iterate active ClawsPty instances in deactivate(), call .kill()
- Estimated effort: 1 hour

**Fix 2.5 — BUG-1/7: canSpawn and canEndSession wired up** (P2)
- Add calls in server.ts advance paths
- Estimated effort: 2 hours

**Fix 2.6 — BUG-2/4: canCleanup gate and reflect() route** (P2)
- Add canCleanup() method; route reflect() through canTransition
- Estimated effort: 2 hours

**Fix 2.7 — L8 re-enablement: Option D (two-phase)** (P2)
- Implement warning + 60s cancel window for tui_idle
- Estimated effort: 4 hours

**Fix 2.8 — H1: _pconnWrite retry + fallback flag file** (P1)
- Add 1 retry after 1s; write flag file as fallback
- Estimated effort: 2 hours

**Fix 2.9 — BUG-H: fleet monitor_arm_command** (P2)
- Remove misleading top-level field OR build a real composite command
- Estimated effort: 1 hour

**Fix 2.10 — BUG-6: phases_completed mission tracking** (P2)
- Add `mission_phases_completed` counter, reset on plan
- Estimated effort: 1 hour

**Tier 2 total estimated effort: ~20 hours**

### 10.3 Tier 3: Long-range (v0.9.x / future)

**Fix 3.1 — BUG-VS06: async foreground PID detection**
- Replace spawnSync pgrep with async exec + caching
- Estimated effort: 4 hours

**Fix 3.2 — BUG-VS07: SIGTERM process group**
- Kill process group instead of PID
- Estimated effort: 2 hours

**Fix 3.3 — BUG-RELOAD-1/2: VS Code reload terminal close synthesis**
- Synthesize close events in deactivate(); synchronous socket cleanup
- Estimated effort: 4 hours

**Fix 3.4 — L10: mission_failed heartbeat kind**
- Add mission_failed detection + publish logic
- Estimated effort: 2 hours

**Fix 3.5 — Session ID epoch for terminal ID uniqueness**
- Add session epoch prefix to terminal IDs
- Estimated effort: 2 hours

**Fix 3.6 — Bidirectional channels (v3 protocol)**
- Channel registry, routing, new MCP tools
- Estimated effort: 20+ hours (design-first)

**Tier 3 total estimated effort: ~34+ hours**

### 10.4 Dependency Graph

```
H2 fix → BUG-VS03 fix (orphan scan uses same handler after H2 fix)
BUG-F fix → BUG-C fix (same watcher, fix both together)
BUG-F fix → BUG-E fix (same watcher file, do all three together)
BUG-28 fix → Requires understanding hook registration format
BUG-A fix → Unlocks accurate fast-path completion
BUG-B-close fix → Enables clean close semantics for Tier 2 work
BUG-D fix → Required before wave_workers_wait is reliable
```

**Recommended fix order (Tier 1):**
1. H2 (byTerminal delete ordering) — 30 min, zero dependencies
2. HB stale tests — 30 min, zero dependencies
3. BUG-F + BUG-C + BUG-E (all in _dswTick together) — 3 hours
4. BUG-A + BUG-B-close (fast-path + close cleanup together) — 3 hours
5. BUG-D (workers_wait signals) — 2 hours
6. BUG-28 (PreToolUse matcher) — 2 hours (do last — separate from extension code)

---

## 11. Open Questions for Human Review

### Q1: Should FAILED be terminal or recoverable?

Current behavior: FAILED is a terminal state. `plan()` from FAILED is a no-op (BUG-5). The recovery path is restart.

**Design decision needed:**  
(A) Make FAILED terminal — document it clearly, throw a descriptive error from `plan()`, require restart.  
(B) Allow FAILED→PLAN — the workflow recovers, but this requires careful state cleanup (what if workers are still running?).

**Tradeoff:** Option A is simpler and safer. Option B is more user-friendly but risky — if partial worker state is not cleaned up before re-plan, the new session inherits stale worker registrations.

**Recommendation:** Option A with a clear error message and cleanup guidance. Document that `claws_close --all` is the recovery path before restart.

---

### Q2: Should the lifecycle be per-session or per-mission?

Current: Lifecycle is per-session (one state machine per VS Code window). Multiple missions within a session cascade through the lifecycle serially.

**Design decision needed:**  
(A) Keep per-session — simpler, current behavior  
(B) Make per-mission — each `plan()` creates a new sub-lifecycle, session lifecycle tracks all sub-lifecycles

**Tradeoff:** Per-mission is semantically cleaner (BUG-6 disappears; phases_completed is meaningful). But it requires lifecycle-state.json to track multiple concurrent lifecycles, and the auto-advance engine must handle parallel missions.

**Recommendation:** Per-mission is the right long-term model. Schedule for v0.8.x. For now, document the per-session behavior and fix BUG-6 with a `mission_phases_completed` counter.

---

### Q3: What is the right L8 tui_idle threshold?

L8 (disarmed) used a fixed threshold (30s of silence). Deep-thinking workers regularly exceed this.

**Design decision needed:** What is the right timeout? Options:
- 60s (2x original): catches most stuck workers but still kills deep thinkers occasionally
- 300s (5 min): rarely triggers false positives; long enough for most thinking; but 5 min of wasted time for actually stuck workers
- User-configurable: allows orchestrators to set timeout per mission

**Recommendation:** User-configurable per `claws_worker` call, with a default of 300s. Short missions use a low timeout (60s); long analysis missions use a high timeout (600s). Implement as Option D (two-phase warning) for all timeout values.

---

### Q4: Should claws_close publish system.worker.completed?

When a user or orchestrator calls `claws_close`, should the system auto-publish `system.worker.completed` with `completion_signal:'user-closed'`?

**Arguments for YES:**
- Consistent: all 4 completion signals are defined; user-close should trigger the lifecycle
- Prevents watcher from running to timeout when user manually closes
- Enables clean lifecycle advancement even on early-exit

**Arguments for NO:**
- Semantic: a user-closed terminal may not have completed its mission. Marking it 'complete' is misleading.
- Alternative: publish a separate `system.worker.user-closed` event that orchestrators can handle separately

**Recommendation:** Publish a new event type `system.worker.user-closed` (not conflated with completed). The lifecycle can treat user-closed as a special case: advance to RECOVER (not HARVEST), allowing the orchestrator to decide what to do.

---

### Q5: Should monitor_arm_command for fleet be a composite command?

`claws_fleet` returns a top-level `monitor_arm_command` that is currently broken (doc text). The fix options:

(A) Build a real composite monitor command: `stream-events.js | tee | grep --line-buffered -m<N> 'system.worker.completed'` that exits after N fleet workers complete  
(B) Remove the top-level field entirely — document that orchestrators should use per-worker commands  
(C) Return a bash one-liner that runs N parallel Monitor processes and waits for all

**Tradeoff:** Option A is correct but complex. Option B is simpler and less misleading. Option C is the most powerful but hardest to implement.

**Recommendation:** Option B (remove) in v0.7.13 to fix the misleading field. Option A in v0.8.x when the composite monitor pattern is validated.

---

### Q6: BUG-03 — When will capabilities:['push'] workaround be removed?

BUG-03 note says `capabilities:['push']` is required until a server-side fix lands. The Wave Discipline Contract mandates this workaround.

**Questions:**
- What exactly is the server-side fix needed?
- Is there a tracked issue for this?
- What is the expected timeline?

Without a tracked issue and timeline, this workaround will persist indefinitely and confuse future workers who don't understand why it's required.

**Recommendation:** Create a tracked issue. Document the root cause (server rejects claws_publish without push capability registered). The fix is in `peer-registry.ts` — capabilities field check on publish handler. Estimate: 2 hours. Should be fixed before v0.8.x.

---

### Q7: Should lifecycle-state.json persist across VS Code reloads?

Currently, `lifecycle-state.json` persists across extension activations. After a VS Code reload, the old lifecycle state is loaded — potentially with stale worker registrations (terminals that no longer exist).

**Design decision needed:**  
(A) Clear lifecycle state on every activation (simple, always-fresh start)  
(B) Persist and reconcile — compare persisted terminal IDs with current `terminalManager.list()` and tombstone missing terminals  
(C) Persist with session epoch — only load state if epoch matches current session ID

**Recommendation:** Option C (session epoch). Add a `sessionEpoch` field to lifecycle-state.json (ISO timestamp of extension activation). On load, if epoch doesn't match, treat as fresh start. This is simple (one extra field), avoids stale state, and preserves in-progress state for quick VS Code focus/unfocus cycles.

---

### Q8: Should the Claws extension support multiple concurrent lifecycle instances?

Currently, one lifecycle per VS Code window. A VS Code window with multiple root folders (multi-root workspace) has one lifecycle for all folders.

**Design decision:** Should lifecycle be per-folder (scoped to the workspace folder that owns the socket) or per-window?

**Recommendation:** Keep per-window for now. Per-folder requires socket scoping (which is already done in multi-root but the lifecycle is not). Tag as v0.9.x enhancement.

---

### Q9: How should claws_workers_wait handle partial completion?

If 5 workers are dispatched and 4 complete but 1 times out, `claws_workers_wait` currently:
- Waits for all 5
- Returns timeout error

Should it instead:
- Return partial results after N complete
- Allow `min_complete=4 out of 5` semantics
- Report per-worker status (complete/timeout/error) regardless

**Recommendation:** Add `{ results: [{ id, status, signal }] }` to the response, populated as workers complete. Add `min_complete` option. Return when `min_complete` workers are done; report remaining as `pending`. This matches real orchestration needs where one slow worker shouldn't block the harvest of 4 complete ones.

---

### Q10: Is the 5-layer enforcement chain the right architecture?

The enforcement chain has 5 layers: global CLAUDE.md → project CLAUDE.md → ECC rules → SessionStart → PreToolUse. This grew organically.

**Problems observed:**
- Layer 3 (ECC rules) only loads for ECC plugin users, not stock Claude Code
- Layer 5 (PreToolUse Bash matcher) has wrong matcher (BUG-28)
- Layers 1-2 are always loaded but passive (text instructions only, not enforced)

**Design question:** Is it better to consolidate enforcement into fewer, more reliable layers, or to keep the belt-and-suspenders multi-layer approach?

**Recommendation:** Keep multi-layer but fix each layer's coverage. The CLAUDE.md layers (1-2) are passive but reliable (always loaded). Fix PreToolUse matcher (BUG-28) and add an MCP-level gate. Remove the ECC-only layer (3) if it can't be guaranteed to load for all users. Document clearly which layers apply to which users.

---

## 12. References — File:Line Citations

All claims in this document are backed by one or more of these sources:

### Lifecycle Core (audit-lifecycle-core.md)

```
BUG-1 (canSpawn dead code)           lifecycle-store.ts (conceptual), server.ts:863
BUG-2 (HARVEST→CLEANUP no gate)      server.ts:1610-1622
BUG-4 (reflect bypasses canTrans)    lifecycle-store.ts:251
BUG-5 (FAILED→PLAN no-op)           lifecycle-store.ts:119
BUG-6 (phases_completed session)     lifecycle-store.ts (phases tracking)
BUG-7 (canEndSession dead)           lifecycle-store.ts
BUG-8 (auto-REFLECT synthetic text)  lifecycle-engine.ts:48
BUG-B double-call pattern            mcp_server.js (detach watcher completion)
Phase table (10 phases)              lifecycle-store.ts:1-50 (type definitions)
canTransition truth table            lifecycle-rules.ts (full table)
Auto-advance cascade rules           lifecycle-engine.ts (advance triggers)
```

### VS Code Integration (audit-vscode-integration.md)

```
H2 (byTerminal delete before dispose) terminal-manager.ts:283-297
BUG-RELOAD-1/2 (no close on reload)  extension.ts (deactivate hook)
BUG-VS03 (orphan scan no event)       terminal-manager.ts (orphan scan close path)
BUG-VS04 (deactivate no kill)         extension.ts (deactivate)
BUG-VS06 (spawnSync blocks host)      terminal-manager.ts (foreground PID detection)
BUG-VS07 (SIGTERM no process group)   terminal-manager.ts (kill logic)
Close path 3.1 (RPC close) ✓          terminal-manager.ts close + onDidCloseTerminal
Close path 3.2 (user X) ✓             extension.ts onDidCloseTerminal handler
Close path 3.3 (VS Code reload) ✗     extension.ts deactivate
Close path 3.6 (orphan scan) ✗        terminal-manager.ts orphan scan
```

### MCP Dispatch (audit-mcp-dispatch.md)

```
H1 (_pconn write silent drop)         mcp_server.js (detach watcher, try/catch)
BUG-A (fast-path full log)            mcp_server.js:2044 (_fpTick detectCompletion)
BUG-B-close (close no cancel)         mcp_server.js:1598-1601
BUG-C (_dswTick full log)             mcp_server.js (_dswTick)
BUG-D (workers_wait 2 of 4 signals)   mcp_server.js (claws_workers_wait)
BUG-E (_dswTick no HB)                mcp_server.js (_dswTick)
BUG-F (_dswTick stale boot detect)    mcp_server.js (_dswTick)
BUG-H (fleet monitor_arm_cmd doc)     mcp_server.js (claws_fleet response)
BUG-28 (PreToolUse wrong matcher)     scripts/inject-settings-hooks.js
_fpTick full behavior description     mcp_server.js:2000-2150 (approx)
claws_fleet parallel dispatch         mcp_server.js (claws_fleet implementation)
4 completion signals definition       mcp_server.js (detectCompletion function)
```

### Heartbeat Integration (audit-heartbeat-integration.md)

```
L1-L10 plan definition               docs/heartbeat-action-plan.md (phased roadmap)
L1-L3 shipped                        extension/src/heartbeat-parsers.ts (parsers)
L4-L9 fast-path only                 mcp_server.js (_fpTick HeartbeatStateMachine)
L8 disarmed                          commit ed27870 (tui_idle DISARM)
L10 not shipped                      mcp_server.js (mission_failed absent)
parsePromptIdle v1/v2/v3 history     mcp_server.js (parsePromptIdle function)
HB stale tests                       extension/test/heartbeat-parsers.test.js
HeartbeatStateMachine states         extension/src/hb-state-machine.ts (conceptual)
5 L8 re-enablement options           docs/heartbeat-action-plan.md
```

### History and Past Approaches (audit-history-and-past-approaches.md)

```
6 completion detection eras           audit-history-and-past-approaches.md §2
F1/F2/F3 convention + M15 origin      audit-history-and-past-approaches.md §5
Mission injection patterns            audit-history-and-past-approaches.md §3
Wave Discipline Contract (9 items)    CLAUDE.md (global), claws-default-behavior.md
BUG-03 capabilities:push workaround   CLAUDE.md (global) BUG-03 note
BUG-06 role name vs peerId            CLAUDE.md (global) BUG-06 note
9 past audit findings (M01-M62)       audit-history-and-past-approaches.md §8
19 slash command inventory            .claude/commands/ (ls count)
```

### Architecture (docs/ARCHITECTURE.md)

```
10 principles (P1-P10)                ARCHITECTURE.md §3
System layers diagram                 ARCHITECTURE.md §2
Wire protocols (claws/1, claws/2)     ARCHITECTURE.md §4
10-phase lifecycle table              ARCHITECTURE.md §5
Enforcement chain (6 layers)          ARCHITECTURE.md §6
Test infrastructure (109 files/143)   ARCHITECTURE.md §7
Anti-patterns catalog (A1-A10)        ARCHITECTURE.md §9
Known gaps (Wave C/D/V/E)             ARCHITECTURE.md §10
```

### Code Cross-References

```
extension/src/lifecycle-store.ts      — Phase state storage, gate methods
extension/src/lifecycle-engine.ts     — Auto-advance trigger logic
extension/src/lifecycle-rules.ts      — canTransition truth table
extension/src/terminal-manager.ts     — Terminal lifecycle, H2 bug location
extension/src/server.ts               — RPC handler, lifecycle advances
extension/src/peer-registry.ts        — Peer registration, heartbeat reset
extension/src/task-registry.ts        — Task lifecycle
extension/src/claws-pty.ts            — PTY wrapper, process management
extension/src/extension.ts            — VS Code activation, deactivate
mcp_server.js                         — All MCP tools, dispatch logic, watchers
scripts/inject-settings-hooks.js      — Hook registration (BUG-28 location)
scripts/stream-events.js              — Monitor sidecar
extension/test/heartbeat-parsers.test.js — Stale tests (HB-stale)
docs/heartbeat-action-plan.md         — L1-L10 phased plan
docs/heartbeat-architecture.md        — HB design doc (foundation)
docs/ARCHITECTURE.md                  — Canonical architectural anchor
```

---

## Appendix A: Prioritized Fix Order (Condensed)

For an engineer starting fresh:

**Week 1 (Tier 1, ~10 hours total):**
1. `terminal-manager.ts:283-297` — move byTerminal.delete after dispose (H2) — 30 min
2. `extension/test/heartbeat-parsers.test.js` — update stale tests — 30 min
3. `mcp_server.js` _dswTick — replace 'trust' with parsePromptIdle, add markerScanFrom, add HeartbeatStateMachine (BUG-F+C+E together) — 3 hours
4. `mcp_server.js` _fpTick — add markerScanFrom (BUG-A), add watcher cancellation to claws_close (BUG-B-close) — 3 hours
5. `mcp_server.js` claws_workers_wait — add pub_complete + terminated signal checks (BUG-D) — 2 hours
6. `scripts/inject-settings-hooks.js` — extend PreToolUse matcher (BUG-28) — 2 hours

**After Week 1:** All P0 bugs fixed. Major P1 bugs fixed. Test suite should be green.

**Month 2 (Tier 2, ~20 hours):**
- Heartbeat for runBlockingWorker + _dswTick (BUG-E backport) — 4h
- FAILED recovery (BUG-5) — 2h
- H1 _pconn retry + flag file — 2h
- canSpawn/canEndSession wired up (BUG-1/7) — 2h
- canCleanup gate + reflect() route (BUG-2/4) — 2h
- L8 re-enablement Option D (two-phase) — 4h
- BUG-6 phases_completed mission tracking — 1h
- BUG-H fleet monitor_arm_command remove/fix — 1h
- BUG-VS03/04 (orphan scan + deactivate) — 2h

**Quarter 3+ (Tier 3):**
- Async foreground PID detection (BUG-VS06) — 4h
- SIGTERM process group (BUG-VS07) — 2h
- VS Code reload close synthesis (BUG-RELOAD-1/2) — 4h
- L10 mission_failed heartbeat — 2h
- Session ID epoch for terminal ID uniqueness — 2h
- Per-mission lifecycle model — 8h
- Bidirectional channels (v3 protocol) — 20h+

---

## Appendix B: Invariants That Must Never Break

The following invariants are load-bearing — breaking them introduces cascading failures:

```
INV-1: claws_worker must always pass correlation_id to detectCompletion
INV-2: system.worker.completed must fire for EVERY worker termination path
INV-3: heartbeat topics must use peerId, never role name
INV-4: capabilities:['push'] must be in every claws_hello call (until BUG-03 fixed)
INV-5: F3 printf must be a Bash tool call, never an assistant message
INV-6: missions must be inline, never file-referrer
INV-7: --no-verify is forbidden; all commits must pass pre-commit hooks
INV-8: Worker missions must call claws_hello within 60s of boot
INV-9: _detachWatchers must be cancelled when terminal is closed
INV-10: byTerminal must be valid when onDidCloseTerminal fires
```

INV-2 and INV-10 are currently violated (H2). INV-9 is currently violated (BUG-B-close). Fixing H2 and BUG-B-close restores all 10 invariants.

---

## Appendix C: Detailed Fix Specifications

This appendix provides exact change specifications for all Tier 1 fixes, giving future engineers a precise diff-level description of what to change and why.

### C.1 Fix Spec: H2 — byTerminal Delete Ordering

**File:** `extension/src/terminal-manager.ts`  
**Location:** ~line 283-297 (`close(id: number)` method)

**Current (broken) code pattern:**
```typescript
close(id: number): void {
  const entry = this.byId.get(id);
  if (!entry) return;

  // WRONG ORDER: deletes from map before dispose fires event
  this.byTerminal.delete(entry.terminal);
  this.byId.delete(id);

  entry.terminal.dispose();  // onDidCloseTerminal fires HERE — but map is already empty
}
```

**Fixed code pattern:**
```typescript
close(id: number): void {
  const entry = this.byId.get(id);
  if (!entry) return;

  // Mark as closing to prevent re-entrant handling
  entry.closing = true;

  // dispose() fires onDidCloseTerminal synchronously in some VS Code versions,
  // asynchronously in others. Keep entry in byTerminal until after dispose.
  entry.terminal.dispose();

  // Now safe to delete — onDidCloseTerminal has already fired (sync path)
  // For async path: onDidCloseTerminal will fire with entry still in map ✓
  this.byTerminal.delete(entry.terminal);
  this.byId.delete(id);
}
```

**Alternative approach (safer for async onDidCloseTerminal):**
```typescript
close(id: number): void {
  const entry = this.byId.get(id);
  if (!entry) return;

  // Capture reference before any disposal
  const terminal = entry.terminal;

  // Let onDidCloseTerminal fire with full map integrity
  terminal.dispose();

  // Schedule cleanup after current event loop turn so async onDidCloseTerminal fires first
  setImmediate(() => {
    this.byTerminal.delete(terminal);
    this.byId.delete(id);
  });
}
```

**Test to add:**
```typescript
test('claws_close publishes system.worker.terminated', async () => {
  const { id } = await claws_create({ name: 'test-h2', wrapped: true });
  
  const events: string[] = [];
  await claws_subscribe({ topic: 'system.worker.*' });
  
  await claws_close({ id });
  
  // Drain events — terminated should fire
  const drained = await claws_drain_events({ timeout_ms: 1000 });
  const topics = drained.events.map(e => e.topic);
  
  expect(topics).toContain('system.worker.terminated');
});
```

**Risk assessment:**
- Low risk: the change is a reorder, not a logic change
- The `closing` flag prevents double-handling in edge case where dispose fires synchronously AND onDidCloseTerminal fires asynchronously later
- Zero impact on non-close code paths

---

### C.2 Fix Spec: BUG-F — _dswTick Boot Detection

**File:** `mcp_server.js`  
**Location:** `_dswTick` function (approximate: search for `'trust'` near `_dswTick`)

**Current (broken) pattern:**
```javascript
// _dswTick boot detection — v1 pattern, stale
const lastLines = lines.slice(-5);
const bootDetected = lastLines.some(l => l.includes('trust'));
```

**Fixed pattern:**
```javascript
// _dswTick boot detection — v3 pattern (same as _fpTick)
const last30 = lines.slice(-30);
const bootDetected = parsePromptIdle(last30);
```

Where `parsePromptIdle` is already defined in the same file (used by `_fpTick`):
```javascript
function parsePromptIdle(lines) {
  const last30 = lines.slice(-30).join('\n');
  return last30.includes('bypass permissions on');
}
```

**Also fix BUG-C simultaneously (in the same function):**

Current (broken) — full log to detectCompletion:
```javascript
// BUG-C: scans full log including mission text
const result = detectCompletion(fullLogText, terminalId);
```

Fixed:
```javascript
// Record offset at mission inject time
if (!entry.markerScanFrom && missionInjected) {
  entry.markerScanFrom = currentLogOffset;
}

// Only scan content after mission injection
const scanText = markerScanFrom 
  ? fullLogText.slice(markerScanFrom) 
  : fullLogText;
const result = detectCompletion(scanText, terminalId);
```

**Also fix BUG-E simultaneously (in the same function init):**
```javascript
// Add HeartbeatStateMachine — same 10 lines as _fpTick
const hbsm = new HeartbeatStateMachine(terminalId, (kind, message) => {
  publishHeartbeat(terminalId, kind, message);
});

// In the tick loop body:
hbsm.onLogUpdate(newLines);  // newLines = lines since last tick
```

**Risk assessment:**
- Medium risk: boot detection change affects all dispatch_subworker calls
- BUG-C fix is additive (adds markerScanFrom tracking)
- BUG-E fix is additive (adds new HeartbeatStateMachine)
- All three changes are independent and can be rolled back individually
- Test: existing _dswTick integration test, plus new HB event test

---

### C.3 Fix Spec: BUG-A — Fast-Path markerScanFrom

**File:** `mcp_server.js`  
**Location:** `_fpTick` function (line ~2044)

**Current (broken):**
```javascript
// BUG-A: detectCompletion sees full log text
// If mission text contains marker, instant false positive
const detected = detectCompletion(await readFullLog(terminalId), terminalId);
```

**Fixed:**
```javascript
// Track when mission was injected
if (!entry.missionInjected && missionWasSentThisTick) {
  entry.missionInjectedAt = await getLogOffset(terminalId);
}

// Only scan post-injection content
const fullLog = await readFullLog(terminalId);
const scanFrom = entry.missionInjectedAt ?? 0;
const scanContent = fullLog.slice(scanFrom);
const detected = detectCompletion(scanContent, terminalId);
```

**The `getLogOffset(terminalId)` function** already exists (used by `claws_exec`): it returns the current byte position in the pty log. Use this to anchor `markerScanFrom`.

**Edge case:** If the worker completes before `missionInjectedAt` is recorded (very fast worker, same tick as injection), `scanFrom = 0` and BUG-A resurfaces. Fix: set `missionInjectedAt` to the byte position BEFORE injecting, not after.

**Risk assessment:**
- Low risk: additive change (adds offset tracking)
- The false positive scenario is rare in practice (mission must contain exact marker text on its own line)
- But it's a correctness issue that can cause silent data loss (worker marked complete before starting)

---

### C.4 Fix Spec: BUG-B-close — claws_close Watcher Cleanup

**File:** `mcp_server.js`  
**Location:** `claws_close` handler (~line 1598-1601)

**Current (broken):**
```javascript
case 'close': {
  const { id } = args;
  terminalManager.close(id);
  return { ok: true };
  // BUG: _detachWatcher for id is still running, will eventually timeout
}
```

**Fixed:**
```javascript
case 'close': {
  const { id } = args;
  
  // Cancel any running detach watcher for this terminal
  const watcherIndex = _detachWatchers.findIndex(w => w.terminalId === id);
  if (watcherIndex !== -1) {
    const watcher = _detachWatchers[watcherIndex];
    clearInterval(watcher.intervalId);
    _detachWatchers.splice(watcherIndex, 1);
    
    // Emit user-closed event so orchestrators monitoring via bus are notified
    if (_pconn) {
      await _pconnWrite({
        push: 'message',
        protocol: 'claws/2',
        topic: 'system.worker.user-closed',
        payload: {
          terminal_id: id,
          completion_signal: 'user-closed',
          timestamp: new Date().toISOString()
        }
      }).catch(e => console.error('claws_close user-closed event write error', e));
    }
    
    // Also update lifecycle
    try {
      await lifecycleAdvanceIfReady();
    } catch (e) {
      // Non-fatal — lifecycle advance is best-effort on user close
    }
  }
  
  terminalManager.close(id);
  return { ok: true };
}
```

**Risk assessment:**
- Medium risk: modifies watcher cleanup logic
- The `_detachWatchers` splice must use the correct index (splice is index-based, not watcher-reference-based; don't splice during iteration)
- `system.worker.user-closed` is a new topic — orchestrators must be updated to handle it

---

### C.5 Fix Spec: BUG-D — claws_workers_wait Missing Signals

**File:** `mcp_server.js`  
**Location:** `claws_workers_wait` handler

**Current (checks only 2 signals):**
```javascript
// Check marker and error_marker only
const markerFound = logContent.includes(entry.expectedMarker);
const errorFound = logContent.includes(entry.errorMarker);
if (markerFound || errorFound) {
  completedIds.push(id);
}
```

**Fixed (checks all 4 signals):**
```javascript
// 1. Marker
const markerFound = markerScanFrom 
  ? logContent.slice(markerScanFrom).includes(entry.expectedMarker)
  : logContent.includes(entry.expectedMarker);

// 2. Error marker
const errorFound = logContent.includes(entry.errorMarker);

// 3. pub_complete: worker published [CLAWS_PUB] topic=... pattern in log
const pubCompletePattern = /\[CLAWS_PUB\]\s+topic=/;
const pubFound = pubCompletePattern.test(logContent.slice(markerScanFrom ?? 0));

// 4. terminated: check if system.worker.terminated was received for this id
const terminatedSet = getRecentTerminatedIds();  // new helper: tracks last N terminated events
const termFound = terminatedSet.has(id);

if (markerFound || errorFound || pubFound || termFound) {
  const signal = markerFound ? 'marker' 
    : errorFound ? 'error_marker' 
    : pubFound ? 'pub_complete' 
    : 'terminated';
  completedIds.push({ id, signal });
}
```

**New helper `getRecentTerminatedIds()`:**
Subscribe to `system.worker.terminated` at MCP server startup; maintain a `Set<number>` of recently terminated terminal IDs (TTL: 10 min). Workers_wait queries this set.

**Risk assessment:**
- Low risk: additive signal checks
- `getRecentTerminatedIds()` requires a persistent subscription — ensure it's set up at MCP server init, not lazily
- The pub_complete regex should be the same as used in detectCompletion to avoid divergence

---

### C.6 Fix Spec: BUG-28 — PreToolUse Hook Matcher

**File:** `scripts/inject-settings-hooks.js`

**Current (broken matcher):**
```javascript
hooks.push({
  type: 'PreToolUse',
  matcher: 'Bash',  // BUG-28: Bash only
  command: '...',
});
```

**Problem:** VS Code extension MCP tools are called as `mcp__claws__claws_worker`, `mcp__claws__claws_fleet`, etc. from the Claude Code perspective. The PreToolUse hook needs to match these names.

**Fixed — Option A (explicit MCP tool names):**
```javascript
const SPAWN_CLASS_TOOLS = [
  'mcp__claws__claws_worker',
  'mcp__claws__claws_fleet',
  'mcp__claws__claws_dispatch_subworker',
  'mcp__claws__claws_wave_create',
];

hooks.push({
  type: 'PreToolUse',
  matcher: `(${SPAWN_CLASS_TOOLS.join('|')})`,
  command: path.join(hooksDir, 'pre-tool-use-claws.js'),
});
```

**Fixed — Option B (regex catch-all):**
```javascript
hooks.push({
  type: 'PreToolUse',
  matcher: 'mcp__claws__claws_(worker|fleet|dispatch_subworker|wave_create)',
  command: path.join(hooksDir, 'pre-tool-use-claws.js'),
});
```

**Also update `pre-tool-use-claws.js`** to check if a Monitor is already armed:
```javascript
// pre-tool-use-claws.js
const { execSync } = require('child_process');

// Check if any Monitor process is watching events.log
try {
  execSync('pgrep -f "tail.*events.log"', { stdio: 'pipe' });
  // Monitor running — no warning needed
  process.exit(0);
} catch {
  // No Monitor running — warn
  console.error(
    '[claws] WARNING: No Monitor armed. Arm one before spawning workers:\n' +
    'Bash(command="tail -F .claws/events.log", run_in_background=true)'
  );
  // Don't block (exit 0) — just warn
  process.exit(0);
}
```

**Risk assessment:**
- Low risk: additive hook, warning only (doesn't block)
- Matcher format must be validated against the Claude Code hook matcher syntax
- May need testing in a real session to verify the hook fires for MCP tool calls

---

## Appendix D: Test Coverage Plan

### D.1 Existing Test Infrastructure

```
extension/test/ — 109 test files, ~143 test targets (v0.6.0 baseline)

Key test suites:
- smoke.test.js                — basic extension activation
- native-bundle.test.js        — bundled node-pty
- config-reload.test.js        — settings reload
- capture-store.test.js        — pty capture
- oversized-line.test.js       — log overflow
- pty-lifecycle.test.js        — pty create/destroy
- profile-provider.test.js     — shell profile detection
- multi-connection.test.js     — concurrent clients
- claws-v2-hello.test.js       — peer registry (6 checks)
- claws-v2-pubsub.test.js      — pub/sub (11 checks)
- claws-v2-tasks.test.js       — task registry (16 checks)
- worker-fixes-v079.test.js    — v0.7.9 regression tests
- version-drift.test.js        — version consistency
- heartbeat-parsers.test.js    — HB parser tests (2 stale)
```

### D.2 Missing Tests — Tier 1 Bugs

For each Tier 1 fix, a corresponding test must exist before shipping:

**H2 test** (new file: `claws-v2-close.test.js`):
```
Test 1: claws_close on worker terminal → system.worker.terminated fires
Test 2: auto-close (orphan scan) → system.worker.terminated fires
Test 3: user-X close (simulated) → system.worker.terminated fires
Test 4: claws_close on non-worker terminal → no crash (graceful)
```

**BUG-F test** (extend `worker-fixes-v079.test.js` or new `worker-dispatch-subworker.test.js`):
```
Test 1: dispatch_subworker with short mission → boot detected → mission injected → completion
Test 2: dispatch_subworker boot detection uses 'bypass permissions on' not 'trust'
Test 3: dispatch_subworker with marker in mission text → no false positive (BUG-C)
Test 4: dispatch_subworker → heartbeat events published on bus (BUG-E)
```

**BUG-A test** (extend `worker-fixes-v079.test.js`):
```
Test 1: claws_worker mission containing marker text → no false positive before worker runs
Test 2: claws_worker completes normally → marker detected → completion event fires
Test 3: markerScanFrom recorded at injection time → detectCompletion only scans post-inject
```

**BUG-B-close test** (extend `claws-v2-close.test.js`):
```
Test 1: claws_close → _detachWatcher cancelled (no more ticks)
Test 2: claws_close → system.worker.user-closed fires
Test 3: claws_close while watcher in mid-tick → tick completes cleanly then watcher stops
```

**BUG-D test** (new or extend `claws-v2-tasks.test.js`):
```
Test 1: worker completes via pub_complete → claws_workers_wait returns (not timeout)
Test 2: worker closed via Wave D → claws_workers_wait returns with signal:'terminated'
Test 3: worker completes via marker → claws_workers_wait returns with signal:'marker' (regression)
Test 4: worker completes via error_marker → claws_workers_wait returns (regression)
```

**BUG-28 test** (new: `pre-tool-use-hook.test.js`):
```
Test 1: claws_worker called without Monitor → PreToolUse hook fires warning
Test 2: claws_fleet called without Monitor → PreToolUse hook fires warning
Test 3: claws_worker called with Monitor armed → no warning
Test 4: Bash tool called → PreToolUse hook does not fire (Bash has its own hook)
```

**HB stale tests fix** (update `heartbeat-parsers.test.js`):
```
Test stale-1 (update): parsePromptIdle returns true for 'bypass permissions on' text
Test stale-2 (update): parsePromptIdle returns false for text without bypass footer
New Test 3: parsePromptIdle v3 false positive check for ❯ without bypass footer
New Test 4: parsePromptIdle works with ANSI-stripped log output
```

### D.3 Missing Tests — Tier 2 Bugs

**Lifecycle gate tests** (new `lifecycle-gates.test.js`):
```
Test 1: canSpawn called before SPAWN advance → correct gate enforcement
Test 2: canEndSession called before SESSION-END → correct gate enforcement
Test 3: canCleanup called before CLEANUP → blocks if harvest incomplete
Test 4: reflect() routes through canTransition → invalid phase throws error
Test 5: FAILED → plan() → throws clear error (not silent no-op)
Test 6: phases_completed resets at each new plan (mission-scoped)
```

**Heartbeat watcher coverage tests** (new `heartbeat-all-watchers.test.js`):
```
Test 1: runBlockingWorker detach worker → heartbeat events fire on bus
Test 2: _dswTick worker → heartbeat events fire on bus
Test 3: fast-path worker → heartbeat events fire on bus (regression)
Test 4: All 3 watchers → HB state machine reaches COMPLETE on mission complete
```

### D.4 Test Architecture Recommendation

Current: tests call the extension API directly (in-process). This misses:
- Socket framing issues (binary framing, partial writes)
- Network timing (socket reconnect between spawn and complete)
- Multi-client contention (two orchestrators on same socket)

Recommendation for v0.8.x: add an **integration test harness** that:
1. Spawns the real extension in a headless VS Code (vscode-test framework)
2. Connects via the real Unix socket
3. Drives real worker spawns with real terminal processes
4. Verifies real pub/sub events arrive at real subscribers

This level of testing is the only reliable way to catch H1 (_pconn disconnect), H2 (event ordering), and BUG-RELOAD-1/2 (deactivate timing) before production.

---

## Appendix E: Glossary

```
Term              | Definition
------------------|-----------------------------------------------------------
_detachWatcher    | In-process interval-based watcher in mcp_server.js that polls
                  | pty log for completion signals. One per dispatched worker.
_fpTick           | Fast-path tick function. Watcher for claws_worker fast-path
                  | missions. Has heartbeat L4-L9.
_dswTick          | Dispatch-subworker tick function. Watcher for claws_dispatch_
                  | subworker missions. Has BUG-F/C/E.
byTerminal        | WeakMap<VsCodeTerminal, TerminalEntry> in TerminalManager.
                  | Lookup key for onDidCloseTerminal handler.
byId              | Map<number, TerminalEntry> in TerminalManager.
                  | Lookup key for MCP command handlers.
canTransition     | Truth table function in lifecycle-rules.ts. Returns bool for
                  | (from, to) phase pair validity.
claws/1           | Original protocol: newline-delimited JSON, no peer identity.
claws/2           | Extended protocol: peer registry, pub/sub, tasks, server-push
                  | frames (no rid field).
ClawsPty          | Wrapper around node-pty that adds log capture, ANSI stripping,
                  | and byte offset tracking.
correlation_id    | UUID generated at claws_worker spawn. Flows through mission
                  | text + Monitor grep to isolate one worker's events.
D+F architecture  | Declaration + Forwarding: correlation_id declared before spawn,
                  | both spawn AND monitor registered atomically before MCP return.
detectCompletion  | Function in mcp_server.js that scans log text for any of 4
                  | completion signals (marker, error_marker, pub_complete, terminated).
HeartbeatState-   | State machine (BOOTING/READY/WORKING/POST_WORK/COMPLETE) that
Machine           | publishes heartbeat events based on log content changes.
L1-L10            | Heartbeat enhancement levels (leveled rollout plan).
lifecycle-engine  | Auto-advance trigger logic. Fires after each state mutation to
                  | cascade phases forward.
lifecycle-rules   | canTransition truth table. Separate file from lifecycle-store.
lifecycle-store   | State storage. Holds current phase, worker registrations, audit
                  | log. Emits 'advanced' events.
markerScanFrom    | Byte offset in pty log. detectCompletion only scans content after
                  | this offset, preventing false positives from mission text.
MCP               | Model Context Protocol. Claude Code's tool interface. 38 claws
                  | tools exposed via mcp_server.js.
onDidCloseTerminal| VS Code API event. Fires when a terminal is closed. The extension
                  | handles this to publish system.worker.terminated.
parsePromptIdle   | Function that detects when Claude Code TUI has finished booting.
                  | v3: looks for 'bypass permissions on' in last 30 lines.
_pconn            | Persistent claws/2 socket connection from mcp_server.js to the
                  | extension. Used to publish events on behalf of workers.
peerId            | Unique identifier returned by claws_hello. Must be used in
                  | heartbeat topics, NOT role name.
pub_complete      | Completion signal: worker publishes '[CLAWS_PUB] topic=...'
                  | visible in pty log AND as a pub/sub event.
runBlockingWorker | Shared dispatch function used by claws_fleet and claws_dispatch_
                  | subworker. Two modes: detach (non-blocking) and blocking (poll).
stream-events.js  | Sidecar script. Subscribes to claws/2 bus; emits each push frame
                  | as one stdout line. Enables Monitor to consume event stream.
system.worker.    | Pub/sub topic published when worker terminal closes.
terminated        | Only fires via user-X or RPC close (H2: broken for programmatic).
system.worker.    | Pub/sub topic published when worker completes successfully (any
completed         | of 4 signals). Primary orchestrator completion signal.
terminated (Wave D)| Fourth completion signal: onDidCloseTerminal fires → server
                  | publishes system.worker.terminated → watcher picks up.
Wave Discipline   | 9-item mandatory contract for sub-workers in Wave Army missions.
Contract (WDC)    | Requires: claws_hello within 60s, capabilities:['push'], heartbeat
                  | every 20s using peerId, phase events, complete event before F3.
Wave D            | Safety net architecture: onDidCloseTerminal → terminated event.
                  | Currently broken by H2 for programmatic close.
wrapped terminal  | Terminal running under script(1) for full pty byte capture.
                  | Required for claws_worker and heartbeat to work.
```

---

## Appendix F: Architectural Decision Records (ADRs)

### ADR-001: Non-blocking MCP transport by default

**Status:** Accepted (v0.7.9)  
**Context:** MCP stdio transport has no timeout mechanism. A long-running tool call (e.g., claws_worker waiting for 10-minute worker) blocks the entire orchestrator session.  
**Decision:** claws_worker, claws_fleet, claws_dispatch_subworker return immediately with terminal_ids. Completion is async via pub/sub events + claws_workers_wait.  
**Consequences:**
- (+) Orchestrator can dispatch N workers and observe them via Monitor
- (-) Requires orchestrator to arm Monitor before dispatch
- (-) Creates the Monitor-arm enforcement gap (BUG-28)
- (-) Requires durable _detachWatchers that persist beyond MCP response

### ADR-002: 4 Completion Signals for Redundancy

**Status:** Accepted (v0.7.10)  
**Context:** Any single completion signal can fail: marker can be missed (false negative if printf in assistant message), pub/sub can drop events (H1), Wave D can miss (H2).  
**Decision:** Four independent signals: marker, error_marker, pub_complete, terminated. First signal fires the watcher.  
**Consequences:**
- (+) Redundant coverage — if 3 fail, 4th usually fires
- (-) claws_workers_wait only checks 2 of 4 (BUG-D — partial implementation)
- (-) More complex detectCompletion logic

### ADR-003: Heartbeat for Fast-Path Only (v0.7.12)

**Status:** Accepted temporarily (v0.7.12)  
**Context:** Heartbeat state machine was designed for all 4 watchers. Implementation started with fast-path (_fpTick) as proof of concept.  
**Decision:** Ship L4-L9 for fast-path only; backport to other watchers in v0.8.x.  
**Consequences:**
- (+) Unblocks v0.7.12 release — partial progress visible for primary workers
- (-) Fleet and dispatch_subworker orchestrators get no live progress (watcher coverage gap)
- (-) Creates misleading impression that all workers have heartbeat support

### ADR-004: L8 tui_idle DISARMED (commit ed27870)

**Status:** Accepted (v0.7.12)  
**Context:** L8 auto-closed terminals after N seconds of worker silence. Deep-thinking workers were killed during legitimate analysis (false positive rate ~40%).  
**Decision:** Disable L8. Workers never auto-close on tui_idle. Orchestrators must explicitly close.  
**Consequences:**
- (+) No more silent loss of in-progress work
- (-) Stuck workers run until timeout (10 min default)
- (-) Resource leak if orchestrators don't clean up
- Future: re-enable with Option D (two-phase warning + cancel window)

### ADR-005: Wave Discipline Contract as Mandatory Protocol

**Status:** Accepted (v0.6.0 claws/2)  
**Context:** Sub-workers in Wave Army pattern need consistent behavior for heartbeat, completion events, and bus communication.  
**Decision:** 9-item contract; violation causes server violation timer to expire (25s); watcher reports timeout.  
**Consequences:**
- (+) Consistent sub-worker behavior; watcher can make guarantees
- (-) Complex onboarding — workers must follow all 9 items
- (-) BUG-03 (capabilities:['push'] required) makes contract brittle until server-side fix
- (-) BUG-06 (role vs peerId heartbeat topic) silently breaks timer reset

### ADR-006: parsePromptIdle v3 — Bypass Permissions Footer

**Status:** Accepted (v0.7.12)  
**Context:** v1 (❯ last line) and v2 (❯ in last 10 lines) both failed due to ANSI stripping and Ink re-render patterns. Need stable boot detection signal.  
**Decision:** Look for 'bypass permissions on' substring in last 30 lines. This footer appears after trust acceptance and persists.  
**Consequences:**
- (+) High reliability — footer is stable across Claude Code versions tested
- (-) Two stale tests still testing v1/v2 behavior (HB-stale-tests)
- (-) Brittle if Claude Code changes the footer text in a future version
- Mitigation: Use a configurable pattern (claws.bootDetectionPattern setting)

---

*End of Claws Lifecycle Master Plan — 2026-05-04*
