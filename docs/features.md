# Claws — Complete Feature Reference

Everything the extension can do, in depth. For the quick overview, see the [README](../README.md).

---

## Table of Contents

- [Terminal Discovery](#terminal-discovery)
- [Terminal Creation](#terminal-creation)
- [Wrapped Terminals](#wrapped-terminals)
- [Text Injection (send)](#text-injection)
- [Command Execution (exec)](#command-execution)
- [Pty Log Reading (readLog)](#pty-log-reading)
- [Event Streaming (poll)](#event-streaming)
- [Introspection (introspect)](#introspection)
- [Terminal Profile — Dropdown Integration](#terminal-profile)
- [Safety Gate](#safety-gate)
- [Bracketed Paste](#bracketed-paste)
- [Command Palette](#command-palette)
- [Keybindings](#keybindings)
- [Status Bar Item](#status-bar-item)
- [Uninstall Cleanup](#uninstall-cleanup)
- [Configuration Reference](#configuration-reference)
- [Socket Server Internals](#socket-server-internals)
- [Cross-Device Control](#cross-device-control)

---

## Terminal Discovery

**Command**: `list`

Returns every open VS Code terminal with full metadata:

| Field | Type | Description |
|---|---|---|
| `id` | string | Stable numeric ID, persists for the terminal's lifetime |
| `name` | string | Terminal display name (user-set or auto-assigned) |
| `pid` | number | Shell process ID |
| `hasShellIntegration` | boolean | Whether VS Code's shell integration is active |
| `active` | boolean | Whether this is the currently focused terminal |
| `logPath` | string or null | Absolute path to the pty log file (null if not wrapped) |

**Why stable IDs matter**: VS Code's terminal API identifies terminals by object reference internally. Claws assigns each terminal a monotonically increasing numeric ID at first sight and holds it in a `WeakMap`. The ID survives terminal renames, focus changes, and extension reloads within the same VS Code session. External clients use this ID for every subsequent command — no fragile name-matching.

**Example response**:
```json
{
  "ok": true,
  "terminals": [
    {"id": "1", "name": "zsh", "pid": 45123, "hasShellIntegration": true, "active": false, "logPath": null},
    {"id": "3", "name": "build-worker", "pid": 45890, "hasShellIntegration": false, "active": true, "logPath": "/project/.claws/terminals/claws-3.log"}
  ]
}
```

---

## Terminal Creation

**Command**: `create`

Opens a new VS Code integrated terminal with full control over its configuration.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `name` | string | `"claws"` | Display name in the terminal panel |
| `cwd` | string | workspace root | Working directory |
| `wrapped` | boolean | `false` | Wrap in `script(1)` for pty logging |
| `show` | boolean | `true` | Show the terminal panel and focus it |
| `shellPath` | string | system default | Override the shell binary |
| `env` | object | `{}` | Additional environment variables |

**Returns**: `{ id, logPath }` — the new terminal's stable ID and (if wrapped) the absolute path to its pty log file.

**Terminal naming**: the `name` parameter sets the tab label in VS Code's terminal panel. Use descriptive names for orchestration (`"lint-worker"`, `"test-runner"`, `"ai-session-1"`) so you can identify terminals visually.

**Working directory**: defaults to the workspace root. Set `cwd` to any absolute path to start the terminal elsewhere — useful for monorepo setups where different workers operate in different packages.

---

## Wrapped Terminals

The core innovation. A wrapped terminal runs your shell inside `script(1)`:

```
VS Code Terminal Panel
└── script(1) process
    └── /bin/zsh (your actual shell)
        └── whatever you run (claude, npm, vim, etc.)
```

`script(1)` is a standard Unix utility (ships with macOS and Linux) that records everything that flows through a pseudo-terminal to a file. Claws sets the output file to `.claws/terminals/claws-<id>.log` and passes it via the `CLAWS_TERM_LOG` environment variable.

### What gets captured

Everything. Every byte that the terminal renders:

- Shell prompts and command echoes
- stdout and stderr from every command
- Interactive TUI rendering (Claude Code's Ink framework, vim's ncurses, htop's dashboard)
- ANSI escape sequences (colors, cursor movement, screen clearing)
- Control characters

### What you get back (after ANSI stripping)

Clean, readable text. Claws strips ANSI CSI sequences (`\e[...m`, `\e[...H`, etc.), OSC sequences (`\e]...BEL`), and control characters (`\x00-\x1f` except `\n` and `\t`). The result is what a human would read if they were watching the terminal.

### Visual impact

Zero. A wrapped terminal looks, feels, and behaves identically to a regular terminal. The `script(1)` layer adds no visible latency, no changed prompts, no extra processes in the shell's job table. The user cannot tell the difference unless they check for the `CLAWS_WRAPPED=1` environment variable.

### Log buffering

`script(1)` buffers output before writing to disk. On macOS with the default settings (no `-F` flag), there's a ~1-2 second delay before new content appears in the log file. This is intentional — aggressive flushing (`-F` flag) causes visual corruption in Ink-based TUI renderers (like Claude Code) by splitting their atomic frame updates across flush boundaries.

### Creating wrapped terminals

Three ways:

1. **From the dropdown**: Click the arrow next to `+` in the terminal panel → "Claws Wrapped Terminal"
2. **From code**: `client.create("name", wrapped=True)`
3. **From the socket**: `{"cmd": "create", "name": "name", "wrapped": true}`

### The wrapper script

Located at `scripts/terminal-wrapper.sh`. It:

1. Creates the log directory if missing
2. Truncates the log file (fresh start)
3. Sets `CLAWS_WRAPPED=1` in the environment
4. Exec-replaces itself with `script -q "$CLAWS_TERM_LOG" /bin/zsh -il`

The script is resolved at runtime: Claws checks for a workspace-local `scripts/terminal-wrapper.sh` first, then falls back to the extension-bundled copy.

---

## Text Injection

**Command**: `send`

Sends text into any terminal's input stream. This is equivalent to a human typing — the text appears at whatever input cursor is active (shell prompt, TUI input field, REPL prompt).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `id` | string | required | Target terminal ID |
| `text` | string | required | Text to send |
| `newline` | boolean | `true` | Append Enter (newline) after the text |

**Single-line**: `{"cmd": "send", "id": "3", "text": "ls -la"}` — sends `ls -la\n` into the terminal.

**Raw keystrokes**: Set `newline: false` and send control characters directly:
- `\r` — Enter (carriage return, needed for some TUIs)
- `\x03` — Ctrl+C (interrupt)
- `\x04` — Ctrl+D (EOF)
- `\x1a` — Ctrl+Z (suspend)
- `\x1b` — Escape

**Sending to TUI sessions**: When the terminal is running Claude Code, vim, or any interactive program, `send` delivers text to that program's input handler. This is how AI orchestration works — you send a prompt as text into a Claude Code session, and Claude Code processes it as a user turn.

---

## Command Execution

**Command**: `exec`

Runs a shell command in a terminal and captures structured output. Unlike `send`, `exec` waits for the command to finish and returns the result.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `id` | string | auto-created | Target terminal ID |
| `command` | string | required | Shell command to run |
| `timeoutMs` | number | `claws.execTimeoutMs` (default `180000`) | Max wait time in milliseconds. Falls back to the hot-reloadable config value when omitted. |

**Returns**:
```json
{
  "ok": true,
  "terminalId": "3",
  "commandLine": "npm test",
  "output": "PASS src/utils.test.ts\nTests: 5 passed\n",
  "exitCode": 0
}
```

### How file-based capture works

Shell integration (`onDidEndTerminalShellExecution`) is unreliable in many terminal configurations. Claws uses a robust alternative:

1. Wraps your command: `{ your_command; } > /tmp/claws-exec/abc123.out 2>&1; echo $? > /tmp/claws-exec/abc123.done`
2. Sends the wrapped command via `send`
3. Polls for the `.done` marker file
4. Reads the output file and exit code
5. Cleans up both temp files

This works in **every terminal type** — wrapped, unwrapped, with or without shell integration, bash, zsh, fish.

### Auto-created exec terminal

If you call `exec` without specifying a terminal `id`, Claws automatically creates (or reuses) a terminal named `claws-work` for execution. This is the simplest path for scripts that just need to run commands.

### Timeout handling

If the command doesn't produce a `.done` file within `timeoutMs`, `exec` returns an error with whatever partial output was captured. The command itself keeps running in the terminal — Claws doesn't kill it.

---

## Pty Log Reading

**Command**: `readLog`

Reads a wrapped terminal's pty log file with optional ANSI stripping.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `id` | string | required | Terminal ID (must be wrapped) |
| `offset` | number | tail of file | Byte offset to start reading from |
| `limit` | number | `524288` | Max bytes to read (512KB) |
| `strip` | boolean | `true` | Strip ANSI escape sequences |

**Returns**:
```json
{
  "ok": true,
  "bytes": "$ npm test\nPASS src/utils.test.ts\nTests: 5 passed\n$ ",
  "offset": 4096,
  "nextOffset": 4350,
  "totalSize": 4350,
  "truncated": false,
  "logPath": "/project/.claws/terminals/claws-3.log"
}
```

### Incremental tailing

Use `offset` and `nextOffset` for efficient tailing without re-reading the entire file:

```python
cursor = 0
while True:
    resp = client._send({"cmd": "readLog", "id": term_id, "offset": cursor})
    if resp["nextOffset"] > cursor:
        print(resp["bytes"])  # new content
        cursor = resp["nextOffset"]
    time.sleep(1)
```

### ANSI stripping

When `strip: true` (default), Claws removes:
- CSI sequences: `\e[0m`, `\e[31;1m`, `\e[2J`, `\e[H`, etc.
- OSC sequences: `\e]0;title\a`, `\e]133;...`, etc.
- Control characters: `\x00`-`\x08`, `\x0b`-`\x1a`, `\x1c`-`\x1f`, `\x7f`

Set `strip: false` to get the raw pty output with all escape sequences intact — useful for terminal replay or debugging rendering issues.

### Errors

- `"terminal X is not wrapped (no log path)"` — you called readLog on an unwrapped terminal. Create it with `wrapped: true`.
- `"read failed: ..."` — file I/O error (permissions, disk full, etc.)

---

## Event Streaming

**Command**: `poll`

Returns shell-integration command-completion events since a cursor position.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `since` | number | `0` | Sequence cursor — return only events after this |

Each event contains:

| Field | Type | Description |
|---|---|---|
| `seq` | number | Monotonically increasing sequence number |
| `terminalId` | string | Which terminal this event came from |
| `terminalName` | string | Terminal display name at time of event |
| `commandLine` | string | The command that was executed |
| `output` | string | Captured stdout (up to `maxOutputBytes`) |
| `exitCode` | number | Process exit code |
| `startedAt` | number | Epoch ms when the command started |
| `endedAt` | number | Epoch ms when the command finished |

**Cursor-based pagination**: Save the `cursor` from each response and pass it as `since` in the next call. You'll only receive new events.

**Reliability note**: `poll` depends on VS Code's `onDidEndTerminalShellExecution` API, which requires shell integration to be active. It's unreliable in wrapped terminals (where shell integration often doesn't inject) and in TUI sessions. For those cases, use `readLog` instead.

**Ring buffer**: Claws stores the last `maxHistory` events (default 500). Older events are dropped. If you poll infrequently, you may miss events that were pushed out of the buffer.

**Response cap**: Each `poll` is also capped at `claws.pollLimit` (default 100). The response includes `limit` (the effective cap applied) and `truncated` (true when the pending queue exceeded it). Clients may pass their own `limit` on the request; it's clamped to `claws.pollLimit` as an upper bound.

---

## Introspection

**Command**: `introspect`

Returns a single structured snapshot of the extension + host. Both the `/claws-introspect` slash command and the in-UI `Claws: Health Check` command are powered by the same provider, so the data is identical across paths.

**Request**: `{"cmd": "introspect"}`

**Response**:
```json
{
  "ok": true,
  "protocol": "claws/1",
  "extensionVersion": "0.5.0",
  "nodeVersion": "v20.11.1",
  "electronAbi": 125,
  "platform": "darwin-arm64",
  "nodePty": {
    "loaded": true,
    "loadedFrom": "/absolute/path/to/extension/native/node-pty",
    "error": null
  },
  "servers": [
    { "workspace": "/absolute/path", "socket": "/absolute/path/.claws/claws.sock" }
  ],
  "terminals": 3,
  "uptime_ms": 1234567
}
```

- `nodePty.loaded = false` → pipe-mode fallback is active; wrapped terminals still work but without real PTY semantics (no resize signals, limited TUI compatibility).
- `servers` is an array: multi-root workspaces run one server per folder, each with its own socket.
- `uptime_ms` is since the server bound its socket, not since VS Code launched.

Call `introspect` as the first thing after connecting to verify compatibility and confirm `node-pty` loaded cleanly.

---

## Terminal Profile

Claws registers a terminal profile so "Claws Wrapped Terminal" appears in the VS Code terminal dropdown (the arrow next to `+`).

When selected:
1. Claws reserves a terminal ID and computes a log path
2. A new terminal opens with `scripts/terminal-wrapper.sh` as the shell
3. The `CLAWS_TERM_LOG` environment variable points to the log file
4. `onDidOpenTerminal` fires, Claws associates the terminal with the reserved ID

The profile name includes the ID: "Claws Wrapped 5". This is used for internal matching and can be renamed by the user after creation without affecting Claws.

---

## Safety Gate

Before `send` injects text, Claws inspects the terminal's process tree to detect the foreground process:

1. Reads the terminal's shell PID from VS Code's API
2. Runs `pgrep -P <pid>` to find child processes
3. Checks if the foreground child is a known shell (`bash`, `zsh`, `fish`, `sh`, `dash`, `ksh`)
4. If it's not a shell (e.g., `claude`, `vim`, `less`, `top`, `python3`), emits a warning

**Default behavior**: warn and proceed. The send goes through with a `[warning: foreground is 'vim' (not a shell)]` prefix in the response. The caller decides whether to continue.

**Strict mode**: Pass `strict: true` in the send request. Claws will refuse the send and return an error instead of a warning.

**Why warn instead of block**: The primary use case for Claws is AI pair programming, where you intentionally send prompts into Claude Code's TUI input. Blocking that would defeat the purpose. The warning exists to catch accidental sends (e.g., a script meant to run a shell command but the terminal is in vim).

---

## Bracketed Paste

When `send` receives multi-line text (contains `\n`), it automatically wraps it in bracketed paste mode:

```
\x1b[200~your multi-line text here\x1b[201~
```

This tells the terminal to treat the entire block as a single paste operation. Without it, each `\n` in the text would be interpreted as a separate Enter keystroke, causing the shell to execute each line independently — breaking multi-line commands, heredocs, and prompt text.

After the bracketed paste block, Claws sends a separate `\r` (carriage return) to submit the pasted content.

**Disable with `paste: false`** if you want raw line-by-line behavior.

---

## Command Palette

Every contributed command is grouped under the `Claws:` category in the command palette (`Cmd/Ctrl+Shift+P`).

| Command | ID | What it does |
|---|---|---|
| Show Status | `claws.status` | Writes a markdown-formatted runtime block to the `Claws` Output channel (socket list, runtime, version). |
| Refresh Status Bar | `claws.statusBar` | Manually refresh + re-show the status bar item (useful after a theme swap or focus cycle). |
| List Terminals | `claws.listTerminals` | Opens a QuickPick with every Claws-known terminal (`id · name · wrapped/unwrapped · pid`). Selecting an item calls `terminal.show()`. |
| Health Check | `claws.healthCheck` | Renders a full introspection snapshot — extension version, Node / Electron ABI, platform, node-pty state, active sockets, MCP server version, uptime — to the Output channel. |
| Show Log | `claws.showLog` | Focuses the `Claws` Output channel. |
| Rebuild Native PTY | `claws.rebuildPty` | Runs `@electron/rebuild` against the bundled `node-pty`. Use after a VS Code major upgrade if pipe-mode fallback kicks in. |
| Uninstall Cleanup | `claws.uninstallCleanup` | Opt-in — scans workspace folders, inventories Claws-installed files, asks per folder, removes only what was installed. See below. |

All seven commands are also registered as activation events, so invoking any of them from a cold start activates the extension before executing.

---

## Keybindings

Chord bindings (`ctrl+alt+c` prefix on Windows/Linux, `cmd+alt+c` on macOS) for the three most-used diagnostic commands:

| Binding | Command |
|---|---|
| `cmd+alt+c h` / `ctrl+alt+c h` | Claws: Health Check |
| `cmd+alt+c l` / `ctrl+alt+c l` | Claws: Show Log |
| `cmd+alt+c s` / `ctrl+alt+c s` | Claws: Show Status |

Conflicts with other extensions surface in `Keyboard Shortcuts` (`Cmd/Ctrl+K Cmd/Ctrl+S`). The extension remains fully functional if you rebind or remove them.

---

## Status Bar Item

Right-aligned, priority 100. Shows `$(terminal) Claws (N)` where `N` is the live terminal count.

- **Tooltip**: Markdown-rendered block listing every active socket, node-pty load state, and extension version. Hovering for ~500ms reveals it.
- **Click**: runs `Claws: Health Check`.
- **Color**: default theme color when healthy; warning-yellow (`statusBarItem.warningBackground`) in pipe-mode fallback; error-red (`statusBarItem.errorBackground`) when no server is running.
- **Refresh cadence**: 30s interval (unref'd — never blocks shutdown). Manual refresh via `claws.statusBar`.

To hide: right-click the status bar and uncheck "Claws".

---

## Uninstall Cleanup

`claws.uninstallCleanup` is an opt-in, reversible-by-git, destructive-outside-git command that removes Claws's per-project footprint from one or more workspace folders.

**What it scans for**, per folder:
- `.mcp.json` — the `claws` entry only (other MCP entries are left untouched; file deleted only if that was the only entry)
- `.claws-bin/` — vendored MCP server + shell hook
- `.claude/commands/claws-*.md` — the 19 slash command files
- `.claude/rules/claws-default-behavior.md`
- `.claude/skills/claws-orchestration-engine/` + `.claude/skills/claws-prompt-templates/`
- `.vscode/extensions.json` — removes `neunaha.claws` from `recommendations` only
- `CLAUDE.md` — removes just the fenced `<!-- CLAWS:BEGIN --> … <!-- CLAWS:END -->` block

**Flow**:
1. Inventories everything that's actually present.
2. Prompts with a modal per folder listing exactly what will be removed.
3. On confirm, deletes only what was inventoried — never reaches outside the scanned set.
4. Writes a summary to the `Claws` Output channel.

Machine-wide artifacts (`~/.claws-src/`, the extension symlink, the shell-hook line in your `rc` file) are **not** touched. Remove those manually as documented in the README's "Uninstall" section.

---

## Configuration Reference

All settings live under the `claws` namespace in VS Code's settings (`settings.json`).

### `claws.socketPath`
- **Type**: string
- **Default**: `.claws/claws.sock`
- **Description**: Path to the Unix domain socket, relative to the workspace root. Claws creates the parent directory if it doesn't exist. The socket is created with `chmod 600` (owner-only access).

### `claws.logDirectory`
- **Type**: string
- **Default**: `.claws/terminals`
- **Description**: Directory where wrapped terminal pty logs are stored. Each terminal gets its own file: `claws-<id>.log`. Add `.claws/` to your `.gitignore`.

### `claws.defaultWrapped`
- **Type**: boolean
- **Default**: `false`
- **Description**: When `true`, every terminal created via the Claws API (not via VS Code's `+` button) is automatically wrapped with pty logging. Useful for AI orchestration setups where you always want readable terminals.

### `claws.maxOutputBytes`
- **Type**: number
- **Default**: `262144` (256KB)
- **Description**: Maximum bytes of stdout captured per shell-integration command event. Larger outputs are truncated with a `[...truncated N bytes]` note. Does not affect `readLog` (which has its own `MAX_READLOG_BYTES` of 512KB).

### `claws.maxHistory`
- **Type**: number
- **Default**: `500`
- **Description**: Maximum number of command-completion events retained in the ring buffer for `poll`. Older events are dropped FIFO. Increase if you poll infrequently and don't want to miss events.

### `claws.maxCaptureBytes`
- **Type**: number
- **Default**: `1048576` (1 MB)
- **Description**: Per-terminal in-memory capture buffer for Pseudoterminal-backed wrapped terminals. `readLog` serves from this ring buffer. Bytes beyond the cap are dropped FIFO. Hot-reloadable.

### `claws.execTimeoutMs`
- **Type**: number
- **Default**: `180000` (180 s)
- **Description**: Default wall-clock timeout for an `exec` request before the server rejects with `exec timeout after Xms`. Individual requests may override via `timeoutMs` in the payload. Hot-reloadable — edits to `settings.json` take effect on the next request, no reload needed.

### `claws.pollLimit`
- **Type**: number
- **Default**: `100`
- **Description**: Maximum number of history events returned by a single `poll` request. Client-requested `limit` is clamped to this. Responses exceeding the cap return the tail slice with `truncated: true`. Hot-reloadable.

### `claws.enableWebSocket`
- **Type**: boolean
- **Default**: `false`
- **Description**: [Planned — v0.6] Enable a WebSocket server alongside the Unix socket for cross-device access. Currently a no-op.

### `claws.webSocketPort`
- **Type**: number
- **Default**: `9876`
- **Description**: [Planned — v0.6] Port for the WebSocket server. Honored only when `claws.enableWebSocket` is true.

---

## Socket Server Internals

### Lifecycle

1. **Activation**: Claws activates on `onStartupFinished`. It reads the workspace root, constructs the socket path, creates the directory, and starts a `net.createServer` listener.
2. **Connection**: Each client gets its own socket connection. Multiple clients can connect simultaneously. Requests are handled independently.
3. **Protocol**: Newline-delimited JSON. Each `\n`-terminated line is parsed as a JSON request, handled asynchronously, and the response is written back as a `\n`-terminated JSON line.
4. **Deactivation**: On VS Code shutdown or extension deactivation, the server is closed and the socket file is unlinked.

### Error handling

- Malformed JSON → `{"ok": false, "error": "bad json"}`
- Unknown command → `{"ok": false, "error": "unknown cmd: X"}`
- Missing terminal → `{"ok": false, "error": "unknown terminal id X"}`
- Handler exceptions → `{"ok": false, "error": "Error message"}`

### Security

- Socket created with `chmod 600` — only the current user can connect
- No authentication on Unix socket (same-user access is the trust boundary)
- WebSocket transport (planned) will add token-based auth + TLS

---

## Cross-Device Control

**Status**: Planned for v0.3

### Current workaround — SSH tunnel

You can control a remote VS Code instance today using an SSH tunnel:

```bash
# On your local machine:
ssh -L 9999:/remote/workspace/.claws/claws.sock user@remote-host

# Then connect locally:
from claws import ClawsClient
client = ClawsClient("/tmp/claws-remote.sock")  # forwarded socket
```

### Planned architecture

```
Device A (controller)           Device B (workspace)
┌──────────────┐               ┌──────────────────┐
│ Python/Node  │◄── WebSocket ─►│ Claws Extension  │
│ client       │    + TLS       │ (VS Code)        │
└──────────────┘    + token     └──────────────────┘
```

- **WebSocket transport**: opt-in alongside Unix socket
- **Token auth**: generated per-session, shown in the Claws output panel
- **TLS**: self-signed or ACME for encrypted connections
- **mDNS discovery**: auto-discover Claws-enabled VS Code instances on your LAN
- **Team config**: named devices with per-terminal read/write access control
