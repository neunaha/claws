# VS Code Integration Deep Audit
**Date:** 2026-05-04  
**Mission:** 66 — AUDITOR-VSCODE  
**Scope:** extension/src/{server.ts, terminal-manager.ts, extension.ts, claws-pty.ts, capture-store.ts}  
**Version audited:** v0.7.12

---

## 1. VS Code API Surface

Every `vscode.*` API touched by the extension, what it does, and its known failure modes.

### 1.1 Window APIs

| API | Where used | Purpose | Failure modes |
|-----|-----------|---------|--------------|
| `vscode.window.createOutputChannel` | `extension.ts:64` | Diagnostic log channel | Throws if extension host is shutting down. Guarded by outer try/catch in `activate()`. |
| `vscode.window.createTerminal({pty})` | `terminal-manager.ts:248` | Spawns a Pseudoterminal-backed wrapped terminal | VS Code may silently drop the terminal creation if the extension host is under memory pressure. The UNOPENED_PTY_TIMEOUT_MS (60s) scan catches this orphan case. |
| `vscode.window.createTerminal({name,cwd,...})` | `terminal-manager.ts:260` | Spawns a standard (unwrapped) terminal | Silently succeeds; VS Code fires `onDidOpenTerminal` later (async). |
| `vscode.window.onDidOpenTerminal` | `extension.ts:218` | Adopts newly-opened terminals and links profile-provisioned PTYs | May not fire for terminals opened before the extension activated; mitigated by `adoptExisting()` at activation. UUID-based match prevents name-collision races. |
| `vscode.window.onDidCloseTerminal` | `extension.ts:239` | Routes terminal close to `TerminalManager.onTerminalClosed()` | **Fires asynchronously** — this is the core design issue (see §3). |
| `vscode.window.onDidStartTerminalShellExecution` | `extension.ts:158` | Begins output capture for shell-integration-based exec | Not available on older VS Code (guard: `typeof === 'function'`). Reading the async iterator can throw; inner catch only logs. |
| `vscode.window.onDidEndTerminalShellExecution` | `extension.ts:184` | Completes exec result and notifies exec waiters | Not available on older VS Code. `e.exitCode` may be `undefined` on crash. |
| `vscode.window.registerTerminalProfileProvider` | `extension.ts:247` | Registers "Claws Wrapped Terminal" entry in the `+` dropdown | VS Code does not guarantee `provideTerminalProfile()` is called at most once per click; rapid double-clicks create two `pendingProfiles` entries. UUID token in the terminal name ensures correct linking. |
| `vscode.window.activeTerminal` | `terminal-manager.ts:179` | Reports whether a terminal is the currently-focused one | May be stale if called from a non-UI context. |
| `vscode.window.terminals` | `extension.ts:110,207` | Lists all open terminals | Snapshot at call time; a terminal closed between the snapshot and iteration returns `status:'unknown'` from `describe()`. |
| `vscode.window.showErrorMessage` | `extension.ts:83,785` | User-facing error notifications | Thenable; `.then()` may be called on a disposed extension host. Guarded with optional chaining in most call sites. |
| `vscode.window.showInformationMessage` | `extension.ts:382,793` | User-facing info messages | Same as above. |
| `vscode.window.showQuickPick` | `extension.ts:419` | Terminal picker UI | Returns `undefined` if dismissed; properly guarded. |

### 1.2 Workspace APIs

| API | Where used | Purpose | Failure modes |
|-----|-----------|---------|--------------|
| `vscode.workspace.workspaceFolders` | `extension.ts:90` | Determines server roots (multi-root) | `undefined` when no folder is open. Guarded: `?? []` + early-return path. |
| `vscode.workspace.onDidChangeWorkspaceFolders` | `extension.ts:359` | Starts/stops per-folder servers dynamically | Guard: `typeof === 'function'`. Not available on very old VS Code. |
| `vscode.workspace.onDidChangeConfiguration` | `extension.ts:370` | Hot-reload `maxCaptureBytes` and warns on `socketPath` change | `socketPath` changes require a full reload; the extension warns the user but cannot live-apply. |
| `vscode.workspace.getConfiguration('claws')` | `extension.ts:41` (`cfg()`) | Reads every configurable setting | Returns the declared `fallback` on missing config entries — safe. Reads happen on every handler call (no snapshot caching), so changes take effect immediately. |

### 1.3 Commands API

| Command | Registered in | Notes |
|---------|--------------|-------|
| `claws.status` | `extension.ts:393` | Renders markdown status to output channel |
| `claws.listTerminals` | `extension.ts:399` | QuickPick terminal selector |
| `claws.healthCheck` | `extension.ts:499` | Full diagnostic dump including node-pty state |
| `claws.showLog` | `extension.ts:502` | Shows output channel |
| `claws.rebuildPty` | `extension.ts:504` | Spawns `@electron/rebuild` |
| `claws.statusBar` | `extension.ts:507` | Forces status bar refresh |

### 1.4 Terminal API

| API | Where used | Notes |
|-----|-----------|-------|
| `terminal.processId` (Promise) | `terminal-manager.ts:167` | Async — can throw or resolve null. Wrapped in try/catch. Returns null for Pseudoterminal-backed terminals (VS Code doesn't surface the underlying PID). |
| `terminal.shellIntegration` | `terminal-manager.ts:178`, `server.ts:933` | Only set when VS Code detects shell integration. Unreliable for wrapped PTY terminals; exec path checks for it before using. |
| `terminal.shellIntegration.executeCommand()` | `server.ts:965` | Executes a command and feeds results to `onDidEndTerminalShellExecution`. Can throw; caught inside the exec handler. |
| `terminal.show()` | Multiple | Show + focus a terminal. Returns void; safe to call anytime. |
| `terminal.sendText()` | Multiple | Sends text to unwrapped terminals. VS Code does not guarantee the process receives it before the terminal is closed. |
| `terminal.dispose()` | `terminal-manager.ts:297` | Closes a terminal programmatically. Fires `onDidCloseTerminal` **asynchronously** after dispose() returns; the synchronous `onTerminalClose?.(key, ...)` call in `close()` exists precisely to handle this race. |

### 1.5 Pseudoterminal API (`vscode.Pseudoterminal`)

| Callback | Implementation | Notes |
|----------|---------------|-------|
| `onDidWrite` | `claws-pty.ts:140` | EventEmitter fed by `handleOutput()`. All data from node-pty or pipe-mode child flows here. |
| `onDidClose` | `claws-pty.ts:141` | Fired by `handleExit()`. VS Code closes the terminal tab on this event. |
| `open(initialDimensions)` | `claws-pty.ts:205` | Called by VS Code when the terminal tab becomes visible. Spawns node-pty or pipe-mode child. Also fires `onOpenHook` → `TerminalManager.transitionState(READY)`. |
| `close()` | `claws-pty.ts:257` | Called by VS Code when the terminal is closed by the user. Kills pty or child process. |
| `handleInput(data)` | `claws-pty.ts:270` | Receives keyboard input; routes to pty.write() or stdin. |
| `setDimensions(dims)` | `claws-pty.ts:279` | Resize event; forwarded to ptyProc.resize(). No-op in pipe-mode. |

### 1.6 ExtensionContext / Lifecycle

| API | Where used | Notes |
|-----|-----------|-------|
| `context.subscriptions.push(...)` | Multiple | Automatically calls `.dispose()` on deactivation. All VS Code event subscriptions are registered here. |
| `context.extension.packageJSON.version` | `extension.ts:66` | Version string. May be undefined in test harness — guarded with `|| '0.5.x'`. |
| `context.extensionPath` | `extension.ts:68` | Absolute path to extension root. Used for native PTY binary resolution. |

---

## 2. Terminal Lifecycle

### 2.1 State Machine

Every Claws-tracked terminal has a `VehicleStateName` managed by `TerminalManager.transitionState()`.

```
PROVISIONING → BOOTING → READY → BUSY ↔ IDLE → CLOSING → CLOSED
     └─────────────────────────────────────────→ CLOSING
```

Transition table (from `terminal-manager.ts:11`):
```
PROVISIONING: ['BOOTING', 'CLOSING']
BOOTING:      ['READY', 'CLOSING']
READY:        ['BUSY', 'IDLE', 'CLOSING']
BUSY:         ['IDLE', 'CLOSING']
IDLE:         ['BUSY', 'CLOSING']
CLOSING:      ['CLOSED']
CLOSED:       []
```

Invalid transitions are **silently logged and dropped** (terminal-manager.ts:88-94) — the state does NOT change. This means a missed transition can leave a terminal in a stale state indefinitely.

### 2.2 Wrapped Terminal — Full Lifecycle

```
[Caller: claws_create wrapped=true]
    │
    ▼
TerminalManager.createWrapped()
  → id assigned (nextId++)
  → TerminalRecord created (vehicleState: PROVISIONING)
  → emitInitialState → onStateChange(null → PROVISIONING) → emitSystemEvent vehicle.<id>.state
  → transitionState(BOOTING) → emitSystemEvent vehicle.<id>.state
  → ClawsPty constructed (not yet open)
  → vscode.window.createTerminal({pty}) called
  → byTerminal.set(terminal, id)
  → terminal.show()
    │
    ▼ (asynchronous — VS Code fires onDidOpenTerminal)
extension.ts:219 onDidOpenTerminal handler
  → NOT triggered for createWrapped path (already adopted, not in pendingProfiles)
    │
    ▼ (asynchronous — VS Code calls Pseudoterminal.open())
ClawsPty.open()
  → isOpen = true; openedAt = Date.now()
  → onOpenHook() called → TerminalManager.transitionState(READY)
  → node-pty or pipe-mode child spawned
  → content detection timer started (2s interval, pgrep-based)
    │
    ▼ (terminal ready for use)
BUSY/IDLE transitions driven by content detection / heartbeat publishes
    │
    ▼ (close triggered)
[Any of the 5 close paths described in §3]
```

### 2.3 Standard (Unwrapped) Terminal — Full Lifecycle

```
TerminalManager.createStandard()
  → id assigned; TerminalRecord (vehicleState: PROVISIONING)
  → vscode.window.createTerminal({name,cwd,...})
  → byTerminal.set; records.set
  → terminal.show()
    │
    ▼ (VS Code fires onDidOpenTerminal — handled in extension.ts:219)
  The pending-profiles lookup fails (not a profile terminal)
  → idFor(t) called — but terminal is ALREADY in byTerminal from createStandard!
    BUG: idFor() checks byTerminal.get(terminal) first — returns existing id. Safe.
    But: emitInitialState is NEVER called for standard terminals. 
    vehicle.<id>.state PROVISIONING event is never emitted.
    (emitInitialState only called in createWrapped path)
    │
    ▼ (close)
[Any close path in §3]
```

### 2.4 Profile Terminal (Dropdown `+`) — Full Lifecycle

```
User clicks "Claws Wrapped Terminal" in dropdown
    │
    ▼
registerTerminalProfileProvider.provideTerminalProfile()
  → id reserved (reserveNextId)
  → UUID token generated
  → ClawsPty constructed
  → pendingProfiles.push({id, name, token, pty})
  → 30s orphan timer started
  → returns TerminalProfile({name: "Claws Wrapped N · <short> [<uuid>]", pty})
    │
    ▼ VS Code fires onDidOpenTerminal
extension.ts:224: name.includes(token) → match found
  → pendingProfiles.splice (remove pending entry)
  → clearPending (cancel 30s orphan timer)
  → terminalManager.linkProfileTerminal(id, t, pending.pty)
    → record created (vehicleState: PROVISIONING)
    NOTE: emitInitialState NOT called → no vehicle.<id>.state event emitted
    │
    ▼ (ClawsPty.open() called by VS Code)
Same as wrapped terminal from open() onward.
```

**Gap:** `linkProfileTerminal()` does not call `emitInitialState()`, so profile-spawned terminals never emit the initial PROVISIONING → BOOTING → READY state transition chain to the event bus.

### 2.5 Adopted (Pre-existing) Terminal

```
activateInner() calls terminalManager.adoptExisting(vscode.window.terminals)
  → for each: idFor(t) → creates record (vehicleState: PROVISIONING)
  → emitInitialState NOT called (adoptExisting doesn't trigger state events)
  → content detection NOT started (no pty)
```

### 2.6 Content Detection

The `startContentDetection()` timer (2s interval) runs `pgrep -P <shellPid>` and `ps -p <pid> -o comm=` synchronously via `spawnSync`. This runs on the extension host's event loop:

- **500ms timeout** per pgrep/ps invocation (capped by `timeout: 500` in spawnSync options)
- If the child process is gone, falls back to shell PID
- Results in `vehicle.<id>.content` events on the bus
- Timer is `unref()`'d so it doesn't hold the process open

**Risk:** Each 2s tick can block the extension host for up to 1s (two 500ms spawnSync calls). With many active wrapped terminals, this can accumulate into visible extension host stalls.

---

## 3. Close Paths

There are five distinct close paths. They differ in what fires, what gets missed, and whether `system.worker.terminated` is emitted.

### 3.1 Programmatic Close via RPC (`cmd: 'close'`)

**Trigger:** MCP client calls `claws_close` → `server.ts:1020`

**Sequence:**
```
server.ts:1020 cmd=close handler
  → tm.recordById(r.id) — get TerminalRecord
  → If wrapped: getForegroundProcess() → SIGTERM foreground PID
    → 5s timer: if still alive → SIGKILL  (timer is unref()'d)
  → tm.close(r.id)  [terminal-manager.ts:283]
    → stopContentDetection (clears 2s content timer)
    → transitionState(CLOSING) → onStateChange → vehicle.<id>.state event
    → transitionState(CLOSED)  → onStateChange → vehicle.<id>.state event
    → onTerminalClose(key, rec.wrapped)  ← SYNCHRONOUS call
        → if wrapped: emitSystemEvent('system.worker.terminated', {...})
    → rec.terminal.dispose()  ← triggers async onDidCloseTerminal (ignored, byTerminal already deleted)
    → byTerminal.delete(rec.terminal)
    → records.delete(key)
    → captureStore.clear(key)
  → returns { ok: true, alreadyClosed: false }
```

**What fires:** Full state chain + `system.worker.terminated` (wrapped only).  
**What's missed:** Nothing.  
**Note:** `onTerminalClose` is called BEFORE `byTerminal.delete`, so the subsequent `onDidCloseTerminal` event finds nothing in `byTerminal` and exits at the early-return guard. This is intentional (see the comment at terminal-manager.ts:292-296).

### 3.2 User Clicks X on Terminal Tab

**Trigger:** VS Code fires `onDidCloseTerminal` event.

**Sequence:**
```
extension.ts:240 onDidCloseTerminal handler
  → terminalManager.onTerminalClosed(t)  [terminal-manager.ts:304]
    → id = byTerminal.get(terminal)
    → if !id: return (terminal was not tracked — early exit)
    → byTerminal.delete(terminal)
    → stopContentDetection
    → transitionState(CLOSING) → onStateChange → vehicle.<id>.state event
    → transitionState(CLOSED)  → onStateChange → vehicle.<id>.state event
    → onTerminalClose(id, rec.wrapped)  ← fires callback
        → if wrapped: emitSystemEvent('system.worker.terminated', {...})
    → rec.pty.close()  ← kills pty/child process
    → records.delete(id)
    → captureStore.clear(id)
  → updateStatusBar()
```

**What fires:** Full state chain + `system.worker.terminated` (wrapped only).  
**What's missed:** The pty was already dead (VS Code wouldn't close the tab otherwise), so no double-kill issue. If the terminal was created via `createWrapped()`, `rec.pty.close()` may try to kill an already-exited process — caught by the silent try/catch. Fine.

### 3.3 VS Code Reload / Extension Deactivate

**Trigger:** User runs "Developer: Reload Window", closes VS Code, or uninstalls the extension.

**Sequence:**
```
deactivate() called [extension.ts:821]
  → Promise.race([work(), 3s timeout])
  → work():
    → for each ClawsServer: srv.stop()
        → heartbeatTimer cleared
        → waveRegistry.dispose()
        → wsTransport.stop()
        → eventLog.close()  (best-effort async)
        → this.server?.close()  (net.Server close — stops accepting new connections)
        → fs.unlinkSync(socketPath)  (removes socket file)
        → peers.clear(), subscriptionIndex.clear(), tasks.clear(), usedNonces.clear()
    → servers.clear(); server = null
    → for each deactivateHook: terminalManager.dispose(), statusBar.dispose()
    → outputChannel.dispose()
```

**What fires:** NOTHING per-terminal. No `vehicle.<id>.state` events. No `system.worker.terminated`. No pty kills.

**BUG-RELOAD-1:** All wrapped terminals are left alive in the VS Code panel; their ClawsPty processes are NOT killed during deactivate. When the extension host exits, Node.js child processes (node-pty `ptyProc` or pipe-mode `childProc`) are killed by OS process group death. But if only the extension host is reloaded (not the whole VS Code process), those ClawsPty processes may remain as zombies.

**BUG-RELOAD-2:** The `context.subscriptions.push({dispose})` block at `extension.ts:454` ALSO calls `servers.stop()` and `terminalManager.dispose()` synchronously. This means these are called TWICE during deactivate: once from `context.subscriptions.push({dispose})` (sync, called by VS Code's subscription cleanup) and once from `deactivateHooks` inside `deactivate()` (async). The `TerminalManager.dispose()` call at line 480 is inside `deactivateHooks`, so it fires after the sync dispose. No crash because `clearInterval(null)` is safe, but it's redundant code and the ordering is non-obvious.

### 3.4 `claws_close` Called on Unknown / Already-Closed Terminal

**Trigger:** MCP caller sends `cmd: 'close'` with an id that was already closed.

**Sequence:**
```
server.ts:1038 tm.close(r.id)
  → terminal-manager.ts:283 close()
  → records.get(key) → null
  → return false
→ server.ts:1043 returns { ok: true, alreadyClosed: true }
```

**What fires:** Nothing. Idempotent by design.

### 3.5 ClawsPty Self-Close (Process Exited)

**Trigger:** The shell or process inside the PTY exits normally (e.g., user types `exit`).

**Sequence:**
```
node-pty onExit callback → ClawsPty.handleExit(code)
  → isOpen = true → isOpen = false
  → closeEmitter.fire(code)  ← VS Code receives this
    → VS Code fires onDidCloseTerminal for the terminal tab
      → Close Path 3.2 executes (user-click close path)
```

**What fires:** Eventually the full close chain from path 3.2 fires. There is a delay between `handleExit()` and VS Code firing `onDidCloseTerminal` — during this window the terminal may still appear in `byTerminal`.

**Note:** `handleExit()` sets `isOpen = false` immediately, so any `writeInjected()` calls in that window are silently dropped (early-return guard at line 286).

### 3.6 Orphan Scan — Unopened PTY Cleanup

**Trigger:** Periodic scan every 10s (`UNOPENED_PTY_SCAN_INTERVAL_MS`) for PTYs that were constructed but `open()` was never called within 60s.

**Sequence:**
```
scanUnopenedPtys() [terminal-manager.ts:361]
  → for each record: if pty && !pty.hasOpened() && pty.ageMs() >= 60s:
    → stopContentDetection
    → rec.pty.close()   ← kills pty/child (isOpen is false here — no-op in close())
    → rec.terminal.dispose()
    → byTerminal.delete
    → records.delete
    → captureStore.clear
```

**What fires:** NO state transitions. NO `system.worker.terminated`. NO callback invocation.

**BUG-ORPHAN-1:** The orphan scan skips `onTerminalClose?.(id, rec.wrapped)`. A crashed or never-opened wrapped terminal is silently recycled without emitting `system.worker.terminated`. Any orchestrator waiting for that event will hang until its timeout.

### 3.7 Summary Table

| Close path | State events | system.worker.terminated | pty killed | captureStore cleared |
|-----------|-------------|--------------------------|-----------|---------------------|
| 3.1 RPC close | ✓ CLOSING→CLOSED | ✓ (wrapped) | ✓ (SIGTERM+SIGKILL) | ✓ |
| 3.2 User X click | ✓ CLOSING→CLOSED | ✓ (wrapped) | ✓ (via pty.close()) | ✓ |
| 3.3 VS Code reload | ✗ | ✗ | Via OS (process group) | ✗ |
| 3.4 Already closed | N/A | N/A | N/A | N/A |
| 3.5 PTY self-exit | Via 3.2 (delayed) | ✓ (wrapped, delayed) | N/A (process already gone) | ✓ |
| 3.6 Orphan scan | ✗ | ✗ | ✓ (pty.close()) | ✓ |

---

## 4. Schema Validation

### 4.1 What Gets Validated

Schema validation applies to `cmd: 'publish'` messages only. Topic-keyed schemas live in `topic-registry.ts` (not audited here) and are looked up via `schemaForTopic(r.topic)`.

Topics **without** a registered schema pass through unvalidated (`schemaForTopic` returns `null` → the `if (dataSchema !== null)` block is skipped entirely).

Topics **with** a registered schema go through a two-stage check:

**Stage 1 — Envelope check:**
```
EnvelopeV1.safeParse(r.payload)
```
`EnvelopeV1` is a Zod schema for the `{v, id, from_peer, from_name, ts_published, schema, data}` wrapper.

**If envelope parse FAILS** (BUG-02 path — SDK-less workers that send bare payloads):
- Server auto-wraps: synthesizes the envelope with `randomUUID()`, server-side timestamps, and `from_peer` from the registered peer. 
- Then validates the bare `r.payload` against the inner data schema.
- If inner validation also fails:
  - Logs `[claws/schema] malformed data from <peerId> on <topic>`
  - Emits `system.malformed.received` event (async, fire-and-forget)
  - If `strictEventValidation: true`: returns `{ ok: false, error: 'payload:invalid', details: [...issues] }`
  - If not strict: proceeds with fan-out using the auto-wrapped payload

**If envelope parse SUCCEEDS:**
- Validates `envelopeResult.data.data` against the inner data schema.
- If inner validation fails:
  - Logs + emits `system.malformed.received`
  - Same strict/non-strict branching as above.

### 4.2 Strict vs. Non-Strict Mode

- `strictEventValidation` defaults to `DEFAULT_STRICT_EVENT_VALIDATION` from `server-config.ts` (not audited here — assumed false by default based on developer comments).
- In **non-strict mode**, malformed payloads are **delivered anyway** with the auto-wrapped envelope. Subscribers receive malformed data.
- In **strict mode**, malformed payloads are rejected and not delivered. This is the safer production setting.

### 4.3 `system.malformed.received` Emission

Emitted via `emitServerEvent()` (durable: logs + fans out to subscribers). Topic: `system.malformed.received`. Payload: `{from: peerId, topic: r.topic, error: [...zodIssues]}`.

The `await emitServerEvent(...)` in the publish handler introduces an async gap before the `return`. This means two concurrent publish requests could both enter the schema-validation block simultaneously and both emit `system.malformed.received` for the same message. This is fine (idempotent from the subscriber's perspective) but contributes to `serverInFlight` count for admission control.

### 4.4 Topics with No Schema

System-originated topics (`system.*`, `vehicle.*`, `wave.*`, `task.*`, `command.*`, `pipeline.*`) are emitted by the server itself via `emitSystemEvent` or `emitServerEvent`, bypassing the publish handler entirely — they never hit schema validation.

Worker heartbeats (`worker.<peerId>.heartbeat`) appear to have no registered schema in the default topic-registry, meaning heartbeat payloads are passed through without validation. This is correct behavior: heartbeats are high-frequency and their payload structure varies by kind (L6 progress, approach, error, etc.).

### 4.5 Edge Cases

1. **r.payload = undefined**: Not caught before `EnvelopeV1.safeParse`. Zod will report `Expected object, received undefined`. The server auto-wraps `{data: undefined}` and emits malformed. The fan-out delivers an envelope with `data: undefined` to subscribers in non-strict mode.

2. **Schema registered for wildcard topic**: If `schemaForTopic` uses prefix matching and a topic like `worker.*` has a schema, ALL worker publishes hit validation. If the worker sends `worker.<id>.heartbeat` (which differs from `worker.*`), the match behavior depends on the topic-registry implementation (not audited here).

---

## 5. emitSystemEvent vs emitServerEvent

Both methods append to the event log and fan out to subscribers. They differ in origin and error handling.

### 5.1 `emitSystemEvent(topic, payload)` — server.ts:304

```typescript
private async emitSystemEvent(topic: string, payload: unknown): Promise<void> {
  if (this.eventLog.isDegraded) return;  // ← skip entirely in degraded mode
  try {
    const result = await this.eventLog.append({...});
    this.fanOut(topic, 'server', payload, false, sequence);
  } catch {
    // heartbeat failures must never crash the extension
  }
}
```

**Characteristics:**
- Used for infrastructure events: heartbeats, metrics, vehicle state, content detection, wave events, command.*.start/end
- Returns `void` — always fire-and-forget from call sites
- Silently skips in degraded mode (event log failed at startup)
- Swallows ALL errors — a write failure results in silent no-op
- `from` is always `'server'`
- Called with `void this.emitSystemEvent(...)` at every call site to prevent unhandled promise warnings

### 5.2 `emitServerEvent(topic, payload)` — server.ts:753

```typescript
private async emitServerEvent(topic: string, payload: unknown): Promise<void> {
  let sequence: number | undefined;
  try {
    const logResult = await this.eventLog.append({...});
    sequence = logResult.sequence >= 0 ? ...
  } catch {
    // Real I/O error — fall through with no sequence so fan-out still fires
  }
  this.fanOut(topic, 'server', payload, false, sequence);  // ← always executes
}
```

**Characteristics:**
- Used for semantic/protocol events: task.assigned, task.status, task.completed, task.cancel_requested, system.malformed.received, wave.*.complete, wave.*.harvested, pipeline.*.created/closed
- Called with `await this.emitServerEvent(...)` from within request handlers — the response is held until the log write completes
- **Always fans out** even if the log write fails (unlike `emitSystemEvent` which skips everything in degraded mode)
- Does NOT check `eventLog.isDegraded` — it will attempt the write even in degraded mode; the `append()` in degraded mode returns sequence -1 without throwing, so fan-out proceeds
- `from` is always `'server'`

### 5.3 Key Difference

| Property | emitSystemEvent | emitServerEvent |
|----------|----------------|----------------|
| Degraded mode | Skips entirely | Writes attempt, fan-out always fires |
| Write failure | Silently drops everything | Fan-out fires without sequence number |
| Await behavior | Never awaited by callers | Always awaited by callers |
| Call pattern | `void this.emitSystemEvent(...)` | `await this.emitServerEvent(...)` |
| Use case | Infrastructure telemetry | Protocol/semantic events |

### 5.4 Downstream Consumers

Both methods ultimately call `this.fanOut()` → `this.pushFrame()` → `socket.write()`. Subscribers see identical push frame structure; the only observable difference is the presence/absence of a `sequence` field when the log write fails.

The `stream-events.js` sidecar subscribes to the bus and emits each push frame as a line to stdout — it receives both `emitSystemEvent` and `emitServerEvent` outputs identically.

---

## 6. Wrapped vs. Unwrapped Terminals

### 6.1 Wrapped Terminal

**Creation:** `createWrapped()` or profile provider → `ClawsPty` (custom `vscode.Pseudoterminal`)

**Capture mechanism:**
- `ClawsPty.handleOutput(data)` → `captureStore.append(terminalId, data)` → in-memory ring buffer
- All pty output (from node-pty `onData` or pipe-mode `childProc.stdout/stderr`) is captured
- ANSI stripping applied at read time (`readLog` with `strip=true`)
- Max capacity: `maxBytesPerTerminal` (default 1 MB, hot-configurable)
- Ring buffer: oldest bytes are trimmed when `length > maxBytesPerTerminal`; `droppedBefore` tracks offset

**Log access via RPC:**
```
cmd: readLog, id: <N>
  → rec.wrapped && rec.pty  → captureStore.read()
  → returns { bytes, offset, nextOffset, totalSize, truncated }
```

**Output path:**
- `writeInjected(text, withNewline, bracketedPaste)` — the primary send path for orchestrator use
- Bracketed paste: wraps text in `\x1b[200~...\x1b[201~`, sends trailing CR after 30ms delay (prevents Ink-based TUI paste-detection issues)

**Foreground process detection:**
- `pgrep -P <shellPid>` every 2s → emits `vehicle.<id>.content` events
- Enables content-type classification: shell / claude / vim / python / node / unknown

**Failure modes:**
- node-pty load fails → falls back to pipe-mode (stdin/stdout). TUIs (Claude Code, vim, htop) will NOT render correctly in pipe-mode. Yellow banner emitted to terminal.
- Capture ring buffer: once full, earliest output is lost. If an orchestrator polls `readLog` too slowly, it may miss history.

### 6.2 Unwrapped Terminal

**Creation:** `createStandard()` (or terminals opened directly by the user)

**Capture mechanism:** NONE — no pty or captureStore association.

**Log access:** `readLog` returns `{ ok: false, error: 'terminal N is not wrapped (no log available)' }` unless there is a `logPath` (legacy path for `script(1)`-wrapped terminals — this code path exists but is not used in the current flow).

**Send path:** `terminal.sendText(text, newline)` — VS Code's built-in. No bracketed paste. No content injection control.

**Exec:** Works via shell integration (`terminal.shellIntegration.executeCommand()`) when available. Falls back to sendText with no output capture. Marked `degraded: true` in the response.

**Foreground process detection:** NOT available (no `pty`). `startContentDetection` checks `if (!rec.pty) return` at line 101.

### 6.3 logPath Field (Legacy / Unused)

`TerminalRecord.logPath` is always null for both wrapped and standard terminals created via the current code. The `readLog` handler has a fallback path at `server.ts:1069` that reads from a file if `rec.logPath` is set — this is dead code for all current terminal creation paths. It was the original `script(1)` integration before `ClawsPty` was built. Safe to keep as a future extension point but confusing for readers.

---

## 7. Bug Catalog

### BUG-VS01 — Standard Terminal Missing PROVISIONING State Event
**Symptom:** `vehicle.<id>.state` never emits PROVISIONING for `createStandard()` terminals.  
**File:line:** `terminal-manager.ts:259-281` (`createStandard`), `terminal-manager.ts:96-98` (`emitInitialState`)  
**Root cause:** `emitInitialState` is called only in `createWrapped`. `createStandard` sets `vehicleState: 'PROVISIONING'` in the record but never calls `emitInitialState`, so the state change is never published to the bus.  
**Blast radius:** Orchestrators relying on bus events to track standard-terminal lifecycle see only transitions from CLOSING onward. State snapshots from `claws_list` will show correct `vehicleState`, but subscription-based watchers miss the initial events.  
**Fix shape:** Call `this.emitInitialState(rec)` after the record is created in `createStandard`.

---

### BUG-VS02 — Profile Terminal Missing State Event Chain
**Symptom:** `vehicle.<id>.state` never emits PROVISIONING, BOOTING, or READY for profile-provider terminals.  
**File:line:** `terminal-manager.ts:324-337` (`linkProfileTerminal`), `extension.ts:229` (caller)  
**Root cause:** `linkProfileTerminal` creates the record but calls neither `emitInitialState` nor `transitionState(BOOTING)`. The `onOpenHook` in `ClawsPty` will still call `transitionState(READY)` later, but PROVISIONING and BOOTING are skipped on the bus.  
**Blast radius:** Same as BUG-VS01 but for profile terminals (user's dropdown choice). READY event does fire (from the `onOpenHook` wiring in `createWrapped`), so the worst case is two missing state events per profile terminal.  
**Note:** The `pty` passed to `linkProfileTerminal` was constructed in `provideTerminalProfile` with an `onOpenHook` that fires `transitionState(READY)`. That hook works. The PROVISIONING/BOOTING pair is the gap.  
**Fix shape:** Add `emitInitialState(rec)` + `transitionState(rec, 'BOOTING')` inside `linkProfileTerminal`.

---

### BUG-VS03 — Orphan Scan Skips system.worker.terminated
**Symptom:** When a wrapped terminal is cleaned up by the orphan scan (never-opened within 60s), `system.worker.terminated` is NOT emitted.  
**File:line:** `terminal-manager.ts:361-376` (`scanUnopenedPtys`)  
**Root cause:** The scan calls `rec.pty.close()` and `rec.terminal.dispose()` directly, then removes the record. `onTerminalClose?.(id, rec.wrapped)` is never called.  
**Blast radius:** Any orchestrator monitoring `system.worker.terminated` for a terminal that died at provisioning time will never get the event. The Monitor waits until timeout (typically 600s). This is a common failure mode when VS Code drops a terminal creation silently.  
**Fix shape:** Add `this.onTerminalClose?.(id, rec.wrapped)` call before removing the record in `scanUnopenedPtys`.

---

### BUG-VS04 — Deactivate Does Not Kill ClawsPty Processes
**Symptom:** On VS Code extension reload (not full quit), wrapped terminal shells remain alive as orphan processes.  
**File:line:** `extension.ts:821-860` (`deactivate`), `extension.ts:454-471` (sync dispose)  
**Root cause:** Neither the sync `dispose` block nor the async `deactivate` hook iterates `TerminalManager.records` to kill pty/child processes. `TerminalManager.dispose()` only clears timers (content detection + unopened scan). The ClawsPty instances referenced by records are never `close()`'d.  
**Blast radius:** After a "Reload Window" in a session with active workers, old shell processes continue running. If Claude Code workers were in those terminals, they may keep publishing to the bus (if they reconnected), confusing new orchestrators.  
**Fix shape:** `TerminalManager.dispose()` should iterate `this.records` and call `rec.pty?.close()` on each, then clear the records map. Alternatively, add explicit pty cleanup in the sync dispose block before `terminalManager.dispose()`.

---

### BUG-VS05 — Double Dispose in deactivate()
**Symptom:** `terminalManager.dispose()` and `statusBar.dispose()` are called twice during deactivation.  
**File:line:** `extension.ts:454-470` (sync block), `extension.ts:476-481` (deactivateHook)  
**Root cause:** The sync `{dispose}` object pushed to `context.subscriptions` calls both `.stop()` and `terminalManager.dispose()`. The `deactivateHooks` array also calls `terminalManager.dispose()` and `statusBar.dispose()`. VS Code calls the subscriptions synchronously when deactivating, then `deactivate()` is called and runs the hooks asynchronously.  
**Blast radius:** `clearInterval(null)` and `clearTimeout(null)` are no-ops, so no crash. But the status bar is disposed twice — the second call on an already-disposed VS Code disposable may log an "object is disposed" error in some VS Code versions.  
**Fix shape:** Remove the `terminalManager.dispose()` and `statusBar.dispose()` calls from `deactivateHooks` since `context.subscriptions` already handles them. Or remove them from the sync block and let `deactivate()` handle them. Pick one path.

---

### BUG-VS06 — Content Detection Blocks Extension Host (High Terminal Count)
**Symptom:** Extension host stutters with many active wrapped terminals.  
**File:line:** `claws-pty.ts:179-203` (`getForegroundProcess`), `terminal-manager.ts:100-115` (`startContentDetection`)  
**Root cause:** `spawnSync('pgrep', ...)` and `spawnSync('ps', ...)` are synchronous and block the extension host's Node.js event loop. They are guarded by a 500ms timeout per call. With N wrapped terminals, each 2s content-detection tick can block for up to 1s × N.  
**Blast radius:** At 5+ concurrent wrapped terminals with active worker processes, the extension host can block for 2.5s+ per detection cycle, causing:  
- VS Code UI freezes  
- Delayed responses to MCP socket requests  
- Missed `onDidOpenTerminal` and `onDidCloseTerminal` events during the block  
**Fix shape:** Move `getForegroundProcess()` to an async `child_process.exec()` call, stagger the per-terminal timers (add `id * 200ms` offset), or switch to a shared poll with a single `pgrep` invocation for all terminal PIDs.

---

### BUG-VS07 — SIGTERM/SIGKILL on RPC Close Targets Only Foreground PID
**Symptom:** When closing a wrapped terminal via `claws_close`, the SIGTERM/SIGKILL is sent to the foreground PID. If the shell has spawned background jobs, those are not killed.  
**File:line:** `server.ts:1024-1037`  
**Root cause:** `getForegroundProcess()` returns only the most recent child of the shell PID. Background processes spawned via `&` or `disown` are not captured. After `pty.kill()` or `terminal.dispose()`, the shell process dies but its background children can persist.  
**Blast radius:** For Claude Code workers that spawn child processes (e.g., test runners, builds), those children may continue running after the worker terminal is closed, consuming resources and occasionally writing to shared files.  
**Fix shape:** Use `process.kill(-fgPid, 'SIGTERM')` (negative PID = kill process group) or enumerate all descendants of the shell PID via `pgrep -a -P <shellPid>` recursively.

---

### BUG-VS08 — readLog on logPath Branch Has No Degraded Fallback
**Symptom:** If a terminal has a `logPath` set but the file is deleted/moved, `readLog` returns an error instead of falling back to the captureStore.  
**File:line:** `server.ts:1069-1098`  
**Root cause:** The logPath branch (`if (rec.logPath && fs.existsSync(rec.logPath))`) is entered when logPath is set. If the file disappears mid-session, `fs.statSync` / `fs.readSync` throw and the handler returns `{ ok: false, error: 'read failed: ...' }`. There is no fallback to the captureStore even if data is available there.  
**Blast radius:** Low — `logPath` is always null in current code (dead code path). Zero impact today. Becomes a bug if logPath is ever populated.

---

### BUG-VS09 — shell-integration exec Waiter Leaks on Terminal Close
**Symptom:** If a terminal is closed while an exec waiter is pending, the waiter's timeout fires and the promise rejects — but the waiter entry in `execWaiters` has already been removed. If close happens between push (exec initiated) and callback (terminal closes), the waiter is leaked until the timeout.  
**File:line:** `extension.ts:114-155` (`pushEvent`), `server.ts:954-980`  
**Root cause:** `execWaiters` is a `WeakMap<vscode.Terminal, Array<...>>`. When `tm.close()` calls `rec.terminal.dispose()`, the WeakMap key becomes collectible. The timeout timer in the exec handler still holds a reference to `resolver` and `list`. When the timer fires, it tries to `list.splice(i, 1)` — but `list` may have been GC'd (if the WeakMap entry was collected). In practice Node.js GC doesn't collect that quickly; the timer fire wins the race and the `reject(new Error('exec timeout'))` fires normally. But if GC does collect first, the splice is a no-op and the resolver is lost (leak).  
**Blast radius:** Rare — requires the WeakMap entry to be GC'd before the timeout timer fires. Low blast radius in practice.

---

### BUG-VS10 — replaceAll race in replayFromCursor During Reconnect
**Symptom:** If a peer disconnects and reconnects during an active `replayFromCursor` scan, the replay continues writing to the old socket.  
**File:line:** `server.ts:769-801` (`replayFromCursor`)  
**Root cause:** `replayFromCursor` captures `socket` at subscribe time. When the peer disconnects and reconnects, a new `PeerConnection` is created with a new `socket`. The ongoing `replayFromCursor` still writes to the old socket via `socket.write(frame)`. The old socket is destroyed at disconnect time, so the writes fail silently (caught by VS Code's socket error handling). The peer never receives the replayed events.  
**Blast radius:** Reconnecting peers miss historical replay events. They must re-subscribe from their new cursor to get fresh events.  
**Fix shape:** Check `socket.destroyed` more frequently in the loop, or key replay off `peerId` and look up the current socket for each frame.

---

### BUG-VS11 — createWrapped Returns logPath: null Unconditionally
**Symptom:** MCP `claws_create wrapped=true` response always has `logPath: null` even though a ClawsPty was created.  
**File:line:** `server.ts:885`  
**Root cause:** `return { ok: true, id, logPath: null, wrapped: true }`. The ClawsPty doesn't write to a file path; it uses the captureStore (in-memory). Since there's no file path, returning null is technically correct. But callers expecting a `logPath` for tail-based monitoring will be surprised.  
**Note:** This is correct behavior (captureStore is memory-based) but worth documenting explicitly in the protocol. The comment at `server.ts:885` says `logPath: null` which matches.

---

### BUG-VS12 — Backpressure Drain Flush May Write to Destroyed Socket
**Symptom:** After a peer disconnect during backpressure, queued frames are flushed to the socket in the `drain` callback — but the socket may already be destroyed.  
**File:line:** `server.ts:699-716`  
**Root cause:** The `socket.once('drain', ...)` callback registered at line 697 fires after the socket write buffer drains. If the socket was destroyed in the window between registering the drain callback and the drain event firing, `socket.write(qf)` throws (or emits an error event). The code guards with `try { socket.write(qf); } catch { /* socket may have closed */ }` (line 701) — this catches the synchronous throw but not the `error` event.  
**Blast radius:** The write may fail silently; the queued frames are dropped. The `pausedPeers.delete(peerId)` still fires, which is correct cleanup.  
**Note:** This is an inherent race in TCP/Unix-socket backpressure handling. The try/catch mitigates crashes; dropped frames are acceptable.

---

## 8. Cross-Machine Consistency Risks

### 8.1 Node.js Version Drift

The extension runs inside VS Code's Electron runtime, which bundles a specific Node.js ABI. The bundled `native/node-pty` binary is compiled for a target Electron ABI (stored in `native/.metadata.json`). If the user's VS Code version upgrades Electron, the ABI mismatch causes `node-pty` to fail to load, silently falling back to pipe-mode.

Detection: Health Check command reads `.metadata.json` and compares.  
Mitigation: "Claws: Rebuild Native PTY" command re-builds for the current Electron version.  
Risk: Cross-machine VSIX install picks up the ABI of the machine that ran `npm run build`, not the target machine.

### 8.2 Platform Differences in Shell Resolution

`defaultShell()` in `claws-pty.ts:341`:
- Windows: `COMSPEC || 'powershell.exe'`
- Unix: `$SHELL` → `/bin/bash` → `/bin/zsh` → `/bin/sh`

**Risk:** On a container/Docker environment without a login shell, `$SHELL` may be unset or point to a non-existent path. The `fs.existsSync()` fallback catches `/bin/bash` and `/bin/zsh` not existing, but a container with only `/bin/sh` might skip those and hit the hardcoded `/bin/sh` fallback correctly.

**Risk:** On macOS, the login shell is typically `/bin/zsh`. The `defaultShellArgs` logic checks for `.zprofile`/`.bash_profile`/`.profile` to decide whether to add `-l`. On a clean macOS install with only `.zprofile`, this adds `-l` and the terminal spawns slowly (nvm/asdf init).

### 8.3 BSD vs. GNU `pgrep`/`ps`

`getForegroundProcess()` calls:
- `pgrep -P <shellPid>` — available on both macOS (BSD) and Linux
- `ps -p <pid> -o comm=` — the `-o comm=` format is POSIX and works on both

This is safe. No `-f` flag or other BSD/GNU divergence used.

### 8.4 `script(1)` Wrapper Legacy Code

The `readLog` handler's logPath branch (dead code) originally relied on `script(1)` creating a file. BSD `script` uses `-F <file>` flag; GNU `script` uses `-f <file>`. If this code path is ever revived, the cross-platform differences in `script(1)` flags must be re-verified. See `scripts/terminal-wrapper.sh` for the existing adaptation.

### 8.5 Socket Path Length Limits

Unix domain sockets have a maximum path length (108 bytes on Linux, 104 bytes on macOS for the `sun_path` field in `sockaddr_un`). Long workspace paths can exceed this limit. The extension constructs `socketPath = path.join(workspaceRoot, '.claws/claws.sock')`. If this path exceeds the limit, `net.Server.listen()` throws `EINVAL` and the server fails to start.

**Mitigation:** None currently. A workspace at `/Users/<long-username>/Documents/my-very-very-long-project-name-that-exceeds-limits/` with a deep nesting would fail silently (startError is stored but no user notification).

**Fix shape:** Check path length before `bind()` and emit a user-facing warning with an actionable message ("Set `claws.socketPath` to a shorter path").

### 8.6 VS Code Version API Availability

Both `onDidStartTerminalShellExecution` and `onDidEndTerminalShellExecution` are guarded with `typeof === 'function'` checks. However, `onDidChangeWorkspaceFolders` and `onDidChangeConfiguration` are also guarded. These guards are correct but worth noting that on very old VS Code builds, the shell-integration exec path is fully absent — `exec` degrades to fire-and-forget `sendText`.

### 8.7 Electron Info.plist Path for `runRebuildPty`

The PTY rebuild command tries 4 hardcoded app paths on macOS:
- `/Applications/Visual Studio Code.app`
- `/Applications/Visual Studio Code - Insiders.app`
- `/Applications/Cursor.app`
- `/Applications/Windsurf.app`

On non-standard install paths (e.g., user-scoped installs to `~/Applications/`) or on Linux, no plist is found and the code falls back to `electronVersion = '39.8.5'` — a hardcoded version that may be wrong. The user can override via `CLAWS_ELECTRON_VERSION` env var, but this is not documented in the health check output.

### 8.8 Multi-Root Workspace Socket File Conflicts

In a multi-root workspace, each folder gets its own ClawsServer with its own `.claws/claws.sock`. If two roots share a common ancestor or one root is a subdirectory of another, both sockets are created. Orchestrators must connect to the correct socket for their folder. The stale-socket probe prevents collision, but there is no mapping exposed to clients (the `introspect` command lists all server paths).

---

## 9. Open Questions

1. **linkProfileTerminal missing state events (BUG-VS02):** Was the PROVISIONING/BOOTING emission intentionally omitted for profile terminals because the pty hasn't opened yet? Or is this an oversight? If intentional, a comment would prevent future confusion.

2. **logPath field lifecycle:** `TerminalRecord.logPath` is always null and `readLog` has a file-read branch that is dead code. Should this field be removed to reduce confusion, or is there a planned use case (e.g., external log files via a future `script(1)` integration)?

3. **Content detection interval tuning:** 2s per-terminal polls with 500ms-timeout spawnSync calls are expensive. Is there telemetry on how many concurrent wrapped terminals are typical? For fleet deployments (5-10 workers), this interval should be tunable per-terminal or globally via `claws.contentDetectionIntervalMs`.

4. **exec degraded path:** When shell integration is not available, `exec` falls back to `sendText` and returns `{ degraded: true }`. Is there a signal to the MCP caller to switch to `readLog`-based polling? Current clients that don't check `degraded` may assume the command ran to completion.

5. **Reconnect replay race (BUG-VS10):** Is the expected behavior for a reconnecting peer to always miss in-flight replay? If so, document the expected recovery pattern (re-subscribe from current cursor after reconnect).

6. **Backpressure limits:** `MAX_PENDING_FRAMES = 500` is a per-peer queue cap. For high-frequency heartbeat storms, 500 frames × average frame size ~200 bytes = ~100KB per paused peer. With many paused peers, this could be significant. Should there be a global cap across all paused peers?

7. **deactivate timeout:** The 3-second Promise.race timeout in `deactivate()` is shorter than the `eventLog.close()` flush operation. If the event log has many pending writes, they may be silently dropped on shutdown. Is the 3s timeout tunable or should it be longer?

8. **Platform testing:** Is the extension CI-tested on Linux? The pgrep/ps path in `getForegroundProcess` is only exercised on macOS/Linux; the Windows code path (pipe-mode only, no pgrep) has different behavior.

9. **Phase State Emission Missing for mark-worker-status 'closed':** When `lifecycle.mark-worker-status` is called with `status: 'closed'`, the `TerminalManager.close()` invocation is supposed to happen elsewhere (wave.complete → wave.harvested). But there is no validation that the terminal was actually closed before the worker status is marked closed. The lifecycle engine may auto-advance to CLEANUP without the terminal actually being disposed.

---

## Appendix A: emitSystemEvent Call Sites (Complete List)

| Topic | Trigger location | server.ts approx line |
|-------|-----------------|----------------------|
| `vehicle.<id>.state` | StateChangeCallback | ~213-216 |
| `vehicle.<id>.content` | ContentChangeCallback | ~217-227 |
| `system.worker.terminated` | TerminalCloseCallback | ~228-234 |
| `system.heartbeat` | heartbeatTimer | ~354-358 |
| `system.metrics` | heartbeatTimer | ~362-372 |
| `system.peer.metrics.<peerId>` | heartbeatTimer | ~378-390 |
| `command.<id>.start` | exec handler | ~928-933 |
| `command.<id>.end` | exec handler | ~939-946 / ~973-980 |
| `wave.<waveId>.lead.boot` | wave.create handler | ~1710 |
| `pipeline.<id>.step.<stepId>` | publish handler (pipeline routing) | ~1401-1409 |

## Appendix B: emitServerEvent Call Sites (Complete List)

| Topic | Trigger location | server.ts approx line |
|-------|-----------------|----------------------|
| `system.malformed.received` | publish handler (schema fail) | ~1316-1319, ~1325-1328 |
| `task.assigned.<assignee>` | task.assign handler | ~1475 |
| `task.status` | task.update handler | ~1510 |
| `task.completed` | task.complete handler | ~1535 |
| `task.completed` (failed) | handleDisconnect | ~629 |
| `task.cancel_requested.<assignee>` | task.cancel handler | ~1554 |
| `wave.<waveId>.complete` | wave.complete handler | ~1781 |
| `wave.<waveId>.harvested` | wave.complete handler | ~1797 |
| `pipeline.<id>.created` | pipeline.create handler | ~1873 |
| `pipeline.<id>.closed` | pipeline.close handler | ~1894 |
