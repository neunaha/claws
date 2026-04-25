# Claws — Windows Porting: Findings & Changes

**Date**: 2026-04-25  
**Scope**: Making Claws work on Windows (VS Code extension + MCP server + installer)  
**Files changed**: 3  
**Files audited and confirmed unchanged**: 10+

---

## 1. How Claws Works (Brief)

Claws has three layers that all need to agree on a transport path:

```
Claude Code (MCP/stdio)
        │
        ▼
mcp_server.js          ← resolves socket path, connects to extension
        │
        ▼  JSON over socket
extension/src/server.ts  ← listens on socket, owns terminals
        │
        ▼
node-pty / child_process ← spawns shells inside VS Code
```

On Unix the transport is a **Unix domain socket** at `<workspace>/.claws/claws.sock`.  
On Windows it must be a **named pipe** at `\\.\pipe\claws-<hash>`.  
Node.js `net` uses the same API for both — the difference is only in the path string format and how the path is discovered.

---

## 2. Audit Results — What Was Already Cross-Platform

These required **no changes**. Documented here so they are not re-investigated.

### `extension/src/claws-pty.ts` — Shell resolution

`defaultShell()` (line 278) already has a full Windows branch:

```typescript
if (process.platform === 'win32') {
  return process.env.COMSPEC || 'powershell.exe';
}
```

`defaultShellArgs()` (line 306) already returns `[]` on Windows, correctly skipping the `-i`/`-l` flags that only apply to bash/zsh.

### `extension/src/claws-pty.ts` — node-pty failure fallback

When node-pty fails to load (e.g. missing Windows prebuilt binaries), `ClawsPty.open()` falls back to `child_process` pipe-mode. A warning banner is shown in the terminal. The extension does not crash.

### `extension/native/node-pty/` — Windows terminal code

`windowsTerminal.js`, `windowsPtyAgent.js`, `windowsConoutConnection.js`, and `conpty_console_list_agent.js` are all present and implement full ConPTY (Windows 10 18309+) and WinPTY (legacy fallback) support. The JS layer is complete.

**Caveat**: Only `build/Release/pty.node` is bundled — a macOS/Linux binary. No `prebuilds/win32-x64/` binaries are present. Node-pty will fail to load on Windows and fall back to pipe-mode. This is a degraded-experience issue (no TUI capture), not a crash. Adding Windows prebuilts requires a Windows CI runner.

### `cli.js` — Extension linking on Windows

The `install()` function (line 78) already tries `mklink /J` (Windows junction) as a fallback when `fs.symlinkSync` fails:

```javascript
run(`mklink /J "${extLink}" "${path.join(INSTALL_DIR, 'extension')}"`, { silent: true, ignoreError: true });
```

### `cli.js` — `chmod` on Windows

`fs.chmodSync()` calls (lines 88–91) are wrapped in `try/catch`. They fail silently on Windows. No fix needed.

### `cli.js` — Shell hook injection

The hook injection loop (lines 160–169) only runs if `.zshrc`/`.bashrc` exists. These files don't exist on Windows, so the loop silently skips. The Windows equivalent (PowerShell profile) is handled separately in `install.ps1`.

### `scripts/install.ps1` — Already exists

A PowerShell installer script was already present. It correctly handles: git clone, junction creation, PowerShell `$PROFILE` injection, and MCP registration.

### `mcp_server.js` — `fileExec` temp files

`fileExec()` uses `os.tmpdir()` for temp paths, which works cross-platform. The shell wrapper `{ cmd; } > out 2>&1; echo $? > done` is bash syntax — but `fileExec` is only called when shell integration is not available and the user sends a command. On Windows the default shell is PowerShell/cmd, which uses different redirect syntax. This is a **known limitation**, not addressed in this porting pass (shell integration via VS Code's built-in API is the preferred path).

---

## 3. What Actually Breaks on Windows — Root Cause Analysis

### Blocker 1: `process.umask()` crashes the extension

**File**: `extension/src/server.ts`, `bind()` method (was line 197)  
**Symptom**: Extension activation fails with `Error: ENOSYS: function not implemented, uv_os_umask`  
**Root cause**: `process.umask(0o077)` is a POSIX call. Node.js on Windows throws `ENOSYS` because Windows has no umask concept.  
**Severity**: Hard crash — the socket server never starts, all Claws tools return connection errors.

### Blocker 2: `net.Server.listen('.claws/claws.sock')` fails on Windows

**File**: `extension/src/server.ts`, `bind()` method (was line 208)  
**Symptom**: Extension logs `[server error] Error: listen ENOENT .claws/claws.sock` or similar  
**Root cause**: On Windows, `net.Server.listen(path)` creates a **named pipe**, not a Unix socket file. Named pipes must use the path format `\\.\pipe\<name>`. A relative file path like `.claws/claws.sock` is not valid as a named pipe identifier.  
**Severity**: Hard crash — the socket server cannot bind on Windows.

### Blocker 3: `getSocket()` in `mcp_server.js` never finds the socket on Windows

**File**: `mcp_server.js`, `getSocket()` function (was lines 549–571)  
**Symptom**: Every MCP tool call fails with `socket error: connect ENOENT .claws/claws.sock`  
**Root cause**: The discovery walk uses `fs.statSync(candidate).isSocket()` to detect Unix socket files. Named pipes on Windows do not appear as entries in the filesystem — they live in the `\\.\pipe\` kernel namespace. The walk always falls through to the final `return envSock || '.claws/claws.sock'`, which is not a valid named pipe path.  
**Severity**: Hard crash — all 14 MCP tools are broken.

### Blocker 4: `install.ps1` hardcodes `CLAWS_SOCKET=".claws/claws.sock"` in MCP config

**File**: `scripts/install.ps1`, lines 88–90 and 104–106  
**Symptom**: After fixing blockers 1–3, MCP still falls back to wrong path  
**Root cause**: The `getSocket()` fallback at the end of the walk is `envSock || platformDefault`. The env var `CLAWS_SOCKET=".claws/claws.sock"` (set by the installer in `settings.json`) is relative, so it doesn't trigger the absolute-path early return. But it does override the correct platform default (`\\.\pipe\claws`) when discovery fails (e.g. extension not started yet).  
**Severity**: Intermittent — only matters when the extension isn't running, which is when error messages are most important.

---

## 4. Changes Made

### 4.1 `extension/src/server.ts`

**Added import** (line 5):
```typescript
import * as crypto from 'crypto';
```
Needed to hash the workspace root into a stable named pipe name.

**Added field** (class body):
```typescript
private pipeNameFile: string | null = null;
```
Tracks the `.claws/claws.pipename` discovery file path so `stop()` can clean it up without re-deriving the workspace root.

**Modified `start()`** — Windows branch:
```typescript
if (process.platform === 'win32') {
  const hash = crypto.createHash('sha1').update(this.opts.workspaceRoot).digest('hex').slice(0, 8);
  this.socketPath = `\\\\.\\pipe\\claws-${hash}`;
  this.pipeNameFile = path.join(clawsDir, 'claws.pipename');
  try { fs.writeFileSync(this.pipeNameFile, this.socketPath, 'utf8'); } catch { /* ignore */ }
} else {
  const socketRel = this.opts.socketRel || DEFAULT_SOCKET_REL;
  this.socketPath = path.join(this.opts.workspaceRoot, socketRel);
}
```

Why a hash? Named pipe names have a flat namespace (`\\.\pipe\<name>`). Using a SHA-1 hash of the absolute workspace root gives each workspace a unique pipe so two VS Code windows in different workspaces don't collide. 8 hex chars (32-bit) is enough collision resistance for a local machine.

Why write a file? Named pipes don't appear in the filesystem. The MCP server discovers the socket by walking up the directory tree from CWD. A plain text file in `.claws/claws.pipename` is the cross-process rendezvous point.

**Modified `stop()`** — platform-split cleanup:
```typescript
if (process.platform === 'win32') {
  // Named pipes are cleaned up by the OS — remove only the discovery file.
  try { if (this.pipeNameFile) fs.unlinkSync(this.pipeNameFile); } catch { /* ignore */ }
} else {
  try { if (this.socketPath) fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
}
```

On Windows, the OS automatically destroys the named pipe when the last handle closes. We only need to clean up the `.claws/claws.pipename` discovery file so a stale file from a previous session doesn't mislead a restarting MCP server.

**Modified `prepareSocket()`** — Windows skip of `fs.existsSync`:
```typescript
if (process.platform === 'win32') {
  const occupied = await this.probeSocket(sockPath);
  if (occupied) {
    throw new Error(`refusing to start: another server is already listening on ${sockPath}. Close the other VS Code window.`);
  }
  return;
}
// Unix path: check fs.existsSync, unlink stale socket, etc.
```

`probeSocket()` uses `net.createConnection()` which works with named pipes — it gets `ECONNREFUSED` if no one is listening, or succeeds if someone is. The `fs.existsSync` check and `fs.unlinkSync` are skipped because the named pipe namespace is not addressable via the filesystem.

**Modified `bind()`** — umask guard (the primary crash fix):
```typescript
// process.umask() throws ENOSYS on Windows — skip entirely for named pipes.
const prevUmask = process.platform !== 'win32' ? process.umask(0o077) : undefined;
try {
  this.server.once('listening', () => {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
    }
    // ...
  });
  this.server.listen(sockPath);
} finally {
  if (prevUmask !== undefined) process.umask(prevUmask);
}
```

`process.umask()` and `fs.chmodSync()` are POSIX concepts with no Windows equivalent. Named pipes use Windows ACLs for access control (default: only the creating user). Both calls are skipped on Windows.

---

### 4.2 `mcp_server.js`

**Modified `getSocket()`** — Windows pipe discovery:

```javascript
while (true) {
  if (process.platform === 'win32') {
    const pipeFile = path.join(dir, '.claws', 'claws.pipename');
    try {
      const pipeName = fs.readFileSync(pipeFile, 'utf8').trim();
      if (pipeName) return pipeName;
    } catch { /* not found at this level */ }
  } else {
    const candidate = path.join(dir, '.claws', 'claws.sock');
    try {
      if (fs.statSync(candidate).isSocket()) return candidate;
    } catch { /* not found at this level */ }
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

return envSock || (process.platform === 'win32' ? '\\\\.\\pipe\\claws' : '.claws/claws.sock');
```

On Windows, each directory level is checked for `.claws/claws.pipename`. The file contains the full named pipe path written by the extension at startup. The final fallback is now platform-aware: `\\.\pipe\claws` for Windows, `.claws/claws.sock` for Unix.

Discovery continues to work correctly when Claude Code is launched from a subdirectory of the workspace — the walk reaches the workspace root where `.claws/claws.pipename` lives.

---

### 4.3 `scripts/install.ps1`

**Removed** `env = @{ CLAWS_SOCKET = ".claws/claws.sock" }` from both MCP registration blocks (new settings.json creation and existing settings.json update).

Before (both locations):
```powershell
claws = @{
    command = "node"
    args    = @($MCP_PATH.Replace('\', '/'))
    env     = @{ CLAWS_SOCKET = ".claws/claws.sock" }
}
```

After:
```powershell
claws = @{
    command = "node"
    args    = @($MCP_PATH.Replace('\', '/'))
}
```

The `CLAWS_SOCKET` env var is only used as a final fallback in `getSocket()`. Since it was relative (`.claws/claws.sock`), it did not trigger the early absolute-path return — but it did shadow the corrected platform default (`\\.\pipe\claws`) that would otherwise be used when the extension isn't running. Removing it lets the correct fallback apply.

---

## 5. Remaining Gaps (Not Fixed — Scope Decisions)

### node-pty Windows prebuilt binaries

**Impact**: Wrapped terminals fall back to pipe-mode. TUI applications (Claude Code TUI, vim, htop) don't render correctly in wrapped terminals. `claws_read_log` still works but output quality is reduced.

**Fix**: Add a Windows CI runner (GitHub Actions `windows-latest`) that runs `electron-rebuild` to compile `pty.node`, `conpty.node`, and `conpty_console_list.node` for `win32-x64` and bundles them into `extension/native/node-pty/prebuilds/win32-x64/`.

### `fileExec` shell wrapper syntax

**Impact**: `claws_exec` uses `{ cmd; } > out 2>&1; echo $? > done` which is bash syntax. On Windows with PowerShell this fails.

**Fix**: On Windows, use PowerShell syntax: `$e = 0; try { cmd } catch { $e = 1 } finally { $e | Out-File done }`. Alternatively, `claws_exec` could detect Windows and route through shell integration instead of file-based capture.

### `tests/run.sh` and other test scripts

All test runner scripts are bash. They would need PowerShell equivalents or WSL for CI on Windows.

---

## 6. Porting Summary Table

| Component | Status | Notes |
|---|---|---|
| Socket transport (server) | **Fixed** | Named pipe with workspace hash |
| Socket discovery (MCP client) | **Fixed** | Reads `.claws/claws.pipename` |
| umask crash | **Fixed** | Guarded with `platform !== 'win32'` |
| Default shell (PowerShell) | Already done | `claws-pty.ts:279` |
| Shell args on Windows | Already done | Returns `[]` on win32 |
| Extension linking (junction) | Already done | `cli.js` has `mklink /J` fallback |
| PowerShell profile hook | Already done | `install.ps1` handles `$PROFILE` |
| node-pty Windows JS code | Already done | `windowsTerminal.js` etc. present |
| node-pty Windows prebuilts | **Gap** | Needs Windows CI runner |
| `fileExec` shell syntax | **Gap** | Bash-only redirect syntax |
| Test scripts | **Gap** | All bash, need PS1 equivalents |
