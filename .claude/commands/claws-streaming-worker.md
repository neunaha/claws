---
description: Spawn a streaming worker that publishes real-time events over the Claws pub/sub bus. Use instead of /claws-worker when you need live phase/heartbeat/event visibility without polling the pty log.
---

# /claws-streaming-worker

Spawn a wrapped terminal running Claude Code that publishes typed `EnvelopeV1` events at every mission checkpoint.

## Environment contract

The orchestrator sets these env vars in the worker's terminal before sending the mission:

| Variable | Required | Description |
|---|---|---|
| `CLAWS_PEER_ID` | yes | Peer ID returned by `claws_hello` for the worker |
| `CLAWS_PEER_NAME` | recommended | Human label (e.g. `impl-worker-1`) |
| `CLAWS_SOCKET` | auto | Path to Claws socket (auto-discovered if unset) |
| `CLAWS_TERMINAL_ID` | recommended | Terminal ID for log correlation |

## SDK invocation pattern

```bash
# Workers publish via the zero-dep CLI sidecar:
node ./.claws-bin/claws-sdk.js publish boot     --mission "<summary>"
node ./.claws-bin/claws-sdk.js publish phase    --phase PLAN
node ./.claws-bin/claws-sdk.js publish phase    --phase DEPLOY --prev PLAN
node ./.claws-bin/claws-sdk.js publish event    --kind BLOCKED --summary "<why>" --severity warn
node ./.claws-bin/claws-sdk.js publish event    --kind DECISION --summary "<what you decided>"
node ./.claws-bin/claws-sdk.js publish heartbeat --phase DEPLOY
node ./.claws-bin/claws-sdk.js publish complete --result ok --summary "<outcome>"
```

## Orchestrator steps

```
1. claws_lifecycle_plan     — log your plan (required before any create)
2. claws_hello role=orchestrator peerName=orch → save orchestratorPeerId
3. claws_subscribe topic="worker.**"           — receive all worker events
4. (optional) start stream-events sidecar for continuous push delivery
5. claws_create name="<slug>" wrapped=true     → terminalId
6. [7-step boot sequence — see /claws-boot]
7. claws_hello role=worker peerName="<slug>"   → workerPeerId
8. claws_send: export CLAWS_PEER_ID=<workerPeerId>
   claws_send: export CLAWS_PEER_NAME=<slug>
   claws_send: export CLAWS_TERMINAL_ID=<terminalId>
9. Send streaming worker mission (Template 8 from /prompt-templates)
```

## Event topics the worker will publish

| Topic | Schema | When |
|---|---|---|
| `worker.<peerId>.boot` | `WorkerBootV1` | First action in terminal |
| `worker.<peerId>.phase` | `WorkerPhaseV1` | Every phase transition |
| `worker.<peerId>.event` | `WorkerEventV1` | BLOCKED / DECISION / PROGRESS / WARNING |
| `worker.<peerId>.heartbeat` | `WorkerHeartbeatV1` | Every ~10s during long steps |
| `worker.<peerId>.complete` | `WorkerCompleteV1` | Before MISSION_COMPLETE |

## Stuck detection

- No `heartbeat` for >30s → call `claws_read_log` to diagnose
- `event.kind=BLOCKED` → read `summary`, decide to unblock via `claws_send` or skip
- `complete.result=failed` or `complete.result=timeout` → proceed to RECOVER phase

## Orchestrator → Worker (reverse channel)

When a worker publishes `event.kind=BLOCKED` or `event.kind=REQUEST`, the push frame
carries a `request_id`. Use that value to compose a `[CLAWS_CMD]` reply and inject it
into the worker's pty:

**Step 1 — extract request_id from the push frame**
```javascript
// Push frame received on worker.** subscription:
// { push:'message', topic:'worker.<peerId>.event',
//   payload:{ kind:'BLOCKED', summary:'...', request_id:'req-abc' } }
const requestId = pushFrame.payload.request_id;
```

**Step 2 — broadcast the command with inject=true**
```javascript
claws_broadcast(
  text=`[CLAWS_CMD r=${requestId}] approve_request: {"approved":true}`,
  targetRole="worker",
  inject=true
)
```

The `r` value correlates the command: workers ignore `[CLAWS_CMD]` lines whose
`r` does not match a `request_id` they published, making fan-out safe when multiple
workers are running concurrently.

**Five standard actions**

| Action | Effect |
|---|---|
| `approve_request` | Unblock the worker; it continues on the approved path |
| `reject_request` | Deny the request; worker falls back or stops |
| `abort` | Worker stops immediately, publishes `complete --result failed` |
| `pause` | Worker suspends at next safe checkpoint |
| `resume` | Worker continues from paused state |

Workers launched with Template 8 already contain `RECEIVING ORCHESTRATOR COMMANDS`
instructions. Workers with custom missions need equivalent instructions in their
prompt to process `[CLAWS_CMD]` lines.

For single-worker targeting (safer than fan-out), use `task.assign deliver=inject`
with the specific `assignee` peerId instead of `claws_broadcast`.

## Cleanup

Always call `claws_close` on the terminal after harvesting results.
The `CLAWS_PEER_ID` registration expires automatically when the socket disconnects.

## See also

- `/claws-worker` — legacy fire-and-forget (no streaming events)
- `/claws-broadcast` — reverse channel command dispatch reference (actions, BNF, unicast vs fan-out)
- `/prompt-templates` → Template 8 for the full mission prompt boilerplate
- `/claws-orchestration-engine` → Phase 4 OBSERVE for the event-driven observation pattern
- `docs/event-protocol.md §5` → command channel spec and wire format
