# Claws MCP — Disconnection Investigation: Findings & Suggested Fixes

**Date**: 2026-04-25  
**Method**: MCP spec research (live web fetch) + line-by-line code audit of `mcp_server.js`  
**Symptom**: Claude Code disconnects from the Claws MCP server before any tool executes  

---

## Part 1 — MCP Protocol: What the Spec Actually Says

### 1.1 Transport & Framing

**Source**: [modelcontextprotocol.io/specification/2025-11-25/basic/transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

The stdio MCP transport uses **Content-Length framing** (same as LSP — Language Server Protocol). Each message is:

```
Content-Length: <byte-length>\r\n
\r\n
<JSON body>
```

- `Content-Length` is the **UTF-8 byte count** of the JSON body, not the character count.
- The separator is `\r\n\r\n` (two CRLFs — one ending the header, one blank line).
- The JSON body itself may contain any UTF-8 characters.
- `stdout` **MUST** contain only valid MCP frames. Any other bytes (banners, debug text, warnings) break parsing.
- All logging **MUST** go to `stderr`.

### 1.2 Initialization Handshake — Exact Sequence

**Source**: [modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

Three steps are mandatory, in order:

**Step 1** — Client sends `initialize` request:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {},
    "clientInfo": { "name": "Claude Code", "version": "..." }
  }
}
```

**Step 2** — Server must respond with `initialize` result:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "claws", "version": "0.5.3" }
  }
}
```

**Step 3** — Client sends `notifications/initialized` notification (no `id`, no response expected):
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

The spec states:
> "After successful initialization, the client **MUST** send an `initialized` notification to indicate it is ready to begin normal operations."

Only after Step 3 is the connection considered live.

### 1.3 Protocol Version Negotiation

**Source**: [modelcontextprotocol.io/specification/versioning](https://modelcontextprotocol.io/specification/versioning)

Version strings are date-based (`YYYY-MM-DD`). History:

| Version String | Release |
|---|---|
| `2024-11-05` | November 2024 (original) |
| `2025-03-26` | March 2025 |
| `2025-06-18` | June 2025 |
| `2025-11-25` | November 2025 (current) |

Negotiation rule (from spec):
> "If the server supports the requested protocol version, it **MUST** respond with the **same** version. Otherwise, it **MUST** respond with another version it supports. If the client does not support the version in the response, it **SHOULD** disconnect."

Claude Code currently sends `protocolVersion: "2025-11-25"` in its `initialize` request. If the server responds with `"2024-11-05"`, Claude Code **may** disconnect if it no longer supports that older version.

### 1.4 The `capabilities` Field

**Source**: [modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

In the `initialize` response, three fields are **required**:

| Field | Required | Notes |
|---|---|---|
| `protocolVersion` | Yes | Must match client's requested version if supported |
| `capabilities` | Yes | Empty object `{}` is valid; omitting the field entirely is not |
| `serverInfo` | Yes | Must have `name` (string); `version` is optional |

Within `capabilities`, all sub-keys are optional. Declaring a capability you don't implement is harmless per spec — clients ignore unknown entries. Declaring `experimental: { 'claude/channel': {} }` is non-standard; Claude Code silently discards it.

### 1.5 Stdout Cleanliness Rule

**Source**: MCP spec + confirmed via community bug reports

> "The server **MUST NOT** write anything to its `stdout` that is not a valid MCP message."

Real-world failure pattern: a server writes a startup banner or warning to stdout before the first JSON frame. Claude Code's Content-Length parser reads `WARNING: ...` as a header, fails to find `Content-Length`, and either stalls or disconnects. Every byte on stdout must be part of a valid framed message.

### 1.6 Ping / Keep-Alive

**Source**: [modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping)

Ping is **optional**. Neither party is required to send it. The spec says:
> "Either party can send a ping request to verify the connection is alive."

For stdio transport there is no timeout mechanism built into the protocol. The process lifecycle (stdin EOF, process exit) is the connection lifecycle. Keep-alive is not required and is not a source of disconnections.

### 1.7 How Other Companies Implement MCP Servers

All major MCP server implementations use the official TypeScript/Python SDK from Anthropic. The SDK handles framing, initialization, and capability negotiation internally. Notable patterns observed across implementations:

| Pattern | Who | Detail |
|---|---|---|
| Official SDK (`@modelcontextprotocol/sdk`) | Anthropic reference servers, most third-party | Handles Content-Length framing, version negotiation, and lifecycle automatically |
| Zero-dependency raw Node.js (like `mcp_server.js`) | Advanced/embedded use | Must implement framing manually — high risk of bugs |
| Python SDK (`mcp` package) | Data science, scripting | Same protocol, different language |
| Protocol version echoing | All compliant servers | Server echoes back exactly the version the client sent |
| `notifications/initialized` handling | All compliant servers | Accepted silently — no response sent |
| Stderr-only logging | All compliant servers | stdout is reserved for JSON frames |

The Claws `mcp_server.js` is a hand-rolled zero-dependency implementation. This gives control but requires getting every detail of the protocol correct manually.

---

## Part 2 — Code Audit: `mcp_server.js`

Audited commit: current file as of 2026-04-25. Line numbers refer to the file after the Windows porting changes (no functional changes to MCP logic were made in that pass).

### Finding A — CRITICAL: String accumulator sliced by byte count

**Lines**: 33, 45–47

```javascript
let inputBuf = '';   // line 33 — string accumulator

// Inside readMessage():
const len = parseInt(match[1], 10);   // byte count from Content-Length header
const bodyStart = headerEnd + 4;
if (inputBuf.length < bodyStart + len) return false;  // ← length = chars, not bytes
const body = inputBuf.slice(bodyStart, bodyStart + len); // ← slices by chars
```

**The bug**: `Content-Length` is a UTF-8 **byte** count. `inputBuf` is a JavaScript string. `String.prototype.length` and `String.prototype.slice` count **UTF-16 code units** (characters), not bytes. For pure ASCII content (all code points ≤ 127), one char = one byte so the bug is invisible. The moment Claude Code sends a message body containing any non-ASCII character — a Unicode filename, an emoji in a mission prompt, a smart quote — `len` is larger than `inputBuf.length` would suggest, the body is mis-sliced, and `JSON.parse` throws.

**What happens**: The `JSON.parse` call on line 48 is inside a `Promise` constructor. A synchronous throw inside a `Promise` constructor becomes a rejected promise. The `await readMessage()` in `main()` propagates this rejection, which `main().catch(console.error)` catches — printing a stack trace to stderr and **terminating the process**. Claude Code observes unexpected EOF on the child's stdout and reports a disconnect.

**Why it doesn't fail on every connection**: Tool names, IDs, and most simple arguments are ASCII-only. The bug only triggers when non-ASCII bytes appear in the JSON body — typically in tool arguments (file paths, mission text, user-written content). This explains why the server can connect and even pass the initialization handshake successfully, but later disconnects mid-use or on first complex tool call.

### Finding B — MEDIUM: `JSON.parse` throws synchronously inside Promise constructor instead of sending a parse error

**Line**: 48

```javascript
const tryParse = () => {
  // ...
  resolve(JSON.parse(body));  // ← can throw synchronously
  return true;
};
```

When `JSON.parse` fails (for any reason — Finding A, truncated frame, framing bug), the error propagates as an unhandled rejection that kills the process. The correct behavior per JSON-RPC spec is to send a response with error code `-32700 Parse error` and continue. The process should never die from a bad incoming frame.

### Finding C — MEDIUM: Protocol version mismatch

**Line**: 826

```javascript
respond(id, {
  protocolVersion: '2024-11-05',   // ← hardcoded old version
  serverInfo: { name: 'claws', version: '0.5.3' },
  capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
});
```

The server always responds with `2024-11-05`. Claude Code currently sends `2025-11-25` in the `initialize` request. Per the spec, the server **must** respond with the same version if it supports it, or a version it does support. Claude Code may be checking that the version it gets back matches what it sent. If Claude Code has dropped support for `2024-11-05` (likely, given it was November 2024 — over a year ago), it will disconnect immediately after receiving the initialize response.

**This is the most likely cause of disconnect before any tool executes**, because it happens in the first round-trip, before `tools/list` or `tools/call` is ever sent.

### Finding D — LOW: `notifications/initialized` is handled correctly

**Lines**: 830–831

```javascript
} else if (method === 'notifications/initialized') {
  // no response needed
```

This is correct. `notifications/initialized` has no `id` so no response must be sent. The handler correctly accepts and discards it. No issue.

### Finding E — LOW: Unknown `experimental: { 'claude/channel': {} }` capability + unsolicited notifications

**Lines**: 137–144, 828

The server declares `experimental: { 'claude/channel': {} }` and sends unsolicited `notifications/claude/channel` frames when the extension pushes pub/sub events. Claude Code does not know about this capability. Per the MCP spec, clients ignore unknown capability keys, so the declaration itself is harmless. However, the unsolicited notification frames may confuse Claude Code's message loop if it does not expect server-initiated notifications in this form. The feature does not work — Claude Code discards these frames silently.

### Finding F — LOW: stdin `end` event never resolves `readMessage()`

**Lines**: 36, 52–56

If Claude Code closes its stdin (process shutdown, disconnection), the Promise returned by `readMessage()` hangs forever — it is waiting for a `data` event that will never come. The main loop never reaches `if (!msg) break`. In practice the parent process kills the child immediately after closing stdin, so this is never observed. Still a correctness gap.

### Finding G — LOW: No stdout flush before `process.exit(0)` in signal handler

**Line**: 852

```javascript
function shutdown() {
  process.stderr.write('[claws-mcp] shutting down\n');
  if (_v2Socket && !_v2Socket.destroyed) _v2Socket.destroy();
  process.exit(0);
}
```

`process.exit()` does not wait for stdout to drain. Any in-flight `writeMessage()` call can be cut off mid-frame. In practice signals arrive between event loop ticks (not mid-write), making this extremely unlikely to cause a problem. Noted for completeness.

### Audit Summary

| ID | Lines | Severity | Summary |
|---|---|---|---|
| A | 33, 45–47 | **Critical** | String accumulator sliced by byte count — mis-slices multi-byte UTF-8, kills process |
| B | 48 | **Medium** | `JSON.parse` in Promise constructor — bad frame kills process instead of sending `-32700` |
| C | 826 | **Medium** | Protocol version hardcoded `2024-11-05` — Claude Code expects `2025-11-25`, may disconnect immediately |
| D | 830–831 | None | `notifications/initialized` — handled correctly |
| E | 137–144, 828 | Low | Unsolicited `claude/channel` frames — discarded by Claude Code, feature non-functional |
| F | 36, 52–56 | Low | stdin `end` never resolves readMessage — main loop hangs instead of exiting cleanly |
| G | 852 | Low | No stdout flush on SIGINT/SIGTERM — mid-frame truncation theoretically possible |

---

## Part 3 — Root Cause of the Disconnection

Based on the audit, there are two probable causes that each independently reproduce "disconnects before executing anything":

### Root Cause 1 (Most Likely): Protocol version mismatch

Claude Code sends `protocolVersion: "2025-11-25"` in `initialize`. The server responds with `"2024-11-05"`. If Claude Code treats version mismatch as fatal — which the spec says it **should** — it disconnects immediately after the initialize response, before `tools/list` is ever called. The user sees the server appear and then immediately drop.

This is the most likely culprit for "disconnects before even thinking of executing something" because it happens in the very first exchange, 100% of the time, regardless of what content the user sends.

### Root Cause 2 (Triggered on first non-ASCII input): UTF-8 slicing bug

Once connected, the first tool call containing any non-ASCII character in its arguments kills the process. This explains intermittent disconnects that seem tied to specific inputs rather than every connection.

---

## Part 4 — Suggested Changes

These are suggestions only. No files have been changed in this pass.

### Suggested Change 1 — Fix: Protocol version (addresses Root Cause 1)

**File**: `mcp_server.js`, line 826

The server must echo back the protocol version the client requested, provided the server supports it. Claude Code sends the current spec version. The server should respond with the same version.

**Current**:
```javascript
respond(id, {
  protocolVersion: '2024-11-05',
  serverInfo: { name: 'claws', version: '0.5.3' },
  capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
});
```

**Suggested**:
```javascript
const requestedVersion = (params.protocolVersion) || '2024-11-05';
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const negotiatedVersion = SUPPORTED_VERSIONS.includes(requestedVersion)
  ? requestedVersion
  : '2024-11-05';
respond(id, {
  protocolVersion: negotiatedVersion,
  serverInfo: { name: 'claws', version: '0.5.3' },
  capabilities: { tools: {} },
});
```

**Why remove `experimental: { 'claude/channel': {} }`**: The capability is non-standard and the feature (pushing pub/sub events to Claude Code as channel notifications) does not work — Claude Code discards the frames. Declaring it causes no harm but is misleading. Remove it until the feature is properly implemented.

---

### Suggested Change 2 — Fix: UTF-8 safe frame reader (addresses Root Cause 2, Finding A & B)

**File**: `mcp_server.js`, lines 33–57

Replace the string accumulator with a `Buffer` accumulator. Use `Buffer.byteLength` for length comparisons and `Buffer.slice` for body extraction. Wrap `JSON.parse` in a `try/catch` that sends a proper `-32700` error instead of killing the process.

**Current `readMessage()` (abbreviated)**:
```javascript
let inputBuf = '';   // string accumulator

function readMessage() {
  return new Promise((resolve) => {
    const tryParse = () => {
      const headerEnd = inputBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return false;
      const match = inputBuf.slice(0, headerEnd).match(/content-length:\s*(\d+)/i);
      if (!match) return false;
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (inputBuf.length < bodyStart + len) return false;  // ← char count vs byte count
      const body = inputBuf.slice(bodyStart, bodyStart + len);  // ← char slice
      inputBuf = inputBuf.slice(bodyStart + len);
      resolve(JSON.parse(body));  // ← throws synchronously on bad JSON
      return true;
    };
    // ...
  });
}
```

**Suggested `readMessage()` replacement**:
```javascript
let inputBuf = Buffer.alloc(0);  // Buffer accumulator — counts bytes, not chars

function readMessage() {
  return new Promise((resolve, reject) => {
    const tryParse = () => {
      // Find \r\n\r\n in bytes
      const headerEnd = inputBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return false;
      const headerStr = inputBuf.slice(0, headerEnd).toString('ascii');
      const match = headerStr.match(/content-length:\s*(\d+)/i);
      if (!match) return false;
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (inputBuf.length < bodyStart + len) return false;  // ← byte comparison, correct
      const bodyBuf = inputBuf.slice(bodyStart, bodyStart + len);  // ← byte slice, correct
      inputBuf = inputBuf.slice(bodyStart + len);
      let parsed;
      try {
        parsed = JSON.parse(bodyBuf.toString('utf8'));  // ← wrapped, won't throw uncaught
      } catch (e) {
        // Bad JSON — reject so main() can send a -32700 error and continue
        reject(Object.assign(e, { _parseError: true }));
        return true;
      }
      resolve(parsed);
      return true;
    };
    if (tryParse()) return;
    const onData = (chunk) => {
      inputBuf = Buffer.concat([inputBuf, chunk]);  // ← concat Buffers
      if (tryParse()) process.stdin.removeListener('data', onData);
    };
    process.stdin.on('data', onData);
  });
}
```

And in `main()`, handle the `_parseError` case:
```javascript
while (true) {
  let msg;
  try {
    msg = await readMessage();
  } catch (e) {
    if (e._parseError) {
      // Send JSON-RPC parse error — do NOT kill the process
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    throw e;  // real error — propagate
  }
  if (!msg) break;
  // ... rest of dispatch
}
```

---

### Suggested Change 3 — Fix: stdin `end` causes clean exit (Finding F)

**File**: `mcp_server.js`, inside `readMessage()`

Add an `'end'` listener that resolves with `null` so `main()`'s `if (!msg) break` can fire:

```javascript
const onEnd = () => {
  process.stdin.removeListener('data', onData);
  resolve(null);
};
process.stdin.once('end', onEnd);

const onData = (chunk) => {
  inputBuf = Buffer.concat([inputBuf, chunk]);
  if (tryParse()) {
    process.stdin.removeListener('end', onEnd);
    process.stdin.removeListener('data', onData);
  }
};
```

---

### Suggested Change 4 — Informational: `experimental: { 'claude/channel': {} }` and channel notifications

**File**: `mcp_server.js`, lines 137–144 and line 828

The unsolicited `notifications/claude/channel` frames (sent when the extension pushes pub/sub events) are not part of the MCP spec and do not reach the user. Two options:

- **Option A (minimal)**: Remove the capability declaration and the `writeMessage` call at line 137–144. Clean up the dead code.
- **Option B (proper)**: Implement proper MCP [server-sent notifications](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging) via the `notifications/message` method with `level: 'info'`, which Claude Code does understand.

---

## Part 5 — Priority Order

| Priority | Change | Addresses | Expected Impact |
|---|---|---|---|
| 1 | Protocol version negotiation (Change 1) | Root Cause 1 | Fixes disconnect before any tool runs — most urgent |
| 2 | Buffer-based frame reader (Change 2) | Root Cause 2, Findings A & B | Fixes disconnect on non-ASCII input + makes server resilient to bad frames |
| 3 | stdin `end` clean exit (Change 3) | Finding F | Clean shutdown — no user-visible impact but correct |
| 4 | Remove `claude/channel` (Change 4 Option A) | Finding E | Removes dead/misleading code — no user-visible impact |

Change 1 alone should stop the "disconnects before executing" symptom. Change 2 should be implemented alongside it since it's the next most dangerous bug and would cause intermittent disconnects once Change 1 is in place.

---

## Part 6 — Sources

| Claim | Source |
|---|---|
| MCP stdio uses Content-Length framing | [modelcontextprotocol.io/specification/2025-11-25/basic/transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) |
| Initialization 3-step lifecycle | [modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) |
| Protocol version format and negotiation rules | [modelcontextprotocol.io/specification/versioning](https://modelcontextprotocol.io/specification/versioning) |
| `capabilities` field requirements | [modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) |
| stdout must contain only valid frames | [modelcontextprotocol.io/specification/2025-11-25/basic/transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) |
| Ping is optional, no mandatory keep-alive | [modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping) |
| Claude Code disconnects immediately (GitHub issue) | [github.com/anthropics/claude-code/issues/36818](https://github.com/anthropics/claude-code/issues/36818) |
| Missing `notifications/initialized` (GitHub issue) | [github.com/anthropics/claude-code/issues/1604](https://github.com/anthropics/claude-code/issues/1604) |
| Community server implementation patterns | [github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) |
| stdout corruption causing disconnect (community) | [github.com/MemPalace/mempalace/issues/225](https://github.com/MemPalace/mempalace/issues/225) |
