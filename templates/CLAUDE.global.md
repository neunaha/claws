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

### If `.claws/claws.sock` does not exist

No Claws server running. Use standard tools. If the user explicitly installs Claws for this project, re-read `.claws-bin/README.md` for project-specific tool list.
<!-- CLAWS-GLOBAL:END v1 -->
