# Claws — Architecture Reference

> **Status**: This document is the canonical architectural anchor for Claws. Every implementation choice — including bug fixes — must be checked against the principles and component contracts here. If a fix would violate something in this doc, fix the doc OR change the approach. Never silently drift.
>
> **Version**: v0.7.10 baseline (May 2026). Updated on architectural changes only.

---

## I. The Charter — what Claws is

Claws is a **bridge** that turns every VS Code integrated terminal into a programmable, observable, controllable endpoint. External processes (AI orchestrators, automation, CI) connect over a local socket and orchestrate terminals end-to-end.

**Claws IS:**
- A VS Code extension that owns terminal identity, pty capture, and a JSON-over-socket protocol.
- An MCP server that exposes that protocol as tools to Claude Code (and other MCP clients).
- A pub/sub event bus (claws/2) that lets orchestrators and workers communicate as peers.
- A 10-phase lifecycle state machine that orchestrates multi-terminal missions.
- A 5-layer enforcement chain that makes the protocol non-optional in practice.

**Claws IS NOT:**
- A terminal emulator (VS Code already is one).
- A remote shell (SSH already does that).
- A multiplexer (tmux already does that).
- A collaboration tool (Live Share already does that).
- A polling/heuristic completion detector. **Completion is event-driven, period.**

The smallest surface area that enables AI-driven multi-terminal orchestration with strong contracts.

---

## II. Architectural Principles (Non-Negotiable)

Each principle has a **rationale** (why) and an **enforcement** (where the protocol holds the line). If a code change violates a principle, the change is wrong — not the principle.

### P1 — Event-driven, never polling
Completion, state changes, worker progress — all surface as bus events. Never `sleep + check`, never idle-timeout heuristics, never "give up after N seconds and assume done."
- **Rationale**: Polling is fragile (race conditions, false positives), it burns budget, and it makes the system silent during the only periods that matter (long-running real work). The pub/sub bus exists precisely so observation is event-sourced.
- **Enforcement**: `[CLAWS_PUB]` line scanner publishes worker self-reported events; `system.worker.completed` emitted by the watcher only on explicit signals (marker / error / pub-complete); VS Code `onDidCloseTerminal` becomes `system.worker.terminated` (planned).
- **Anti-pattern**: idle-timeout in `detectCompletion` (introduced in Task #58, ripped out in v0.7.10 — see anti-patterns catalog).

### P2 — Wrapped terminals or it doesn't count
Anything Claws creates is `wrapped: true` (under `script(1)`) so the full pty stream is captured to a log. Unwrapped terminals are user-owned and Claws never touches them.
- **Rationale**: VS Code shell-integration is unreliable for TUIs (Claude, vim, REPLs). pty capture is the only reliable observability.
- **Enforcement**: `claws_create wrapped=true` is the default contract. `readLog` rejects unwrapped terminals.

### P3 — Non-blocking by default for spawn-class tools
`claws_worker` / `claws_fleet` / `claws_dispatch_subworker` spawn terminals and return `terminal_ids` within seconds. Orchestrators poll completion via `claws_workers_wait`, the bus, or `.local/audits/` files.
- **Rationale**: MCP stdio cannot safely hold a response open for more than a few seconds. Blocking the socket stalls the entire orchestrator session.
- **Enforcement**: `detach` defaults to `true` in v0.7.10. Blocking modes (`wait:true` / `detach:false`) are explicit opt-in and flagged unsafe.

### P4 — Atomic writes for every persisted file
`.claws/lifecycle-state.json`, `~/.claude/settings.json`, `CLAUDE.md` (CLAWS:BEGIN block), event log segments — all use temp-file + fsync + rename.
- **Rationale**: Partial writes during crash, reload, or concurrent install corrupt the install permanently and silently.
- **Enforcement**: `json-safe.mjs` + `atomic-file.mjs` helpers; fsync test (`test:lifecycle-store-fsync`); exclusive lock for settings (`test:inject-settings-exclusive-lock`).

### P5 — Hooks safety over hook completeness
Hooks may never crash, hang, or exit non-zero except for an intentional, documented deny. A buggy hook must degrade silently.
- **Rationale**: A flaky hook breaks every Claude Code session machine-wide. Worse than a missing hook.
- **Enforcement**: Every hook has a 5s self-kill `setTimeout(...).unref()`, every block is wrapped in try/catch, errors only print when `CLAWS_DEBUG=1`. Verified by `test:hook-stdin-safety`, `test:hook-misfire-log`, `test:hook-debug-visibility`.

### P6 — One commit, one concern; no `--no-verify`
Pre-commit hooks (test suite + CHANGELOG update) are mandatory. Bypassing them is not allowed even when the bypass would be "convenient."
- **Rationale**: Every bypass becomes load-bearing. The hook exists because something broke last time.
- **Enforcement**: Memory rule + worker mission preambles. Every worker that needs to commit gets reminded explicitly.

### P7 — File-referrer missions are forbidden
Worker missions must be inline in the `mission:` arg. Never `Read /path/to/mission.md and execute it`.
- **Rationale**: v0.7.9 introduced file-referrer to handle multi-line missions. v0.7.10 (commit 70ec1b1) ripped it out — direct prompts are simpler, debuggable, and don't leave temp files behind.
- **Enforcement**: Documented in memory + `templates/CLAUDE.project.md`. Future Wave C should add a hook that detects "Read .*mission.*md" patterns and fails.

### P8 — Direct edits to `mcp_server.js` from the orchestrator are forbidden
The orchestrator dispatches a worker for every change to `mcp_server.js`. Workers run with `CLAWS_WORKER=1` and bypass the gate.
- **Rationale**: `mcp_server.js` is the contract surface. Inline orchestrator patches accumulate untested, ungated, and untraceable churn.
- **Enforcement**: `pre-tool-use-claws.js` PreToolUse hook hard-blocks Edit/Write to `mcp_server.js` from the orchestrator (verified live).

### P9 — Monitor primitive: bus-stream subscription, not file polling
Orchestrators arm Monitors via `Monitor + scripts/stream-events.js | grep --line-buffered` — bus subscription with sub-100ms latency. Never `tail -F file | grep` (anti-pattern: dies via SIGURG within ~30s of inactivity).
- **Rationale**: `tail -F | grep` is a passive idle wait; Claude Code's background-process supervisor SIGURG-kills it. `stream-events.js` emits constantly (heartbeats, system metrics, every event) — it never goes idle, never gets killed, and each push frame becomes one Monitor notification.
- **Enforcement**: CLAUDE.md principle #5 documents canonical pattern. Spawn-class tool responses include `monitor_arm_command` in the canonical form. Wave C (TODO) will make the PreToolUse hook recognize the bus-stream pattern and stop demanding the deprecated `tail -F` satisfier.

### P10 — Lifecycle gates are server-enforced, not honor-based
Phase transitions, worker capacity, terminal-must-be-closed-before-REFLECT — all enforced by the lifecycle store before the relevant operation lands. Orchestrators cannot skip phases.
- **Rationale**: Pre-v0.7.10 was an 8-phase honor system. Orchestrators routinely skipped CLEANUP or REFLECT. The v0.7.10 store + engine + rules close that.
- **Enforcement**: `canSpawn` (gates `claws_create`), `canCleanup` / `canReflect` / `canEndSession` (gate transitions), `nextAutoPhase` (engine cascades). Hook-side enforcement (Wave C TODO): PostToolUse verifies monitor registered within 5s; Stop hook blocks exit until phase ∈ {REFLECT, SESSION-END}.

---

## III. System Layers

```
┌─ Slash commands + skills (.claude/) ─────────────────────────────┐
│   /claws-do, /claws-go, /claws-worker, /claws-fleet, …           │
│   skills/claws-prompt-templates/SKILL.md                         │
└──────────────────────────────────────────────────────────────────┘
           ↓
┌─ Templates + injectors (templates/, scripts/inject-*) ───────────┐
│   CLAUDE.global.md → ~/.claude/CLAUDE.md                          │
│   CLAUDE.project.md → <project>/CLAUDE.md (CLAWS:BEGIN block)     │
│   inject-settings-hooks.js → ~/.claude/settings.json              │
└──────────────────────────────────────────────────────────────────┘
           ↓
┌─ Hooks (scripts/hooks/) ─────────────────────────────────────────┐
│   session-start-claws.js → reminder + sidecar spawn               │
│   pre-tool-use-claws.js → spawn-gate + Bash-pattern + edit-gate   │
│   stop-claws.js → cleanup + REFLECT reminder                      │
└──────────────────────────────────────────────────────────────────┘
           ↓
┌─ MCP server (mcp_server.js) — 38 tools ──────────────────────────┐
│   Per-call socket (claws/1): list, create, send, exec, readLog,  │
│     close, lifecycle.*                                            │
│   Persistent socket (claws/2): hello, publish, subscribe,         │
│     broadcast, task.*, drain_events                               │
│   Worker orchestration: claws_worker, claws_fleet,                │
│     claws_dispatch_subworker (with detach watchers)               │
└──────────────────────────────────────────────────────────────────┘
           ↓
┌─ stream-events.js sidecar ───────────────────────────────────────┐
│   Single persistent claws/2 connection; subscribes to **;        │
│   pipes every push frame to .claws/events.log (one line each).   │
│   Spawned by SessionStart hook, killed by Stop hook.             │
└──────────────────────────────────────────────────────────────────┘
           ↓
┌─ VS Code extension (extension/src/, TypeScript) ─────────────────┐
│   ClawsServer (Unix socket, claws/1 + claws/2 routing)            │
│   TerminalManager + ClawsPty (wrapped pty via node-pty)          │
│   CaptureStore (per-terminal ring buffer with ANSI strip)        │
│   PeerRegistry + TaskRegistry + WaveRegistry                      │
│   LifecycleStore + LifecycleRules + LifecycleEngine              │
│   EventLog (append-only segmented JSONL with rotation)           │
└──────────────────────────────────────────────────────────────────┘
```

### A. VS Code Extension (`extension/src/`)

22 TypeScript files, ~7,000 lines. Strict mode, zero npm runtime deps (only stdlib + VS Code API + bundled `node-pty`).

| File | Lines | Purpose |
|------|-------|---------|
| `extension.ts` | 862 | Activation entry; per-workspace ClawsServer; UUID-keyed terminal profile matching; 30s pending-pty cleanup; deactivate hardening (3s timeout) |
| `server.ts` | 2010 | Unix socket server; routes claws/1 + claws/2; peer/task/wave registries; rate limiting; event log; backpressure; lifecycle integration |
| `terminal-manager.ts` | 363 | Stable terminal IDs; vehicle state FSM (PROVISIONING→BOOTING→READY→BUSY/IDLE→CLOSING→CLOSED); 2s content polling; 60s unopened-pty cleanup |
| `claws-pty.ts` | 446 | `vscode.Pseudoterminal` impl; bundled-first node-pty load with pipe-mode fallback; bracketed-paste; env sanitization (drop VSCODE_/ELECTRON_/npm_ prefixes); foreground PID detection |
| `capture-store.ts` | 111 | Per-terminal circular buffer; trim-on-overflow; offset-based reads; ANSI-strip on demand |
| `protocol.ts` | ~200 | Wire types (claws/1 + claws/2); SubWorkerRole + ContractedRoles |
| `ansi-strip.ts` | 53 | CSI/OSC/DCS/single-ESC/C0-C1 stripping; preserves `\t` `\n` `\r` |
| `peer-registry.ts` | 94 | Peer identity (`p_NNNNNN`); fingerprinting (`fp_NNNNNNNNNNNN`) for reconnect; subscription tracking |
| `task-registry.ts` | 52 | Task lifecycle (pending → running → blocked → succeeded/failed/skipped); IDs `t_NNN` |
| `lifecycle-store.ts` | ~250 | Schema v3 state; persists to `.claws/lifecycle-state.json` atomically; `bootSession`, `plan`, `setPhase`, `registerSpawn`, `registerMonitor`, `markWorkerStatus`, `reflect` |
| `lifecycle-rules.ts` | ~170 | Pure validators: `canTransition`, `canSpawn`, `canCleanup`, `canReflect`, `canEndSession`, `nextAutoPhase` (auto-advance decisions) |
| `lifecycle-engine.ts` | 61 | `onWorkerEvent` triggers cascade through `nextAutoPhase`; safety limit 10 iterations; emits `lifecycle.phase-changed` |
| `server-config.ts` | 99 | Live config getter from VS Code settings; hot-reload on settings.json edits |
| `status-bar.ts` | ~100 | Right-aligned status item; color-coded (green/yellow/red); 30s refresh |
| `topic-registry.ts` | 69 | Zod schema map `pattern → schema` for all known topics |
| `topic-utils.ts` | 47 | Pure `matchTopic(topic, pattern)`; `*` (one segment) and `**` (one+ segments, greedy) |
| `event-schemas.ts` | ~150 | EnvelopeV1 + WorkerBootV1 / WorkerPhaseV1 / WorkerEventV1 / WorkerHeartbeatV1 / WorkerCompleteV1 / Cmd*V1 / VehicleStateV1 / PipelineStepV1 / RpcRequestV1 / RpcResponseV1 / WaveHarvestedV1 |
| `event-log.ts` | ~250 | Append-only segments (10 MB / 1h rotation); manifest tracking; cursor `NNNN:offset`; crash recovery via dir scan |
| `pipeline-registry.ts` | 83 | In-memory data-flow pipelines `pipe_NNNN`; source/sink steps; close marks all closed |
| `websocket-transport.ts` | ~150 | L19 WebSocket server; lazy `ws` require; `WsSocketAdapter` shim presents net.Socket-like interface |
| `wave-registry.ts` | ~150 | Wave manifest; per-sub-worker 25s violation timer; LEAD violation timer; auto-harvest |
| `uninstall-cleanup.ts` | 233 | Inventory + remove Claws-installed artifacts (.mcp.json entry, .claws-bin, .claude/commands/claws-*, CLAWS:BEGIN block); atomic writes; per-folder confirmation |

### B. MCP Server (`mcp_server.js`, ~2150 lines)

Pure Node.js, zero deps. Exposes 38 MCP tools to Claude Code over stdio JSON-RPC.

**Tool families:**
- **Terminal control** (claws/1, per-call socket): `claws_list`, `claws_create`, `claws_send`, `claws_exec`, `claws_read_log`, `claws_poll`, `claws_close`
- **Worker orchestration**: `claws_worker`, `claws_fleet`, `claws_workers_wait`, `claws_dispatch_subworker`
- **Pub/sub** (claws/2, persistent socket): `claws_hello`, `claws_subscribe`, `claws_publish`, `claws_broadcast`, `claws_ping`, `claws_drain_events`, `claws_peers`
- **Lifecycle**: `claws_lifecycle_plan`, `claws_lifecycle_advance`, `claws_lifecycle_snapshot`, `claws_lifecycle_reflect`
- **Wave**: `claws_wave_create`, `claws_wave_status`, `claws_wave_complete`
- **Tasks**: `claws_task_assign`, `claws_task_update`, `claws_task_complete`, `claws_task_cancel`, `claws_task_list`
- **RPC + commands**: `claws_deliver_cmd`, `claws_cmd_ack`, `claws_rpc_call`
- **Schema + pipeline**: `claws_schema_list`, `claws_schema_get`, `claws_pipeline_create`, `claws_pipeline_list`, `claws_pipeline_close`

**Three socket models inside the MCP server:**
1. **Per-call stateless** (claws/1): `clawsRpc(sockPath, req, timeout)` — opens, sends one frame, reads response, closes. Used by every claws/1 tool + lifecycle.
2. **Persistent claws/2** (`_pconn`): single TCP socket, lazy connect, auto-reconnect with 1s delay, idempotent `_pconnEnsureRegistered` re-registers on reconnect. Used by all stateful claws/2 tools.
3. **Sidecar stream**: `stream-events.js` holds its own claws/2 connection subscribed to `**`; pipes push frames to `events.log`.

**Detach watcher pattern** — there are 4 watchers, all sharing the same `detectCompletion` helper (Task #58, idle-timeout removed):
1. `runBlockingWorker` detach branch (~line 659): created when `claws_worker(detach:true)` (default). Background `setInterval` polls log, calls `detectCompletion`, on signal publishes `system.worker.completed` + auto-closes.
2. `runBlockingWorker` blocking poll loop (~line 726): for `wait:true` / `detach:false`. Same logic, in-line while loop.
3. Fast-path `_fpTick` (~line 1425): for `claws_worker` fast-path (event-driven boot detection — polls for `❯` + `cost:$` stable for 3 polls + 5000ms settle).
4. `dispatch_subworker` `_dswTick` (~line 1885): for wave sub-workers; same shape but tracks `waveId` + `role` in payload.

**Ring buffer + drain** (`_eventBuffer`): 1000-frame circular buffer captures every server push; dedup via `seenSequences` Set; overflow emits `system.bus.ring-overflow`; `claws_drain_events` consumers wait via `_eventBuffer.waiters`.

**Sidecar auto-spawn** (`_spawnAndVerifySidecar`): on first claws/2 push, MCP detects + spawns `stream-events.js` if not running (pgrep dedup by socket path), opens `events.log`, waits for `sidecar.subscribed` JSON. GAP-A1 fixes the dedup.

### C. Scripts Layer

**Install / update / uninstall:**
- `install.sh` (~380 lines, Unix), `install.ps1` (Windows): clone → install extension → build VSIX → install to editor → inject CLAUDE.md → register MCP → register hooks. 9 steps, idempotent, env-overridable.
- `update.sh`: pull → rebuild → reinstall → re-inject. Preserves `.claws/lifecycle-state.json`.
- `uninstall.sh`: deregister hooks via `inject-settings-hooks.js --remove` → strip CLAWS:BEGIN blocks → remove shell-hook sourcing → kill sidecar+tail → remove grace file.

**Injectors:**
- `inject-claude-md.js`: writes `<!-- CLAWS:BEGIN --> ... <!-- CLAWS:END -->` block into project `CLAUDE.md`. Atomic write. Migrates legacy v0.1–v0.3 sections.
- `inject-global-claude-md.js`: same for `~/.claude/CLAUDE.md`.
- `inject-settings-hooks.js`: registers SessionStart + PreToolUse + Stop hooks into `~/.claude/settings.json`. Tags with `_source:"claws"` for clean uninstall. Atomic + JSONC-tolerant + exclusive-lock (M-18). Auto-migrates legacy flat-array hook format.

**Hooks:**
- `session-start-claws.js`: detects `.claws/claws.sock`; spawns sidecar (pgrep dedup); pre-creates `events.log`; emits lifecycle reminder. 5s self-kill, silent errors unless `CLAWS_DEBUG=1`.
- `pre-tool-use-claws.js`: gates spawn-class MCP tools (must have Monitor armed within 5s grace); blocks long-running Bash patterns (`npm/yarn/pnpm/bun` + `serve|dev|watch`, `node/python` + `server`, `uvicorn`/`gunicorn`/`flask run`, etc.) with argv0 allowlist (BUG-16); blocks Edit/Write to `mcp_server.js` from orchestrator (worker bypass via `CLAWS_WORKER=1`).
- `stop-claws.js`: kills sidecar + orphan tails + grace file; warns on unclosed terminals; reminds about REFLECT.

**Stream + helpers:**
- `stream-events.js`: persistent claws/2 sidecar; subscribes per `CLAWS_TOPIC` env (default `**`); JSON output one frame per stdout line. Designed for Monitor consumption.
- `shell-hook.sh`: sourced by `~/.zshrc` / `~/.bashrc`; emits Claws banner + bridge status; provides `claws-ls`, `claws-new`, `claws-run`, `claws-log` shell functions over the socket.
- `terminal-wrapper.sh`: sets `CLAWS_WRAPPED=1`, `CLAWS_PIPE_MODE` conditional, `CLAWS_WORKER` env vars inside wrapped terminals.
- `bump-version.sh`: single source of truth for version bumps across `package.json`, extension `package.json`, tags.
- `_helpers/json-safe.mjs` + `atomic-file.mjs`: shared atomic-write helpers used by all injectors.

### D. Templates + Slash Commands

**Templates** (`templates/`):
- `CLAUDE.global.md`: machine-wide policy; loaded into `~/.claude/CLAUDE.md` by global injector. Contains the 7-step worker boot sequence, the lifecycle phase list, and the wave discipline contract.
- `CLAUDE.project.md`: project-level rules; loaded into `<project>/CLAUDE.md` CLAWS:BEGIN block. Contains tool inventory placeholders (`{TOOLS_V1_COUNT}`, `{TOOLS_V2_COUNT}`, `{CMDS_COUNT}`) filled at injection time.

**Slash commands** (`.claude/commands/claws-*.md`): 19 commands. The user-facing entry points (`/claws-do`, `/claws-go`, `/claws-worker`, `/claws-fleet`, `/claws-army`, `/claws-watch`, `/claws-cleanup`, etc.) and admin commands (`/claws-install`, `/claws-update`, `/claws-fix`, `/claws-status`, `/claws-introspect`, etc.).

**Skills** (`.claude/skills/`):
- `claws-prompt-templates/SKILL.md`: production-grade mission prompts and lifecycle patterns.
- `claws-wave-lead/SKILL.md` + `claws-wave-subworker/SKILL.md`: wave army role contracts.

---

## IV. Wire Protocols

### claws/1 (Terminal Control) — per-call stateless

Newline-delimited JSON over Unix socket (`.claws/claws.sock`). Multi-root workspaces get one socket per folder.

Request envelope:
```json
{ "id": <number|string>, "cmd": "<command>", "protocol": "claws/1", ...args }
```

Response envelope (always):
```json
{ "id": <echoed>, "rid": <echoed>, "ok": true|false, "protocol": "claws/1", ... }
```
Use `rid` (not `id`) for correlation — `id` is sometimes shadowed by response-specific fields (e.g., `create` returns the new terminal's `id`).

Commands: `list`, `create`, `show`, `send`, `exec`, `readLog`, `poll`, `close`, `introspect`. See `docs/protocol.md` for full request/response shapes.

### claws/2 (Agentic SDLC) — persistent connection

Same wire format but the connection is stateful. Required first frame:
```json
{ "id": 1, "cmd": "hello", "protocol": "claws/2", "role": "orchestrator|worker|observer",
  "peerName": "...", "terminalId": "<optional>", "capabilities": ["push", ...] }
```
Server allocates `peerId` (`p_NNNNNN` transient, or `fp_NNNNNNNNNNNN` if `instanceNonce` provided for reconnect recovery). Exactly one orchestrator per socket.

**Server-pushed frame** (no `rid`, can arrive any time after `hello`):
```json
{ "push": "message", "protocol": "claws/2", "topic": "...",
  "from": "p_NNNNNN", "payload": {...}, "sentAt": <epoch_ms> }
```

**Commands**: `subscribe`, `unsubscribe`, `publish`, `broadcast`, `task.assign`, `task.update`, `task.complete`, `task.cancel`, `task.list`, `ping`.

### Topic namespace

| Prefix | Owner | Permissions | Purpose |
|--------|-------|-------------|---------|
| `worker.<peerId>.*` | worker (self) | write self only | boot / phase / heartbeat / event / complete |
| `cmd.<peerId>.*` | orchestrator | orchestrator-only write | direct commands |
| `cmd.role.<role>` | orchestrator | orchestrator-only | broadcast by role |
| `task.<taskId>.*` | orch + assignee | split | task lifecycle |
| `wave.<waveId>.<role>.*` | LEAD + sub-workers | role-scoped | wave army |
| `system.*` | server | server-only | peer joined/left/stale, gate fires, malformed events, worker.completed/spawned |

**Wildcards** (`subscribe` / `topic_registry`): `*` = one segment, `**` = one+ segments greedy.

---

## V. Lifecycle Architecture (10-Phase, v0.7.10)

Schema v3 (`extension/src/lifecycle-store.ts`):
```typescript
interface LifecycleState {
  v: 3;
  phase: Phase;
  phases_completed: Phase[];
  plan: string;
  worker_mode: 'single' | 'fleet' | 'army';
  expected_workers: number;
  spawned_workers: { id, correlation_id, name, spawned_at, status, completed_at? }[];
  monitors: { terminal_id, correlation_id, command, armed_at }[];
  workers: { id, closed }[];   // backward-compat mirror
  mission_n: number;
  session_started_at: string;
  mission_started_at: string;
  reflect?: string;
}
```

### The 10 phases

```
SESSION-BOOT → PLAN → SPAWN → DEPLOY → OBSERVE
                                         ↓     ↘
                                       HARVEST  RECOVER (escape — back to DEPLOY/OBSERVE/FAILED)
                                         ↓
                                       CLEANUP → REFLECT → PLAN (next mission)
                                                            ↓
                                                          SESSION-END
       FAILED is reachable from any phase; routes to CLEANUP or SESSION-END.
```

| # | Phase | Trigger | Entry gate | Auto-advance |
|---|-------|---------|-----------|--------------|
| 0 | SESSION-BOOT | mcp_server constructor / session-start hook | sidecar verified alive | auto when sidecar verified |
| 1 | PLAN | `claws_lifecycle_plan(text, mode, count)` | non-empty text + valid mode + positive count | manual |
| 2 | SPAWN | `claws_lifecycle_advance to=SPAWN` | PLAN done | auto → DEPLOY when all `expected_workers` spawned + monitors armed |
| 3 | DEPLOY | engine | all workers registered + monitored | auto → OBSERVE when any worker `status !== spawned` |
| 4 | OBSERVE | engine | at least one worker progressed | auto → HARVEST: single=1 done; fleet=all done; army=`claws_wave_complete` |
| 5 | RECOVER | manual on failure | any | manual |
| 6 | HARVEST | engine | all workers terminal | auto → CLEANUP via `canCleanup` |
| 7 | CLEANUP | engine | gate via `canCleanup` | auto → REFLECT via `canReflect` (all closed) |
| 8 | REFLECT | `claws_lifecycle_reflect(text)` | gate via `canReflect` | manual: → PLAN (mission n+1) or → SESSION-END |
| 9 | SESSION-END | Stop hook or explicit | phase REFLECT/FAILED + zero open terminals | terminal |

### Auto-advance engine (`lifecycle-engine.ts`)

`onWorkerEvent(reason)` cascades transitions via while-loop until `nextAutoPhase(state)` returns null. Safety limit 10 iterations. Each transition validated by `canTransition` + appropriate gate before persisting. Emits `lifecycle.phase-changed` on the bus.

`nextAutoPhase` rules (`lifecycle-rules.ts`):
- SPAWN → DEPLOY: `spawned.length === expected && allWorkersHaveMonitors(state)`
- DEPLOY → OBSERVE: `spawned.some(w => w.status !== 'spawned')`
- OBSERVE → HARVEST: mode-aware (army never auto-advances; single=1 terminal status; fleet=all)
- HARVEST → CLEANUP: `canCleanup(state).ok` (BUG-A fix)
- CLEANUP → REFLECT: `canReflect(state).ok` (BUG-B fix — `mark-worker-status('closed')` after auto-close)

### D+F architecture (Declaration + Forwarding)

Race-free spawn + monitor registration:
1. **D (Declaration)**: orchestrator-supplied `correlation_id` (UUID) flows in mission AND in spawn-tool args.
2. **F (Forwarding)**: MCP spawn tool atomically calls `lifecycle.register-spawn(termId, corrId, name)` + `lifecycle.register-monitor(termId, corrId, command)` before returning.
3. Watcher publishes `system.worker.completed` with `correlation_id` in payload.
4. Per-worker Monitor subscribes via `grep '"correlation_id":"<UUID>"' | grep -m1 'system\.worker\.completed'` — exits on first completion event for THAT worker.

Result: zero race window between "terminal exists" and "monitor registered." Correlation_id is the single source of truth for matching events to workers.

---

## VI. Enforcement Chain (5 + 1 layers)

The enforcement chain is *progressive* — each outer layer educates, each inner layer enforces. Failure of an outer layer surfaces in an inner layer's deny.

| # | Layer | Scope | Mechanism | Failure mode |
|---|-------|-------|-----------|--------------|
| 1 | `templates/CLAUDE.global.md` → `~/.claude/CLAUDE.md` | machine-wide | always-loaded user instructions | honor system + boot sequence |
| 2 | `templates/CLAUDE.project.md` → `<project>/CLAUDE.md` CLAWS:BEGIN | project | always-loaded project instructions + tool inventory | honor system + lifecycle phases |
| 3 | `.claude/rules/claws-default-behavior.md` (ECC plugin) | session-runtime | system-reminder via ECC SessionStart | optional supplement |
| 4 | `scripts/hooks/session-start-claws.js` | session start | sidecar spawn + reminder emit | sidecar dead → PreToolUse deny |
| 5 | `scripts/hooks/pre-tool-use-claws.js` | every MCP tool call | hard-block via exit 2 OR `permissionDecision: deny` | spawn-class denied if Monitor missing; long Bash patterns blocked; mcp_server.js edits forbidden from orchestrator |
| 6 | `scripts/hooks/stop-claws.js` | session end | cleanup + audit | warn on unclosed terminals + missing REFLECT |

Wave C (TODO):
- New `post-tool-use-claws.js`: fail-closed if `lifecycle.monitors[terminal_id]` not registered within 5s of a spawn-class tool returning.
- Update `stop-claws.js`: hard-block exit until phase ∈ {REFLECT, SESSION-END} + zero open terminals.
- Update `pre-tool-use-claws.js`: recognize the canonical bus-stream Monitor pattern (currently still demands the deprecated `tail -F` satisfier — known bug).

---

## VII. Test Infrastructure

109 test files / 143 named test targets in `extension/package.json`. `npm test` runs them all sequentially. Major categories:

- **Smoke + baseline** (5): activation, native PTY, config reload, capture-store trim, oversized line.
- **Native bundle + build** (8): arch selection, spawn correctness, timeout, editor detect, atomic copy.
- **PTY lifecycle + capture** (6): per-terminal isolation, profile detection, multi-conn, event log.
- **Claws/1** (5): reverse-channel, SDK/CLI, socket timeout, atomic file.
- **Claws/2 + SDLC** (13): hello, pubsub, tasks, vehicle-state, broadcast-seq, claws-pub-scanner, content/control/identity/pipeline/typed-rpc.
- **Lifecycle** (10): store, server, fsync, engine, rules, reset, non-blocking-defaults, multisignal-completion, sequence-persist, task-event-persist.
- **Hooks** (10): safe-merge, dedup, exclusive-lock, canonical-fast-path, misfire-log, explicit-if, stdin-safety, strict-deny-newline, debug-visibility, atomic-state.
- **Template injection** (3): claude-md-atomic, dev-hooks, absolute-paths.
- **install.sh / update.sh / fix.sh** (26): every step, race conditions, error paths, dry-run, atomicity, recovery.
- **Wave army** (2): registration → boot → complete cycle for single + multi-role.
- **Schema + validation** (4): event-schemas, server-validation, topic-registry, mcp-tools-codegen (38 tools).
- **Worker reliability** (3): v0.7.9 marker fixes, version-drift, worker-fixes-v079 (11 assertions).

**Key invariants enforced by tests:**
1. Atomic file writes — no partial files, fsync verified.
2. Hook safety — never exit non-zero except intentional deny; settings.json never silently reset.
3. Terminal isolation — each terminal owns its pty; capture per-terminal.
4. Bus ordering — events fan-out deterministically; peer isolation enforced.
5. Lifecycle gates — phase transitions validated; REFLECT requires all closed.
6. Bash pattern detection — long-running blocked; argv0 allowlist prevents false positives.
7. Monitor requirement — spawn-class tools gated unless Monitor armed.
8. Worker protocol — boot sequence exact; mission delivery correct; markerScanFrom prevents echo false-match.
9. Idempotency — install/update/hooks repeatable safely.
10. Timeout safety — no blocking calls; configurable timeouts everywhere.

---

## VIII. Anti-Patterns Catalog (burned in)

Each entry: the pattern we tried, why it broke, and the right answer. **Adding to this list is the cost of an architecture violation. Read it before adding "just a small fix."**

### A1 — `tail -F file | grep` Monitor primitive
- **Tried**: `Monitor(command="tail -F .claws/events.log | grep ...")` to watch the bus.
- **Broke**: Claude Code's background-process supervisor SIGURG-kills idle processes within ~30s. `tail -F` produces no output during quiet periods.
- **Right answer**: `Monitor(command="node scripts/stream-events.js | grep --line-buffered ...")`. The sidecar emits constantly (heartbeats, system.metrics, every event) — never idle, never killed.

### A2 — idle-timeout completion signal
- **Tried**: Task #58 added `idle_timeout_ms` to `detectCompletion` — declare worker complete after N seconds of no pty growth.
- **Broke**: Claude TUI is silent during long thinking. Real-world test killed a worker at 70s before any work happened. Idle is fundamentally polling; contradicts P1.
- **Right answer**: removed entirely (commit pending). Use only event-driven signals: `complete_marker`, `error_markers`, `[CLAWS_PUB] topic=worker.<id>.complete`. Future event-driven fallback: VS Code `onDidCloseTerminal` → `system.worker.terminated` bus event.

### A3 — File-referrer missions
- **Tried**: v0.7.9 — write mission to `/tmp/...md`, send `Read /tmp/.../mission.md and follow it precisely` to Claude.
- **Broke**: extra abstraction layer; debug nightmare; left temp files; race conditions on mission file vs. Claude readiness.
- **Right answer**: v0.7.10 reverted (commit 70ec1b1). Mission text is sent inline as Claude's input, as if a human typed it.

### A4 — Mission augmentation with `[CLAWS_PUB]` preamble
- **Tried**: prepend "First publish [CLAWS_PUB] topic=..." preamble to every mission.
- **Broke**: bracketed-paste with the preamble broke multi-line submission — paste landed in shell instead of Claude's input.
- **Right answer**: never augment. Ask the worker (in the mission body) to publish if needed. Multi-line missions use single `paste:true newline:true` send; `writeInjected` handles 30ms internal CR.

### A5 — Marker that appears literally in mission text
- **Tried**: `complete_marker: "MISSION_COMPLETE"` while the mission text said "print MISSION_COMPLETE when done".
- **Broke**: marker false-matched on Claude's mission echo before any work.
- **Right answer**: printf concat trick: `printf 'M%sARK%s_OK_XXXX\n' '' ''` — the marker string `MARK_OK_XXXX` never appears in the mission body.

### A6 — `script -F` flag with Ink-based TUIs
- **Tried**: `script -F` (per-write flush) for snappier reads.
- **Broke**: Splits Ink's atomic frames mid-render; visual corruption in Claude Code TUI.
- **Right answer**: default buffering. The ~1-2s buffering delay is acceptable.

### A7 — `parallel: true` as advisory flag
- **Tried**: `claws_fleet({ parallel: true, ... })` documented as parallel but actually serialized internally.
- **Broke**: invisible regression — orchestrators relied on parallelism that wasn't there.
- **Right answer**: `parallel: true` must be enforced in code, not just documented. `claws_fleet` actually dispatches concurrently in v0.7.10.

### A8 — Hard-blocking safety gate by default
- **Tried**: refuse to send text into TUI processes (Claude, vim, less).
- **Broke**: defeats Claws's primary use case (sending prompts INTO Claude).
- **Right answer**: warn-and-proceed by default; `strict: true` is the opt-in for hard-block.

### A9 — Inline orchestrator patches
- **Tried**: orchestrator edits `mcp_server.js` directly because "it's just a small fix."
- **Broke**: untracked, untested, ungated churn accumulates; the orchestrator becomes a developer instead of an orchestrator.
- **Right answer**: PreToolUse hook hard-blocks (P8). Every change goes through a worker.

### A10 — Hook-bypass via `--no-verify`
- **Tried**: skip pre-commit hook to commit faster.
- **Broke**: hook exists because something broke last time — bypass = guaranteed regression.
- **Right answer**: never. If the hook is wrong, fix the hook, never bypass it.

---

## IX. Known Gaps + Roadmap

### Wave C — Hook fail-closed enforcement (next)
- New `scripts/hooks/post-tool-use-claws.js`: after spawn-class tool returns, verify `lifecycle.monitors[terminal_id]` registered within 5s; else emit `wave.violation` + auto-cancel.
- Update `stop-claws.js`: hard-block session exit until phase ∈ {REFLECT, SESSION-END} + zero open terminals.
- Update `pre-tool-use-claws.js`: recognize canonical bus-stream Monitor pattern; stop demanding deprecated `tail -F`.
- Update `inject-settings-hooks.js`: register PostToolUse with `matcher='*'`.

### Wave D — Event-driven completion (Task #58 v2)
- Replace removed idle-timeout with `onDidCloseTerminal` → `system.worker.terminated` bus event.
- Mission preamble (per worker class) injects: "Your final action MUST publish `[CLAWS_PUB] topic=worker.<your-id>.complete`."
- Add `tests/onDidCloseTerminal-publish` test.

### Wave V — Infra hardening (long-range orchestration)
- `events.log` rotation policy (currently grows unbounded ~1MB/hr; cap 10MB + rotate).
- Bus reconnect on socket drop in `stream-events.js` + sidecar manager.
- Periodic stale-terminal sweep (workers stuck at `status='spawned'` > N min).
- Auto-sidecar restart on crash detection.
- 1+ hour soak test verifying memory + bus stability.

### Wave E — Ship gates
- Full Phase A/B/C sim: single + fleet + army workers, all auto-cascade through 10 phases.
- CHANGELOG complete for v0.7.10.
- Tag + push to origin.

### Phase 3 — Cross-device (post-v0.7.10)
- WebSocket transport (opt-in alongside Unix socket).
- Token auth + TLS.
- mDNS/Bonjour discovery for LAN.
- Cross-device readLog streaming (WebSocket push, not poll).

### Phase 4 — Ecosystem (post-Phase 3)
- CLI tool (`npx claws list`, `npx claws send 1 "ls"`).
- REST API mode.
- Dashboard web UI.
- Live Share integration.
- GitHub Action.

---

## X. Anchoring Protocol (how to use this doc)

**Before any architectural change, the implementer MUST:**

1. **Find the affected component** in §III. If the change adds or removes a component, this doc must change too.
2. **Check the principles** in §II. If the change violates a principle, the change is wrong — find a different approach OR change the principle (with rationale, in a PR).
3. **Check the anti-patterns catalog** in §VIII. If the change resembles an anti-pattern, stop. The right answer is in the catalog.
4. **For lifecycle/protocol changes**, update §IV–§V; update tests in `extension/test/`; update injectors if templates change.
5. **For new completion signals**, the signal must be event-driven (P1). No exceptions.
6. **For new gates**, add the rule to `lifecycle-rules.ts` (pure function, testable) AND surface in the engine if auto-advance applies.
7. **For new hooks**, the hook must satisfy P5 (5s timeout, silent errors, no exit non-zero except intentional deny).

**Worker missions referencing this doc**: every non-trivial worker should be told: "Before edits, read `docs/ARCHITECTURE.md` §X. Your change must not violate anything there." Workers that do violate get reverted.

**This doc is the contract.** Updates require an explicit PR titled `docs(architecture): <change>`. CHANGELOG entry required. Every contributor reads it before touching anything load-bearing.
