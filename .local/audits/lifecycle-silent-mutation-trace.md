# Lifecycle Silent-Mutation Bug — Trace
Date: 2026-05-04
Reproduction: corr d99dae06-67a8-4636-9af8-4be8298b9064 (mission 43, term=3)

## Summary

When the fast-path watcher detects worker completion and calls `cmd:'close'` via
`clawsRpc`, `TerminalManager.close()` deletes the terminal from the `byTerminal` map
*before* calling `terminal.dispose()`. VS Code's async `onDidCloseTerminal` fires after
the map entry is gone, so `onTerminalClosed()` returns early — the `onTerminalClose`
callback (which emits `system.worker.terminated`) is never called. Separately, if the
`_pconn` persistent socket is disconnected at completion time, `system.worker.completed`
is also silently dropped; `lifecycle.mark-worker-status` still succeeds via the ephemeral
`clawsRpc` connection, writing `status:closed` to disk with zero bus events. Monitors
waiting on `system.worker.completed` or `system.worker.terminated` are permanently blind.

---

## File:line trace

### 1. `extension/src/terminal-manager.ts:283-295` — `close()` drops the map before dispose

```typescript
// line 283
close(id: string | number): boolean {
  const key = String(id);
  const rec = this.records.get(key);
  if (!rec) return false;
  this.stopContentDetection(rec);
  this.transitionState(rec, 'CLOSING');    // emits vehicle.N.state
  this.transitionState(rec, 'CLOSED');     // emits vehicle.N.state
  try { rec.terminal.dispose(); } catch { /* ignore */ }
  this.byTerminal.delete(rec.terminal);   // ← BUG: happens AFTER dispose
  this.records.delete(key);
  this.captureStore.clear(key);
  return true;
}
```

**Why suspicious:** `terminal.dispose()` causes VS Code to fire `onDidCloseTerminal`
asynchronously (via the extension host event loop). By that point
`this.byTerminal.delete(rec.terminal)` (line 291) has already run, so when
`onTerminalClosed()` is called, `this.byTerminal.get(terminal)` returns `undefined`
and the function bails at line 299: `if (!id) return`. The `onTerminalClose?.(id,
rec.wrapped)` call on line 306 is never reached.

Additionally, `close()` never calls `this.onTerminalClose` directly — only
`onTerminalClosed()` does. So there are *two* reasons the callback is skipped:
the direct path doesn't exist, and the indirect (VS Code event) path is blocked by
the premature map deletion.

### 2. `extension/src/terminal-manager.ts:297-311` — `onTerminalClosed` exits early after programmatic close

```typescript
// line 297
onTerminalClosed(terminal: vscode.Terminal): void {
  const id = this.byTerminal.get(terminal);  // ← returns undefined after close()
  if (!id) return;                           // ← bails here; callback never fires
  this.byTerminal.delete(terminal);
  const rec = this.records.get(id);
  if (rec) {
    this.stopContentDetection(rec);
    this.transitionState(rec, 'CLOSING');
    this.transitionState(rec, 'CLOSED');
    this.onTerminalClose?.(id, rec.wrapped); // ← never reached
  }
  ...
}
```

**Why suspicious:** This is the only path that calls `this.onTerminalClose` — and it is
unconditionally blocked after a programmatic `close()`. The event chain
`close() → dispose() → onDidCloseTerminal → onTerminalClosed → onTerminalClose callback
→ emitSystemEvent('system.worker.terminated')` is broken at step 4.

### 3. `extension/src/server.ts:228-234` — close callback set but never fires

```typescript
// line 228
opts.terminalManager.setTerminalCloseCallback((id, wrapped) => {
  if (!wrapped) return;
  void this.emitSystemEvent('system.worker.terminated', {
    terminal_id: id,
    terminated_at: new Date().toISOString(),
  });
});
```

**Why suspicious:** The callback is correctly wired and the `wrapped: true` flag IS set
in both `createWrapped()` (line 219) and `linkProfileTerminal()` (line 323). The guard
`if (!wrapped) return` would NOT be the problem. The problem is the callback is never
invoked — see items 1 and 2.

### 4. `extension/src/server.ts:304-318` — `emitSystemEvent` silently drops on degraded log

```typescript
// line 304
private async emitSystemEvent(topic: string, payload: unknown): Promise<void> {
  if (this.eventLog.isDegraded) return;  // ← SILENT drop; no fanOut
  try {
    const result = await this.eventLog.append({...});
    ...
    this.fanOut(topic, 'server', payload, false, sequence);
  } catch {
    // swallowed
  }
}
```

**Why suspicious:** If the event log failed to open at startup (disk error, permissions,
stale segment), `isDegraded` is `true` and ALL `emitSystemEvent` calls silently return —
no append, no `fanOut`, no bus event. Compare `emitServerEvent` (line 753) which always
calls `this.fanOut()` even on append failure. `system.worker.terminated` uses
`emitSystemEvent`, so it would be silently dropped if the log is degraded.

### 5. `extension/src/lifecycle-store.ts:228-245` — `markWorkerStatus` emits no bus event

```typescript
// line 228
markWorkerStatus(terminalId: string, status: WorkerStatus): SpawnedWorker | null {
  if (!this.state) return null;
  const idx = this.state.spawned_workers.findIndex(w => w.id === terminalId);
  if (idx === -1) return null;
  const updated: SpawnedWorker = { ...this.state.spawned_workers[idx], status, ... };
  const newSpawned = [...this.state.spawned_workers];
  newSpawned[idx] = updated;
  const newWorkers = this.state.workers.map(w =>
    w.id === terminalId ? { ...w, closed: status === 'closed' } : w
  );
  this.state = { ...this.state, spawned_workers: newSpawned, workers: newWorkers };
  this.flushToDisk();   // ← writes lifecycle-state.json
  return updated;       // ← no bus event emitted
}
```

**Why suspicious:** This is the only method called when the fast-path marks a worker
closed. It mutates state and writes to disk without emitting any bus event. The caller
(`server.ts:1690`) then calls `lifecycleEngine.onWorkerEvent('mark-worker-status:closed')`
which CAN emit `lifecycle.phase-changed` events — but NOT `system.worker.terminated` or
`system.worker.completed`. So lifecycle-state.json gets `status:closed` but the bus
stays silent.

### 6. `mcp_server.js:1927-1940` — fast-path watcher: `system.worker.completed` silently dropped when `_pconn` down

```javascript
// line 1927
if (_fpStatus !== null) {
  clearInterval(_fpIntervalId);
  _detachWatchers.delete(termId);
  try {
    await _pconnEnsureRegistered(sock);  // ← can fail if pconn disconnected
    await _pconnWrite({ cmd: 'publish', ..., topic: 'system.worker.completed', ... });
  } catch (e) { log('fast-path watcher publish failed: ' + (e && e.message || e)); }
  // ↑ failure is logged but not propagated — bus event is lost
  try { await clawsRpc(sock, { cmd: 'lifecycle.mark-worker-status', ... }); } catch {}
  // ↑ clawsRpc uses a fresh ephemeral socket — succeeds even when _pconn is down
  if (_fpOpt.close_on_complete) {
    try { await clawsRpc(sock, { cmd: 'close', id: termId }); } catch {}
    try { await clawsRpc(sock, { cmd: 'lifecycle.mark-worker-status', ..., status: 'closed' }); } catch {}
  }
}
```

**Why suspicious:** The `_pconnWrite` for `system.worker.completed` and the `clawsRpc`
for `lifecycle.mark-worker-status` use different socket paths: `_pconn` is the persistent
pub/sub connection; `clawsRpc` opens a fresh ephemeral connection per call. If `_pconn`
is disconnected (circuit breaker, extension restart, previous timeout), `system.worker.completed`
is silently dropped to a log line while `lifecycle.mark-worker-status` still succeeds. This
produces exactly the observed symptom: `lifecycle-state.json` shows `status:closed`, zero
bus events beyond spawn for the correlation_id.

The same failure pattern applies to heartbeat publishes (line 1900-1916):
```javascript
try {
  await _pconnEnsureRegistered(sock);
  await _pconnWrite({ cmd: 'publish', topic: `worker.${termId}.heartbeat`, ... });
  _fpHbLastPublishedAt = _fpHbNow;
} catch (e) {
  log('hb-l4 fast-path backstop publish failed: ' + (e && e.message || e));
  // ← heartbeat silently dropped; no retry
}
```

---

## Hypotheses ranked by likelihood

### H1 (Highest): `_pconn` disconnected → `system.worker.completed` silently dropped; lifecycle mutated via ephemeral RPC

**Evidence:**
- corr d99dae06 shows `system.worker.spawned` ✓ then total silence for ~4.5 min
- Lifecycle-state.json shows `status:closed` (proving the ephemeral `clawsRpc` path fired)
- `_pconnWrite` for `system.worker.completed` is in a try/catch that logs-and-continues
- `clawsRpc` (used for `lifecycle.mark-worker-status`) opens its own fresh socket — unaffected by `_pconn` state
- Circuit breaker at `_circuitBreaker.scanDisabled` can suppress subsequent `_pconnEnsureRegistered` attempts
- The heartbeat silence (zero `worker.3.heartbeat` events) is explained: heartbeat publishes also go via `_pconnWrite` and fail with the same catch-and-continue pattern

**Scenario:** `_pconn` had a disconnection (possibly from a prior session restart or socket path staleness). `_pconnHandleClose()` clears `_pconn.connected`, `_pconn.socket`, and `_workerTerminatedSubscribed`. Reconnect may have failed (circuit breaker). All `_pconnWrite` calls for that terminal silently dropped. `clawsRpc` (ephemeral, always fresh) worked fine.

### H2 (Confirmed structurally): `close()` deletes `byTerminal` before `dispose()` — `system.worker.terminated` never emits from the close path

**Evidence:**
- `terminal-manager.ts:291`: `this.byTerminal.delete(rec.terminal)` runs BEFORE the async `onDidCloseTerminal` fires
- `onTerminalClosed()` line 299: `if (!id) return` — exits immediately when byTerminal lookup fails
- The `onTerminalClose` callback (which would emit `system.worker.terminated`) is NEVER reached for programmatically-closed terminals
- This is a structural bug independent of socket state — every `claws_close`/`claws_worker` auto-close loses the terminated event

**Impact:** Even if H1 is fixed (pconn reconnection), the `system.worker.terminated` event will STILL not fire because the close path is broken at the TerminalManager level.

### H3 (Secondary): `emitSystemEvent` silently drops all events when event log is degraded

**Evidence:**
- `server.ts:305`: `if (this.eventLog.isDegraded) return` — no `fanOut`, no bus delivery
- `emitServerEvent` (line 753) does NOT have this guard — always calls `fanOut()`
- `system.worker.terminated` uses `emitSystemEvent`; would be invisible if the log degraded at startup
- Observable only when the degraded warning appears in VS Code's diagnostic channel — easy to miss

---

## Recommended fix(es) per hypothesis

### Fix for H1: Make `system.worker.completed` resilient to `_pconn` state

**In `mcp_server.js` fast-path watcher (around line 1927):**
- After the `_pconnWrite` try/catch fails, enqueue the publish to a retry set
- On the next successful `_pconnEnsureRegistered`, drain the retry queue
- Or: publish `system.worker.completed` via `clawsRpcStateful` with a fresh connection attempt, same as the heartbeat fallback pattern

**Minimal fix:** Change the heartbeat + completion publish catch blocks to attempt
one retry via `clawsRpcStateful` (which calls `_pconnEnsure` internally) before giving up.

### Fix for H2: Fix `close()` to fire the callback directly (don't rely on VS Code's async event)

**In `extension/src/terminal-manager.ts`, `close()` method:**

```typescript
close(id: string | number): boolean {
  const key = String(id);
  const rec = this.records.get(key);
  if (!rec) return false;
  this.stopContentDetection(rec);
  this.transitionState(rec, 'CLOSING');
  this.transitionState(rec, 'CLOSED');
  this.onTerminalClose?.(key, rec.wrapped);  // ← ADD: fire before map deletion
  try { rec.terminal.dispose(); } catch { /* ignore */ }
  this.byTerminal.delete(rec.terminal);
  this.records.delete(key);
  this.captureStore.clear(key);
  return true;
}
```

This ensures `system.worker.terminated` emits for every programmatic close, regardless
of VS Code's async event timing.

The double-fire risk (both `close()` and eventual `onTerminalClosed`) is handled by
`onTerminalClosed`'s existing early-return: after `close()` removes from `byTerminal`,
`onTerminalClosed` returns at line 299 — no double callback.

### Fix for H3: Change `emitSystemEvent` to always call `fanOut` (like `emitServerEvent`)

**In `extension/src/server.ts:304-318`:**

```typescript
private async emitSystemEvent(topic: string, payload: unknown): Promise<void> {
  let sequence: number | undefined;
  if (!this.eventLog.isDegraded) {
    try {
      const result = await this.eventLog.append({ topic, from: 'server', ts_server: new Date().toISOString(), payload });
      sequence = result.sequence >= 0 ? result.sequence : undefined;
    } catch { /* non-fatal */ }
  }
  this.fanOut(topic, 'server', payload, false, sequence);  // always fan out
}
```

---

## Tests we'd add

1. **`close()` fires close callback** — unit test: create a wrapped terminal record,
   wire `setTerminalCloseCallback`, call `close(id)`, assert callback was called with
   `(id, true)`. Currently fails because `close()` never calls the callback.

2. **`system.worker.terminated` on programmatic close** — integration test: spawn a
   wrapped worker terminal, subscribe to `system.worker.terminated`, call `claws_close`,
   assert event received within 2s. Currently fails (event never emitted).

3. **`system.worker.completed` survives `_pconn` disconnect** — unit test: mock
   `_pconnWrite` to throw 'persistent socket not connected', call the fast-path
   completion path, assert that a retry path or alternate publish was attempted and
   the event log records the completion. Currently the event is silently dropped.
