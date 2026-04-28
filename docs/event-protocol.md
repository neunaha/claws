# Claws Event Protocol — Convention Layer

This document defines the **observable behavior** every Claws-driven worker must
exhibit and every orchestrator can rely on. It is a convention, not a wire
protocol — the wire protocol is `claws/2` pub/sub (see `protocol.md` and
`extension/src/protocol.ts`). What lives here is the **shape and timing of
events** workers emit, the **command channel** orchestrators use to drive them,
and the **state machine** that bounds the dialogue.

The goal is real-time, no-polling orchestration. Events arrive at the
orchestrator within milliseconds of being published. The orchestrator decides
based on events, not on log scrapes. Workers signal their state explicitly
instead of being inferred.

---

## 1. Universal Event Envelope

Every payload published on any worker- or task-scoped topic SHOULD carry this
envelope. Consumers can rely on these fields existing.

```jsonc
{
  "v": 1,                           // envelope schema version (integer)
  "id": "<uuid-v4>",                // unique message id — for dedup, reference
  "correlation_id": "<uuid-v4>?",   // groups related events (request/response, decision/outcome)
  "parent_id": "<peer-id>?",        // lineage — null for root orchestrator, peer-id of parent worker otherwise
  "from_peer": "<peer-id>",         // who published (server adds if absent)
  "from_name": "<peer-name>",       // human label (worker-X, orchestrator-main)
  "terminal_id": "<id>?",           // associated terminal id, if any
  "ts_published": "2026-04-27T12:00:00.123Z",  // worker clock at publish time
  "ts_server":    "2026-04-27T12:00:00.124Z",  // server clock at fan-out time (server adds)
  "schema": "<topic-schema-name>",  // e.g. "worker-phase-v1"
  "data": { /* schema-specific */ }
}
```

**Why the envelope:** dedup (`id`), threading (`correlation_id`), tree walks
(`parent_id`), clock skew detection (`ts_published` vs `ts_server`), and forward
compatibility (`v`, `schema`).

**Server adds** `ts_server`, `from_peer` (if missing), and refuses to fan out
events whose `from_peer` doesn't match the publishing connection's peer id.

---

## 2. Topic Namespace

Topics are dot-separated, lowercase, hierarchical. Patterns support `*` (one
segment) and `**` (recursive, zero or more).

| Namespace | Owner | Purpose |
|---|---|---|
| `worker.<peerId>.*` | worker `<peerId>` | facts the worker publishes about itself |
| `cmd.<peerId>.*` | orchestrator | commands targeted at one specific worker |
| `cmd.role.<role>` | orchestrator | broadcast to all workers of a role |
| `task.<taskId>.*` | orchestrator + assigned worker | task lifecycle (orthogonal to worker boot) |
| `system.*` | server | server-generated (peer.joined, peer.left, gate.fired) |

**Authorization (server-enforced — see §10):** workers can only publish on
`worker.<theirOwnPeerId>.*` and `task.<assignedTaskId>.*`. Only orchestrators
can publish on `cmd.*`. `system.*` is server-write-only.

---

## 3. Worker-emitted Topics

Every worker MUST emit on these topics in the order shown. A worker that skips
`boot` is invisible to the orchestrator. A worker that skips `complete` looks
crashed.

### 3.1 `worker.<peerId>.boot`

**When:** Claude Code (or whatever process) is up and ready to accept the mission. Emit ONCE per worker lifetime, immediately after `claws_hello`.

```jsonc
{
  "schema": "worker-boot-v1",
  "data": {
    "model": "claude-sonnet-4-6",
    "role": "worker",
    "parent_peer_id": "p_000001",       // orchestrator's peer id
    "mission_summary": "Audit src/server.ts for security issues",
    "capabilities": ["mcp_claws", "sub_workers", "long_thinking"],
    "cwd": "/Users/.../Desktop/Claws",
    "terminal_id": "5"
  }
}
```

### 3.2 `worker.<peerId>.phase`

**When:** every transition between the 8 lifecycle phases (or to a terminal
state). The state machine in §4 bounds legal transitions.

```jsonc
{
  "schema": "worker-phase-v1",
  "data": {
    "phase": "DEPLOY",                       // current phase entered
    "prev":  "SPAWN",                        // phase exited
    "transition_reason": "all-workers-spawned",
    "phases_completed": ["PLAN","SPAWN","DEPLOY"],
    "metadata": { /* phase-specific notes */ }
  }
}
```

### 3.3 `worker.<peerId>.event`

**When:** any sentinel checkpoint within a phase. The `kind` field switches the
sub-schema.

```jsonc
{
  "schema": "worker-event-v1",
  "data": {
    "kind": "BLOCKED|REQUEST|HARVEST|ERROR|DECISION|PROGRESS|LOG",
    "severity": "info|warn|error|fatal",
    "message": "human-readable headline",
    "request_id": "<uuid>?",  // present if this expects a response
    /* + kind-specific fields, see §3.3.x */
  }
}
```

#### 3.3.1 `kind: "BLOCKED"`
Worker has paused waiting for something external. Orchestrator should respond
on `cmd.<peerId>.unblock` with `correlation_id = data.request_id`.
```jsonc
{ "kind": "BLOCKED",
  "severity": "warn",
  "message": "needs approval to spawn 3 sub-workers",
  "request_id": "req-abc",
  "data": { "blocking_resource": "approval", "retryable": true } }
```

#### 3.3.2 `kind: "REQUEST"`
Worker is asking the orchestrator to make a decision. Orchestrator responds on
`cmd.<peerId>.<action>` with `correlation_id = data.request_id`.
```jsonc
{ "kind": "REQUEST",
  "severity": "info",
  "message": "choose: full rewrite vs. patch?",
  "request_id": "req-xyz",
  "data": { "request_type": "decision",
            "options": [{"id":"A","label":"full rewrite"},{"id":"B","label":"patch"}] } }
```

#### 3.3.3 `kind: "HARVEST"`
Worker is delivering intermediate or final artifacts. Orchestrator may collect.
```jsonc
{ "kind": "HARVEST",
  "severity": "info",
  "message": "audit findings ready",
  "data": { "artifacts": [{"path":"/tmp/audit.md","type":"markdown","size_bytes":4200}] } }
```

#### 3.3.4 `kind: "ERROR"`
Something failed. Severity drives recovery: `warn` is informational, `error`
needs orchestrator attention, `fatal` means the worker is going down.
```jsonc
{ "kind": "ERROR",
  "severity": "fatal",
  "message": "ran out of token budget",
  "data": { "error_class": "UsageLimitExceeded", "retryable": false,
            "suggested_action": "respawn with smaller model" } }
```

#### 3.3.5 `kind: "DECISION"`
Worker made a decision autonomously and is logging it (NOT requesting input).
For audit trails.
```jsonc
{ "kind": "DECISION",
  "severity": "info",
  "message": "chose option B (patch) — full rewrite would touch shared files",
  "data": { "decision_id": "dec-1", "option_chosen": "B", "reasoning": "..." } }
```

#### 3.3.6 `kind: "PROGRESS"`
Worker reports incremental progress within a long phase. Optional but useful.
```jsonc
{ "kind": "PROGRESS",
  "severity": "info",
  "message": "3 of 7 files reviewed",
  "data": { "percent": 0.43, "current_step": 3, "total_steps": 7, "eta_ms": 120000 } }
```

#### 3.3.7 `kind: "LOG"`
Catch-all for diagnostic narration. Orchestrator usually ignores; observers may
collect.

### 3.4 `worker.<peerId>.heartbeat`

**When:** every 10s while the worker is alive. Frequency may be tuned but MUST
be at least every 30s — workers silent for 30s+ are considered stale.

```jsonc
{
  "schema": "worker-heartbeat-v1",
  "data": {
    "current_phase": "OBSERVE",
    "time_in_phase_ms": 47000,
    "tokens_used": 5421,
    "cost_usd": 0.78,
    "last_event_id": "<uuid of most recent event>",
    "active_sub_workers": ["p_000004"]
  }
}
```

If the worker knows it's about to crash (e.g. SIGINT received), it SHOULD
publish a final heartbeat with `severity: "fatal"` and a parting message
before disconnecting.

### 3.5 `worker.<peerId>.complete`

**When:** worker has finished its mission successfully. Emit ONCE, immediately
before calling `claws_close` or disconnecting. Mutually exclusive with a
`fatal` ERROR.

```jsonc
{
  "schema": "worker-complete-v1",
  "data": {
    "result": "ok",
    "summary": "audited 7 files, found 2 issues — see /tmp/audit.md",
    "artifacts": [{"path":"/tmp/audit.md","type":"markdown"}],
    "phases_completed": ["PLAN","SPAWN","DEPLOY","OBSERVE","HARVEST","CLEANUP","REFLECT"],
    "total_tokens": 18420,
    "total_cost_usd": 2.41,
    "duration_ms": 412000
  }
}
```

---

## 4. Phase State Machine

Workers SHOULD transition through phases in this order. Illegal transitions
trigger a `system.gate.fired` event from the server (see §6) and may be
rejected outright.

```
          ┌──────────┐
          │   PLAN   │  ← only entry point; required
          └────┬─────┘
               ▼
          ┌──────────┐
       ┌─►│  SPAWN   │
       │  └────┬─────┘
       │       ▼
       │  ┌──────────┐    ┌──────────┐
       │  │  DEPLOY  │◄──►│ RECOVER  │
       │  └────┬─────┘    └────┬─────┘
       │       ▼               │
       │  ┌──────────┐         │
       └──┤ OBSERVE  │◄────────┘
          └────┬─────┘
               ▼
          ┌──────────┐
          │ HARVEST  │
          └────┬─────┘
               ▼
          ┌──────────┐
          │ CLEANUP  │
          └────┬─────┘
               ▼
          ┌──────────┐
          │ REFLECT  │  ← terminal
          └──────────┘

  +- FAILED (terminal) — reachable from any non-terminal state on fatal error
```

Allowed transitions (other → other):
- `PLAN → SPAWN`
- `SPAWN → DEPLOY | RECOVER | FAILED`
- `DEPLOY → OBSERVE | RECOVER | FAILED`
- `OBSERVE → HARVEST | RECOVER | FAILED`
- `RECOVER → DEPLOY | OBSERVE | FAILED`
- `HARVEST → CLEANUP | FAILED`
- `CLEANUP → REFLECT | FAILED`
- `REFLECT → (terminal, no further transitions)`
- `FAILED → (terminal)`

`RECOVER` may be entered from DEPLOY, OBSERVE, or SPAWN and may exit back to
the same phase (re-deploy after a recovery). Workers should publish RECOVER
entry/exit pairs so observers can compute MTTR.

---

## 5. Command Channel — Orchestrator → Worker

Workers do NOT subscribe to anything by default (they would need a long-poll
or a sidecar to receive pushes via MCP). Instead, the orchestrator delivers
commands via two routes:

### 5.1 Bracketed-paste injection (preferred default)

`mcp__claws__claws_broadcast(text="...", targetRole="worker", inject=true)`
or its single-target equivalent (broadcast filtered server-side by `peerId`).

The server writes the text directly into the worker's pty via bracketed paste.
The worker's Claude Code receives it as if the human typed a follow-up. This
needs no worker-side machinery.

When the orchestrator wants to drive a specific worker, the injected text
SHOULD start with a recognizable header so the worker knows it's a command
and not noise:

```
[CLAWS_CMD r=req-abc] approve_request: { "approved": true, "payload": {...} }
```

The worker's mission instructs it to look for `[CLAWS_CMD r=<id>]` lines and
correlate by `r`.

### 5.2 Worker-side sidecar (advanced)

For workers that need many commands or want to subscribe to broad patterns,
spawn a side process inside the worker terminal that runs
`scripts/stream-events.js` with `CLAWS_TOPIC=cmd.<myPeerId>.**` and a known
output file. The worker's Claude Code (which has access to Bash + Read) can
tail that file. Higher fidelity, more setup. Use when 5.1 isn't enough.

### 5.3 Standard command schemas

Topics under `cmd.<peerId>.*`:

| Topic | Purpose | Schema |
|---|---|---|
| `cmd.<peerId>.approve` | approve a `BLOCKED` or `REQUEST` event | `{correlation_id, payload}` |
| `cmd.<peerId>.reject` | reject with reason | `{correlation_id, reason}` |
| `cmd.<peerId>.abort` | terminate the worker now | `{reason}` |
| `cmd.<peerId>.pause` | pause until resumed | `{}` |
| `cmd.<peerId>.resume` | resume after pause | `{}` |
| `cmd.<peerId>.set_phase` | force phase transition (override) | `{phase, reason}` |
| `cmd.<peerId>.spawn` | tell worker to spawn a sub-worker | `{name, mission, model?}` |
| `cmd.<peerId>.inject_text` | raw text inject (no schema) | `{text, paste?}` |

Every command MUST carry `correlation_id` matching the `request_id` of the
event it answers (if any).

---

## 6. Server-emitted Topics

The server publishes on `system.*` for events not tied to any one peer.

| Topic | When | Payload |
|---|---|---|
| `system.peer.joined` | a peer completes `hello` | `{peerId, role, peerName, ts}` |
| `system.peer.left` | a peer disconnects | `{peerId, role, reason: "clean"\|"crash"\|"timeout"}` |
| `system.peer.stale` | no heartbeat from a worker for >30s | `{peerId, last_seen, missed_heartbeats}` |
| `system.gate.fired` | a hook or server-side gate blocked an action | `{tool, reason, peerId}` |
| `system.budget.warning` | total cost across active workers exceeds threshold | `{current_usd, threshold_usd}` |
| `system.malformed.received` | server received an event that didn't validate | `{from, topic, error}` |

---

<!-- BEGIN GENERATED SCHEMAS -->
_This section is auto-generated by `npm run schemas` in `extension/`. Run to update._

| Topic Pattern | Schema Name | Key Required Fields |
|---|---|---|
| `worker.*.boot` | `worker-boot-v1` | model, role, mission_summary, cwd, terminal_id |
| `worker.*.phase` | `worker-phase-v1` | phase, prev, transition_reason, phases_completed |
| `worker.*.event` | `worker-event-v1` | kind, severity, message |
| `worker.*.heartbeat` | `worker-heartbeat-v1` | current_phase, time_in_phase_ms, tokens_used, cost_usd |
| `worker.*.complete` | `worker-complete-v1` | result, summary, artifacts, phases_completed |
| `cmd.*.approve` | `cmd-approve-v1` | correlation_id |
| `cmd.*.reject` | `cmd-reject-v1` | correlation_id, reason |
| `cmd.*.abort` | `cmd-abort-v1` | reason |
| `cmd.*.pause` | `cmd-pause-v1` | _(none)_ |
| `cmd.*.resume` | `cmd-resume-v1` | _(none)_ |
| `cmd.*.set_phase` | `cmd-set-phase-v1` | phase, reason |
| `cmd.*.spawn` | `cmd-spawn-v1` | name, mission |
| `cmd.*.inject_text` | `cmd-inject-text-v1` | text |
| `system.peer.joined` | `system-peer-joined-v1` | peerId, role, peerName, ts |
| `system.peer.left` | `system-peer-left-v1` | peerId, role, reason |
| `system.peer.stale` | `system-peer-stale-v1` | peerId, last_seen, missed_heartbeats |
| `system.gate.fired` | `system-gate-fired-v1` | tool, reason, peerId |
| `system.budget.warning` | `system-budget-warning-v1` | current_usd, threshold_usd |
| `system.malformed.received` | `system-malformed-received-v1` | from, topic, error |
<!-- END GENERATED SCHEMAS -->

---

## 7. Heartbeat Discipline

- Workers publish `worker.<peerId>.heartbeat` every 10s while in non-terminal
  phases. Pause heartbeats during REFLECT (terminal) and after `complete`.
- The server tracks `last_seen` per peer (any frame counts, including
  publishes). If `last_seen` is older than 30s, server emits
  `system.peer.stale`.
- Orchestrator subscribed to `system.peer.stale` decides: nudge via
  `cmd.<peerId>.inject_text`, abort via `cmd.<peerId>.abort`, or respawn.
- A worker that knows it's about to die SHOULD emit a `worker.<peerId>.event`
  with `kind: "ERROR", severity: "fatal"` BEFORE disconnecting (the "last
  will"). The server emits `system.peer.left` immediately on socket close.

---

## 8. Lineage & Trees

- `parent_id` in the envelope encodes the parent peer.
- For workers spawned by the orchestrator: `parent_id` = orchestrator's peerId.
- For sub-workers spawned by another worker (worker-A spawns worker-B):
  `parent_id` = worker-A's peerId.
- The orchestrator can walk the tree by querying `claws_peers` and joining on
  `parent_id`.

A `correlation_id` MAY span the tree: when worker-A publishes a REQUEST and
worker-B is spawned to answer, both A's REQUEST and B's COMPLETE share the
same `correlation_id`. This lets observers thread cause and effect.

---

## 9. Schema Versioning

- `v` in the envelope is the envelope-schema version (currently `1`).
- `schema` is the data-schema name with version suffix (currently `-v1`).
- Adding a new field to a `data` payload is non-breaking; consumers MUST
  ignore unknown fields.
- Removing or renaming a field is breaking; bump to `-v2` and run both in
  parallel for a deprecation window.
- Adding a new event `kind` is non-breaking if consumers default to ignoring
  unknown kinds.
- Adding a new top-level topic is non-breaking.
- Removing a topic or changing its semantics is breaking; coordinate
  carefully.

---

## 10. Authorization Rules (server-enforced)

In `server.ts`, the publish handler MUST reject:

- A peer publishing on `worker.<X>.*` where `X != ownPeerId` → reject with
  `{ok: false, error: "publish forbidden — not your topic"}`.
- A non-orchestrator publishing on `cmd.*` → reject.
- Any peer publishing on `system.*` → reject (server-only).
- Subscribers may subscribe to anything (`**` is allowed).

These rules turn pub/sub into a trust boundary, not just a routing layer.

---

## 11. Persistence & Replay

- An optional sidecar with `CLAWS_TOPIC='**'` tees every event to
  `.claws/events.jsonl` (one JSON object per line, newline-delimited).
- Tools can replay: `cat .claws/events.jsonl | jq 'select(.topic | startswith("worker."))'`.
- For multi-session replay, the file is appended (not truncated). Rotation
  is the user's responsibility (e.g. `logrotate`).

---

## 12. Worker Checklist (what a worker MUST do)

A compliant worker:
1. After `claws_hello`, immediately publish `worker.<peerId>.boot` with the
   universal envelope.
2. Publish `worker.<peerId>.phase` on every phase transition.
3. Publish `worker.<peerId>.heartbeat` every 10s while non-terminal.
4. Publish `worker.<peerId>.event` at every sentinel checkpoint (BLOCKED,
   REQUEST, HARVEST, ERROR, DECISION).
5. Watch its own pty input (or its sidecar tailed file) for
   `[CLAWS_CMD r=<id>]` lines and correlate by `r`.
6. On terminal phase entry (REFLECT or FAILED): publish
   `worker.<peerId>.complete` (or a final `ERROR` with `severity: fatal`)
   THEN disconnect.

A worker that doesn't do (1)–(4) is invisible to the orchestrator and
defaults to the legacy polling model.

---

## 13. Orchestrator Checklist (what an orchestrator MUST do)

A compliant orchestrator:
1. Launch `scripts/stream-events.js` under Monitor with
   `CLAWS_ROLE=orchestrator CLAWS_TOPIC='**'` (or a tighter pattern) at
   session start. ONE persistent connection.
2. React to incoming events as Monitor notifications. NO polling.
3. Maintain its own model of the worker tree from `boot`, `phase`, and
   `complete` events.
4. Respond to `BLOCKED` and `REQUEST` events within a sensible deadline by
   publishing on `cmd.<peerId>.*` with matching `correlation_id`.
5. On `system.peer.stale` for a worker it spawned: nudge or respawn.
6. On `system.peer.left` with `reason: "crash"`: optionally respawn or escalate.
7. Before ending its own session: publish `cmd.role.worker` with `abort` and
   wait for `complete` or `peer.left` from each worker.

---

## 14. Examples — Full Dialogue

**Scenario:** orchestrator spawns worker-A to audit `src/server.ts`. A finds
a complex case and asks for guidance.

```
# orchestrator → server (via mcp__claws__claws_create + claws_send)
spawns wrapped terminal with Claude Code, mission: "audit src/server.ts"

# server → orchestrator's sidecar
{topic: "system.peer.joined", from_peer: "p7", role: "worker", peerName: "audit-A"}

# worker-A → all subscribers
{topic: "worker.p7.boot", data: {model:"sonnet-4-6", mission_summary:"audit src/server.ts", parent_peer_id:"p1"}}

# worker-A transitions
{topic: "worker.p7.phase", data: {phase:"DEPLOY", prev:"SPAWN"}}
{topic: "worker.p7.heartbeat", data: {current_phase:"DEPLOY", tokens_used:120}}

# worker-A finds something tricky
{topic: "worker.p7.event", data: {kind:"REQUEST", request_id:"r1",
  message:"server.ts:380 — should I rewrite the handler or patch it?",
  options: [{id:"A",label:"rewrite"},{id:"B",label:"patch"}]}}

# orchestrator (in chat with human) decides "B"
mcp__claws__claws_publish(topic:"cmd.p7.approve",
  payload:{correlation_id:"r1", chosen:"B"})

# server → worker-A's pty (via inject route, see §5.1)
[CLAWS_CMD r=r1] approve_request: {"chosen":"B"}

# worker-A continues
{topic: "worker.p7.phase", data: {phase:"OBSERVE"}}
{topic: "worker.p7.event", data: {kind:"HARVEST",
  message:"audit done", artifacts:[{path:"/tmp/audit.md"}]}}
{topic: "worker.p7.phase", data: {phase:"HARVEST"}}
{topic: "worker.p7.phase", data: {phase:"CLEANUP"}}
{topic: "worker.p7.phase", data: {phase:"REFLECT"}}
{topic: "worker.p7.complete", data: {result:"ok", summary:"...", artifacts:[...]}}

# worker-A disconnects
# server → orchestrator
{topic: "system.peer.left", from_peer:"p7", reason:"clean"}
```

The whole exchange happens in real time. The orchestrator's chat sees each
event as a Monitor notification. No polling, no log scraping, no MISSION_COMPLETE
string match.

---

## 15. What this Convention does NOT cover (yet)

- **Bandwidth/throttling**: a worker that publishes 1000 events/sec will
  flood the orchestrator. Future work: rate-limit per topic per peer.
- **At-least-once delivery**: `claws/2` is in-process best-effort fan-out. If
  the orchestrator's sidecar disconnects mid-event, the event is lost.
  Persistence (§11) is the workaround.
- **Cross-machine**: `claws/2` is unix socket only today. WebSocket transport
  is Phase 3 of the project.
- **Encryption / auth**: same machine, same user — no auth. Cross-machine
  needs token auth (Phase 3).
- **Schema validation**: today the convention is enforced by humans reading
  the spec. Future: a thin client wrapper that validates before publish, and
  server-side rejection of malformed events.

---

## 16. Quick Reference

```
WORKER MUST EMIT:
  worker.<id>.boot                        once, after hello
  worker.<id>.phase   (on transition)     every phase change
  worker.<id>.heartbeat (every 10s)       while non-terminal
  worker.<id>.event   (at checkpoints)    BLOCKED | REQUEST | HARVEST | ERROR | DECISION | PROGRESS
  worker.<id>.complete                    once, before disconnect

ORCHESTRATOR MUST SUBSCRIBE:
  worker.**       (everything from workers)
  system.**       (server-generated)
  task.**         (if using tasks)

ORCHESTRATOR MAY PUBLISH:
  cmd.<peerId>.*  (commands to specific worker)
  cmd.role.*      (broadcast to a role)

SENTINEL TOKEN IN INJECTED TEXT:
  [CLAWS_CMD r=<id>] <command>: <json-payload>
```
