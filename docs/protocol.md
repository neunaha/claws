# Claws Protocol Specification v1

## Transport

- **Unix socket** (default): workspace-relative path, default `.claws/claws.sock`. Multi-root workspaces get one socket per folder.
- **WebSocket** (planned, v0.6): `ws://host:port` with token auth.

## Framing

Newline-delimited JSON. Each message is one JSON object terminated by `\n`. Client sends requests; server sends responses.

## Requests

```json
{ "id": 1, "cmd": "list" }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | number \| string | yes | Echoed back by the server. Clients use it to correlate responses. |
| `cmd` | string | yes | Command name (see below). |
| `protocol` | string | no | Must be `"claws/1"` if present. Absent = treated as `claws/1`. Any other value → rejected with `ok:false, error:"incompatible protocol version"`. |
| `clientName` | string | no | Optional client label (e.g. `"claws-mcp"`) for server-side logging. |
| `clientVersion` | string | no | SemVer string. If present, the server compares against its own extension version and logs a one-shot drift warning at ≥ 1 minor release behind. |

## Responses

Every response includes the following envelope fields:

| Field | Type | Always present | Description |
|---|---|---|---|
| `ok` | boolean | yes | `true` on success, `false` on error. |
| `id` | number \| string | yes | The request's `id`, echoed for legacy clients. |
| `rid` | number \| string | yes | The request's `id`, guaranteed un-shadowed by body fields. **New clients should read `rid`, not `id`** — some command responses put their own `id` field in the body (e.g. `create` returns a new terminal id). |
| `protocol` | string | yes | Always `"claws/1"`. |
| `error` | string | on error only | Human-readable description. |

On error:

```json
{ "id": 1, "rid": 1, "ok": false, "protocol": "claws/1", "error": "unknown cmd: xyz" }
```

---

## Commands

### `list`

Enumerate all open VS Code terminals.

**Request:** `{ "id": N, "cmd": "list" }`

**Response:**
```json
{
  "id": N, "rid": N, "protocol": "claws/1", "ok": true,
  "terminals": [
    {
      "id": "1",
      "name": "Terminal Name",
      "pid": 12345,
      "hasShellIntegration": true,
      "active": false,
      "logPath": "/absolute/path/to/pty.log"
    }
  ]
}
```

### `create`

Open a new terminal.

**Request:**
```json
{
  "id": N,
  "cmd": "create",
  "name": "my-terminal",       // optional, default "claws"
  "cwd": "/path/to/dir",       // optional, default workspace root
  "wrapped": true,              // optional, default false — Pseudoterminal with in-memory capture
  "show": true                  // optional, default true
}
```

**Response:**
```json
{
  "id": N, "rid": N, "protocol": "claws/1", "ok": true,
  "id": "5",                    // NEW terminal id — prefer reading `rid` for the request correlation
  "wrapped": true,
  "logPath": null               // always null for Pseudoterminal-backed wrapped terminals (buffer is in-memory)
}
```

### `show`

Focus a terminal in the panel.

**Request:** `{ "id": N, "cmd": "show", "id": "5", "preserveFocus": true }`

**Response:** `{ "id": N, "rid": N, "protocol": "claws/1", "ok": true }`

### `send`

Send text into a terminal. Automatically wraps multi-line text in bracketed paste.

**Request:**
```json
{
  "id": N,
  "cmd": "send",
  "id": "5",
  "text": "echo hello",
  "newline": true,   // optional, default true — append Enter after text
  "paste": false     // optional — force bracketed paste off
}
```

**Response:**
```json
{ "id": N, "rid": N, "protocol": "claws/1", "ok": true, "mode": "wrapped" }
```

`mode` is `"wrapped"` if the send went through the Pseudoterminal write path (byte-accurate) or `"unwrapped"` if it went through VS Code's `terminal.sendText` API (user-visible text substitution possible).

### `exec`

Run a shell command and wait for completion. Uses VS Code shell integration when available; falls back to a "degraded" mode when not.

**Request:**
```json
{
  "id": N,
  "cmd": "exec",
  "id": "5",
  "command": "npm test",
  "timeoutMs": 120000    // optional — falls back to claws.execTimeoutMs (default 180000)
}
```

**Response (integration available):**
```json
{
  "id": N, "rid": N, "protocol": "claws/1", "ok": true,
  "event": {
    "seq": 42, "terminalId": "5", "terminalName": "worker",
    "commandLine": "npm test", "output": "PASS ...", "exitCode": 0,
    "startedAt": 1713168000000, "endedAt": 1713168001000
  }
}
```

**Response (no shell integration):**
```json
{
  "id": N, "rid": N, "protocol": "claws/1", "ok": true,
  "degraded": true,
  "note": "no shell integration active; output not captured via exec — use readLog on wrapped terminals"
}
```

### `readLog`

Read a wrapped terminal's capture buffer with optional ANSI stripping.

**Request:**
```json
{
  "id": N,
  "cmd": "readLog",
  "id": "5",
  "offset": 0,
  "limit": 524288,
  "strip": true
}
```

**Response:**
```json
{
  "id": N, "rid": N, "protocol": "claws/1", "ok": true,
  "bytes": "cleaned text content...",
  "offset": 0,
  "nextOffset": 1234,
  "totalSize": 5678,
  "truncated": false,
  "logPath": null
}
```

### `poll`

Drain shell-integration command-completion events since a cursor.

**Request:** `{ "id": N, "cmd": "poll", "since": 0, "limit": 50 }`

**Response:**
```json
{
  "id": N, "rid": N, "protocol": "claws/1", "ok": true,
  "events": [ /* HistoryEvent[] */ ],
  "cursor": 42,
  "limit": 50,
  "truncated": false
}
```

- `limit` — effective cap applied to this response. Client-requested `limit` is an upper bound; the server additionally clamps to `claws.pollLimit` (default 100).
- `truncated` — `true` when more events matched `since` than the limit allowed; you're reading the tail slice.

Note: `poll` relies on VS Code shell integration (`onDidEndTerminalShellExecution`), which is unreliable in wrapped terminals and TUI sessions. For reliable output capture, use `readLog` on wrapped terminals.

### `close`

Dispose a terminal. Idempotent — closing an already-closed or never-known id is not an error.

**Request:** `{ "id": N, "cmd": "close", "id": "5" }`

**Response:** `{ "id": N, "rid": N, "protocol": "claws/1", "ok": true, "alreadyClosed": false }`

When the id was unknown (already closed, never created, or race with auto-cleanup):

```json
{ "id": N, "rid": N, "protocol": "claws/1", "ok": true, "alreadyClosed": true }
```

Clients don't need local bookkeeping to avoid racing their cleanup with the extension's.

### `introspect`

Return a structured snapshot of extension + host state. Powers both the `/claws-introspect` slash command and the in-UI `Claws: Health Check` command — both paths render identical data.

**Request:** `{ "id": N, "cmd": "introspect" }`

**Response:**
```json
{
  "id": N, "rid": N, "ok": true, "protocol": "claws/1",
  "extensionVersion": "0.5.0",
  "nodeVersion": "v20.11.1",
  "electronAbi": 125,
  "platform": "darwin-arm64",
  "nodePty": {
    "loaded": true,
    "loadedFrom": "/path/to/extension/native/node-pty",
    "error": null
  },
  "servers": [
    { "workspace": "/absolute/workspace/path", "socket": "/absolute/workspace/path/.claws/claws.sock" }
  ],
  "terminals": 3,
  "uptime_ms": 1234567
}
```

- `nodePty.loaded = false` indicates pipe-mode fallback is active — the status bar goes warning-yellow.
- `servers` is an array because multi-root workspaces run one server per folder.

---

## Error Codes

All errors return `{ "ok": false, "error": "message" }`. Common errors:

| Error | Meaning |
|---|---|
| `unknown terminal id X` | Terminal ID not found (closed or never existed). Most commands return this on unknown id; `close` returns `ok:true, alreadyClosed:true` instead. |
| `terminal X is not wrapped (no log available)` | `readLog` called on an unwrapped terminal |
| `bad json` | Request could not be parsed as JSON |
| `unknown cmd: X` | Unrecognized command name |
| `incompatible protocol version (server: claws/1, client: …)` | Request's `protocol` field is not `"claws/1"` |
| `request too large` | A single request exceeded 1 MB — the connection is dropped |

---

## Versioning

Protocol version is exchanged in-band via the optional `protocol` field on every request (absent = `claws/1`). Every response carries the server's `protocol` string so clients can detect server-side upgrades.

For richer server metadata (extension version, node-pty state, socket list, uptime), call `introspect` after connecting.
