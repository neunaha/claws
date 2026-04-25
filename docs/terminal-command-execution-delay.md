# Claws — Terminal Command Execution Delay: Findings & Suggested Fixes

**Date**: 2026-04-25  
**Symptom**: Terminal created successfully via Claws, but commands sent to it are never executed. The user observes that nothing happens for ~60–90 seconds (1–1.5 min), then either gives up or sees a timeout error. The `fileExec` default timeout is 180,000ms (3 minutes); the 1–1.5 min window is how long the user typically waits before noticing failure — not when `fileExec` would eventually time out.  
**Method**: Full source audit of `terminal-manager.ts`, `claws-pty.ts`, `server.ts`, `mcp_server.js` + VS Code terminal API research  

---

## Part 1 — The Exact Failure Path

Here is the precise sequence of events that produces the reported symptom:

```
1. claws_create / claws_worker called
   └─ Extension: ID returned immediately ← PTY not spawned yet, open() not called

2. mcp_server.js: await sleep(400)
   └─ 400ms fixed wait ← frequently insufficient

3. send RPC arrives at extension
   └─ server.ts: rec.pty.writeInjected(text, ...)
      └─ claws-pty.ts: if (!this.isOpen) return  ← SILENT DROP
         └─ Returns { ok: true } to caller ← LIES: nothing was sent

4. VS Code eventually calls open() — shell process spawns
   └─ Shell is idle at a blank prompt, no command in input

5. fileExec polls donePath every 150ms for up to timeoutMs (default 180,000ms = 3 min)
   └─ File never appears — command was never executed

6. User sees: 60–90 second wait with no output
   └─ Either user intervenes manually, OR runBlockingWorker exhausts boot_wait_ms
      and its poll loop runs ~52–82 more seconds before the caller gives up
   └─ fileExec's own 3-minute timeout would fire later if no one intervenes
```

---

## Part 2 — VS Code Terminal API: What the Research Found

### 2.1 `createTerminal()` does not mean the shell is ready

**Source**: [VS Code API docs](https://code.visualstudio.com/api/references/vscode-api) + [vscode-extension-samples/issues/732](https://github.com/microsoft/vscode-extension-samples/issues/732)

`window.createTerminal()` returns a `Terminal` object synchronously. The shell process has not started yet. The `processId` property is a `Thenable` (Promise) — undefined until the shell spawns. Calling `sendText()` immediately after creation may appear to work because VS Code internally buffers input, but the buffer is delivered to the shell only after it has started reading from stdin. If anything goes wrong with that delivery (see §2.3), the command is lost.

### 2.2 `Pseudoterminal.open()` is the real start signal — not `createTerminal()`

**Source**: [VS Code Pseudoterminal API docs](https://vshaxe.github.io/vscode-extern/vscode/Pseudoterminal.html)

> "Events fired before `Pseudoterminal.open` is called will be ignored."

When Claws creates a wrapped terminal, it uses the `Pseudoterminal` interface (`ClawsPty` implements it). VS Code calls `open(initialDimensions)` only when the terminal tab is actually rendered on screen. There is no deterministic delay between `createTerminal()` and `open()`. On a typical system it is 100–600ms. On a cold VS Code launch, with a slow login shell, or on a loaded machine, it can be 1–2 seconds.

The shell process (bash, zsh, PowerShell) is **not spawned until `open()` fires**. This means any write before `open()` goes to a process that does not yet exist.

### 2.3 Confirmed VS Code bugs: `sendText()` silently drops input

**Source**: [VS Code #215402](https://github.com/microsoft/vscode/issues/215402), [VS Code #292058](https://github.com/microsoft/vscode/issues/292058)

Two confirmed VS Code bugs where `sendText()` drops input silently:

- **#215402** — "Terminal ignoring first character of input via `terminal.sendText()`": The first character of a `sendText()` call is occasionally dropped when the terminal was just created.
- **#292058** — "`sendText()` fails when a terminal is created and immediately has `sendText()` called on it": Input is dropped entirely when sent before the shell is ready. There is no error — the API returns silently as if the write succeeded.

These are not Claws-specific. They affect any VS Code extension that sends input immediately after terminal creation.

### 2.4 Shell integration: the authoritative readiness signal — but slow

**Source**: [VS Code Shell Integration docs](https://code.visualstudio.com/docs/terminal/shell-integration), [VS Code #221399](https://github.com/microsoft/vscode/issues/221399)

VS Code fires `onDidChangeTerminalShellIntegration` once its injection script has run inside the shell. At this point `terminal.shellIntegration` becomes non-null and `executeCommand()` is safe to use.

> "The shell integration object will always be undefined immediately after the terminal is created."

The recommended pattern in the VS Code docs:

```typescript
const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
  if (event.terminal === terminal) {
    disposable.dispose();
    terminal.shellIntegration.executeCommand('your-command');
  }
});
// Fallback: if no shell integration within 3 seconds, use sendText
setTimeout(() => { disposable.dispose(); terminal.sendText('your-command'); }, 3000);
```

Shell integration depends on shell support (bash, zsh, fish, PowerShell all support it; others may not). It fires 200ms–2s after `open()`, depending on shell startup speed.

### 2.5 node-pty: no synchronous "ready" signal

**Source**: [node-pty GitHub](https://github.com/microsoft/node-pty), community discussions

After `nodePty.spawn()` returns, the shell process is forked but has not yet printed its prompt. There is no callback or event that fires when the shell is ready to accept input.

> "There is no way to check if a command ran or not, and awaits don't work as a way to achieve sequential command execution."

> "A common workaround: wait to start writing PTY data until seeing some arbitrary unicode marker... to ensure the shell prompt has appeared."

The only reliable approach is to monitor the PTY's data output stream and wait until a shell prompt pattern appears before writing the first command.

### 2.6 The 1.5–3 second heuristic from VS Code's own team

**Source**: VS Code extension documentation, VS Code terminal discussions

> "A 500ms delay before sending activation commands is used, and a sleep of 1.5 seconds should practically always work."

The fact that VS Code's own engineers recommend 1.5–3 seconds as a timing heuristic confirms that there is no synchronous readiness guarantee. The 400ms sleep in `runBlockingWorker` is below even the lowest recommended threshold.

---

## Part 3 — Code Audit: Every Gap Found

### Gap 1 — `claws-pty.ts:225` — Silent discard with false success

```typescript
// claws-pty.ts
writeInjected(text: string, withNewline: boolean, bracketedPaste: boolean): void {
  if (!this.isOpen) return;  // ← silent drop, no error, no queue
  ...
}
```

`isOpen` is `false` until `open()` is called by VS Code. Any write before that is dropped with no indication to the caller. There is no queue, no retry, no error returned.

**Line**: `claws-pty.ts:240`

### Gap 2 — `server.ts:479–485` — `send` returns `{ ok: true }` when text was dropped

```typescript
// server.ts — send handler
if (rec.pty) {
  rec.pty.writeInjected(text, newline, r.paste === true);
  return { ok: true, mode: 'wrapped' };  // ← always ok, even if dropped
}
```

The `send` command returns success unconditionally. The MCP server, `runBlockingWorker`, and `fileExec` all treat this as confirmation the text was delivered. It is not.

**Line**: `server.ts:479–484`

### Gap 3 — `terminal-manager.ts:148` — ID returned before PTY is open

```typescript
// terminal-manager.ts — createWrapped
const { id } = tm.createWrapped(r);
return { ok: true, id, logPath: null, wrapped: true };
// ← returned immediately; open() has not fired, shell has not started
```

The caller receives an ID and immediately tries to use it. There is no way for the caller to know the terminal is not yet ready.

**Line**: `terminal-manager.ts:148` (approximate, ID-return line in createWrapped)

### Gap 4 — `mcp_server.js:459` — 400ms sleep is a guess

```javascript
// runBlockingWorker
await sleep(400);  // "Give shell a moment to emit prompt"
```

400ms is below every threshold documented by VS Code's own team (500ms minimum, 1.5–3s recommended). It is especially insufficient on:
- Cold VS Code startup (node-pty native binding loaded for the first time)
- Login shells with `.zprofile`/`.bash_profile` scripts (nvm, rbenv, conda, etc.)
- Windows (ConPTY initialization overhead)
- Any loaded or slow system

**Line**: `mcp_server.js:459` (approximately, inside `runBlockingWorker`)

### Gap 5 — `mcp_server.js` — `fileExec` bash wrapper fails silently when shell is not ready

```javascript
const wrapper = `{ ${command}; } > ${outPath} 2>&1; echo $? > ${donePath}`;
await clawsRpc(sockPath, { cmd: 'send', id: termId, text: wrapper, newline: true });
```

The wrapper is sent via the `send` path. If the PTY is not open, `writeInjected` drops it silently, `send` returns `ok: true`, and `fileExec` starts polling for `donePath`. It polls every 150ms for `timeoutMs` (default 180,000ms = 3 minutes). The file never appears because the command was never delivered. The 1–1.5 minute window the user observes is not `fileExec` timing out — the default would run for 3 minutes. The early apparent-failure comes from the user noticing nothing is happening and intervening, or from `runBlockingWorker` exhausting `boot_wait_ms` (8,000ms) and its own outer poll loop then running for ~52–82 seconds of inactivity before the caller surfaces an error.

**Lines**: `mcp_server.js:219–225` (fileExec)

### Gap 6 — No PTY readiness command in the protocol

There is no `waitReady` or `status` command in the Claws protocol that would allow the MCP server to wait until `ClawsPty.hasOpened()` is true. The only way to check readiness from the outside is to read the log and look for shell prompt output.

---

## Part 4 — Suggested Fixes

Three tiers: immediate fix (lowest effort, good enough), proper fix (correct solution), and complete fix (ideal).

---

### Tier 1 — Immediate: Fix the silent discard in `writeInjected` with an input queue

**File**: `extension/src/claws-pty.ts`  
**Impact**: Commands sent before `open()` are now replayed once the shell starts, instead of dropped.

**Suggested change**:

```typescript
// In ClawsPty class — add a pending queue
private pendingWrites: Array<{ text: string; withNewline: boolean; bracketedPaste: boolean }> = [];

writeInjected(text: string, withNewline: boolean, bracketedPaste: boolean): void {
  if (!this.isOpen) {
    // Queue instead of drop — replayed once open() fires
    this.pendingWrites.push({ text, withNewline, bracketedPaste });
    return;
  }
  this._writeInjectedNow(text, withNewline, bracketedPaste);
}

private _writeInjectedNow(text: string, withNewline: boolean, bracketedPaste: boolean): void {
  let payload = text;
  if (bracketedPaste) payload = `\x1b[200~${payload}\x1b[201~`;
  if (withNewline) payload += '\r';
  if (this.ptyProc) {
    this.ptyProc.write(payload);
  } else if (this.childProc?.stdin.writable) {
    this.childProc.stdin.write(payload);
  }
}

open(initialDimensions: vscode.TerminalDimensions | undefined): void {
  this.isOpen = true;
  this.openedAt = Date.now();
  // ... existing spawn logic ...

  // After spawn succeeds, replay any writes that arrived before open()
  // Use a short delay to let the shell emit its first prompt
  setTimeout(() => {
    const queued = this.pendingWrites.splice(0);
    for (const w of queued) {
      this._writeInjectedNow(w.text, w.withNewline, w.bracketedPaste);
    }
  }, 300);
}
```

The 300ms delay inside `open()` before replaying is intentional — `open()` fires when VS Code renders the terminal, but node-pty's `spawn()` may still be initializing. The 300ms gives the shell time to print its first prompt so the queued command lands at the shell prompt rather than into the spawn setup.

**Why this is better than the current state**: Commands are no longer lost. The worst case is a 300ms delay before the command executes — not a 1–3 minute apparent hang.

---

### Tier 2 — Proper: Add a `waitReady` server command + shell prompt detection

**Files**: `extension/src/server.ts`, `extension/src/protocol.ts`, `mcp_server.js`

#### Part A — New `status` command in `server.ts`

Expose PTY readiness state via a new lightweight command so the MCP server can poll for it explicitly:

```typescript
// In server.ts handle()
if (cmd === 'status') {
  const r = req as ClawsRequest & { id: string | number };
  const rec = tm.recordById(r.id);
  if (!rec) return { ok: false, error: `unknown terminal id ${r.id}` };
  return {
    ok: true,
    ptyOpen: rec.pty ? rec.pty.hasOpened() : null,
    ptyMode: rec.pty ? rec.pty.mode : null,
    pid: rec.pty ? rec.pty.pid : null,
    wrapped: rec.wrapped,
  };
}
```

#### Part B — `runBlockingWorker` polls for PTY readiness before sending

Replace the fixed 400ms sleep with a poll loop that checks `ptyOpen`:

```javascript
// In mcp_server.js — runBlockingWorker, replace the sleep(400) block
// Instead of: await sleep(400)

const PTY_READY_POLL_MS = 100;
const PTY_READY_TIMEOUT_MS = 10000;
const ptyDeadline = Date.now() + PTY_READY_TIMEOUT_MS;
let ptyReady = false;

while (Date.now() < ptyDeadline) {
  const statusResp = await clawsRpc(sock, { cmd: 'status', id: termId });
  if (statusResp.ok && statusResp.ptyOpen === true) {
    ptyReady = true;
    break;
  }
  await sleep(PTY_READY_POLL_MS);
}
if (!ptyReady) {
  // Fall through — best-effort, same as before but with a clear log
  process.stderr.write(`[claws-mcp] PTY did not open within ${PTY_READY_TIMEOUT_MS}ms for ${termId}\n`);
}
await sleep(200); // Brief extra wait for shell to emit first prompt after open()
```

This replaces a blind 400ms sleep with a 100ms-interval poll that exits as soon as `open()` has fired. On a fast system this resolves in 100–300ms. On a slow system it waits properly rather than sending too early.

---

### Tier 3 — Complete: Shell prompt detection before first command

The most robust solution combines Tier 1 + Tier 2 with shell prompt detection. Instead of using `ptyOpen` (PTY process started) as the readiness signal, use the first output from the shell (the prompt) as the signal.

**File**: `extension/src/claws-pty.ts` + `extension/src/server.ts`

#### Track prompt readiness in `ClawsPty`

```typescript
// In ClawsPty class
private promptSeen = false;

private handleOutput(data: string): void {
  this.writeEmitter.fire(data);
  this.opts.captureStore.append(this.opts.terminalId, data);
  // Mark shell as ready on first output — conservative: any output means the
  // shell is alive and reading from stdin.
  if (!this.promptSeen && data.trim().length > 0) {
    this.promptSeen = true;
  }
}

hasPrompt(): boolean {
  return this.promptSeen;
}
```

#### Expose `hasPrompt` in the `status` command

```typescript
// In server.ts status handler
return {
  ok: true,
  ptyOpen: rec.pty ? rec.pty.hasOpened() : null,
  promptSeen: rec.pty ? rec.pty.hasPrompt() : null,
  // ...
};
```

#### `runBlockingWorker` waits for prompt, not just PTY open

```javascript
// Poll for promptSeen instead of ptyOpen
while (Date.now() < ptyDeadline) {
  const statusResp = await clawsRpc(sock, { cmd: 'status', id: termId });
  if (statusResp.ok && statusResp.promptSeen === true) {
    ptyReady = true;
    break;
  }
  await sleep(PTY_READY_POLL_MS);
}
// No extra sleep needed — we've confirmed the shell has output something
```

This is the most reliable approach: "shell has printed at least one byte" is a concrete, observable signal that the shell is running and reading from stdin. It requires no heuristic delays.

---

### Tier 4 — Use VS Code Shell Integration event (wrapped terminals: N/A, standard: yes)

For **standard** (unwrapped) terminals, VS Code fires `onDidChangeTerminalShellIntegration` when the shell is fully ready. The extension could listen for this and mark the terminal as ready:

```typescript
// In extension.ts or terminal-manager.ts
vscode.window.onDidChangeTerminalShellIntegration((event) => {
  const rec = terminalManager.recordByVscodeTerminal(event.terminal);
  if (rec) {
    rec.shellIntegrationReady = true;
  }
});
```

Then the `send` handler can check `shellIntegrationReady` before issuing `sendText`, and queue if not ready.

**Note**: Shell integration is not available for wrapped terminals (which use `Pseudoterminal` instead of VS Code's shell integration injection). For wrapped terminals, Tiers 1–3 are the applicable approaches.

---

## Part 5 — Priority and Impact Table

| Fix | Tier | Files | Effort | Impact |
|---|---|---|---|---|
| Input queue in `writeInjected` | 1 | `claws-pty.ts` | Low | Eliminates silent drops — commands no longer lost |
| `status` command in server | 2 | `server.ts`, `protocol.ts` | Low | Exposes PTY readiness to MCP server |
| `runBlockingWorker` polls readiness | 2 | `mcp_server.js` | Low | Replaces fixed 400ms guess with real poll |
| `promptSeen` detection in `ClawsPty` | 3 | `claws-pty.ts` | Low | True shell readiness signal, no heuristic |
| Shell integration listener | 4 | `extension.ts` | Medium | Correct for standard terminals only |

**Recommended implementation order**: Tier 1 → Tier 2 → Tier 3. Each tier is independent and builds on the previous. Tier 1 alone eliminates the 1–3 minute apparent hang symptom by ensuring commands are never silently dropped. Tiers 2+3 eliminate the remaining race condition properly.

---

## Part 6 — What Is NOT the Problem

- **The MCP server framing** — confirmed working after the buffer fixes in the disconnection pass.
- **The extension socket server** — the `send` command reaches the extension successfully. The drop happens inside `ClawsPty`, not in the network layer.
- **The `fileExec` polling logic** — the 150ms poll interval is fine. The file never appears because the command was never sent, not because polling is too slow.
- **Shell integration timeouts** — Claws does not rely on shell integration for wrapped terminals; this is not a contributing factor.

---

## Part 7 — Sources

| Claim | Source |
|---|---|
| `open()` not called until terminal renders | [VS Code Pseudoterminal API docs](https://vshaxe.github.io/vscode-extern/vscode/Pseudoterminal.html) |
| `sendText()` silently drops input on early call | [VS Code #215402](https://github.com/microsoft/vscode/issues/215402), [VS Code #292058](https://github.com/microsoft/vscode/issues/292058) |
| Shell integration timing and 3s fallback pattern | [VS Code Shell Integration docs](https://code.visualstudio.com/docs/terminal/shell-integration) |
| `onDidChangeTerminalShellIntegration` timing issues | [VS Code #221399](https://github.com/microsoft/vscode/issues/221399) |
| node-pty: no synchronous ready signal | [node-pty GitHub](https://github.com/microsoft/node-pty) |
| 1.5s heuristic from VS Code team | [VS Code terminal advanced docs](https://code.visualstudio.com/docs/terminal/advanced) |
| VS Code 5ms output buffer after `open()` | [VS Code #85257](https://github.com/microsoft/vscode/issues/85257) |
| `processId` is Thenable (shell not sync-ready) | [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api) |
