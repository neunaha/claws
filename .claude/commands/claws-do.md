---
name: claws-do
description: Universal verb — classifies any task into the right execution shape and runs it.
---

# /claws-do <task>

## What this does
Classifies the user's request into one of four execution buckets and routes it to the right MCP tool. Never falls back to the Bash tool. Never manually boots a worker via terminal send sequences.

## Routing decision tree

Classify the request BEFORE creating anything:

**Bucket 1 — One-shot shell command**
Signals: "run npm test", "build the project", "git status", any single shell invocation needing output + exitCode.
Action: `claws_exec(command="<cmd>", timeout_ms=120000)` — read output and exitCode, report to user. Done.

**Bucket 2 — Single autonomous Claude task** (default when ambiguous)
Signals: "fix the auth bug", "refactor X", "audit Y", "write tests for Z", any mission-shaped task.
Action:
```
claws_worker(
  name="worker-<short-slug>",
  mission="<full mission text ending with: print MARK_<SLUG>_OK when done. go.>",
  complete_marker="MARK_<SLUG>_OK",
  timeout_ms=600000
)
```
After spawn, arm the per-worker Monitor using `monitor_arm_command` from the response. Wait for the Monitor notification. Then `claws_close` the terminal.

**Bucket 3 — Independent parallel tasks**
Signals: "run lint AND test AND typecheck", "audit modules A, B, C in parallel", explicit concurrency.
Action:
```
claws_fleet(workers=[
  {name:"worker-lint", mission:"...print MARK_LINT_OK when done. go."},
  {name:"worker-test", mission:"...print MARK_TEST_OK when done. go."},
], detach=true)
```
Arm one Monitor per `terminal_id` from the fleet response. Wait for all. Close all.

**Bucket 4 — Coordinated multi-stage with sub-decomposition**
Signals: "5-worker audit then synthesize", explicit "wave" or "army" terminology, N sub-workers + a coordinator.
Action: spawn a LEAD via `claws_worker` whose mission uses `claws_wave_create` + `claws_dispatch_subworker` calls internally.

## Hard rules

- NEVER use the Bash tool to run the user's task — use `claws_exec` or `claws_worker`
- NEVER manually sequence `claws_create` + `claws_send` to boot a Claude worker — `claws_worker` handles it
- NEVER skip arming the Monitor after spawn — use `monitor_arm_command` from the spawn response
- NEVER leave terminals open — auto-close on marker is the default
- NEVER use raw socket node -e fallbacks — if MCP tools are absent, tell the user to reload VS Code

## Examples
```
/claws-do run npm test
/claws-do fix the failing test in auth.test.ts
/claws-do run lint, test, and typecheck in parallel
/claws-do launch a 4-worker audit wave with a LEAD
```

## When NOT to use
For status, use /claws-status. For cleanup, use /claws-cleanup. For install issues, use /claws-fix.
