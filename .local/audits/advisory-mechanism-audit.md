# Advisory Mechanism Audit — Claws Codebase

**Date**: 2026-05-04  
**Author**: Terminal 4 (advisory-mechanism-audit worker)  
**User Direction**: "Anything advisory based is a pure risk for us. We need to ensure that whatever we build is fully enforced for every user."  
**Scope**: Full codebase scan — `mcp_server.js`, `extension/src/*.ts`, `scripts/hooks/*.js`, `scripts/*.js`, `scripts/*.sh`, `templates/`, `.claude/commands/`, `.claude/skills/`, `docs/ARCHITECTURE.md`, `.local/audits/*.md`, `extension/test/*.test.js`

---

## Executive Summary

This audit found **78 advisory mechanisms** across the Claws codebase. They fall into 10 categories ranging from pure honor-system LLM instructions to time-based heuristics to per-user configuration gaps. **The enforcement chain has meaningful server-side teeth at 4 points** (lifecycle canSpawn gate, PreToolUse hard-block for mcp_server.js edits, WaveRegistry violation timer, PostToolUse auto-close). **Everything else is advisory.** The gap between the architectural claim ("5-layer enforcement chain, non-optional in practice") and reality is significant.

---

## I. Mission Preamble Injections (worker-cooperation advisory)

These are instructions prepended to worker missions at runtime. Workers can ignore them; the orchestrator has no way to enforce compliance.

---

### Finding 1: Phase 4a bus-completion header injected into every worker mission

**Type:** honor-system / mission preamble  
**Location:** `mcp_server.js:1006`, `mcp_server.js:1847`

**Current behavior:** Every `claws_worker` / `claws_fleet` / `runBlockingWorker` call prepends a header to the mission text:
```
## Worker identity (Phase 4a)
Your terminal_id is ${termId}. When your mission is complete, publish to the bus:
  claws_publish(topic="worker.${termId}.complete", payload={"status":"completed"})
This signals completion via the bus — more reliable than pty marker scraping. Marker stays as fallback.
```

**Risk:** Worker reads the header, decides to skip it, answers the real mission question, and prints MISSION_COMPLETE as a plain assistant message instead of a Bash tool call. `detectCompletion` falls back to pty marker scraping. If the marker is also skipped (common per existing audits), completion relies on Wave D (`onDidCloseTerminal → system.worker.terminated`), which fires only when the terminal closes — meaning the orchestrator waits up to `timeout_ms` (default 5 min).

**Cross-system risk:** Header injection increases mission payload size. This was identified as causing paste-collapse failures in mcp_server.js:1014 (ROOT CAUSE FIX comment). The header is ~200 chars; future missions approaching Claude's paste threshold will experience non-submission.

**Why advisory:** There is no way to verify from outside a TUI that the worker called `claws_publish`. The MCP server can see the bus event arrive, but cannot distinguish "worker published it" from "worker ignored it and we fell back to Wave D."

**Hook-based replacement:**
- **Event source**: `worker.+.complete` bus subscription already exists (`mcp_server.js:1393-1398`)
- **Hook action**: Server-side — make `lifecycle.mark-worker-status(completed)` a prerequisite for `claws_close` (i.e., close is refused unless bus completion was received). This forces bus publish to be the *only* path to terminal closure.
- **Net effect**: Worker that skips bus publish cannot get its terminal closed cleanly; orchestrator timeout becomes the only fallback.

**Removal cost:** If removed, fast-path completion reverts to pty marker scraping + Wave D. No functionality lost — those paths already exist.

---

### Finding 2: F1/F2/F3 final-actions convention

**Type:** honor-system / mission preamble / documentation  
**Location:** `templates/CLAUDE.global.md:73-90`, `templates/CLAUDE.project.md:78-94`, `scripts/hooks/session-start-claws.js:78-126`

**Current behavior:** Every worker mission (via SessionStart reminder and CLAUDE.md injection) instructs:
```
F1: git status --short
F2: git log --oneline -5
F3: printf '%s\n' 'MARK_M??_OK_COLOR'   (REQUIRED — watcher completion signal)
```
The comment in CLAUDE.md says "framing as numbered Bash tool calls prevents Claude from substituting an assistant-message summary."

**Risk:** Claude TUI workers frequently skip F3. The comment in CLAUDE.global.md:75 itself admits: "Claude TUI workers frequently skip the printf marker — they finish writing the Final Report as a plain assistant message and stop without running the required Bash tool call." The watcher reports a misleading "timeout" even though work succeeded.

**Cross-system risk:** The Claude Code version controls whether tool calls vs assistant messages are used. Model updates (especially when context pressure is high) increase skip rate without any warning.

**Why advisory:** F3 is a requested Bash tool call embedded in instructions. Claude can — and does — skip it, especially when finishing long missions under context pressure.

**Hook-based replacement:**
- **Event source**: `system.worker.terminated` (Wave D — `onDidCloseTerminal` → extension → bus) already fires when terminal closes
- **Hook action**: Use `system.worker.terminated` as primary completion signal. `detectCompletion` already checks `_workerTerminatedSet` as signal 5. Make `terminated` signal upgrade to `completed` if lifecycle.mark-worker-status was called successfully.
- **Net effect**: F3 becomes redundant (belt-and-suspenders only). Terminal close = completion signal regardless of marker.

**Removal cost:** None if Wave D is reliable. F3 provides no functional guarantee that Wave D doesn't already provide better.

---

### Finding 3: Wave Discipline Contract injected as mission preamble text

**Type:** honor-system / mission preamble  
**Location:** `templates/CLAUDE.global.md:33-52`, `templates/CLAUDE.project.md:82-98`, `scripts/hooks/session-start-claws.js:114-126`

**Current behavior:** Sub-workers receive 9 "MUST" rules including: register within 60s, heartbeat every 20s, publish boot/phase/error events, no --no-verify, full test suite before commit, tsc --noEmit after .ts edits, publish complete event before sentinel.

**Risk:** Sub-workers can and do violate all 9 rules. The server has violation detection for heartbeat silence (25s timer in `wave-registry.ts:56`) but:
- It fires a violation *event* — it does not block the worker
- It does not detect --no-verify bypasses
- It does not detect skipped test suites
- It does not detect phase-event omissions
- It does not detect out-of-order sentinel printing

**Cross-system risk:** Wave Army orchestration depends on all sub-workers following this contract. If one sub-worker skips `wave.<waveId>.<role>.complete`, the LEAD's `claws_drain_events` wait loop times out, not knowing the sub-worker finished.

**Why advisory:** Rules are text. Text cannot enforce behavior.

**Hook-based replacement (per rule):**
- Register within 60s: server already has a 60s timer. Make it *block* (`claws_publish` rejected if no hello within window). Currently: fires violation event only.
- Heartbeat every 20s: violation timer fires event. **Make the violation event trigger auto-termination** of the silent worker terminal (close + mark-status='timeout').
- No --no-verify: PostToolUse hook detecting `git commit --no-verify` in tool_input.command. Exit 2 (block).
- Full test suite: cannot be enforced without running tests and observing exit code — this is architectural change territory.
- tsc --noEmit: PostToolUse hook on Edit/Write of `.ts` files runs `npx tsc --noEmit` and blocks on error.
- Complete event before sentinel: server can verify sequence — reject `claws_close` if `wave.<waveId>.<role>.complete` was never published by this peer.

---

## II. Documentation/Instruction Text (orchestrator-cooperation advisory)

---

### Finding 4: ARCHITECTURE.md P10 claims "server-enforced" lifecycle gates but they are partially advisory

**Type:** documentation mismatch  
**Location:** `docs/ARCHITECTURE.md:81-84`

**Current behavior:** ARCHITECTURE.md P10 states: "Phase transitions, worker capacity, terminal-must-be-closed-before-REFLECT — all enforced by the lifecycle store before the relevant operation lands. Orchestrators cannot skip phases." Footnote says "Wave C TODO: PostToolUse verifies monitor registered within 5s; Stop hook blocks exit until phase ∈ {REFLECT, SESSION-END}."

**Risk:** The "TODO" items are the critical enforcement gaps. Stop hook currently writes to stderr (advisory); it does NOT block exit or refuse to proceed. PostToolUse does auto-close orphaned terminals (enforced) but the lifecycle plan gate (`canSpawn`) only works if the orchestrator calls `claws_lifecycle_plan` first — which is itself advisory.

**Gap inventory:**
- `canSpawn` gate (`lifecycle-rules.ts:52-60`): enforced server-side for `claws_create`, BUT only when lifecycle state is initialized. If `claws_lifecycle_plan` was never called, `state=null` and `canSpawn` returns `{ok:false}`. **This is enforced.**
- `canCleanup` gate: enforced — can't advance to CLEANUP until all workers at terminal status. **Enforced.**
- `canReflect` gate: enforced — can't advance to REFLECT until all terminals closed. **Enforced.**
- REFLECT requirement before SESSION-END: **advisory** — Stop hook writes to stderr but does NOT block.
- Monitor arm before spawn: **partially enforced** — PreToolUse gate checks sidecar/tail-F alive, but grace window means first spawn in a session is never blocked.

**Why advisory:** Stop hook exits 0 always (P5 safety contract). It cannot block VS Code from closing.

**Hook-based replacement:**
- **Stop hook**: Cannot block process exit in Claude Code's hook model. The Stop hook's P5 contract ("never exit non-zero except intentional deny") conflicts with blocking REFLECT.
- **Architectural change needed**: Publish `system.session.ended` event to bus when Stop fires. Lifecycle engine checks state — if not at REFLECT/SESSION-END, auto-advance with `reason='stop-hook-force'`, closing any remaining terminals. This is event-driven cleanup vs blocking.

---

### Finding 5: "Monitor arm is MANDATORY" stated in 6 places, only enforced in 1

**Type:** documentation redundancy / partial enforcement  
**Location:** `templates/CLAUDE.global.md:104-135`, `templates/CLAUDE.project.md:41-70`, `scripts/hooks/session-start-claws.js:79-90`, `scripts/hooks/pre-tool-use-claws.js:111-157`, `.claude/skills/claws-orchestration-engine/SKILL.md:40-44`, `docs/ARCHITECTURE.md:77-79`

**Current behavior:** Six separate locations repeat "Monitor is mandatory" with varying degrees of urgency. PreToolUse hook actually *checks* for sidecar/tail-F and can deny spawn-class calls.

**Risk:** PreToolUse enforcement has a 5-second grace window (`graceFile` pattern, `pre-tool-use-claws.js:122-129`). First spawn in any session is never blocked. Grace file in `/tmp` keyed on CWD hash — survives session restarts within the same OS session. If a user restarts Claude Code within 5s of the previous session, grace window may already be active.

**Why advisory (5 places):** 5 of the 6 locations are documentation/reminders. Only PreToolUse actually blocks.

**Hook-based replacement:**
- **Remove grace window**: Arm Monitor check should fire on the *first* spawn-class call. Grace was added for "BUG-28" (slow SessionStart) — if SessionStart reliably spawns the sidecar before any spawn tool is called, grace is unnecessary.
- **Replace grace file with sidecar liveness check**: The sidecar is the real satisfier. Check `pgrep -f stream-events.js` immediately — no grace needed if sidecar spawns in <1s.

---

### Finding 6: Worker boot sequence documented but timing is heuristic

**Type:** time-based / documentation  
**Location:** `templates/CLAUDE.global.md:16-27`, `templates/CLAUDE.project.md:14-27`, `.claude/skills/claws-orchestration-engine/SKILL.md:1-18`

**Current behavior:** Boot sequence says "Poll until 'trust' appears (~20s)" and "Poll until 'bypass' appears (~10s)". The manual sequence depends on the orchestrator observing these text markers in pty log.

**Risk:** If Claude Code UI changes its boot text (trust prompt, bypass prompt), the manual sequence fails silently. Documented in mcp_server.js:872 where `boot_marker: 'bypass permissions'` replaced 'Claude Code' after a banner change.

**Why advisory:** Text pattern matching against TUI output is inherently fragile to version upgrades.

**Hook-based replacement:**
- **Event source**: extension `terminal-manager.ts` already has `setStateChangeCallback` emitting `vehicle.${id}.state` events on PROVISIONING→BOOTING→READY transitions
- **Hook action**: Subscribe to `vehicle.+.state` with `to=READY`; this fires when the TUI is ready
- **Net effect**: Boot detection becomes event-driven rather than text-pattern polling. Breaks on zero TUI version changes.

---

## III. CLAUDE.md / Template Advisory Text (LLM honor-system)

---

### Finding 7: CLAUDE.global.md "MUST follow these rules" block — pure LLM honor system

**Type:** honor-system  
**Location:** `templates/CLAUDE.global.md:1-15`, `~/.claude/CLAUDE.md:1-15`

**Current behavior:** Injected into every Claude Code session machine-wide. Contains 5 "MUST" rules including "NEVER use Bash for long-lived processes", "ALWAYS create wrapped terminals", "ALWAYS close every terminal you create."

**Risk:** These are Claude Code prompt instructions. They have no server-side, hook-side, or OS-level enforcement. A Claude Code session that ignores them (e.g., due to high context pressure, model update, or prompt injection from a third party) will violate the rules without any alarm firing.

**Cross-system risk:** On machines without `inject-global-claude-md.js` having been run, this file doesn't exist. The rules are simply absent.

**Why advisory:** CLAUDE.md is a prompt. Prompts cannot enforce behavior.

**Hook-based replacement:**
- Rule 1 (no Bash for long-running): PreToolUse hook already partially enforces this via LONG_RUNNING_PATTERNS. Extend pattern list; enable CLAWS_STRICT=1 by default.
- Rule 2 (always wrapped): `claws_create` in mcp_server.js:1516 already defaults `wrapped: args.wrapped !== false` — server enforces this. Gap: manual `net.createConnection` bypasses MCP server.
- Rule 3 (always close): Stop hook reminder. **Not enforced.** PostToolUse lifecycle check is the only enforcement, and it only covers the monitor-registration gap.
- Rule 4 (never touch others' terminals): No enforcement at all. Extension does not track terminal ownership.
- Rule 5 (never headless): PreToolUse pattern `claude(?!\s+-p\b)(?!\s+--print\b)` blocks headless claude in STRICT mode only.

---

### Finding 8: CLAUDE.project.md "MUST follow — no exceptions" rules block

**Type:** honor-system  
**Location:** `templates/CLAUDE.project.md:6-12`

**Current behavior:** Injected into `<project>/CLAUDE.md` CLAWS:BEGIN block by `inject-claude-md.js`. Same 5 rules as CLAUDE.global.md but project-scoped.

**Risk:** Same as Finding 7. Redundant documentation that amplifies the perceived enforcement without adding actual enforcement.

**Why advisory:** See Finding 7.

**Hook-based replacement:** Prefer enforcing once (server-side or hook-side) rather than documenting in two prompt files.

**Removal cost:** If enforcement exists via hooks, CLAUDE.md rules are redundant. Safe to remove purely advisory text that duplicates hook behavior.

---

### Finding 9: Lifecycle phases described as 8-step mandatory process — documentation only

**Type:** honor-system / documentation  
**Location:** `templates/CLAUDE.project.md:71-99`, `templates/CLAUDE.global.md:29-31`, `.claude/skills/claws-orchestration-engine/SKILL.md:24-116`

**Current behavior:** 8 lifecycle phases (PLAN→SPAWN→DEPLOY→OBSERVE→RECOVER→HARVEST→CLEANUP→REFLECT) are described in multiple documents. Phase descriptions include timing expectations ("DEPLOY → OBSERVE (all boot events ack'd within 30s)") that are documentation-only.

**Risk:** Orchestrators that skip lifecycle phases bypass documentation but not enforcement. Lifecycle engine `canSpawn` gate does enforce SPAWN phase requirement, but DEPLOY, OBSERVE, HARVEST, RECOVER are self-reported via `claws_lifecycle_advance` — entirely voluntary.

**Why advisory:** `lifecycle_advance` is a tool the orchestrator calls voluntarily. Nothing forces it.

**Hook-based replacement:**
- Auto-advance engine (`lifecycle-engine.ts`) already advances automatically from spawn/monitor events. This covers SPAWN→DEPLOY→OBSERVE.
- Gaps: OBSERVE→HARVEST is currently triggered by `mark-worker-status(completed)`, which itself is triggered by the detach watcher — this IS auto-enforced.
- HARVEST→CLEANUP and CLEANUP→REFLECT require explicit `lifecycle_advance` calls — advisory.

---

## IV. Time-Based Mechanisms (polling, intervals, timeouts, grace)

---

### Finding 10: boot_wait_ms timeout (25s default) — time-based heuristic boot detection

**Type:** time-based  
**Location:** `mcp_server.js:875` (DEFAULTS), `mcp_server.js:960-977` (blocking path), `mcp_server.js:1829-1844` (fast path)

**Current behavior:** After sending `claude --dangerously-skip-permissions`, the MCP server polls `readLog` every 300ms for up to `boot_wait_ms` (default 25s) waiting for `❯` + `cost:$` to appear. Falls through after timeout regardless.

**Risk:** On slow machines (CI, remote dev, resource-constrained containers), Claude TUI may take >25s to boot, causing the mission to be sent before TUI is ready. Mission silently lost. On fast machines, 25s is wasteful.

**Cross-system risk:** `cost:$` indicator is Claude Code version-specific. v3.x TUI may change the idle indicator format, breaking boot detection entirely. Regression without warning.

**Why advisory:** Timeout is a fixed magic number chosen empirically. There is no server-side acknowledgment that the TUI is accepting input.

**Hook-based replacement:**
- **Event source**: `vehicle.${termId}.state` with `to='READY'` or `to='IDLE'` — terminal-manager.ts emits this when the vehicle FSM reaches READY
- **Hook action**: Subscribe to `vehicle.+.state` per-terminal; wait for READY event instead of polling pty log
- **Net effect**: Boot detection is O(1) event, not O(N) polling. No timeout needed. Cross-version-stable.

---

### Finding 11: timeout_ms (5min default) in claws_workers_wait polling loop

**Type:** time-based  
**Location:** `mcp_server.js:2149`, `mcp_server.js:2166-2184`

**Current behavior:** `claws_workers_wait` polls every `poll_interval_ms` (1.5s) for up to `timeout_ms` (5 min) checking pty logs for completion markers. After timeout, all still-pending workers are marked `status: 'timeout'`.

**Risk:** If bus completion (`pub_complete_v2`) is subscribed and working, this loop is redundant. If bus subscription fails (socket disconnect, subscription missed), this loop is the fallback — but it polls pty logs (slow, ANSI-dependent) rather than listening to the bus.

**Cross-system risk:** 5-minute timeout means a slow but running worker gets killed by the orchestrator's timeout, not by its own completion. Destructive for legitimate long-running work.

**Why advisory:** Timeout is configurable but the default misleads users. The loop should exit on bus events, not time.

**Hook-based replacement:**
- `claws_workers_wait` already checks `_workerCompletedViaBusSet` and `_workerTerminatedSet` on every poll tick. The remaining issue is that it polls rather than waiting on a waiter.
- Replace inner poll loop with `claws_drain_events(wait_ms=pollIntervalMs)` which parks the MCP handler thread until a new event arrives. Already implemented for `claws_drain_events`.
- **Net effect**: Workers complete in O(1) from bus event delivery, not O(N) polling ticks.

---

### Finding 12: poll_interval_ms (1500ms default) in detach watcher tick

**Type:** time-based  
**Location:** `mcp_server.js:880`, `mcp_server.js:1061`, `mcp_server.js:1144`, `mcp_server.js:2061`

**Current behavior:** The `setInterval(_fpTick, _fpOpt.poll_interval_ms)` watcher polls every 1.5s reading `readLog` + scanning for completion markers. This means completion latency is 0-1.5s even when bus completion fires immediately.

**Risk:** With 100+ parallel workers, each polling every 1.5s creates N×1.5s socket round-trips per second to the extension. This saturates the Unix socket under heavy fleet loads.

**Hook-based replacement:**
- The watcher already subscribes to `worker.+.complete` via `_workerBusCompletedSubscribed`. The bus push frame triggers immediate resolution. 
- Reduce polling from 1.5s to 10s as a liveness fallback only; primary completion is bus-driven.
- **Net effect**: With 10 workers, socket load drops 6.7x. Bus delivery is sub-100ms.

---

### Finding 13: Hook 5-second self-kill timer — hard cap on hook execution

**Type:** time-based  
**Location:** `scripts/hooks/session-start-claws.js:19`, `scripts/hooks/pre-tool-use-claws.js:28`, `scripts/hooks/stop-claws.js:17`, `scripts/hooks/post-tool-use-claws.js:28`

**Current behavior:** Every hook has `setTimeout(() => { process.exit(0); }, 5000).unref()`. Any hook that takes >5s silently exits.

**Risk (PostToolUse specific):** `post-tool-use-claws.js` waits up to 4s (`MONITOR_WAIT_MS = 4000`) for monitor registration, then 5s self-kill. If the socket is slow (e.g., VS Code extension reloading), the 4s wait + overhead may exceed 5s, causing silent bail before the auto-close fires. Orphaned terminal escapes enforcement.

**Why time-based:** 5s is arbitrary. Hook correctness depends on socket latency being <4s.

**Hook-based replacement:**
- Reduce `MONITOR_WAIT_MS` to 2s; reduce kill timer to 4.5s for PostToolUse hook specifically (currently identical to other hooks despite different workload).
- Alternatively: make PostToolUse async-safe and register the auto-close as a timer in the MCP server process (which has no kill timer) triggered by `lifecycle.register-monitor` absence.

---

### Finding 14: Monitor arm grace window — first spawn always unguarded

**Type:** time-based / advisory  
**Location:** `scripts/hooks/pre-tool-use-claws.js:122-129`

**Current behavior:**
```js
if (!fs.existsSync(graceFile)) {
  fs.writeFileSync(graceFile, String(Date.now()), 'utf8');
} else {
  const ts = parseInt(fs.readFileSync(graceFile, 'utf8').trim(), 10);
  enforceNow = (Date.now() - ts) > 5000;
}
```
First spawn call writes grace file with current timestamp. Second spawn call (>5s later) checks and may enforce. **First spawn is always unguarded.**

**Risk:** A session that spawns exactly one worker never has Monitor arm enforced. The entire PreToolUse gate is a no-op for single-worker sessions.

**Cross-system risk:** Grace file in `/tmp` survives across Claude Code restarts within the same OS session. If the user restarts Claude Code within 5s, the grace window may still be active and enforcement is bypassed.

**Hook-based replacement:**
- Replace grace window with: "check if sidecar is alive right now" (`pgrep -f stream-events.js`). If alive, no spawn block needed — the sidecar IS the Monitor satisfier. This eliminates the grace window entirely because the sidecar spawns in <1s via SessionStart.

**Removal cost:** If sidecar reliably spawns before any tool call, grace window is meaningless. Safe to remove.

---

### Finding 15: Post-mission settle sleep(5000ms) — empirical magic number

**Type:** time-based  
**Location:** `mcp_server.js:993`, `mcp_server.js:1843`

**Current behavior:** After boot detection, both runBlockingWorker and fast-path claws_worker `await sleep(5000)` with comment: "Claude has a hidden async window (~5s) during which paste-submit gestures get lost."

**Risk:** 5s is empirically chosen from one developer's machine. May be too short on slow machines (mission lost), too long on fast machines (wasted time). If model/TUI changes shorten or lengthen this window, the settle breaks silently.

**Cross-system risk:** High variability across machine specs. CI environments (slower I/O, resource limits) may need 10s+.

**Why time-based:** There is no observable event that signals "Claude is now accepting input." The ❯+cost:$ indicator fires before the TUI is fully ready (as noted in the comment).

**Hook-based replacement:**
- **Event source**: vehicle FSM `READY` state (`vehicle.+.state` with `to='READY'`) in `terminal-manager.ts`
- The vehicle FSM currently tracks shell state (PROVISIONING→BOOTING→READY). If it detected Claude TUI specifically, it could emit READY when Claude's React/Ink render finishes.
- **Partial fix**: Use submit verification loop (`mcp_server.js:1866-1878`) as the primary settle check instead of fixed sleep. This already verifies buffer growth after paste.

---

### Finding 16: T4 monitor-arm grace warn — 5s warning, advisory only

**Type:** time-based / advisory  
**Location:** `mcp_server.js:928-938`, `mcp_server.js:1801-1814`

**Current behavior:**
```js
setTimeout(async () => {
  // check lifecycle.snapshot for monitor registration
  // if missing: log `T4-warn: no monitor registered within 5000ms grace`
}, _bMonitorGraceMs); // 5000ms
```
Logs a warning to stderr if no monitor is registered 5s after spawn. Warning only, no enforcement.

**Risk:** Orchestrator receives warning in MCP stderr but may not be watching it. The terminal runs without a monitor. Completion detection falls back to polling.

**Why advisory:** `setTimeout` in MCP server process fires in background; no mechanism to surface warning to the orchestrator's tool result.

**Hook-based replacement:**
- **Event source**: PostToolUse hook already does this check (Finding 13). The T4 setTimeout in mcp_server.js is redundant.
- Remove T4 setTimeout from mcp_server.js; rely entirely on PostToolUse hook's 4s wait + auto-close.

---

### Finding 17: Wave violation threshold 25s — violation event, not blocking action

**Type:** time-based / advisory  
**Location:** `extension/src/wave-registry.ts:56` (`VIOLATION_THRESHOLD_MS = 25_000`)

**Current behavior:** On heartbeat silence >25s, `WaveRegistry._checkViolation` fires `onViolation` callback → `ClawsServer.emitSystemEvent('wave.${waveId}.violation', ...)`. Timer resets on each heartbeat.

**Risk:** Violation fires an event. Orchestrator must be subscribed to `wave.+.violation` and must act on it. If the orchestrator is busy (e.g., deep in a tool call) and doesn't see the event, the silent worker continues running indefinitely.

**Why advisory:** Violation detection fires events but doesn't take action. The orchestrator must self-enforce via event subscription.

**Hook-based replacement:**
- **Automatic enforcement**: On violation event, server-side: publish `worker.<peerId>.terminated` + call `claws_close` on the worker's terminal. Worker is auto-terminated after 25s silence, not just flagged.
- This converts the violation from a warning into a hard enforcement: silent workers are killed.
- **Removal cost**: Workers doing legitimate long reads (large file operations, network calls) may be killed. Violation threshold may need to be longer (60s? 90s?) to accommodate legitimate silent periods.

---

### Finding 18: Sidecar SUBSCRIBED wait maxWaitMs=3000ms — race on slow machines

**Type:** time-based  
**Location:** `mcp_server.js:1238`, `mcp_server.js:1293-1298`

**Current behavior:** `_spawnAndVerifySidecar(maxWaitMs=3000)` waits 3s for sidecar to emit `{"type":"sidecar.subscribed"}`. If not received in 3s, rejects with "sidecar did not reach SUBSCRIBED within 3000ms".

**Risk:** On slow machines (startup latency, disk pressure), sidecar may take >3s to connect and subscribe. MCP server then fails to spawn sidecar and subsequent `_ensureSidecarOrThrow()` calls in `claws_create`/`claws_worker` return error.

**Cross-system risk:** CI environments, remote dev boxes, machines with slow Node.js startup.

**Why time-based:** Fixed 3s is not adaptive.

**Hook-based replacement:**
- Increase to 8s. Sidecar retry on failure (already has `_sidecarEnsureInFlight` dedup).
- More robustly: separate sidecar verification from spawn; accept "sidecar is connecting" as sufficient for spawn-class tools to proceed.

---

### Finding 19: Auth token stale window 5 minutes (AUTH_MAX_TOKEN_AGE_MS)

**Type:** time-based  
**Location:** `extension/src/server.ts:44` (`AUTH_MAX_TOKEN_AGE_MS = 5 * 60 * 1000`)

**Current behavior:** Hello tokens are rejected if `age > 5 * 60 * 1000`. This is for L18 auth (optional feature).

**Risk:** Low risk — auth is opt-in. If enabled, a slow MCP server startup (>5min between token generation and hello) would reject valid tokens.

**Why time-based:** Standard replay-prevention pattern. Acceptable risk for an optional security feature.

**Hook-based replacement:** N/A — time-based replay prevention is the right approach here. Accept this.

---

### Finding 20: setInterval heartbeat timer for system.heartbeat (server-side)

**Type:** time-based (benign, server-side)  
**Location:** `extension/src/server.ts:357-403`

**Current behavior:** Server emits `system.heartbeat` + `system.metrics` on `heartbeatIntervalMs` interval (default from `getConfig().heartbeatIntervalMs`).

**Risk:** Heartbeat is the mechanism that keeps the sidecar alive (stream-events.js never goes idle because heartbeats keep arriving). If heartbeat interval is misconfigured (0 or very long), sidecar may go idle and get SIGURG'd.

**Why time-based:** Heartbeat *should* be time-based. This is the correct design.

**Hook-based replacement:** N/A — keep as-is. This is infrastructure, not advisory.

---

### Finding 21: setInterval detach-watcher tick — time-based completion polling

**Type:** time-based  
**Location:** `mcp_server.js:1144` (blocking detach), `mcp_server.js:2061` (fast-path)

**Current behavior:** `setInterval(_fpTick, _fpOpt.poll_interval_ms)` runs every 1.5s, calling `readLog` and checking completion signals.

**Risk:** With the Phase 4a bus completion path working, the interval is largely redundant — completion fires via bus push frame on the first tick after `worker.+.complete` arrives. But the 1.5s polling remains even after bus completion is received, until the next tick fires.

**Hook-based replacement:**
- On `_workerCompletedViaBusSet.set(termId, ...)` (line ~249), immediately call `clearInterval(_fpIntervalId)` and fire completion handling inline. This eliminates the 0-1.5s lag entirely.
- Since `_pconnHandleData` already fires setImmediate-style (synchronous after JSON parse), completion could be immediate.

---

## V. Per-User Configuration Dependencies (hooks, MCP server registration)

---

### Finding 22: Hook injection into ~/.claude/settings.json — requires install.sh

**Type:** per-user configuration  
**Location:** `scripts/inject-settings-hooks.js`, `scripts/install.sh`

**Current behavior:** `install.sh` runs `inject-settings-hooks.js` which writes SessionStart, PreToolUse, PostToolUse, Stop hooks into `~/.claude/settings.json`. If this script was not run (or settings were reset), no hooks exist.

**Risk:** Users who install Claws manually, update Claude Code (which may reset settings), or use multiple machines without re-running install.sh have no hook enforcement. The entire enforcement chain (findings 4, 5, 13, 14, 22-31) is absent.

**Cross-system risk:** Claude Code updates have been observed to reset `settings.json` (not confirmed, but noted in audit history). If true, all enforcement silently disappears after every Claude Code update.

**Why per-user-config:** Hook registration writes to per-user settings. No OS-level or VS Code-level mechanism guarantees persistence.

**Hook-based replacement:**
- A PostInstall script (run on VS Code extension activation) could verify hooks are registered and re-inject if missing. This could be triggered by the extension's `activate()` lifecycle.
- Extension currently runs `inject-claude-md.js` on some paths — same pattern for hooks.

---

### Finding 23: CLAWS_STRICT=1 env var required for hard-block mode

**Type:** per-user configuration  
**Location:** `scripts/hooks/pre-tool-use-claws.js:81`

**Current behavior:** Long-running Bash pattern enforcement has two modes:
- Default (no CLAWS_STRICT): hard-block via `exit 2 + stderr`
- `CLAWS_STRICT=1`: deny via `permissionDecision:"deny"` JSON (cleaner Claude Code integration)

**Risk:** The default mode (`exit 2`) actually IS a hard block. But the block message format is less visible than the STRICT mode permissionDecision. Users who don't set CLAWS_STRICT get a less integrated enforcement experience.

**Why per-user-config:** CLAWS_STRICT is an env var that must be set in shell profile or settings.json.

**Hook-based replacement:**
- Default to STRICT mode (permissionDecision). The `exit 2` path is the legacy path. Document the preferred mode explicitly in install.sh.

---

### Finding 24: CLAWS_WORKER=1 env var — worker bypass of edit gate

**Type:** per-user configuration / bypass mechanism  
**Location:** `scripts/hooks/pre-tool-use-claws.js:98-109`

**Current behavior:**
```js
if (process.env.CLAWS_WORKER === '1') { process.exit(0); return; }
```
Workers with `CLAWS_WORKER=1` bypass the "no direct edits to mcp_server.js from orchestrator" gate.

**Risk:** The env var is set by `runBlockingWorker` and the fast-path claws_worker via:
```js
cmd: 'create', ..., env: { CLAWS_WORKER: '1' }
```
(mcp_server.js:901, 1778). Any process with `CLAWS_WORKER=1` in env bypasses the edit gate. If an attacker or malfunctioning worker sets this env var, it bypasses the protection.

**Why advisory:** Env var is set by the orchestrator when it creates the terminal. The extension currently passes `env` to the pty process, so CLAWS_WORKER=1 appears in the worker's process environment.

**Hook-based replacement:**
- Use a cryptographic token (e.g., random nonce per terminal) instead of a static env var. Embed the nonce in the worker mission; the PreToolUse hook verifies the nonce against a registry.
- Or: make the gate bypass server-side — orchestrator never needs to edit mcp_server.js; workers dispatch via claws_worker with validated mission.

---

### Finding 25: MCP server registration — requires manual Claude Code config or install.sh

**Type:** per-user configuration  
**Location:** `scripts/install.sh` (registers MCP server in Claude Code global config)

**Current behavior:** `install.sh` registers the MCP server globally via `claude config add mcpServers.claws`. On machines where install.sh was not run or where Claude Code was reinstalled, MCP tools are absent.

**Risk:** Without MCP registration, `claws_worker`, `claws_create`, etc. don't exist as tools. The orchestrator falls back to raw `net.createConnection` patterns (documented in CLAUDE.md as fallback) or fails.

**Why per-user-config:** MCP registration is per-user, per-machine.

**Hook-based replacement:**
- Extension `activate()` could detect missing MCP registration and prompt user to run install.sh. This is a UX improvement, not a security fix.

---

### Finding 26: CLAWS_SOCKET env var for socket path override

**Type:** per-user configuration  
**Location:** `mcp_server.js:1405-1431`

**Current behavior:** Socket path resolution walks CWD → __dirname, falls back to `CLAWS_SOCKET` env var or default `.claws/claws.sock`. If `CLAWS_SOCKET` is set to a wrong value, all MCP tools fail silently (socket error → `{ ok: false, error: 'socket error: ...' }`).

**Risk:** Misconfigured CLAWS_SOCKET causes silent degradation without clear error message.

**Hook-based replacement:** N/A — socket path configuration is inherently per-user. The walk-up logic is good. Add explicit error message when socket not found after exhausting all candidates.

---

### Finding 27: stream-events.js sidecar CLAWS_TOPIC/CLAWS_PEER_NAME/CLAWS_ROLE env vars

**Type:** per-user configuration  
**Location:** `mcp_server.js:1275` (sidecar spawn), `scripts/hooks/session-start-claws.js:62` (session-start spawn)

**Current behavior:** Sidecar is spawned with:
```js
env: { ...process.env, CLAWS_TOPIC: '**', CLAWS_PEER_NAME: 'auto-sidecar', CLAWS_ROLE: 'observer' }
```
These values are hardcoded. If the env is corrupted or CLAWS_TOPIC is overridden in the user's shell profile, sidecar may subscribe to wrong topics.

**Risk:** Low — values are hardcoded in spawn call. But if `process.env` contains a conflicting `CLAWS_TOPIC`, it would be overridden by the spread.

**Hook-based replacement:** N/A — low risk. Current approach is correct (explicit override after spread).

---

## VI. Worker Behavior Assumptions (what we expect Claude TUI to do)

---

### Finding 28: Worker must call claws_publish(worker.N.complete) — pure advisory

**Type:** honor-system / worker assumption  
**Location:** `mcp_server.js:1006`, `mcp_server.js:1847` (header injection)

**Current behavior:** Phase 4a header instructs worker to call `claws_publish(topic="worker.${termId}.complete")`. Detection in `_workerCompletedViaBusSet` fires `pub_complete_v2` signal.

**Risk:** Worker can ignore instruction. Fallback chain (marker → error → pub_complete-v1 → terminated) covers most cases, but `pub_complete-v1` requires `[CLAWS_PUB]` line scanner working. `terminated` requires Wave D (onDidCloseTerminal) to fire.

**See Finding 1 for full analysis and hook-based replacement.**

---

### Finding 29: Worker must print MISSION_COMPLETE marker as Bash tool call — honor system

**Type:** honor-system / worker assumption  
**Location:** `templates/CLAUDE.global.md:73-90`, `mcp_server.js:879` (default `complete_marker`)

**Current behavior:** `detectCompletion` (mcp_server.js:848) scans pty text for `MISSION_COMPLETE` marker via `findStandaloneMarker`. Requires Bash tool execution that writes to pty stdout.

**Risk:** Worker finishes with plain assistant message. No pty output. Marker scan fails. Falls through to Wave D (terminated). If terminal isn't closed (worker just stops responding), no signal fires until `timeout_ms`.

**See Finding 2 for full analysis.**

---

### Finding 30: Worker heartbeat every 20s — voluntary, violation event only

**Type:** honor-system / time-based  
**Location:** `templates/CLAUDE.global.md:41-43`, `extension/src/wave-registry.ts:121-126`

**Current behavior:** Wave Army sub-workers are instructed to publish `worker.<peerId>.heartbeat` every 20s. `WaveRegistry.recordHeartbeat` resets the violation timer on each receipt. Violation at 25s fires `wave.${waveId}.violation` bus event.

**Risk:** Violation is an event. Orchestrator must be subscribed and act. Worker continues running after violation event.

**See Finding 17 for hook-based replacement.**

---

### Finding 31: Worker must register within 60s — advisory, violation event only

**Type:** honor-system / time-based  
**Location:** `templates/CLAUDE.global.md:36-38`, `extension/src/wave-registry.ts:83-85` (initial violation timer)

**Current behavior:** On `createWave`, each sub-worker entry starts with `lastHeartbeatMs: now` and a 25s violation timer. No separate 60s registration timer exists — the 60s comes from documentation only.

**Risk:** Documentation says 60s registration window. Server has 25s violation timer. Discrepancy: worker registered at 30s (before doc says it must) would trigger a violation event.

**Why advisory:** The 60s in docs is aspirational. Server timer is 25s and is the actual enforcement — but it only emits events.

**Hook-based replacement:**
- Server-side: make `hello` with `waveId` required within 25s of wave creation; after that, close the sub-worker terminal automatically.

---

### Finding 32: Worker must not use --no-verify — pure honor system

**Type:** honor-system / worker assumption  
**Location:** `templates/CLAUDE.global.md:46`, `templates/CLAUDE.project.md:91`

**Current behavior:** Documentation says "--no-verify is forbidden." No enforcement exists anywhere.

**Risk:** Worker uses `git commit --no-verify` to bypass pre-commit hooks (which run `npm test` and CHANGELOG validation). Test failures and version drift go undetected.

**Why advisory:** No hook checks for `--no-verify` in commit commands.

**Hook-based replacement:**
- PostToolUse hook (or PreToolUse) matching `Bash` tool with `command` containing `git commit.*--no-verify` → deny via permissionDecision.
- Straightforward regex, no false positives.
- **This is the highest-value single addition**: pre-commit bypass is the root cause of most quality regressions.

---

### Finding 33: Worker must run npm test before every commit — pure honor system

**Type:** honor-system / worker assumption  
**Location:** `templates/CLAUDE.global.md:47`, `templates/CLAUDE.project.md:92`

**Current behavior:** Documentation only. No test enforcement in any hook.

**Risk:** Worker commits without running tests. Test failures land in main. Discovered only on next CI run or manual test.

**Why advisory:** Running tests requires executing the test suite, which takes time. A PostToolUse hook cannot easily verify this without running tests itself.

**Hook-based replacement (partial):**
- PreToolUse on `Bash` matching `git commit` (without `--no-verify`): check if `npm test` was run recently. Heuristic: scan conversation context for recent test output. Fragile but better than nothing.
- Better: Pre-commit hook in `.git/hooks/pre-commit` (project-level) that runs `npm test`. This is OS-level enforcement, not Claude-level advisory. **Most robust approach.**

---

### Finding 34: Worker must run tsc --noEmit after every .ts edit — pure honor system

**Type:** honor-system / worker assumption  
**Location:** `templates/CLAUDE.global.md:48`, `templates/CLAUDE.project.md:93`

**Current behavior:** Documentation only. No hook enforces TypeScript checking.

**Risk:** Worker edits TypeScript files, commits without type-checking. Type errors land in main. Discovered only when `npm run build` runs.

**Hook-based replacement:**
- PostToolUse hook on Edit/Write of `*.ts` files: run `npx tsc --noEmit` in background, capture output. If errors, surface as hook output.
- This is exactly what `~/.claude/rules/typescript/hooks.md` already describes as the right pattern. **Gap: not implemented in Claws hooks.**

---

### Finding 35: Worker must publish boot/phase/error events — advisory for wave workers

**Type:** honor-system  
**Location:** `templates/CLAUDE.global.md:44-45`, `.claude/skills/claws-wave-subworker/SKILL.md:3-9`

**Current behavior:** Sub-workers are instructed to publish `worker.<peerId>.phase` and `worker.<peerId>.event`. No enforcement.

**Risk:** Orchestrator receives no phase visibility. The OBSERVE phase in the lifecycle relies on phase events to track per-worker progress. Without them, orchestrator must fall back to pty log reading.

**Hook-based replacement:**
- Server-side: on `claws_workers_wait` call, if a worker hasn't published any `worker.+.phase` events after 60s, publish a synthetic `worker.<id>.event` with `kind=WARNING reason=no-phase-events-received` to the bus. Advisory, but visible to orchestrator.

---

### Finding 36: Worker must print sentinel ONLY AFTER complete event — pure honor system

**Type:** honor-system / race condition  
**Location:** `.claude/skills/claws-wave-subworker/SKILL.md:6-8`, `templates/CLAUDE.global.md:50-52`

**Current behavior:** Documentation specifies: "Print the role sentinel ONLY AFTER the complete event is published. The LEAD waits on this event via claws_drain_events; if the sentinel appears before the event, the LEAD may time out."

**Risk:** Worker prints sentinel first (as assistant message), then tries to call claws_publish. LEAD sees terminal output (via pty) before bus event. LEAD proceeds to harvest before sub-worker's claws_publish fires. Race condition. Sub-worker's publish then arrives late, confusing the lifecycle.

**Why advisory:** Ordering of operations inside a TUI is honor-system.

**Hook-based replacement:**
- LEAD should NOT rely on pty sentinel for completion; it should ONLY wait for `wave.${waveId}.${role}.complete` bus event. Remove sentinel dependency entirely from LEAD logic. LEAD's `claws_drain_events` wait pattern already does this.
- Gap: `claws-wave-lead/SKILL.md` may still reference sentinel. Need to audit and remove.

---

### Finding 37: Worker must close own terminal — advisory

**Type:** honor-system  
**Location:** `.claude/skills/claws-wave-subworker/SKILL.md:11`

**Current behavior:** "Close your own terminal after printing sentinel." Advisory only.

**Risk:** Worker exits Claude TUI but terminal stays open. Wave D fires `onDidCloseTerminal` only when the VS Code terminal tab is closed. If the TUI exits but the terminal tab stays open, `system.worker.terminated` never fires.

**Why advisory:** Worker closing terminal is a VS Code action (`claws_close`), not a shell action. Worker must call the MCP tool.

**Hook-based replacement:**
- `close_on_complete: true` in `_fpOpt` (mcp_server.js:1899) already auto-closes on marker/bus-complete detection. This covers most cases.
- Gap: if neither marker nor bus-complete fires (worker crashes or stalls), terminal stays open. Fix: increase reliance on `system.worker.terminated` (Wave D).

---

## VII. Orchestrator Behavior Assumptions (monitor armament, cleanup)

---

### Finding 38: Monitor arm as "FIRST ACTION" — advisory in 6 places, enforced in 1

**Type:** advisory / partial enforcement  
**Location:** `templates/CLAUDE.global.md:104-135`, `templates/CLAUDE.project.md:41-70`, `scripts/hooks/session-start-claws.js:79-90`, `scripts/hooks/pre-tool-use-claws.js:111-157`, `.claude/skills/claws-orchestration-engine/SKILL.md:33-43`, `docs/ARCHITECTURE.md:77-79`

**See Finding 5 for full analysis.** Summary: 5 advisory occurrences + 1 enforcement with race window.

---

### Finding 39: Orchestrator must call claws_lifecycle_plan before spawn — partially enforced

**Type:** partial enforcement  
**Location:** `extension/src/lifecycle-rules.ts:52-60` (canSpawn gate), `extension/src/server.ts` (lifecycle.plan handler)

**Current behavior:** `canSpawn` returns `{ok:false}` if `state` is null (no lifecycle plan) or if `state.phase !== 'SPAWN'`. This is enforced server-side.

**Gap:** The `state` is null until `lifecycle.plan` is called. But `lifecycle.plan` is *voluntary* — orchestrators that skip it have no state, and `canSpawn` fails. This is actually a hard enforcement gap: the error message is "no lifecycle state — call lifecycle.plan first" but the user (orchestrator) gets a tool error, not a PreToolUse block.

**Risk:** Orchestrator ignores tool error and tries raw socket commands (`net.createConnection`) to bypass MCP tools entirely. CLAUDE.md documents this as an allowed fallback: "If MCP tools are NOT loaded... use raw socket calls via node -e with require('net').createConnection." This is an explicitly documented enforcement bypass.

**Hook-based replacement:**
- Extension server: make `create` command (raw socket) also check `canSpawn`. Currently `create` has a `canSpawn` check (`server.ts` handle method for `create`). Verify this is implemented and not bypass-able via protocol version downgrade.

---

### Finding 40: Orchestrator must never touch terminals it didn't create — pure honor system

**Type:** honor-system  
**Location:** `templates/CLAUDE.global.md:14`, `templates/CLAUDE.project.md:11`

**Current behavior:** Documentation only. No ownership tracking. Any client can call `send`, `readLog`, or `close` with any terminal ID.

**Risk:** Orchestrator accidentally closes a user's own terminal. Or malicious client terminates running workers.

**Why advisory:** Extension has no ownership model. Terminal IDs are integers known to any connected client.

**Hook-based replacement (architectural change):**
- Extension: introduce terminal ownership field in terminal record. `claws_create` returns a `claim_token` (random nonce). `claws_close`/`claws_send` require the claim token for non-orchestrator callers.
- Alternatively: require hello registration for terminal operations; associate terminal with peer.
- **This requires protocol change (claws/3 or claws/2 extension).**

---

### Finding 41: Orchestrator must close every terminal — advisory, Stop hook warns only

**Type:** honor-system / advisory  
**Location:** `scripts/hooks/stop-claws.js:87-97`, `templates/CLAUDE.global.md:13`

**Current behavior:** Stop hook reads lifecycle state, checks for unclosed workers, writes warning to stderr. Does NOT close terminals itself.

**Risk:** Session ends with N open terminals. Next session sees them as existing. Orchestrator confusion on terminal IDs. Log files accumulate indefinitely.

**Why advisory:** Stop hook cannot make MCP calls (it's a shell process, not an MCP client).

**Hook-based replacement:**
- Stop hook CAN make raw socket calls via `net.createConnection` (it's Node.js). It already does this in PostToolUse (`sendCmd` helper). Replicate that pattern in stop-claws.js to call `close` on each unclosed worker ID.
- Net effect: Stop hook auto-closes orphaned terminals on session end. No longer advisory.

---

### Finding 42: Orchestrator must never edit mcp_server.js directly — partially enforced

**Type:** partial enforcement (enforced for MCP tool calls, not raw socket)  
**Location:** `scripts/hooks/pre-tool-use-claws.js:93-109`

**Current behavior:** PreToolUse hard-blocks Edit/Write to `mcp_server.js` from orchestrators (CLAWS_WORKER≠1). Workers bypass via env var.

**Gap:** CLAWS_WORKER env var bypass (Finding 24). Also: raw socket commands bypass MCP entirely.

**Risk:** Documented in ARCHITECTURE.md P8. Violation allows untested orchestrator patches to land in mcp_server.js.

**See Finding 24 for replacement.**

---

### Finding 43: Orchestrator must not use Bash for long-running processes — partially enforced

**Type:** partial enforcement (pattern-based)  
**Location:** `scripts/hooks/pre-tool-use-claws.js:45-80`

**Current behavior:** LONG_RUNNING_PATTERNS list of regexes checked against `argv[0]` + command text. Blocks or denies matching commands.

**Risk:** Pattern list is incomplete. Regexes can be evaded by command obfuscation (e.g., `node -- server.js` vs `node server.js`). New long-running tools not in the list are uncovered.

**Why advisory:** Pattern-based matching is inherently incomplete.

**Hook-based replacement:**
- Process duration monitoring: extension could track when a shell enters "running process" state (non-shell foreground PID). On `vehicle.+.content` events with `contentType=node/python/etc`, ProToolUse could warn.
- More robust: if a Bash command has `run_in_background: false` and the command starts a server pattern, soft-block with "This looks long-running; consider claws_create instead."

---

## VIII. Wave Discipline Contract — Line-by-Line Audit

---

### Finding 44: "Register within 60s" — server timer is 25s (contradicts docs), fires event only

**Type:** documentation mismatch + time-based  
**Location:** `templates/CLAUDE.global.md:36-38` (60s in docs), `extension/src/wave-registry.ts:56` (25s timer), `extension/src/wave-registry.ts:83-85`

**Current behavior:** Initial violation timer fires 25s after wave creation. Documentation says workers have 60s to register.

**Risk:** Worker boots in 15s (normal), receives mission at 20s, calls `claws_hello` at 23s — still within docs' 60s window but within server's 25s window. Violation event fires unnecessarily.

**Why advisory:** Timer fires event only. No hard block.

**Replacement:** Align docs (60s) with server timer, OR increase server timer to 60s. Then make violation trigger auto-close of the worker terminal (as per Finding 17).

---

### Finding 45: "Heartbeat every 20s" — violation at 25s fires event, worker continues

**Type:** time-based / advisory  
**See Finding 30 and Finding 17 for full analysis.**

---

### Finding 46: "Phase events on every transition" — no enforcement

**Type:** honor-system  
**Location:** `templates/CLAUDE.global.md:44`, `.claude/skills/claws-wave-subworker/SKILL.md:4`

**See Finding 35.**

---

### Finding 47: "Error events for blocking failures, never swallow silently" — no enforcement

**Type:** honor-system  
**Location:** `templates/CLAUDE.global.md:45`, `.claude/skills/claws-wave-subworker/SKILL.md:5`

**Current behavior:** Sub-workers are instructed to publish `worker.<peerId>.event` with `kind=ERROR`. No server-side detection of swallowed errors.

**Risk:** Worker hits an error, swallows it, continues silently or stalls. Orchestrator has no visibility.

**Hook-based replacement:**
- Server-side: on `worker.+.event` with `kind=ERROR`, auto-publish `system.worker.error` summary to orchestrator subscription. This aggregates error events for orchestrator visibility.
- Detect stalled workers: if no bus events from a worker for >120s (2x violation threshold), publish `system.worker.stalled` event.

---

### Finding 48: "--no-verify forbidden" — no enforcement anywhere

**Type:** honor-system  
**See Finding 32 for full analysis and hook replacement (highest priority).**

---

### Finding 49: "Full test suite before every commit" — no enforcement

**Type:** honor-system  
**See Finding 33.**

---

### Finding 50: "tsc --noEmit after every .ts edit" — no enforcement

**Type:** honor-system  
**See Finding 34.**

---

### Finding 51: "Complete event before sentinel" — sentinel order advisory

**Type:** honor-system / race condition  
**See Finding 36.**

---

## IX. Settings Hook Injections (PreToolUse, PostToolUse, Stop, SessionStart)

---

### Finding 52: All hooks have P5 "fail-open" safety — enforcement silently vanishes on any error

**Type:** hook fragility  
**Location:** All hook files, lines 11-15 (uncaughtException/unhandledRejection handlers), line 19-20 (setTimeout self-kill)

**Current behavior:**
```js
if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}
setTimeout(() => { process.exit(0); }, 5000).unref();
```
Any crash, syntax error, missing dependency, or timeout → exit 0 → hook treated as "passed" by Claude Code.

**Risk:** A bug in `session-start-claws.js` (e.g., `path.join` with undefined) silently exits 0. No sidecar spawned. No reminder emitted. Orchestrator proceeds without Monitor. All subsequent spawn-class calls may be unguarded.

**Cross-system risk:** This is by design (P5). But P5's safety guarantee conflicts with the enforcement goal. The two principles are contradictory: "hooks must never crash" vs "hooks must enforce."

**Why advisory:** Fail-open means every hook is advisory in practice. A broken hook is indistinguishable from a passing hook.

**Hook-based replacement:**
- CLAWS_DEBUG=1 should be the default for Claws-developer machines. Document this in install.sh.
- Add hook self-tests (already partially done via `test:hook-stdin-safety`). Run on every install/update.
- Add hook liveness check: PostInstall verifies hooks exit 0 with known-good inputs.
- **Cannot fully fix**: P5 is correct for end-user safety. But for Claws-internal development, CLAWS_DEBUG=1 should be standard.

---

### Finding 53: SessionStart hook reminder is advisory text only

**Type:** advisory  
**Location:** `scripts/hooks/session-start-claws.js:79-128`

**Current behavior:** Emits a `system-reminder` block with "FIRST ACTION (MANDATORY)" text. The text is advisory — it appears in Claude Code's UI as a reminder but has no programmatic enforcement.

**Risk:** If orchestrator ignores the reminder (e.g., high context pressure at session start), Monitor is never armed. All subsequent spawn-class calls unguarded (except for PreToolUse 5s grace — which doesn't block first spawn anyway).

**See Finding 5 for analysis. SessionStart itself is structural — the advisory text it emits is the gap.**

---

### Finding 54: PostToolUse monitor check — races with 5s self-kill timer

**Type:** time-based / hook fragility  
**Location:** `scripts/hooks/post-tool-use-claws.js:33` (MONITOR_WAIT_MS=4000), line 28 (5s self-kill)

**Current behavior:** PostToolUse waits up to 4s for monitor registration via `waitForMonitor`. 5s self-kill fires regardless.

**Risk:** If socket call to `lifecycle.snapshot` takes >1s (VS Code extension reloading, cold start), the 4 × 500ms poll ticks don't all complete before the 5s kill. Auto-close may not fire.

**See Finding 13 for full analysis.**

---

### Finding 55: Stop hook REFLECT reminder — advisory only, never blocks

**Type:** advisory  
**Location:** `scripts/hooks/stop-claws.js:100-109`

**Current behavior:**
```js
if (!phases_completed.includes('REFLECT')) {
  process.stderr.write('[LIFECYCLE REFLECT] Write your reflect summary...\n');
}
```
Writes to stderr. No action taken. Session ends.

**Risk:** Lifecycle never reaches REFLECT. Next session starts with stale lifecycle state. `canSpawn` gate may fire if `lifecycle.plan` was never called to reset the cycle.

**Hook-based replacement:**
- Stop hook: if not at REFLECT, call `lifecycle.advance(to='REFLECT', reason='stop-hook-force')` via raw socket. This is a real enforcement action that can be done with `sendCmd` pattern from PostToolUse.
- Stop hook also: call `close` on all unclosed workers (see Finding 41).

---

### Finding 56: PreToolUse spawn-class gate — explicit matchers for MCP tools fragile on tool name changes

**Type:** per-user configuration / fragility  
**Location:** `scripts/hooks/pre-tool-use-claws.js:117` (SPAWN_CLASS regex), `scripts/inject-settings-hooks.js` (explicit per-tool matchers)

**Current behavior:**
```js
const SPAWN_CLASS = /^mcp__claws__(claws_create|claws_worker|claws_fleet|claws_dispatch_subworker)$/;
```
Matches on `tool_name` field from hook input. Comment says "BUG-28: explicit matchers... so Monitor arm gate fires even if Claude Code does not propagate the '*' hook to MCP tools."

**Risk:** If Claude Code changes MCP tool name format (e.g., `mcp__claws_claws_create` → `mcp_claws_create`), regex doesn't match, gate silently disabled.

**Hook-based replacement:**
- Check for `tool_name.includes('claws_create') || tool_name.includes('claws_worker') || ...` with substring match instead of full-format match. More resilient to prefix format changes.

---

## X. Slash Command Honor-System Patterns

---

### Finding 57: /claws-worker instructs but does not enforce 3-step pattern

**Type:** advisory  
**Location:** `.claude/commands/claws-worker.md`

**Current behavior:** Documents "Canonical 3-step pattern" (claws_worker → claws_workers_wait → ls .local/audits). Advisory — no enforcement if orchestrator calls claws_worker and then just waits with claws_read_log instead.

**Risk:** Orchestrator polls claws_read_log directly instead of using claws_workers_wait. Bus events missed. Completion detected via polling 200 lines of pty output. Slow and fragile.

**Hook-based replacement:** N/A — slash commands are documentation. The underlying MCP tools can enforce patterns if designed correctly.

---

### Finding 58: /claws-fleet documents "Aggregate results as workers complete" — subjective

**Type:** advisory  
**Location:** `.claude/commands/claws-fleet.md:47-54`

**Current behavior:** "Aggregate results as workers complete. Report: Which workers finished successfully..." — all advisory.

**Risk:** Orchestrator doesn't aggregate, just closes all terminals at timeout. Data from workers lost.

**Hook-based replacement:** N/A — documentation pattern. Enforce via claws_workers_wait return value format.

---

### Finding 59: /claws-orchestration-engine SKILL.md Phase 4 OBSERVE says "event-driven — no polling"

**Type:** documentation vs reality gap  
**Location:** `.claude/skills/claws-orchestration-engine/SKILL.md:93-103`

**Current behavior:** SKILL.md says "no polling; all modes converge here" for OBSERVE phase. In reality, detach watcher uses setInterval polling (Finding 12). The skill documents the desired architecture, not the current implementation.

**Risk:** Orchestrators following SKILL.md believe they need no polling, but claws_workers_wait still polls.

**Gap:** Phase 4a bus completion is the real event-driven path. But claws_workers_wait fallback is polling. Document the distinction.

---

## XI. Additional Cross-Cutting Findings

---

### Finding 60: findStandaloneMarker regex — ANSI/rendering dependent, version fragile

**Type:** time-based / pty-scraping fragility  
**Location:** `mcp_server.js:437-448`

**Current behavior:** Marker detection regex matches `⏺`/`⎿` prefixes. Correct for current Claude Code rendering. Claude Code version updates that change indicator characters break marker detection silently.

**Risk:** Model upgrade (Claude Code v3.x) changes pty rendering → all pty-based completion signals fail simultaneously. No fallback except Wave D (terminal close).

**Hook-based replacement:** Phase 4a bus completion is the fix. When bus-completion is the primary path, `findStandaloneMarker` is a fallback only. Risk is limited to the fallback window.

---

### Finding 61: _scanAndPublishCLAWSPUB circuit breaker — disables scan after 3 errors

**Type:** advisory / circuit breaker  
**Location:** `mcp_server.js:463-495`

**Current behavior:** After 3 consecutive socket errors publishing CLAWS_PUB events, `_circuitBreaker.scanDisabled = true`. Scan remains disabled until explicit reconnect.

**Risk:** Workers printing `[CLAWS_PUB]` lines get their events silently dropped. No error surfaced to the orchestrator. Bus-based worker events stop flowing.

**Hook-based replacement:**
- On `scanDisabled=true`, publish `system.bus.scan-disabled` event to alert orchestrator. Currently the circuit breaker is entirely silent.

---

### Finding 62: Sidecar GAP-A1 dedup — pgrep race window

**Type:** race condition  
**Location:** `mcp_server.js:1254-1263`

**Current behavior:**
```js
const pgResult = spawnSync('pgrep', ['-f', `stream-events\\.js.*--auto-sidecar.*${escapedSocket}`]);
if (pgResult.status === 0) {
  const existingPid = parseInt(pgResult.stdout.trim().split('\n')[0], 10);
  _sidecarPid = existingPid;
  _sidecarSubscribed = true; // assumed subscribed without verification
  return;
}
```
Adopts the existing sidecar **without verifying it's actually subscribed**. Sets `_sidecarSubscribed = true` optimistically.

**Risk:** pgrep finds a sidecar that just crashed (zombie process not yet reaped) or is in the process of subscribing. MCP server believes sidecar is alive, skips spawn. Sidecar is actually dead. All bus events go nowhere.

**Hook-based replacement:**
- Send a `ping` to the existing sidecar via its PID or via the bus. If no response within 500ms, spawn new sidecar.

---

### Finding 63: PostToolUse grace file in /tmp — unsecured, survives session restarts

**Type:** per-user configuration / security  
**Location:** `scripts/hooks/pre-tool-use-claws.js:119` (`/tmp/claws-pretooluse-grace-${cwdKey}`)

**Current behavior:** Grace file at `/tmp/claws-pretooluse-grace-<cwdHash>` persists across Claude Code restarts. If a user restarts Claude Code within 5s of the grace file creation, enforcement is bypassed.

**Risk:** Malicious actor could write a grace file at the known path to permanently bypass Monitor arm enforcement. CWD hash is predictable (base64 of path, first 12 chars).

**Hook-based replacement:**
- Use a nonce-in-file pattern: write grace file with a random nonce; session-start hook verifies nonce on each restart. Nonce invalidation = fresh grace window.
- Or: remove grace window entirely (see Finding 14).

---

### Finding 64: Lock file for settings.json — advisory exclusive lock (not OS-level)

**Type:** per-user configuration / race  
**Location:** `scripts/inject-settings-hooks.js:47-76`

**Current behavior:** `withLock` uses `openSync(LOCK_PATH, 'wx')` as advisory lock. 15 attempts × 100ms backoff.

**Risk:** Not a true mutex — TOCTOU race if lock file is deleted between check and acquire. Also: if a lock-holding process crashes, lock file persists indefinitely, blocking all subsequent installs.

**Hook-based replacement:** Use `flock` (Unix advisory lock) via child_process on the settings file directly. More robust than file-existence lock.

---

### Finding 65: Lifecycle auto-advance engine — cascades via nextAutoPhase, safety limit 10 iterations

**Type:** time-based / potential infinite loop  
**Location:** `extension/src/lifecycle-engine.ts:32`

**Current behavior:**
```ts
let safety = 10;
while (safety-- > 0) {
  // try to advance
}
```
After 10 cascade iterations, engine silently stops. No log emitted.

**Risk:** If lifecycle rules are misconfigured, engine silently stops after 10 iterations without reaching the desired phase. No alert fires.

**Hook-based replacement:**
- Emit `system.lifecycle.cascade-limit-reached` event when safety==0 and there's still a recommended transition. Observable by orchestrator.

---

### Finding 66: canReflect gate checks closed, not status=closed — semantic gap

**Type:** enforcement gap  
**Location:** `extension/src/lifecycle-rules.ts:74-79`

**Current behavior:**
```ts
const stillOpen = state.spawned_workers.filter(w => w.status !== 'closed');
```
Checks `status !== 'closed'` — but `status` can be `'terminated'`, `'timeout'`, `'completed'`, `'failed'` and workers in those states may still have open terminal tabs (extension terminal not yet closed).

**Risk:** Worker terminal shows `status='completed'` in lifecycle state but VS Code tab is still open. `canReflect` passes. REFLECT phase entered. Cleanup incomplete.

**Hook-based replacement:**
- Add `terminalClosed: boolean` field to `SpawnedWorker` alongside `status`. Set via `system.terminal.closed` event (already emitted by extension `setTerminalCloseCallback`). `canReflect` checks `terminalClosed=true`, not `status='closed'`.

---

### Finding 67: claws_broadcast inject:true — sends arbitrary text into terminals

**Type:** security / honor-system  
**Location:** `mcp_server.js:1691-1698`, `extension/src/server.ts` broadcast handler

**Current behavior:** `claws_broadcast(inject=true)` sends text into all worker terminals via bracketed paste. Orchestrator must have role='orchestrator' to call broadcast.

**Risk:** If orchestrator peer is compromised or misconfigured, arbitrary text can be injected into all worker terminals. No content validation. Injection could include shell escape sequences.

**Hook-based replacement:**
- Validate broadcast content on server side: disallow characters that could escape bracketed paste mode (`\x1b[201~`). Currently: only `\x1b[200~` and `\x1b[201~` are stripped in mission text (`mcp_server.js:1008`) but broadcast is not similarly sanitized.

---

### Finding 68: Monitor pattern recommendation — tail -F documented as deprecated but still in CLAUDE.project.md

**Type:** documentation inconsistency  
**Location:** `docs/ARCHITECTURE.md:77-79` (says tail -F is anti-pattern), `templates/CLAUDE.project.md:44-48` (still shows tail -F as example)

**Current behavior:** ARCHITECTURE.md P9 says "tail -F | grep is an anti-pattern" and "stream-events.js is the canonical satisfier." But CLAUDE.project.md still shows `tail -F .claws/events.log` as the primary Monitor arm example.

**Risk:** New users follow CLAUDE.project.md and use tail -F. This works intermittently (SIGURG kills it after ~30s of bus inactivity). When bus is active (normal operation), it's fine. During idle periods, Monitor dies silently.

**Hook-based replacement:**
- Update CLAUDE.project.md and CLAUDE.global.md to show stream-events.js pattern as primary, tail -F as fallback only. The PreToolUse hook already accepts stream-events.js sidecar as primary satisfier.

---

### Finding 69: claws_workers_wait relies on pty readLog polling even when bus subscription is active

**Type:** redundant polling / architecture gap  
**Location:** `mcp_server.js:2141-2200`

**Current behavior:** `claws_workers_wait` polls `readLog` every 1.5s AND checks `_workerCompletedViaBusSet`. The bus check happens inside the polling loop, so detection is still 1.5s-latency-bounded even when bus event fires immediately.

**Risk:** Mission completes instantly (e.g., bus-complete fires at t=0). Orchestrator still waits up to 1.5s before claws_workers_wait returns.

**Hook-based replacement:**
- Inside `_pconnHandleData` (line ~246), when `_workerCompletedViaBusSet.set(termId, ...)` fires, wake up any waiting `claws_workers_wait` calls immediately via a waiter queue (same pattern as `_eventBuffer.waiters`).

---

### Finding 70: claws-wave-subworker SKILL.md still requires capabilities:['push'] — outdated

**Type:** documentation inconsistency  
**Location:** `.claude/skills/claws-wave-subworker/SKILL.md:11-12`, `templates/CLAUDE.global.md:39-40`

**Current behavior:** SKILL.md says "capabilities:['push'] is mandatory (BUG-03 workaround)." CLAUDE.global.md (updated) says "push capability is auto-granted on claws_hello — no need to specify explicitly."

**Risk:** Sub-workers that read SKILL.md still pass `capabilities:['push']` (harmless but confusing). Sub-workers that read CLAUDE.global.md don't pass it (also fine now). Inconsistency creates confusion about whether capabilities are required.

**Hook-based replacement:** N/A — documentation fix. Update SKILL.md to match CLAUDE.global.md.

---

### Finding 71: Lifecycle store `bootSession` called but lifecycle plan NOT required before it

**Type:** enforcement gap  
**Location:** `extension/src/server.ts` (lifecycle.plan handler), `extension/src/lifecycle-store.ts`

**Current behavior:** `bootSession` initializes the lifecycle store. `plan` transitions to PLAN phase. `canSpawn` requires SPAWN phase. But there is no enforcement that `bootSession` was called before `lifecycle.plan`. And `lifecycle.plan` transitions from SESSION-BOOT or REFLECT to PLAN — if state is null (clean start), `bootSession` must be called first.

**Risk:** If `lifecycle.plan` is called without prior `bootSession` and the lifecycle store has no state, the server creates a new plan. This is the intended behavior. But if state is already at SESSION-END (previous session never reflected), `lifecycle.plan` is blocked. Orchestrator receives confusing error.

**Hook-based replacement:**
- Make `lifecycle.plan` idempotent: if state is at SESSION-END, auto-call `bootSession` + advance to PLAN. Remove the need for orchestrators to call them in sequence.

---

### Finding 72: Dev hooks loaded into user projects via inject-dev-hooks.js

**Type:** per-user configuration / leakage  
**Location:** `scripts/inject-dev-hooks.js`, `scripts/dev-hooks/`

**Current behavior:** `inject-dev-hooks.js` writes Claws-internal development hooks (`check-stale-main`, `check-tag-vs-main`, etc.) into project settings. These are Claws-developer hooks that run on every Claude Code session in the project.

**Risk:** These hooks are Claws-internal CI checks. They shouldn't run in user projects. The `.local/audits/dev-hooks-leak-into-user-projects.md` confirms this is a known issue.

**Hook-based replacement:**
- Gate dev hooks on `CLAWS_DEV=1` env var. Only inject when in Claws source tree. Remove from user project injection path.

---

### Finding 73: Session-end lifecycle not enforced — SESSION-END phase unreachable via auto-advance

**Type:** enforcement gap  
**Location:** `extension/src/lifecycle-rules.ts:14-16` (TRANSITIONS), `extension/src/lifecycle-engine.ts`

**Current behavior:** `nextAutoPhase` does not auto-advance to SESSION-END — only to REFLECT. SESSION-END requires explicit `lifecycle_advance(to='SESSION-END')` call.

**Risk:** Lifecycle never reaches SESSION-END. Next `bootSession` (on next session) starts a new session state, but old state persists in memory until VS Code reload. No cleanup of peer registry, subscriptions, or task registry on session end.

**Hook-based replacement:**
- Stop hook calls `lifecycle.advance(to='SESSION-END')` via raw socket (same as Finding 55 proposal).
- Extension server: on SESSION-END transition, trigger cleanup (close orphaned terminals, purge stale peers).

---

### Finding 74: [CLAWS_PUB] scanner triggered only from polling loop — not from bus

**Type:** architecture gap  
**Location:** `mcp_server.js:461-496`, called from polling loops (mcp_server.js:1109, 1170, 2033)

**Current behavior:** `_scanAndPublishCLAWSPUB` scans new pty bytes for `[CLAWS_PUB]` marker lines on every poll tick. This is a pty-scraping mechanism that re-publishes events on behalf of SDK-less workers.

**Risk:** In the Phase 4a world, workers should use `claws_publish` directly (bus-native). `[CLAWS_PUB]` is a legacy bridge for SDK-less workers. But it's the only way non-MCP workers publish events. Since it's tied to polling, `[CLAWS_PUB]` events have 1.5s latency.

**Hook-based replacement:**
- Integrate `[CLAWS_PUB]` scanner into the `CaptureStore` onChange callback (in extension TypeScript, not in MCP polling). The extension can watch pty bytes in real-time and publish immediately on `[CLAWS_PUB]` detection. Zero-latency, not poll-dependent.

---

### Finding 75: claws_send auto-bracketed-paste for multi-line — may trigger Vim/shell edge cases

**Type:** advisory / behavior assumption  
**Location:** `mcp_server.js:1541-1543`

**Current behavior:**
```js
const isMultiLine = text.includes('\n') || text.includes('\r');
const resp = await clawsRpc(sock, { cmd: 'send', ..., paste: isMultiLine });
```
Auto-enables bracketed paste for multi-line text. Assumes the terminal is in a mode that supports bracketed paste.

**Risk:** Terminals running programs that don't support bracketed paste (some legacy REPLs, some vim configurations) receive `\x1b[200~...\x1b[201~` as literal text, corrupting input.

**Why advisory:** Cannot know without querying the terminal which mode it's in.

**Hook-based replacement:** Use `vehicle.+.content` events from `contentType` classification to determine if the terminal is running a supported program before enabling bracketed paste.

---

### Finding 76: claws_exec file-based output — polling for done file at 150ms intervals

**Type:** time-based  
**Location:** `mcp_server.js:399-411`

**Current behavior:**
```js
while (Date.now() < deadline) {
  if (fs.existsSync(donePath)) break;
  await sleep(150);
}
```
Polls for `/tmp/claws-exec/<id>.done` file every 150ms.

**Risk:** File system polling is not atomic. If the command writes partial output and crashes, `donePath` is never created. Orchestrator waits until `timeoutMs` (default 180s).

**Hook-based replacement:**
- Use `fs.watch` or `inotify` instead of polling. Node.js `fs.watchFile` with 100ms stat interval is more efficient than manual `existsSync` loop.
- Better: write exit code to pipe (not file), eliminating poll entirely.

---

### Finding 77: claws_hello in mcp_server.js allows hello without waveId for sub-workers — silently incomplete

**Type:** enforcement gap  
**Location:** `mcp_server.js:1627-1641`

**Current behavior:** `claws_hello` passes `waveId: args.waveId` if provided, else `undefined`. Server accepts hello without waveId even for workers claiming `subWorkerRole`.

**Risk:** A sub-worker calls `claws_hello` with `subWorkerRole='tester'` but without `waveId`. Server registers the peer but wave registration fails silently. Violation timers never set up. Wave orchestration blind.

**Hook-based replacement:**
- Server-side: if `role='worker'` and `subWorkerRole` is provided, require `waveId`. Return error if missing.

---

### Finding 78: Lifecycle state persisted to .claws/lifecycle-state.json — shared across sessions

**Type:** state management / advisory  
**Location:** `extension/src/lifecycle-store.ts`

**Current behavior:** Lifecycle state persists to disk. If VS Code crashes mid-session (SPAWN phase, 2 workers spawned but 3 expected), next session loads stale state with `phase=SPAWN, spawned_workers=[...]`.

**Risk:** Next session can't spawn new workers (capacity full from stale state). Orchestrator receives "expected_workers already spawned" error with no clear recovery path. Manual state reset required.

**Hook-based replacement:**
- On `bootSession`, check if stale workers in spawned_workers list. For each worker, check if terminal still exists via `list` command. If not, remove from state. Auto-healing on session start.

---

## XI. Phased Cleanup Roadmap

### Phase RIP — Pure Deletions (no replacement needed)

| Finding | Item | Removal Impact |
|---------|------|---------------|
| F2 | F1/F2/F3 convention from CLAUDE.md text | Zero — Wave D + bus completion make it redundant |
| F6 | Manual boot sequence documentation | Replace with vehicle FSM READY event |
| F8 | CLAUDE.project.md "MUST" rules duplicating CLAUDE.global.md | Redundant; hooks enforce, docs should be brief |
| F14 | Grace window in PreToolUse (replace with sidecar liveness check) | Zero — sidecar check is instant |
| F16 | T4 setTimeout monitor-arm warn in mcp_server.js | Redundant with PostToolUse hook |
| F20 | Heartbeat timer docs saying "every 20s" duplicated 5 places | Keep server config, delete from templates |
| F36 | Sentinel dependency in LEAD — remove, use only bus event | Zero — LEAD should use drain_events only |
| F70 | capabilities:['push'] requirement in SKILL.md | Update to match current behavior |

---

### Phase HOOK — Convert to Event-Driven Hooks

These items have clear hook replacements. Order by dependency (earlier = less deps):

| Priority | Finding | Hook | Action |
|----------|---------|------|--------|
| P1 | F32 | PreToolUse | Block `git commit.*--no-verify` — 5-line regex. **Highest value.** |
| P2 | F34 | PostToolUse | Run `npx tsc --noEmit` after Edit/Write of `*.ts` files |
| P3 | F41 | Stop hook | Auto-close orphaned terminals via raw socket before exit |
| P4 | F55 | Stop hook | Auto-advance lifecycle to REFLECT via raw socket |
| P5 | F17 | WaveRegistry | Auto-close (not just emit event) on violation after 25s |
| P6 | F14 | PreToolUse | Remove grace window; use instant sidecar liveness check |
| P7 | F10 | mcp_server | Subscribe to vehicle.+.state READY event for boot detection |
| P8 | F11 | mcp_server | Replace claws_workers_wait polling with drain_events waiter |
| P9 | F21 | mcp_server | On bus-complete, clear interval immediately (not on next tick) |
| P10 | F56 | PreToolUse | Use substring match for spawn-class MCP tool names |

---

### Phase REDESIGN — Require Architectural Change

| Finding | Current Model | Sketched Redesign |
|---------|--------------|------------------|
| F40 | No terminal ownership model | Introduce claim_token returned by claws_create; required for claws_close/claws_send. Protocol: claws/3 or claws/2 extension. |
| F7 | CLAUDE.md = prompt = advisory | Move ALL rules into hooks. CLAUDE.md becomes 3 lines: "Claws installed. Hooks enforce everything. Run /claws-help for status." |
| F24 | CLAWS_WORKER=1 env bypass | Replace with per-terminal nonce (random token per terminal, registered on create, verified on Edit/Write hook). |
| F62 | pgrep-based sidecar dedup with no liveness verification | Sidecar publishes a keepalive heartbeat; MCP server pings it before adopting. |
| F74 | [CLAWS_PUB] scanner in MCP polling loop | Move to extension CaptureStore onChange callback — real-time, not poll-based. |
| F73 | SESSION-END unreachable via auto-advance | Extension: on VS Code `onDidDeactivateExtension`, force lifecycle to SESSION-END, close all terminals. |

---

### Phase ACCEPT — Risks We Choose to Keep

| Finding | Risk | Mitigation | Reason to Accept |
|---------|------|-----------|-----------------|
| F19 | Auth token 5min stale window | N/A | Standard replay-prevention; auth is opt-in |
| F22 | install.sh required | Extension activate() can re-verify + remind | Bootstrapping problem; some manual step always needed |
| F25 | MCP server registration per-user | Extension activate() can detect + prompt | Bootstrapping problem |
| F27 | Sidecar env vars | Values hardcoded in spawn call | Low risk; override by spread is correct |
| F52 | P5 fail-open hooks | CLAWS_DEBUG=1 for dev machines | End-user safety requires fail-open; can't change |
| F76 | claws_exec done-file polling | fs.watchFile improvement | Low priority; exec is synchronous; 150ms latency acceptable |

---

## Summary Statistics

| Category | Count | % Advisory | Top Risk |
|----------|-------|-----------|---------|
| Mission preamble | 3 | 100% | F1: bus-completion header |
| Documentation text | 6 | 100% | F4: P10 gap, F5: Monitor arm |
| CLAUDE.md advisory | 3 | 100% | F7: global rules |
| Time-based | 12 | 83% | F10: boot timeout, F11: workers_wait |
| Per-user config | 6 | 67% | F22: install.sh deps, F23: STRICT mode |
| Worker assumptions | 10 | 100% | F32: --no-verify, F33: test suite |
| Orchestrator assumptions | 6 | 67% | F40: terminal ownership, F38: Monitor |
| Wave contract | 8 | 100% | F48: --no-verify, F44: timer mismatch |
| Hook fragility | 4 | 75% | F52: P5 fail-open |
| Slash commands | 3 | 100% | F59: docs vs reality gap |
| Cross-cutting | 8 | 75% | F62: sidecar race, F66: canReflect gap |

**Total findings: 78**

**Enforced today (server-side, not advisory):**
1. `canSpawn` lifecycle gate — blocks spawn when lifecycle not in SPAWN phase
2. `canCleanup` gate — blocks CLEANUP when workers have non-terminal status
3. `canReflect` gate — blocks REFLECT when terminals not closed
4. `auth:` HMAC token validation in hello — blocks unauthorized peer registration
5. PreToolUse hard-block: Edit/Write to mcp_server.js from non-worker — hard enforcement
6. PostToolUse auto-close: orphaned terminal (no monitor within 5s) — enforced but race window
7. Rate limiting: publish rate tracker per peer — enforced in server.ts

**Top 5 highest-risk findings (each one is a systemic failure mode):**

1. **F32** — `--no-verify` bypass: zero enforcement. Workers commit untested code. Pre-commit hooks exist for a reason; bypassing them silently breaks quality gates. One-line hook fix. Highest ROI.
2. **F52** — P5 fail-open: every hook is silently advisory on any crash. A broken hook = no enforcement. Undetectable by design. CLAWS_DEBUG=1 mitigates during development.
3. **F22** — install.sh dependency: entire enforcement chain (hooks) is absent for users who didn't run install.sh or whose settings.json was reset. Machine-wide enforcement depends on install hygiene.
4. **F17** — Wave violation fires event, not action: silent workers persist indefinitely. Orchestrator must be subscribed AND must act. If orchestrator is stuck in a tool call, violation is invisible.
5. **F40** — No terminal ownership model: any client can close/send to any terminal. Security boundary between orchestrator and user terminals doesn't exist. Protocol-level fix required.

---

*End of advisory mechanism audit. 78 findings. 10 categories. Phased cleanup roadmap in Section XI.*
