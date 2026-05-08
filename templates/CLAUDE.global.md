<!-- CLAWS-GLOBAL:BEGIN -->
## Claws — Machine-Wide Terminal Policy (v{VERSION})

Claws may be installed in the current project. The trigger is the file `.claws/claws.sock` in the project root — if it exists, the rest of this section applies. If it does not, this section is inert.

### What is already running for you

When you start a session in a Claws project, several things happen automatically before your first message. You do not need to spawn or arm any of them yourself:

- **MCP server** (`mcp__claws__*` tools) is registered via `.mcp.json` and exposes the full Claws API.
- **Sidecar** (`stream-events.js --auto-sidecar`) is spawned by the SessionStart hook, streaming every bus event into `.claws/events.log`.
- **Hooks** in `~/.claude/settings.json` watch your tool calls: a Monitor gate on spawn-class MCP calls, an orphan-cleanup PostToolUse hook, a `--no-verify` block on Bash, and a Stop hook that kills the sidecar at session end.

You should treat these as part of the runtime — do not respawn them, do not kill them.

### The simple path: `/claws-do`

For most work, run `/claws-do "<task>"`. It classifies the task into one of four buckets and runs the right tool:

1. **One-shot shell** — `claws_exec(command, …)` for quick captures.
2. **Single Claude task** — `claws_worker(name, mission)` for anything that needs a TUI Claude session.
3. **Parallel fleet** — `claws_fleet(workers=[…])` for independent jobs that can run in parallel.
4. **Wave with LEAD** — multi-role wave army for coordinated multi-worker missions.

`/claws-status` shows live terminal + lifecycle state. `/claws-help` lists every command and tool.

Each entry-point command (`/claws-do`, `/claws`, `/claws-fix`) includes a MANDATORY
cold-start sequence at its top — read it before deliberating.

### Terminal hygiene (non-negotiable)

- **NEVER use Bash for long-lived processes** — servers, watchers, REPLs, builds. Use `claws_create` + `claws_send`, or let `claws_worker` / `claws_fleet` do it for you.
- **ALWAYS create wrapped terminals** (`wrapped: true` is the default — leave it on). Wrapped terminals capture every pty byte to a log; unwrapped terminals are invisible to `claws_read_log`.
- **ALWAYS close terminals you create.** Either via `claws_done()` from inside the worker (preferred), or `claws_close(id)` from the orchestrator at cleanup.
- **NEVER touch terminals you did not create.**
- **NEVER run Claude headless** (`claude -p "…"`). Workers must be visible TUI sessions launched via `claws_worker` or by sending `claude --dangerously-skip-permissions` into a wrapped terminal.

### Workers boot themselves — do not run the send sequence manually

`claws_worker(mission=…)` and `claws_fleet(workers=[…])` run the full boot sequence internally: create wrapped terminal → launch `claude --model … --dangerously-skip-permissions` → wait for the prompt to settle (detected by `❯` + `cost:$` stable for 3 polls) → bracketed-paste the mission → submit. Boot waits default to 25 s.

You do **not** call `claws_create` + `claws_send` to boot workers manually. That sequence is automated.

`claws_worker` and `claws_fleet` use a **mode-aware** detach default:
- Mission-mode (you pass `mission=…`) → `detach: true` by default. The call returns immediately with `terminal_id` + `correlation_id` and a copy-pasteable `monitor_arm_command`. Poll completion with `claws_workers_wait(terminal_ids=[…])`.
- Command-mode (you pass `command=…` instead) → `detach: false` by default. The call blocks until the command exits.
- Override with `detach: true|false` if needed.

`claws_fleet` always defaults to detach unless you pass `detach: false` explicitly.

### Worker completion — five layers, `claws_done()` is primary

Every worker mission must end with these final actions, in order:

```
F1 (Bash):    git status --short                       — verify state
F2 (Bash):    git log --oneline -5                     — verify commits
F3 (MCP):     claws_done()                             — PRIMARY, REQUIRED
F4 (Bash):    printf '%s\n' '__CLAWS_DONE__'           — pty-byte backup
F5 (chat):    end final message with __CLAWS_DONE__    — last-resort backup
```

`claws_done()` reads `CLAWS_TERMINAL_ID` from the worker's environment (set by the extension at spawn), publishes `system.worker.completed` with `marker:'__CLAWS_DONE__'`, and closes the terminal. Zero arguments. That is the entire signal — you do not need `claws_publish` for completion.

The marker the server recognizes is **`__CLAWS_DONE__`** and only that string. No other marker variant is recognized.

If a worker exits without firing F3 or F4, VS Code's `onDidCloseTerminal` triggers the Wave D fallback: the extension publishes `system.worker.terminated`, which the MCP server upgrades to `system.worker.completed` with `completion_signal:'terminated'`. So a worker that just dies still gets accounted for — but `claws_done()` is the canonical path and what `/claws-do` and the prompt templates teach.

### Monitor — sidecar streams, per-worker filters

The sidecar is already running and writing every bus event to `.claws/events.log`. The PreToolUse hook gates spawn-class MCP calls (`claws_create`, `claws_worker`, `claws_fleet`, `claws_dispatch_subworker`) and refuses if no Monitor process is detected — there is a 5 s grace from the first call.

The hook accepts either of these patterns:
- `pgrep -f 'stream-events\.js'` — the canonical bus subscription (preferred)
- `pgrep -f 'tail.*\.claws/events\.log'` — legacy `tail -F` fallback (still works)

Per-worker observation: every spawn response includes a `monitor_arm_command` string. Copy-paste it into a `Monitor(...)` call:

```
Monitor(command="node <claws-bin>/stream-events.js --wait <correlation_id>",
        description="claws monitor | term=<id>", timeout_ms=600000, persistent=false)
```

`stream-events.js --wait <correlation_id>` filters the bus stream to one worker and self-exits on `system.worker.completed`. SIGPIPE-safe, no SIGURG kill — unlike `tail -F | grep`, which the supervisor will kill within ~30 s of inactivity.

### Lifecycle (full session phase machine)

```
{LIFECYCLE_PHASES}
```

`SESSION-BOOT` and `SESSION-END` are session-boundary phases (server-internal). Workers report a 9-phase subset: `PLAN → SPAWN → DEPLOY → OBSERVE → RECOVER → HARVEST → CLEANUP → REFLECT`, plus `FAILED` as an off-path terminal state. `FAILED` exits to `CLEANUP` or `SESSION-END`; `failure_cause` (with optional `recovery_hint`) is preserved across recovery.

### Wave Discipline (Wave Army sub-workers only)

If you receive a Wave Army mission, you are a sub-worker. You MUST:

1. **Register** — call `claws_hello` with `waveId` and `subWorkerRole` within 60 s of boot. (`capabilities: ['push']` is auto-granted as of v0.7.13 — passing it is now optional but harmless.)
2. **Boot event** — publish `wave.<waveId>.<role>.boot` immediately after hello.
3. **Heartbeat every 20 s** — publish `worker.<peerId>.heartbeat` (use the `peerId` returned by `claws_hello`, NOT the role name — only `worker.<peerId>.*` topics reset the server's 25 s violation timer).
4. **Phase events** — publish `worker.<peerId>.phase` on every transition.
5. **Error events** — publish `worker.<peerId>.event` with `kind=ERROR` for any blocking failure; never silently swallow.
6. **No `--no-verify`** — every commit must pass pre-commit hooks. The Bash hook hard-blocks `--no-verify` and `--no-gpg-sign`.
7. **Full suite before commit** — `npm test` (or equivalent) must be green.
8. **Type-check after `.ts` edits** — `npx tsc --noEmit` must report zero errors.
9. **Complete event** — publish `wave.<waveId>.<role>.complete` as the absolute final act before printing the role sentinel (the LEAD waits on this).

### What's automatic now (don't do these manually)

- ❌ Manual sidecar spawn — the SessionStart hook does it.
- ❌ Manual peer registration before publishing — `claws_done` and other helpers do it for you when needed.
- ❌ Passing `capabilities: ['push']` to `claws_hello` — auto-granted.
- ❌ Running `claws_create` + `claws_send` to boot Claude in a worker — `claws_worker` / `claws_fleet` do the full sequence.
- ❌ Choosing a marker string per worker — always `__CLAWS_DONE__`.
- ❌ Polling `tail -F` for completion — use the per-worker `monitor_arm_command` from the spawn response.
- ❌ Closing your own terminal at the end — `claws_done()` does it.

### If `.claws/claws.sock` does not exist

No Claws server is running for this project. Use standard tools (Bash, Edit, Write). Nothing in this section applies.
<!-- CLAWS-GLOBAL:END -->
