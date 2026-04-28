---
description: Send a reverse-channel command from orchestrator to workers via claws_broadcast with inject=true. Use to deliver [CLAWS_CMD r=<id>] approve/reject/abort/pause/resume responses into worker terminals.
---

# /claws-broadcast

Fan-out a text message to all peers of a given role via the Claws pub/sub bus, optionally injecting it directly into each worker's pty so Claude Code receives it as conversation input.

## Grammar (BNF)

```
broadcast-call  ::= claws_broadcast(text=<header-line>, targetRole=<role>, inject=<bool>)
header-line     ::= "[CLAWS_CMD r=" request-id "] " action ": " json-payload
request-id      ::= string   ; value of request_id from the worker's BLOCKED/REQUEST event
action          ::= "approve_request" | "reject_request" | "abort" | "pause" | "resume"
json-payload    ::= "{" … "}"
```

## Standard actions

| Action | `cmd.*` schema | When to use |
|---|---|---|
| `approve_request` | `cmd-approve-v1` | Unblock a worker paused at a REQUEST or BLOCKED event |
| `reject_request` | `cmd-reject-v1` | Deny the worker's request; worker should stop or use fallback |
| `abort` | `cmd-abort-v1` | Stop the worker immediately; do not continue current task |
| `pause` | `cmd-pause-v1` | Suspend the worker at the next safe checkpoint |
| `resume` | `cmd-resume-v1` | Resume a paused worker |

## Call pattern

```javascript
// Fan-out approve to all workers (broadcast — all workers receive it)
claws_broadcast(
  text="[CLAWS_CMD r=<request_id>] approve_request: {\"approved\":true,\"reason\":\"looks good\"}",
  targetRole="worker",
  inject=true
)

// Fan-out abort to all observers
claws_broadcast(
  text="[CLAWS_CMD r=<request_id>] abort: {\"reason\":\"mission cancelled\"}",
  targetRole="observer",
  inject=true
)
```

## Fan-out vs unicast

| Pattern | Primitive | Use when |
|---|---|---|
| **All workers** (fan-out) | `claws_broadcast(inject=true)` | One CMD for all workers simultaneously |
| **Single worker** (unicast) | `task.assign deliver=inject` | Target a specific peerId; avoids accidental delivery |

Use `task.assign deliver=inject` when multiple workers are running concurrently and only one should receive the command. `r` correlation (workers ignore CMDs whose `r` doesn't match a pending `request_id`) provides safety for fan-out, but unicast is always safer.

## Worker behaviour

Workers using Template 8 already contain a `RECEIVING ORCHESTRATOR COMMANDS` block that instructs them to:
- Watch input for `[CLAWS_CMD r=<id>] <action>: <payload>`
- Correlate `r` against any `request_id` they published in a `BLOCKED` or `REQUEST` event
- Process the action and continue; never echo the `[CLAWS_CMD]` line back

Workers NOT launched with Template 8 will not automatically handle reverse-channel CMDs unless their mission prompt includes equivalent instructions.

## inject=true requirements

`inject=true` delivers the text into the worker's pty via `writeInjected` only when:
1. The peer registered a `terminalId` in its `claws_hello` call.
2. The terminal record is still open (not closed).

Without `terminalId`, the push frame is still delivered to the worker's socket subscription but no pty write occurs (no error).

## Example: unblock a worker after BLOCKED event

```
# 1. Orchestrator receives push frame on worker.** subscription:
#    { push: 'message', topic: 'worker.p_000042.event',
#      payload: { kind: 'BLOCKED', summary: 'needs approval', request_id: 'req-7f3a' } }

# 2. Extract request_id and send approve:
claws_broadcast(
  text="[CLAWS_CMD r=req-7f3a] approve_request: {\"approved\":true}",
  targetRole="worker",
  inject=true
)

# 3. Worker processes it, publishes event --kind PROGRESS, continues mission.
```

## See also

- `/claws-streaming-worker` — full orchestrator ↔ worker lifecycle including stuck detection
- `docs/event-protocol.md §5` — command channel spec, wire format, authorization rules
