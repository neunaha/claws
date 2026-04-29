<!-- CLAWS-GLOBAL:BEGIN v1 -->
## Claws — Machine-Wide Terminal Policy

Claws may be installed in the current project. Before running any long-lived process, check whether `.claws/claws.sock` exists in the project root.

### If `.claws/claws.sock` exists — you are in a Claws project

You MUST follow these rules:

1. **NEVER use Bash for long-lived processes** (servers, test watchers, builds, REPLs). Use `claws_create` + `claws_send`.
2. **ALWAYS create wrapped terminals** (`wrapped=true`) to enable log reading.
3. **ALWAYS close every terminal you create** when the task is done.
4. **NEVER touch terminals you did not create.**
5. **NEVER run Claude Code in headless/non-interactive mode.**

### Worker boot sequence (exact — do not skip steps)

```
Step 1  claws_create name="worker-<slug>" wrapped=true
Step 2  claws_send id=<N> text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions"
Step 3  Poll claws_read_log every 5s until output contains "trust" (~20s)
Step 4  claws_send id=<N> text="1" newline=false
Step 5  Poll claws_read_log every 5s until output contains "bypass" (~10s)
Step 6  claws_send id=<N> text="<mission>" newline=false
Step 7  claws_send id=<N> text="
" newline=false
```

### Lifecycle (8 phases — apply to every multi-terminal orchestration)

PLAN → SPAWN → DEPLOY → OBSERVE → RECOVER → HARVEST → CLEANUP → REFLECT

### Wave Discipline Contract (mandatory for Wave Army sub-workers)

When you receive a Wave Army mission you are a sub-worker. You MUST:

1. **Register** — call `claws_hello` with `waveId` and `subWorkerRole` within 60 s of boot.
2. **Publish boot event** — publish `wave.<waveId>.<role>.boot` (matching WaveLeadBootV1 or role-specific schema) immediately after hello.
3. **Heartbeat every 20 s** — publish `worker.*.heartbeat` continuously while active. The server fires a `wave.<waveId>.violation` event after 25 s of silence.
4. **Phase events** — publish `worker.*.phase` on every lifecycle transition.
5. **Error events** — publish `worker.*.event` with `kind=ERROR` for any blocking failure; never swallow errors silently.
6. **No --no-verify** — every commit MUST pass pre-commit hooks. `--no-verify` is forbidden.
7. **Full suite before every commit** — run `npm test` (or equivalent); assert zero failures.
8. **Type check per .ts file** — run `npx tsc --noEmit` after editing any TypeScript; fix all errors before proceeding.
9. **Complete event** — publish `wave.<waveId>.<role>.complete` as final act, then close terminal.

### If `.claws/claws.sock` does not exist

No Claws server running. Use standard tools. If the user explicitly installs Claws for this project, re-read `.claws-bin/README.md` for project-specific tool list.
<!-- CLAWS-GLOBAL:END v1 -->
