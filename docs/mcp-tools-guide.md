# Claws MCP Tools — Calibration Guide

**Audience:** AI orchestrators (Claude Code, autonomous loops) deciding *which* of the 37 Claws MCP tools to call for a given task.

**TL;DR decision matrix below.** Full detail per tool follows.

---

## TL;DR — pick the right tool

| You want to … | Use this | Don't use |
|---|---|---|
| Run **one** Claude Code worker on a mission | `claws_worker` — **Non-blocking** (returns `terminal_id` immediately; poll via `claws_workers_wait`) | `claws_create` + manual orchestration |
| Run **N** Claude Code workers truly in parallel | **`claws_fleet`** — **Non-blocking** (single MCP call, server-side `Promise.all`; returns `terminal_ids` in seconds) | N×`claws_worker` from one assistant message — Claude Code's MCP client serializes those |
| Run a one-shot shell command and capture output | `claws_exec` | `claws_send` + `claws_read_log` (more code, same result) |
| Send free-form text into an existing terminal | `claws_send` | `claws_exec` (use only when you need exit-code capture) |
| Read what's currently in a wrapped terminal | `claws_read_log` | `claws_poll` — that's for shell-integration events, not pty contents |
| List all live terminals | `claws_list` | grep `.claws/captures/` |
| Close a terminal you created | `claws_close` | leave it dangling |
| Create a terminal without launching anything in it | `claws_create` (then `claws_send` later) | `claws_worker` with `launch_claude=false` (heavier) |
| Wave-army LEAD dispatching sub-workers (TESTER/REVIEWER/AUDITOR/DOC) | **`claws_fleet`** — single call fans out all sub-workers in parallel via `Promise.all` | `claws_dispatch_subworker` (BUG-08: serial; BUG-09: no auto-close) |
| Server liveness check | `claws_ping` | open a raw socket |
| Diagnose the server's full runtime state | `claws_introspect` | grep extension logs |
| Check who's connected | `claws_peers` | introspect (peers is a subset) |
| Register yourself as orchestrator/worker | `claws_hello` (required before publish/subscribe/tasks) | nothing else works without this |
| Subscribe to bus events | `claws_subscribe` (then `claws_drain_events` to read what arrived) | poll the `.jsonl` files manually |
| Publish to the bus | `claws_publish` (regular peer) or `claws_broadcast` (orchestrator-only) | `claws_send` into a peer's terminal — use only when you also want the text echoed in the TUI |
| Send a structured command to a specific worker with delivery semantics | `claws_deliver_cmd` (server validates, dedupes by idempotencyKey) | `claws_publish` directly |
| Worker acknowledges a delivered command | `claws_cmd_ack` | nothing else works |
| Make a typed RPC call to a peer and wait for response | `claws_rpc_call` | `claws_publish` + manual subscription dance |
| List schemas in the registry | `claws_schema_list` | grep source |
| Inspect one schema | `claws_schema_get` | read TypeScript |
| Assign a task to a worker (orchestrator) | `claws_task_assign` | `claws_send` + hope for the best |
| Update task progress (worker) | `claws_task_update` | nothing else emits the right event |
| Mark task done/failed/skipped (worker) | `claws_task_complete` | nothing else |
| Cancel an in-flight task (orchestrator) | `claws_task_cancel` | `claws_close` (kills terminal but leaves task state stale) |
| List tasks (anyone) | `claws_task_list` | grep state |
| Drain accumulated bus events (with optional wait_ms blocking) | `claws_drain_events` | `claws_subscribe` + manual buffering |
| Build a DAG/pipeline of input→sink topic forwarding | `claws_pipeline_create` (+ `_list` / `_close`) | manual subscribe-publish chains |
| Log the orchestration plan before spawning | `claws_lifecycle_plan` (REQUIRED before `claws_create`) | nothing — server gates terminal creation on this |
| Advance the lifecycle phase | `claws_lifecycle_advance` | nothing else |
| Snapshot lifecycle state | `claws_lifecycle_snapshot` | grep `.claws/lifecycle-state.json` |
| Persist a final retrospective and freeze the cycle | `claws_lifecycle_reflect` | `claws_lifecycle_advance` to REFLECT (allowed but doesn't persist text) |
| Open a wave and register sub-workers | `claws_wave_create` | nothing else gives you the heartbeat-violation timer |
| Check wave heartbeat / completion status | `claws_wave_status` | nothing else |
| Mark wave done (LEAD only) | `claws_wave_complete` | `claws_lifecycle_advance` (lifecycle is global, wave is its own scope) |
| Stream shell-integration command-completion events | `claws_poll` | only useful for unwrapped terminals; useless in wrapped ones (use `claws_read_log`) |

---

## Single-worker vs fleet vs army — the three orchestration shapes

| Shape | Tool | When |
|---|---|---|
| **Single worker** | `claws_worker(name, mission, …)` | One independent task. Default for "run a Claude Code job and wait." |
| **Fleet** (N parallel workers, no coordination between them) | `claws_fleet(workers: [{name, mission}, …])` | Independent parallel tasks (audits, file generation, multi-target validation). Server runs them all via `Promise.all` in one MCP call — bypasses Claude Code's client-side serialization. |
| **Wave army** (LEAD + typed sub-workers with heartbeats and bus coordination) | `claws_wave_create` then **`claws_fleet`** to dispatch sub-workers in parallel | Coordinated mission with role specialization (TESTER + REVIEWER + AUDITOR + DOC working together with the LEAD harvesting). Server tracks heartbeats and fires violation events on silence. |

**The most common mistake:** trying to fan out by calling `claws_worker` N times in one assistant message and expecting parallelism. Claude Code's MCP client awaits each response before sending the next request — the calls serialize. **Use `claws_fleet` instead.**

---

## Non-blocking pattern (canonical workflow)

`claws_fleet` and `claws_worker` are **non-blocking by default** — they spawn and return immediately. The MCP stdio transport cannot safely hold a response open for more than a few seconds. Always follow this 3-step pattern:

**Step 1 — Fire `claws_fleet` or `claws_worker`** (returns `terminal_ids` in seconds):
```
claws_fleet(cwd="...", workers=[{name:"tester", mission:"..."}, {name:"reviewer", mission:"..."}])
→ { fleet_size, terminal_ids, workers:[{terminal_id, name}, …] }
```

**Step 2 — Poll with `claws_workers_wait`** (safe to block here — workers run independently in their own terminals):
```
claws_workers_wait(terminal_ids=[…], timeout_ms=300000)
→ { done: true/false, workers:[{terminal_id, status, marker_found}, …] }
```

**Step 3 — Read `.local/audits/*.md` for ground truth** (always lands on disk regardless of socket state):
```
ls .local/audits/   # each worker writes its own audit file on completion
```

Blocking modes (`wait:true` / `detach:false`) remain available behind an explicit opt-in flag but are flagged unsafe — only use when the caller's event loop can tolerate an indefinite hang.

---

## Mission-style cookbook

### Single mission, multi-line, may contain marker-like words
```
claws_worker(
  name="audit-install-sh",
  cwd="/Users/me/proj",
  mission="...long multi-line mission ending with: print MISSION_COMPLETE",
)
```
v0.7.10's bulletproof scan-offset polls for paste-collapse / spinner indicators (up to 5s) before capturing the marker baseline, so the input echo of "MISSION_COMPLETE" in your mission body is excluded from the scan.

### Single mission with a marker that COULD appear in input echo
Pass a custom `complete_marker` (and a custom `error_markers` if your mission contains "MISSION_FAILED"):
```
claws_worker(
  name="…", mission="…",
  complete_marker="DONE_8KX7",
  error_markers=[],   // disable error matching if your mission discusses MISSION_FAILED
)
```

### Pure shell command, no Claude Code
```
claws_worker(
  name="…",
  command="npm test 2>&1 | tail -5",
)
```
Or for sub-second commands with stdout/stderr/exit_code: `claws_exec(command="…")` against an existing terminal.

### Three independent parallel audits (true fan-out)
```
claws_fleet(
  cwd="/Users/me/proj",
  workers: [
    { name: "tester",   mission: "…" },
    { name: "reviewer", mission: "…" },
    { name: "auditor",  mission: "…" },
  ],
)
```
Returns `{ fleet_size, wall_clock_ms, max_individual_ms, sum_individual_ms, workers: […] }`. If `wall_clock_ms ≈ max_individual_ms`, true parallelism worked. If `wall_clock_ms ≈ sum_individual_ms`, parallelism didn't take.

### Wave army (LEAD coordinating typed sub-workers)
```
claws_hello(role="orchestrator", peerName="lead")
claws_wave_create(waveId="payment-refactor-v1", roles=["TESTER","REVIEWER","AUDITOR","DOC"])
// Dispatch all sub-workers in parallel via claws_fleet (NOT claws_dispatch_subworker — BUG-08: serial, BUG-09: no auto-close):
claws_fleet(cwd="…", workers=[
  { name: "tester",   mission: "… print TESTER_DONE" },
  { name: "reviewer", mission: "… print REVIEWER_DONE" },
  { name: "auditor",  mission: "… print AUDITOR_DONE" },
  { name: "doc",      mission: "… print DOC_DONE" },
])
// monitor:
claws_subscribe(topic="wave.payment-refactor-v1.**")
claws_drain_events(wait_ms=30000)
// when sub-workers all publish complete:
claws_wave_complete(waveId="…")
```

---

## Lifecycle gates — what's required when

| Trying to call | Requires | Why |
|---|---|---|
| `claws_create` (any wrapped or unwrapped terminal) | `claws_lifecycle_plan` first (idempotent) | Server-side gate; blocks creation until a PLAN is logged. Prevents accidental spawn outside an orchestrated mission. |
| `claws_subscribe`, `claws_publish`, `claws_broadcast`, `claws_task_*`, `claws_rpc_call`, `claws_deliver_cmd`, `claws_cmd_ack` | `claws_hello` first | claws/2 peer state is bound to a registered peer; these all need a `peerId`. |
| `claws_wave_create` (and the dispatch tools that follow) | `claws_hello` with `role="orchestrator"` | Wave creation is orchestrator-only. |
| `claws_broadcast` | `role="orchestrator"` | Workers can't broadcast. |
| `claws_task_assign` / `claws_task_cancel` | `role="orchestrator"` | Task lifecycle is orchestrator-controlled. |
| `claws_task_update` / `claws_task_complete` | `role="worker"` (and assigned to that task) | Only the assignee may update. |
| `claws_cmd_ack` | `role="worker"` | Only workers acknowledge. |
| `claws_lifecycle_advance` to REFLECT | All previous phases completed in order | Server enforces the transition matrix. |

---

## Anti-patterns — don't do these

- **Don't send `claude --dangerously-skip-permissions ...` into a terminal that already has Claude Code running.** That types it as a user prompt. Use `claws_create` for a fresh terminal, or call `claws_worker(name, mission)` which handles boot automatically.
- **Don't poll `claws_read_log` in tight loops to wait for a marker.** That's `claws_worker`'s job. Use `claws_worker` (it polls internally and returns when matched).
- **Don't put your `complete_marker` literal in your mission text without overriding it.** If you do, the bulletproof scan offset (v0.7.10) will mostly handle it — but the safest pattern is to pass a unique `complete_marker` not present in the mission.
- **Don't expect `claws_fleet` to return per-worker results in input order if a worker errors.** Map results by index from the input `workers[]` array, which is what `claws_fleet`'s response does.
- **Don't use `claws_poll`** unless you specifically need shell-integration command-completion events on unwrapped terminals. For wrapped terminals (the default), use `claws_read_log`.
- **Don't call `claws_worker` and `claws_fleet` together in the same assistant message.** Pick one shape per mission. Mixing them creates lifecycle confusion.
- **Don't skip `claws_lifecycle_plan` and try to call `claws_create` directly.** The server returns `lifecycle:plan-required` and refuses.

---

## Concurrent-dispatch caveats (v0.7.10)

The MCP server's main loop dispatches `tools/call` handlers via `.then()` (no `await`), so multiple handlers run concurrently in the JS event loop. **However**, Claude Code's MCP *client* awaits each response before sending the next request. So:

- `claws_fleet` achieves real parallelism — it's one tool call internally fanning out via `Promise.all`.
- N×`claws_worker` from one assistant message **does not** parallelize — Claude Code serializes them client-side.
- A second tool call from the same message can still dispatch concurrently *on the server* if the client happens to pipeline (it doesn't, today, for tool/call). The fix is real but currently latent — future Claude Code versions or other MCP clients may benefit.

---

## When you need cross-orchestrator coordination

The 8-phase lifecycle is **single global state** (`.claws/lifecycle-state.json`). One orchestrator at a time per server. For multi-orchestrator concurrent missions, each orchestrator should run against a separate Claws socket (different VS Code workspace) — the lifecycle store doesn't yet support per-orchestrator namespacing.

---

## Tool inventory (37 tools as of v0.7.10)

Built into `mcp_server.js`, schemas in `schemas/mcp-tools.json` (single source of truth, generated from `scripts/codegen/gen-mcp-tools.mjs`).

**Core terminal control (7):** `claws_list`, `claws_create`, `claws_send`, `claws_exec`, `claws_read_log`, `claws_poll`, `claws_close`

**Worker spawn (3):** `claws_worker`, **`claws_fleet`** (NEW v0.7.10), `claws_dispatch_subworker`

**claws/2 peer + bus (6):** `claws_hello`, `claws_subscribe`, `claws_publish`, `claws_broadcast`, `claws_ping`, `claws_peers`

**Lifecycle (4):** `claws_lifecycle_plan`, `claws_lifecycle_advance`, `claws_lifecycle_snapshot`, `claws_lifecycle_reflect`

**Wave army (3):** `claws_wave_create`, `claws_wave_status`, `claws_wave_complete`

**Structured commands (2):** `claws_deliver_cmd`, `claws_cmd_ack`

**Schema registry (2):** `claws_schema_list`, `claws_schema_get`

**RPC (1):** `claws_rpc_call`

**Tasks (5):** `claws_task_assign`, `claws_task_update`, `claws_task_complete`, `claws_task_cancel`, `claws_task_list`

**Event bus (1):** `claws_drain_events`

**Pipeline DAG (3):** `claws_pipeline_create`, `claws_pipeline_list`, `claws_pipeline_close`

**Server introspection (1):** `claws_introspect`

Total: 7 + 3 + 6 + 4 + 3 + 2 + 2 + 1 + 5 + 1 + 3 + 1 = **38** (count includes `claws_introspect`; `schemas/mcp-tools.json` exposes the 37 in the schema, with `claws_introspect` registered in handlers but not always in the json — check `node -p "JSON.parse(require('fs').readFileSync('schemas/mcp-tools.json','utf8')).length"`).
