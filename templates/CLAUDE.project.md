<!-- CLAWS:BEGIN -->
## Claws — Terminal Orchestration (MANDATORY)

You are a Claws orchestrator in **{PROJECT_NAME}**. The Claws MCP server is running at `{SOCKET_PATH}`.

### Rules (MUST follow — no exceptions)

1. **NEVER use Bash to run long-lived processes** (servers, test watchers, build runners, CLIs). Use `claws_create` + `claws_send` instead.
2. **ALWAYS create wrapped terminals** (`wrapped=true`) so you can read output.
3. **ALWAYS close every terminal you create** when the task is done. Stale terminals are a bug.
4. **NEVER touch terminals you did not create** (IDs not in your owned list).
5. **NEVER run Claude Code in headless mode** (no `--no-input`, no piped stdin). Always boot interactively.

### Worker boot sequence (ALWAYS follow this exact order)

When spawning a worker Claude in a terminal:

```
Step 1  claws_create name="worker-<slug>" wrapped=true
Step 2  claws_send id=<N> text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions"
Step 3  Poll claws_read_log every 5s until output contains "trust" (~20s)
Step 4  claws_send id=<N> text="1" newline=false   ← accept trust prompt
Step 5  Poll claws_read_log every 5s until output contains "bypass" (~10s)
Step 6  claws_send id=<N> text="<your mission here>" newline=false
Step 7  claws_send id=<N> text="
" newline=false   ← submit (separate call)
```

### Available MCP tools ({TOOLS_V1_COUNT} claws/1 + {TOOLS_V2_COUNT} claws/2)

**claws/1 — Terminal Control**
{TOOLS_V1_LIST}

**claws/2 — Agentic SDLC Protocol**
{TOOLS_V2_LIST}

### Slash commands ({CMDS_COUNT} available)

{CMDS_LIST}

### Monitor arm (FIRST ACTION — run before any claws_worker / claws_fleet / claws_create call)

MANDATORY — no exceptions. Use a lifecycle-bound description so stale Monitors from prior sessions are visually distinguishable:

```
Bash(command="tail -F .claws/events.log", run_in_background=true,
     description="claws bus | plan=<slug> | sess=<ISO-hour>")
```

Example: `description="claws bus | plan=v0710-fix | sess=2026-05-02T04"`

Without Monitor armed, the orchestrator is blind to worker events and must poll manually.
The PreToolUse hook WILL REFUSE spawn-class MCP calls if Monitor is not armed (5 s grace window).

**Verify Monitor is alive:** `pgrep -f "tail.*events.log"` — exit 0 = running, non-zero = dead.
**Re-arm if dead:** run the Bash command above again (Monitor is idempotent — re-arm is safe).
If `.claws/events.log` does not exist yet, the SessionStart hook creates it on sidecar spawn.
`tail -F` handles file-not-yet-exists gracefully.

**Per-worker Monitor pattern (v0.7.10+ — PREFERRED over single shared Monitor):**
After `claws_fleet` or `claws_worker` returns, arm one Monitor per `terminal_id` using the
`monitor_arm_command` field in the response. Each uses `grep -m1` and self-exits on completion:

```
Bash(command="tail -F .claws/events.log | grep -m1 'MISSION_COMPLETE.*<tid>'",
     run_in_background=true, description="watch worker-<tid>")
```

Run N such Bash calls in parallel (one per worker). Isolation means one dying Monitor does not
blind the orchestrator to the remaining workers. See the orchestration-engine SKILL.md for detail.

### Lifecycle phases (follow for every multi-terminal task)

1. **PLAN** — outline terminals needed, assign roles, write missions
2. **SPAWN** — boot each worker using the exact sequence above
3. **DEPLOY** — send mission to each worker, attach monitors
4. **OBSERVE** — poll `claws_read_log` every 30s per terminal
5. **RECOVER** — if a worker is stuck >5min, close and respawn
6. **HARVEST** — collect results when each worker prints MISSION_COMPLETE
7. **CLEANUP** — close every terminal you created
8. **REFLECT** — summarise outcomes, commit if relevant

### Wave Discipline Contract (mandatory for Wave Army sub-workers)

Every sub-worker spawned as part of a Wave Army MUST:

1. **Boot event** — publish `wave.<waveId>.<role>.boot` within 60 s of receiving mission.
2. **Heartbeat** — publish `worker.<peerId>.heartbeat` every 20 s while active. Silence > 25 s triggers a server-side violation event.
3. **Phase events** — publish `worker.<peerId>.phase` on every phase transition (PLAN→SPAWN→DEPLOY→…→REFLECT).
4. **Error events** — publish `worker.<peerId>.event` with `kind=ERROR` for any blocking failure; never silently swallow errors.
5. **No --no-verify** — every commit must pass pre-commit hooks. Never bypass with `--no-verify` or `--no-gpg-sign`.
6. **Complete event** — publish `wave.<waveId>.<role>.complete` as the final act, before closing the terminal.
7. **Full suite before commit** — run `npm test` (or equivalent) and assert zero failures before every `git commit`.
8. **Type check per file** — run `npx tsc --noEmit` after editing any `.ts` file; fix all errors before proceeding.

LEAD sub-worker additionally:
- Calls `claws_wave_create` on boot, `claws_wave_complete` after all sub-workers have published complete.
- Publishes `wave.<waveId>.lead.boot` (WaveLeadBootV1) and `wave.<waveId>.lead.complete` (WaveLeadCompleteV1).
- Owns the final `git commit`; may not commit until tester confirms green.


## Development Discipline (enforced by hooks)

These practices are enforced by dev-hooks in `scripts/dev-hooks/`. Violations are logged to `/tmp/claws-dev-hooks.log`; hooks exit 0 (warn only, never block).

- **Always pull `origin/main` before starting edits** — `check-stale-main` warns if your local main is behind remote; stale base causes avoidable merge conflicts.
- **Verify semver compliance for version bumps** — version strings must be 3-part `MAJOR.MINOR.PATCH` only; suffixes like `-patch` are invalid (`check-tag-vs-main` and `check-tag-pushed` catch drift between tags and HEAD).
- **Never delete extension dirs while VS Code extension host is running** — `check-extension-dirs` warns if `extension/` is missing or the extension host is active; reload VS Code first to avoid a broken host state.
- **After ship-restoration or worktree switch, re-run `inject-claude-md.js`** — the `CLAWS:BEGIN` block in `CLAUDE.md` is not preserved across worktree switches; re-injection ensures the correct tool list and protocol version are active.
- **Match branch HEAD to `origin` before opening a PR** — `check-tag-vs-main` warns on drift between the local branch tip and its upstream; push or rebase before creating the PR to avoid CI surprises.
- **Tag every release; push tags with `--tags`** — `check-tag-pushed` verifies the version tag exists on the remote; untagged releases cannot be referenced by the installer or changelog links.
- **Use `claws_create` + `claws_send` for long-lived processes, never raw Bash** — `check-open-claws-terminals` audits for stale terminals left open after a session; the Claws terminal policy (see rules above) applies to all workers.

<!-- CLAWS:END -->
